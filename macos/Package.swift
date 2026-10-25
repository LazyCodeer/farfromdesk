// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SessionBridge",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "SessionBridge", targets: ["SessionBridge"])],
    targets: [
        .executableTarget(name: "SessionBridge", resources: [.copy("Resources/Fonts")]),
        .testTarget(name: "SessionBridgeTests", dependencies: ["SessionBridge"])
    ],
    swiftLanguageModes: [.v5]
)
