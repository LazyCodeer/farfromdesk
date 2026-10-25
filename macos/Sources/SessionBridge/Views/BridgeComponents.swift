import SwiftUI
import AppKit

enum BridgeStyle {
    private static func color(_ hex: UInt32) -> Color {
        Color(nsColor: nsColor(hex))
    }
    private static func nsColor(_ hex: UInt32) -> NSColor {
        NSColor(red: CGFloat((hex >> 16) & 255) / 255,
                green: CGFloat((hex >> 8) & 255) / 255,
                blue: CGFloat(hex & 255) / 255, alpha: 1)
    }

    // Sampled from the straight-on file-manager reference: canvas #17181D,
    // cards/rows #202126, blue #5C71F1. Selection/button blue is darkened
    // slightly for white small-text contrast; secondary text stays neutral.
    // Lighter accent/text variants keep small labels readable on dark surfaces.
    static let canvasNSColor = nsColor(0x17181D)
    static let canvas = Color(nsColor: canvasNSColor)
    static let canvasInk = color(0xF2F2F4)
    static let canvasSecondary = color(0xA6A7AE)
    static let canvasSuccess = color(0x85C7A1)
    static let sidebar = canvas
    static let toolbar = canvas
    static let panel = color(0x202126)
    static let ink = color(0xF2F2F4)
    static let secondary = color(0xA6A7AE)
    static let accent = color(0x7F91FF)
    static let accentWash = color(0x1D2031)
    static let action = color(0x5267E4)
    static let actionInk = color(0xFFFFFF)
    static let border = color(0x34353C)
    static let hover = color(0x292A30)
    static let success = color(0x85C7A1)
    static let claude = color(0xD9A69F)
    static let surface = color(0x24252B)
    static let shadow = color(0x04050A)
    static let lilac = color(0x302E49)
    static let successWash = color(0x23352C)
    static let selection = color(0x5267E4)
    static let sand = color(0x3B3027)
    static let warningSurface = color(0x382D1F)
    static let warningDetail = color(0xE8D3B5)
    static let warningInk = color(0x251C10)
    static let warning = color(0xE6BB83)
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.6.2" }

}

struct BridgePage<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) { content }
                .frame(maxWidth: 960, alignment: .leading)
                .padding(.horizontal, 26).padding(.top, 22).padding(.bottom, 36)
                .frame(maxWidth: .infinity, alignment: .top)
        }.background(BridgeStyle.canvas)
            .font(BridgeTypography.body).foregroundStyle(BridgeStyle.canvasInk)
            .environment(\.colorScheme, .dark).tint(BridgeStyle.accent)
            .buttonStyle(BridgeSecondaryButtonStyle())
    }
}

struct BridgeCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 18) { content }
            .padding(24).frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(BridgeStyle.ink).environment(\.colorScheme, .dark)
            .background(BridgeStyle.panel, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

struct PageHeading: View {
    let eyebrow: String; let title: String; let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if !eyebrow.isEmpty {
                Text(eyebrow).font(BridgeTypography.font(size: 12, weight: .semibold)).foregroundStyle(BridgeStyle.canvasSuccess)
            }
            Text(title).font(BridgeTypography.font(size: 28, weight: .medium)).tracking(-0.6).foregroundStyle(BridgeStyle.canvasInk)
            if !subtitle.isEmpty {
                Text(subtitle).font(BridgeTypography.font(size: 13)).foregroundStyle(BridgeStyle.canvasSecondary)
                    .lineSpacing(3).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 560, alignment: .leading)
            }
        }
    }
}

struct StatusLabel: View {
    let text: String
    var active = true
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(active ? BridgeStyle.success : BridgeStyle.secondary).frame(width: 6, height: 6)
            Text(text).font(BridgeTypography.font(size: 11, weight: .semibold))
        }
        .foregroundStyle(active ? BridgeStyle.success : BridgeStyle.secondary)
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background((active ? BridgeStyle.success : BridgeStyle.secondary).opacity(0.09), in: RoundedRectangle(cornerRadius: 6))
    }
}

