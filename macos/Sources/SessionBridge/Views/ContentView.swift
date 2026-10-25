import SwiftUI

struct ContentView: View {
    @EnvironmentObject var bridge: BridgeModel
    private var currentPage: NavigationPage { bridge.page ?? .whatsapp }
    private var connectionLabel: String {
        if bridge.connected { return "Connected" }
        if !bridge.reachable { return "Offline" }
        switch bridge.status?.whatsapp.status {
        case "connecting": return "Connecting"
        case "paused": return "Paused"
        default: return "Offline"
        }
    }
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(spacing: 22) {
                FarFromDeskMark().foregroundStyle(BridgeStyle.accent).frame(width: 27, height: 27)
                    .frame(width: 42, height: 42)
                    .accessibilityLabel("FarFromDesk")
                VStack(spacing: 9) {
                    ForEach(NavigationPage.allCases) { item in
                        SidebarNavigationButton(item: item, selected: currentPage == item,
                                                count: item == .activity ? (bridge.status?.approvals.count ?? 0) + (bridge.status?.unfinishedRequests.count ?? 0) : 0) { bridge.page = item }
                    }
                }.padding(7)
                Spacer(minLength: 20)

            }.padding(.top, 22).padding(.bottom, 22).frame(width: 86)
            VStack(spacing: 0) {
                if let error = bridge.error {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                        Text(error).font(BridgeTypography.callout).textSelection(.enabled)
                        Spacer()
                        Button { bridge.error = nil } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain).accessibilityLabel("Dismiss error")
                    }.padding(16).background(.orange.opacity(0.09))
                }
                if let count = bridge.status?.unfinishedRequests.count, count > 0, currentPage != .activity {
                    HStack(spacing: 12) {
                        Image(systemName: "clock.badge.exclamationmark").foregroundStyle(BridgeStyle.warning)
                        Text("\(count) unfinished request\(count == 1 ? "" : "s")")
                            .font(BridgeTypography.font(size: 12, weight: .medium))
                        Text(bridge.reachable ? "Waiting for a reply or review" : "Last known state · bridge offline")
                            .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                        Spacer()
                        Button("Review in Activity") { bridge.page = .activity }
                    }.padding(16).background(BridgeStyle.sand)
                }
                switch currentPage {
                case .whatsapp: WhatsAppView()
                case .activity: ActivityView()
                case .settings: SettingsView()
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(BridgeStyle.canvas.ignoresSafeArea())
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .navigation) {
                HStack(spacing: 14) {
                    Text("FarFromDesk / \(currentPage.rawValue)").font(BridgeTypography.font(size: 14, weight: .semibold))
                        .foregroundStyle(BridgeStyle.canvasInk)
                    HStack(spacing: 6) {
                        Circle().fill(bridge.connected ? BridgeStyle.canvasSuccess : BridgeStyle.canvasSecondary).frame(width: 6, height: 6)
                        Text(connectionLabel).font(BridgeTypography.font(size: 11, weight: .medium))
                    }.foregroundStyle(bridge.connected ? BridgeStyle.canvasSuccess : BridgeStyle.canvasSecondary)
                        .accessibilityElement(children: .ignore).accessibilityLabel("WhatsApp \(connectionLabel.lowercased())")
                }
            }
            ToolbarItemGroup(placement: .automatic) {
                if bridge.busy { ProgressView().controlSize(.small).accessibilityLabel("Updating bridge") }
                Button { Task { await bridge.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh bridge status").foregroundStyle(BridgeStyle.canvasSecondary)
            }
        }
        .toolbarBackground(BridgeStyle.canvas, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .frame(minWidth: 900, minHeight: 640)
        .font(BridgeTypography.body).foregroundStyle(BridgeStyle.canvasInk)
        .preferredColorScheme(.dark).environment(\.colorScheme, .dark)
        .tint(BridgeStyle.accent)
    }
}

private struct SidebarNavigationButton: View {
    let item: NavigationPage
    let selected: Bool
    let count: Int
    let action: () -> Void
    @ViewState private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Button(action: action) {
            Image(systemName: item.symbol).font(.system(size: 18, weight: .regular))
                .foregroundStyle(selected ? BridgeStyle.accent : BridgeStyle.secondary)
                .frame(width: 40, height: 40)
                .background(selected ? BridgeStyle.accentWash : (hovering ? BridgeStyle.hover : .clear), in: RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topTrailing) {
                    if count > 0 {
                        Text(String(count)).font(BridgeTypography.font(size: 9, weight: .semibold))
                            .foregroundStyle(BridgeStyle.actionInk).padding(4).background(BridgeStyle.action, in: Circle())
                            .offset(x: 3, y: -3)
                    }
                }
                .contentShape(Rectangle())
        }.buttonStyle(.plain).onHover { hovering = $0 }
            .help(item.rawValue).accessibilityLabel(item.rawValue)
            .accessibilityValue(count > 0 ? "\(count) pending" : "")
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: hovering)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: selected)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
