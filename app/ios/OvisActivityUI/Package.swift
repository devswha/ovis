// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OvisActivityUI",
    platforms: [.iOS(.v17)],
    products: [.library(name: "OvisActivityUI", targets: ["OvisActivityUI"])],
    targets: [
        .target(name: "OvisActivityUI"),
        .testTarget(name: "OvisActivityUITests", dependencies: ["OvisActivityUI"])
    ]
)
