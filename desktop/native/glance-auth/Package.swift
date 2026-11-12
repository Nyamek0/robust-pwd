// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "glance-auth",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "glance-auth", targets: ["GlanceAuth"])
    ],
    targets: [
        .executableTarget(
            name: "GlanceAuth",
            resources: [
                .copy("Resources/ArcFace.mlpackage")
            ]
        )
    ]
)

