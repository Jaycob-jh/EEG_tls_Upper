// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaoCaoAppSupport",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "CaoCaoAppSupport", targets: ["CaoCaoProtocol"]),
    ],
    targets: [
        .target(name: "CaoCaoProtocol", path: "Sources/CaoCaoProtocol"),
        .testTarget(name: "CaoCaoProtocolTests", dependencies: ["CaoCaoProtocol"], path: "Tests/CaoCaoProtocolTests"),
    ]
)
