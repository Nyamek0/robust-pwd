import Foundation
import CoreGraphics

nonisolated struct FaceRecognitionResult {
    let embedding: [Float]
    let alignedImage: CGImage
    let alignmentTier: AlignmentTier
    let quality: Float?
    let face: DetectedFace
}

private struct StatusOutput: Encodable {
    let ok: Bool
    let enrolled: Bool
    let hasSecret: Bool
    let model: String
}

private struct EnrollOutput: Encodable {
    let ok: Bool
    let samples: Int
    let model: String
}

private struct VerifyOutput: Encodable {
    let ok: Bool
    let matched: Bool
    let similarity: Float
    let model: String
    let master: String?
}

private struct ErrorOutput: Encodable {
    let ok: Bool
    let error: String
}

private func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(value),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

private func fail(_ message: String, code: Int32 = 1) -> Never {
    printJSON(ErrorOutput(ok: false, error: message))
    exit(code)
}

private func makeEmbedder() -> (any FaceEmbedder, String) {
    if let arcFace = try? ArcFaceEmbedder() {
        return (arcFace, "arcface")
    }
    return (VisionFeaturePrintEmbedder(), "vision-fallback")
}

private func alignAndEmbed(
    face: DetectedFace,
    in frame: CGImage,
    embedder: any FaceEmbedder
) throws -> FaceRecognitionResult {
    let input: CGImage
    let tier: AlignmentTier
    if embedder.requiresAlignment {
        guard let aligned = FaceAligner.align(face, from: frame) else {
            throw NSError(domain: "GlanceAuth", code: 2, userInfo: [NSLocalizedDescriptionKey: "Face alignment failed"])
        }
        input = aligned.image
        tier = aligned.tier
    } else {
        guard let cropped = FaceDetector.crop(face, from: frame) else {
            throw NSError(domain: "GlanceAuth", code: 2, userInfo: [NSLocalizedDescriptionKey: "Face crop failed"])
        }
        input = cropped
        tier = .paddedCrop
    }
    let embedding = try embedder.embedding(for: input)
    return FaceRecognitionResult(
        embedding: embedding,
        alignedImage: input,
        alignmentTier: tier,
        quality: face.quality,
        face: face
    )
}

private func selectProminentFace(in faces: [DetectedFace]) -> DetectedFace? {
    let prominent = faces.filter { $0.normalizedBoundingBox.width >= 0.16 }
    return prominent.max {
        $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height
    }
}

@main
struct GlanceAuthCLI {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else {
            fail("Usage: glance-auth <status|enroll|verify|clear>")
        }

