import SwiftUI
import CoreText

/// DM Sans is bundled under the SIL Open Font License. Registration is process-local.
enum BridgeTypography {
    private static let registered: Void = {
        if let url = Bundle.module.url(forResource: "DMSans", withExtension: "ttf", subdirectory: "Fonts") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    static func font(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        _ = registered
        return .custom("DMSans-Regular", size: size).weight(weight)
    }

    static let body = font(size: 13)
    static let callout = font(size: 13)
    static let caption = font(size: 11)
    static let caption2 = font(size: 10)
    static let headline = font(size: 15, weight: .medium)
}
