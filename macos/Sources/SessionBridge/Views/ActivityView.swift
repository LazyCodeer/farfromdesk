import SwiftUI
import AppKit

struct ActivityView: View {
    @EnvironmentObject var bridge: BridgeModel
    @ViewState private var answers: [String: String] = [:]
    @ViewState private var filter: RequestFilter = .all
    @ViewState private var selectedRequests: Set<String> = []
    @ViewState private var bulkSnapshot: [BridgeStatus.Job] = []
    @ViewState private var confirmBulk = false
    var selectedJobs: [BridgeStatus.Job] { allJobs.filter { selectedRequests.contains($0.id) && $0.canClose == true } }
    var allJobs: [BridgeStatus.Job] {
        let pending = bridge.status?.unfinishedRequests ?? []
        let ids = Set(pending.map(\.id))
        return pending + (bridge.status?.jobs ?? []).filter { !ids.contains($0.id) }
    }
    var jobs: [BridgeStatus.Job] { allJobs.filter { filter.includes($0.status) } }
    var body: some View {
        BridgePage {
            PageHeading(eyebrow: "", title: "Activity", subtitle: "See which session answered and what needs your attention.")
            BridgeCard {
                SectionHeading(title: "Requests are saved on this Mac", detail: "\(bridge.status?.unfinishedRequests.count ?? 0) unfinished")
                Text("Closing the window keeps work running when background access is on. If the service stops, unsent requests resume when it runs again; uncertain deliveries stay here for review. Recorded replies wait for WhatsApp to reconnect.")
                    .font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("For Awaiting reply or Needs review: check the exact native chat below. If you already received the answer, or no longer need a reply, close the request after review. To continue interrupted work, send a new message after checking what already ran.")
                    .font(BridgeTypography.callout).foregroundStyle(BridgeStyle.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if !bridge.reachable {
                    Button("Start bridge") { Task { await bridge.startService() } }.disabled(bridge.busy)
                } else if bridge.status?.preferences?.backgroundEnabled != true {
                    Button("Open background settings") { bridge.page = .settings }
                }
            }
            ForEach(bridge.status?.approvals ?? []) { item in
                BridgeCard {
                    Label("\(item.alias) needs your input", systemImage: "hand.raised").font(BridgeTypography.headline)
                    Text(item.question).font(BridgeTypography.callout).textSelection(.enabled)
                    if item.kind == "approval" {
                        HStack {
                            Button("Allow once") { Task { await bridge.command("/approve \(item.code)") } }.buttonStyle(BridgePrimaryButtonStyle())
                            Button("Deny") { Task { await bridge.command("/deny \(item.code)") } }
                        }.disabled(bridge.busy)
                    } else {
                        TextField("Your answer", text: Binding(get: { answers[item.id] ?? "" }, set: { answers[item.id] = $0 })).textFieldStyle(.roundedBorder)
                        Button("Send answer") { Task { await bridge.command("/answer \(item.code) \(answers[item.id] ?? "")") } }
                            .disabled(bridge.busy || (answers[item.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Request history").font(BridgeTypography.font(size: 17, weight: .medium))
                        Text("Unfinished first · then recent replies").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    }
                    Spacer()
                    Text("\(allJobs.count) request\(allJobs.count == 1 ? "" : "s")").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                }.padding(.vertical, 16)
                HStack(spacing: 6) {
                    ForEach(RequestFilter.allCases) { item in
                        BridgeTab(title: item.rawValue, count: allJobs.filter { item.includes($0.status) }.count,
                                  selected: filter == item) { filter = item }
                    }
                    Spacer(minLength: 0)
                }.padding(.bottom, 16)
                HStack(spacing: 12) {
                    Button("Select eligible") { selectedRequests = Set(jobs.filter { $0.canClose == true }.prefix(500).map(\.id)) }
                    if !selectedRequests.isEmpty { Button("Clear selection") { selectedRequests.removeAll() } }
                    Spacer()
                    Button("Close selected (\(selectedJobs.count))…") {
                        bulkSnapshot = selectedJobs
                        confirmBulk = true
                    }.disabled(selectedJobs.isEmpty || !bridge.reachable || bridge.busy)
                }.padding(.bottom, 14)
                Text("Select requests awaiting a reply or review. Known active deliveries, permissions and unfinished delegated work are protected.")
                    .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary).padding(.bottom, 10)
                HStack(spacing: 16) {
                    Color.clear.frame(width: 22, height: 1)
                    Text("Session").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Received").frame(width: 112, alignment: .leading)
                    Text("Status").frame(width: 146, alignment: .leading)
                    Color.clear.frame(width: 12, height: 1)
                }.font(BridgeTypography.font(size: 11, weight: .medium)).foregroundStyle(BridgeStyle.secondary)
                    .padding(.horizontal, 18).padding(.vertical, 12).background(BridgeStyle.canvas)
                if jobs.isEmpty {
                    EmptyState(symbol: "tray", title: filter == .all ? "No requests yet" : "No matching requests", detail: filter == .all ? "Send a task in your connected WhatsApp chat to get started." : "There are no requests in this category in the loaded history.")
                        .padding(22)
                }
                LazyVStack(spacing: 8) {
                    ForEach(jobs) { job in
                        HStack(alignment: .top, spacing: 8) {
                            Toggle("Select request \(job.id)", isOn: Binding(get: { selectedRequests.contains(job.id) }, set: { selected in
                                if selected { selectedRequests.insert(job.id) } else { selectedRequests.remove(job.id) }
                            })).labelsHidden().toggleStyle(.checkbox).disabled(job.canClose != true)
                                .frame(width: 22).padding(.top, 22)
                            ActivityRow(job: job).environmentObject(bridge)
                        }
                    }
                }
                HStack {
                    Text("Showing \(jobs.count) of \(allJobs.count) loaded requests")
                    Spacer()
                    Text("All unfinished + latest 100")
                }.font(BridgeTypography.caption2).foregroundStyle(BridgeStyle.secondary)
                    .padding(.horizontal, 22).padding(.vertical, 16)
            }.foregroundStyle(BridgeStyle.ink).environment(\.colorScheme, .dark)


        }
        .confirmationDialog("Close \(bulkSnapshot.count) selected requests?", isPresented: $confirmBulk, titleVisibility: .visible) {
            Button("Close selected requests") {
                let requests: [[String: Any]] = bulkSnapshot.map { ["requestId": $0.id, "expectedStatus": $0.status, "expectedUpdatedAt": $0.updated_at ?? $0.created_at] }
                Task {
                    await bridge.perform("/api/request-review-bulk", body: ["requests": requests, "confirmed": true])
                    if bridge.error == nil { selectedRequests.removeAll() }
                }
            }
            Button("Keep waiting", role: .cancel) {}
        } message: {
            Text("Close tracking for these requests only if their answers arrived or you no longer need their replies. History is kept. This does not stop native work, resend tasks or mark them successful. If any selected request changes, nothing will be closed.")
        }
    }
}

struct ActivityRow: View {
    @EnvironmentObject var bridge: BridgeModel
    let job: BridgeStatus.Job
    @ViewState private var expanded = false
    @ViewState private var hovering = false
    @ViewState private var confirmReview = false
    var unresolved: Bool { ["queued", "dispatched", "submitted", "uncertain", "failed"].contains(job.status) }
    var reviewable: Bool { ["submitted", "uncertain", "failed"].contains(job.status) }
    var explanation: String {
        switch job.status {
        case "queued": return "Saved and waiting to send. This resumes when background access is enabled and the session is available."
        case "dispatched": return "Delivery is in progress. Wait for it to finish; sending again could duplicate the task."
        case "submitted": return "Sent to the native session; no final receipt yet. It may still be working, waiting for native permission, or have answered without recording a receipt."
        case "uncertain", "failed": return "Delivery or completion could not be confirmed. Check the native chat before sending anything again. This request will not be resent automatically."
        case "replaced": return "Closed automatically when a new master became ready. This request will not be sent again; work already running in a native chat may continue."
        case "auto_closed": return "Tracking closed automatically after the configured period without a recorded update. Native work was not stopped or marked successful. A late reply can still arrive."
        case "reviewed": return "Closed after your review. This does not mark the task successful, stop native work, or resend it."
        default: return "The session recorded a final reply. WhatsApp delivery is handled separately."
        }
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var needsAttention: Bool { ["uncertain", "failed"].contains(job.status) }
    var binding: BridgeStatus.Binding? { bridge.status?.bindings.first { $0.id == job.binding_id } }
    var status: String {
        switch job.status {
        case "completed": "Reply recorded"
        case "submitted": "Awaiting reply"
        case "dispatched": "Sending to agent"
        case "uncertain": "Needs review"
        case "reviewed": "Closed after review"
        case "auto_closed": "Auto-closed"
        case "replaced": "Master replaced"
        default: job.status.capitalized
        }
    }
    var name: String { binding?.name ?? binding?.alias ?? "Coding session" }
    var statusColor: Color { needsAttention ? BridgeStyle.warning : job.status == "completed" ? BridgeStyle.success : BridgeStyle.secondary }
    var statusFill: Color { needsAttention ? BridgeStyle.sand : job.status == "completed" ? BridgeStyle.successWash : BridgeStyle.surface }
    var statusIcon: String { needsAttention ? "exclamationmark.circle" : job.status == "completed" ? "checkmark" : "clock" }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { if !unresolved { expanded.toggle() } } label: {
                HStack(spacing: 16) {
                    HStack(spacing: 11) {
                        if let binding { ProviderIcon(provider: binding.provider, size: 34) }
                        else {
                            Image(systemName: "text.bubble").foregroundStyle(BridgeStyle.secondary)
                                .frame(width: 34, height: 34)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text(name).font(BridgeTypography.font(size: 13, weight: .medium)).foregroundStyle(BridgeStyle.ink).lineLimit(1)
                            Text(binding.map { $0.provider == "claude" ? "Claude Code" : "Codex" } ?? "Native session")
                                .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                        }
                        Spacer(minLength: 0)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(Date(timeIntervalSince1970: job.created_at / 1000), format: .dateTime.hour().minute())
                            .font(BridgeTypography.font(size: 12, weight: .medium)).foregroundStyle(BridgeStyle.ink)
                        Text(Date(timeIntervalSince1970: job.created_at / 1000), format: .dateTime.month(.abbreviated).day())
                            .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    }.frame(width: 112, alignment: .leading)
                    HStack(spacing: 5) {
                        Image(systemName: statusIcon).font(.system(size: 10))
                        Text(status).font(BridgeTypography.font(size: 10, weight: .medium)).lineLimit(1)
                    }.foregroundStyle(statusColor).padding(.horizontal, 9).padding(.vertical, 7)
                        .background(statusFill, in: Capsule()).frame(width: 146, alignment: .leading)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .medium))
                        .foregroundStyle(BridgeStyle.secondary).frame(width: 12).opacity(unresolved ? 0 : 1)
                }.padding(.horizontal, 18).padding(.vertical, 12).frame(minHeight: 60).contentShape(Rectangle())
            }.buttonStyle(.plain).help(unresolved ? "Unfinished request details are shown below" : (expanded ? "Hide request details" : "Show request details"))
                .accessibilityLabel("\(name), \(status). \(unresolved ? "Unfinished" : (expanded ? "Hide" : "Show")) request details")
                .onHover { hovering = $0 }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: hovering)
            if let error = job.error {
                Label(error, systemImage: "exclamationmark.circle").font(BridgeTypography.caption).foregroundStyle(statusColor)
                    .textSelection(.enabled).padding(.horizontal, 22).padding(.bottom, 14)
            }
            if expanded || unresolved {
                VStack(alignment: .leading, spacing: 10) {
                    if let preview = job.preview, !preview.isEmpty {
                        Text(preview).font(BridgeTypography.callout).foregroundStyle(BridgeStyle.ink)
                            .lineLimit(4).textSelection(.enabled)
                    }
                    Text(explanation).font(BridgeTypography.callout).foregroundStyle(BridgeStyle.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(job.id).font(.caption.monospaced()).foregroundStyle(BridgeStyle.secondary).textSelection(.enabled)
                    if let binding {
                        Text("\(binding.provider == "claude" ? "Claude Code" : "Codex") · \(binding.alias)").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    }
                    HStack {
                        if let binding {
                            Button("Copy native session ID") {
                                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(binding.native_id, forType: .string)
                            }.help("Find this exact session in \(binding.provider == "claude" ? "Claude Code" : "Codex") and check its latest reply and permissions.")
                        }
                        if reviewable {
                            Button("Close after review…") { confirmReview = true }
                                .disabled(!bridge.reachable || bridge.busy || binding?.running == true || job.canClose == false)
                        }
                    }
                    Button("Copy request ID", systemImage: "doc.on.doc") {
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(job.id, forType: .string)
                    }.controlSize(.small)
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    .background(BridgeStyle.surface, in: RoundedRectangle(cornerRadius: 14))
                    .padding(.horizontal, 22).padding(.bottom, 16)
            }
        }.background(hovering ? BridgeStyle.hover : BridgeStyle.panel, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(hovering || expanded ? BridgeStyle.border : .clear, lineWidth: 1))
            .confirmationDialog("Have you checked this request in the native chat?", isPresented: $confirmReview, titleVisibility: .visible) {
                Button("I've checked — close request") {
                    Task { await bridge.perform("/api/request-review", body: ["requestId": job.id, "expectedStatus": job.status, "confirmed": true]) }
                }
                Button("Keep waiting", role: .cancel) {}
            } message: {
                Text("Close only if you received the answer or no longer need its reply. The history is kept as Closed after review. This does not stop native work, resend the request, or claim it succeeded. Native approvals remain in the coding app.")
            }
    }
}

private enum RequestFilter: String, CaseIterable, Identifiable {
    case all = "All", waiting = "Waiting", review = "Needs review", answered = "Answered", closed = "Closed"
    var id: Self { self }
    func includes(_ status: String) -> Bool {
        switch self {
        case .all: true
        case .waiting: ["queued", "dispatched", "submitted"].contains(status)
        case .review: ["uncertain", "failed"].contains(status)
        case .answered: status == "completed"
        case .closed: ["reviewed", "auto_closed", "replaced"].contains(status)
        }
    }
}