        switch command {
        case "status":
            let (_, modelName) = makeEmbedder()
            printJSON(StatusOutput(
                ok: true,
                enrolled: KeychainStore.hasEnrolledFace,
                hasSecret: KeychainStore.hasStoredMaster,
                model: modelName
            ))

        case "clear":
            KeychainStore.clearAll()
            printJSON(["ok": true])

        case "enroll":
            await runEnroll(args: Array(args.dropFirst()))

        case "verify":
            await runVerify(args: Array(args.dropFirst()))

        default:
            fail("Unknown command '\(command)'. Use status, enroll, verify, or clear.")
        }
    }

    private static func runEnroll(args: [String]) async {
        let targetSamples = parseIntFlag("--samples", in: args) ?? 5
        let timeout = TimeInterval(parseIntFlag("--timeout", in: args) ?? 15)

        guard let stdinData = try? FileHandle.standardInput.readToEnd(),
              let rawMaster = String(data: stdinData, encoding: .utf8)?
                .trimmingCharacters(in: .newlines),
              !rawMaster.isEmpty else {
            fail("Master password must be provided on stdin.")
        }

        do {
            try await HeadlessCamera.ensureAuthorized()
            let (embedder, modelName) = makeEmbedder()
            let camera = HeadlessCamera()
            try camera.start()
            defer { camera.stop() }

            var samples: [[Float]] = []
            var counter: UInt64 = 0
            let deadline = Date().addingTimeInterval(timeout)

            while samples.count < targetSamples && Date() < deadline {
                guard let (frame, nextCounter) = camera.nextFrame(after: counter, timeout: 0.5) else {
                    continue
                }
                counter = nextCounter

                let faces = (try? FaceDetector.detectFaces(in: frame)) ?? []
                guard let face = selectProminentFace(in: faces) else { continue }
                if let quality = face.quality, quality < 0.25 { continue }

                if let result = try? alignAndEmbed(face: face, in: frame, embedder: embedder) {
                    samples.append(result.embedding)
                    try? await Task.sleep(for: .milliseconds(150))
                }
            }

            guard samples.count >= max(2, targetSamples / 2),
                  let template = FaceEmbedding.average(samples) else {
                fail("Could not capture enough clear face samples. Look directly at the camera.")
            }

            let profile = EnrolledFaceProfile(
                modelIdentifier: embedder.modelIdentifier,
                createdAt: ISO8601DateFormatter().string(from: Date()),
                template: template,
                samples: samples
            )
            try KeychainStore.saveMasterPassword(rawMaster)
            try KeychainStore.saveFaceProfile(profile)

            printJSON(EnrollOutput(ok: true, samples: samples.count, model: modelName))
        } catch {
            fail(error.localizedDescription)
        }
    }

    private static func runVerify(args: [String]) async {
        let timeout = TimeInterval(parseIntFlag("--timeout", in: args) ?? 10)

        do {
            guard let profile = try KeychainStore.loadFaceProfile(),
                  let master = try KeychainStore.loadMasterPassword() else {
                fail("Face unlock is not enrolled.")
            }

            let (embedder, modelName) = makeEmbedder()
            guard profile.modelIdentifier == embedder.modelIdentifier else {
                fail("Enrolled face model mismatch (\(profile.modelIdentifier) vs \(embedder.modelIdentifier)). Please re-enroll.")
            }

            try await HeadlessCamera.ensureAuthorized()
            let camera = HeadlessCamera()
            try camera.start()
            defer { camera.stop() }

            let threshold: Float = modelName == "arcface" ? 0.45 : 0.85
            let liveness = await MainActor.run {
                let analyzer = LivenessAnalyzer()
                analyzer.modeProvider = { .light }
                return analyzer
            }
            var consecutiveMatches = 0
            var bestSimilarity: Float = 0
            var counter: UInt64 = 0
            let deadline = Date().addingTimeInterval(timeout)

            while Date() < deadline {
                guard let (frame, nextCounter) = camera.nextFrame(after: counter, timeout: 0.5) else {
                    continue
                }
                counter = nextCounter

                let faces = (try? FaceDetector.detectFaces(in: frame)) ?? []
                guard let face = selectProminentFace(in: faces) else {
                    consecutiveMatches = 0
                    continue
                }

                guard let result = try? alignAndEmbed(face: face, in: frame, embedder: embedder) else {
                    continue
                }

                let faceCrop = FaceDetector.crop(face, from: frame)
                let livenessFrame = LivenessFeatureExtractor.extract(
                    from: result,
                    frame: frame,
                    faceCrop: faceCrop
                )
                let snapshot = await MainActor.run { liveness.observe(livenessFrame) }

                if case .denied(let cue) = snapshot.decision {
                    fail("Contrôle anti-usurpation échoué (\(cue.rawValue)). Utilisez votre vrai visage, pas une photo ou un écran.", code: 3)
                }

                let centroidSim = FaceEmbedding.cosineSimilarity(result.embedding, profile.template)
                let maxSim = profile.samples
                    .map { FaceEmbedding.cosineSimilarity(result.embedding, $0) }
                    .max() ?? centroidSim
                let score = max(centroidSim, maxSim)
                if score > bestSimilarity { bestSimilarity = score }

                if centroidSim >= threshold && maxSim >= threshold {
                    consecutiveMatches += 1
                    if consecutiveMatches >= 2, case .confirmed = snapshot.decision {
                        printJSON(VerifyOutput(
                            ok: true,
                            matched: true,
                            similarity: score,
                            model: modelName,
                            master: master
                        ))
                        return
                    }
                } else {
                    consecutiveMatches = 0
                }
            }

            printJSON(VerifyOutput(
                ok: false,
                matched: false,
                similarity: bestSimilarity,
                model: modelName,
                master: nil
            ))
            exit(2)
        } catch {
            fail(error.localizedDescription)
        }
    }

    private static func parseIntFlag(_ flag: String, in args: [String]) -> Int? {
        guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
        return Int(args[idx + 1])
    }
}