struct ProviderIcon: View {
    let provider: String
    var size: CGFloat = 36
    var foreground: Color? = nil
    private var color: Color { provider == "claude" ? BridgeStyle.claude : BridgeStyle.accent }
    var body: some View {
        Image(systemName: provider == "claude" ? "asterisk" : "terminal")
            .font(BridgeTypography.font(size: size * 0.45, weight: .medium)).foregroundStyle(foreground ?? color)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct SectionHeading: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(BridgeTypography.font(size: 15, weight: .medium)).foregroundStyle(BridgeStyle.ink)
            Spacer()
            if let detail { Text(detail).font(BridgeTypography.font(size: 12)).foregroundStyle(BridgeStyle.secondary).monospacedDigit() }
        }
    }
}

struct EmptyState: View {
    let symbol: String; let title: String; let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol).font(BridgeTypography.font(size: 21, weight: .medium)).foregroundStyle(BridgeStyle.accent)
                .frame(width: 44, height: 44).padding(.bottom, 3)
            Text(title).font(BridgeTypography.font(size: 15, weight: .medium)).foregroundStyle(BridgeStyle.ink)
            Text(detail).font(BridgeTypography.font(size: 13)).foregroundStyle(BridgeStyle.secondary).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct BridgePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        BridgeButtonBody(configuration: configuration, primary: true)
    }
}

struct BridgeSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        BridgeButtonBody(configuration: configuration, primary: false)
    }
}

private struct BridgeButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let primary: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ViewState private var hovered = false
    var body: some View {
        configuration.label
            .font(BridgeTypography.font(size: 12, weight: .medium))
            .foregroundStyle(primary ? BridgeStyle.actionInk : BridgeStyle.ink)
            .padding(.horizontal, 18).padding(.vertical, 11)
            .contentShape(Rectangle())
            .background(primary ? BridgeStyle.action : (hovered ? BridgeStyle.hover : BridgeStyle.panel), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).fill(Color.white.opacity(primary && hovered ? 0.07 : 0)))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(primary ? Color.clear : BridgeStyle.border, lineWidth: 1))
            .overlay(RoundedRectangle(cornerRadius: 25).strokeBorder(focused ? BridgeStyle.accent : .clear, lineWidth: 2).padding(-3))
            .opacity(enabled ? 1 : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .onHover { hovered = $0 && enabled }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: hovered)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

/// The same linked-chat mark used in the approved HTML review.
struct SidekickMark: View {
    var body: some View {
        GeometryReader { geometry in
            Path { p in
                p.move(to: CGPoint(x: 15, y: 4)); p.addLine(to: CGPoint(x: 8, y: 4))
                p.addCurve(to: CGPoint(x: 8, y: 14), control1: CGPoint(x: 1.3, y: 4), control2: CGPoint(x: 1.3, y: 14))
                p.addLine(to: CGPoint(x: 10, y: 14))
                p.move(to: CGPoint(x: 9, y: 20)); p.addLine(to: CGPoint(x: 16, y: 20))
                p.addCurve(to: CGPoint(x: 16, y: 10), control1: CGPoint(x: 22.7, y: 20), control2: CGPoint(x: 22.7, y: 10))
                p.addLine(to: CGPoint(x: 14, y: 10))
                p.move(to: CGPoint(x: 9, y: 12)); p.addLine(to: CGPoint(x: 15, y: 12))
            }.applying(CGAffineTransform(scaleX: geometry.size.width / 24, y: geometry.size.height / 24))
                .stroke(style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
        }.accessibilityHidden(true)
    }
}

/// Shared, comfortably sized tabs for platform switching and history filters.
struct BridgeTab: View {
    let title: String
    var symbol: String? = nil
    var count: Int? = nil
    var expands = false
    let selected: Bool
    let action: () -> Void
    @ViewState private var hovering = false
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let symbol { Image(systemName: symbol).font(.system(size: 13)) }
                Text(title).font(BridgeTypography.font(size: 13, weight: .medium))
                if let count {
                    Text(String(count)).font(BridgeTypography.font(size: 11, weight: .medium)).monospacedDigit().fixedSize()
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(selected ? Color.white.opacity(0.15) : BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 5))
                }
            }
            .foregroundStyle(selected ? BridgeStyle.actionInk : BridgeStyle.ink)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: expands ? .infinity : nil, minHeight: 44)
            .background(selected ? BridgeStyle.action : hovering ? BridgeStyle.hover : BridgeStyle.surface,
                        in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.5)
        }.buttonStyle(.plain)
            .onHover { hovering = $0 }
            .accessibilityLabel(title)
            .accessibilityValue(count.map { "\($0) requests" } ?? "")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
