import Foundation

/// Which icons the iOS status bar shows, so they stand out on what is under them: the decision alone, which
/// HerdrBridgeViewController carries out. The page says its colour in `<meta name="theme-color">`, as it does for
/// Android (MainActivity.paintBars), where the same line is drawn.
public enum Bars {
    public enum Icons: Equatable {
        /// Light icons, for a dark screen.
        case light
        /// Dark icons, for a light screen.
        case dark
    }

    /// The icons with nothing to go by: the app starts dark, with light icons (SystemBars in capacitor.config.json),
    /// as every page had before the bars followed it.
    public static let fallback: Icons = .light

    /// Above this relative luminance a colour is light, and its icons dark: Android's line (MainActivity.paintBars).
    static let lightAbove = 0.18

    /// The icons for a page whose theme-color is `themeColor`: read only as `#rrggbb`, as Android reads it; anything
    /// else, or none, keeps the app's own (`fallback`).
    public static func icons(themeColor: String?) -> Icons {
        guard let text = themeColor?.trimmingCharacters(in: .whitespacesAndNewlines), text.utf8.count == 7, text.hasPrefix("#"),
              let value = UInt32(text.dropFirst(), radix: 16), text.dropFirst().allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return fallback }
        return icons(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }

    /// The icons for a native view of that colour (a cover over the page), its sRGB components from 0 to 1.
    public static func icons(red: Double, green: Double, blue: Double) -> Icons {
        let linear = [red, green, blue].map { component -> Double in
            let c = min(max(component, 0), 1)
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] > lightAbove ? .dark : .light
    }

    /// What the status bar shows: a cover over the page hides the page, so its colour counts (`cover`); else what the
    /// page last said (`page`); else the app's own.
    public static func icons(cover: Icons?, page: Icons?) -> Icons {
        cover ?? page ?? fallback
    }
}
