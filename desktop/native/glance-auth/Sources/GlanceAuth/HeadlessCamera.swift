import AVFoundation
import CoreGraphics
import CoreImage
import Foundation

enum HeadlessCameraError: LocalizedError {
    case permissionDenied
    case noCameraAvailable
    case setupFailed(String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Camera access denied. Allow camera access in System Settings > Privacy & Security."
        case .noCameraAvailable:
            return "No camera device found."
        case .setupFailed(let detail):
            return "Camera setup failed: \(detail)"
        }
    }
}

final class HeadlessCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let outputQueue = DispatchQueue(label: "com.robustpwd.glance.camera")
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let lock = NSLock()
    private var latestFrame: CGImage?
    private var frameCounter: UInt64 = 0

    static func ensureAuthorized() async throws {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            return
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted {
                throw HeadlessCameraError.permissionDenied
            }
        case .denied, .restricted:
            throw HeadlessCameraError.permissionDenied
        @unknown default:
            throw HeadlessCameraError.permissionDenied
        }
    }

    func start() throws {
        guard let device = AVCaptureDevice.default(for: .video) else {
            throw HeadlessCameraError.noCameraAvailable
        }

        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw HeadlessCameraError.setupFailed(error.localizedDescription)
        }

        session.beginConfiguration()
        session.sessionPreset = .vga640x480

        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw HeadlessCameraError.setupFailed("Cannot add camera input")
        }
        session.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: outputQueue)

        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw HeadlessCameraError.setupFailed("Cannot add video output")
        }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
    }

    func stop() {
        if session.isRunning {
            session.stopRunning()
        }
    }

    func nextFrame(after previousCounter: UInt64, timeout: TimeInterval = 1.0) -> (CGImage, UInt64)? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            lock.lock()
            let currentCounter = frameCounter
            let frame = latestFrame
            lock.unlock()
            if currentCounter > previousCounter, let frame {
                return (frame, currentCounter)
            }
            Thread.sleep(forTimeInterval: 0.03)
        }
        return nil
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }

        lock.lock()
        latestFrame = cgImage
        frameCounter &+= 1
        lock.unlock()
    }
}

