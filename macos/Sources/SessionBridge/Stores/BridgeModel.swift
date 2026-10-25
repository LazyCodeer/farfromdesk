import SwiftUI

@MainActor
final class BridgeModel: ObservableObject {
    @Published var page: NavigationPage?
    @Published var status: BridgeStatus? {
        didSet {
            if ["logged out", "not paired", "scan QR", "account mismatch"].contains(status?.whatsapp.status ?? ""),
               oldValue?.whatsapp.status != status?.whatsapp.status {
                invalidateGroups()
            }
        }
    }
    @Published var error: String?
    @Published var busy = false
    @Published var reachable = false
    @Published var installations = AgentDiscovery.discover()
    @Published var sessions: [CodingSession] = []
    @Published var sessionError: String?
    @Published var loadingSessions = false
    @Published var nextCursor: String?
    @Published var provider = "codex" {
        didSet {
            guard oldValue != provider else { return }
            sessionGeneration += 1
            sessionTask?.cancel()
            sessionTask = nil
            loadingSessions = false
            sessionError = nil
            sessions = sessionCache[provider]?.sessions ?? []
            nextCursor = sessionCache[provider]?.cursor
        }
    }
    @Published var recoveredGroups: [RecoveredGroups.Group] = []
    @Published var loadingGroups = false
    @Published var groupDiscoveryError: String?
    @Published var groupsDiscovered = false
    let client = BridgeClient()
    private var polling: Task<Void, Never>?
    private var refreshing = false
    private var groupDiscoveryAttempted = false
    private var groupGeneration = 0
    private let groupLoader: () async throws -> [RecoveredGroups.Group]
    private let sessionLoader: (String, String?) async throws -> SessionPage
    private let statusLoader: (String?) async throws -> BridgeStatus
    private var sessionCache: [String: SessionPage] = [:]
    private var sessionGeneration = 0
    private var sessionTask: Task<SessionPage, Error>?

    init(groupLoader: (() async throws -> [RecoveredGroups.Group])? = nil,
         sessionLoader: ((String, String?) async throws -> SessionPage)? = nil,
         statusLoader: ((String?) async throws -> BridgeStatus)? = nil) {
        let client = self.client
        self.groupLoader = groupLoader ?? {
            try JSONDecoder().decode(RecoveredGroups.self, from: await client.request("/api/group-recover")).groups
        }
        self.sessionLoader = sessionLoader ?? { provider, cursor in
            try await client.sessions(provider: provider, cursor: cursor)
        }
        self.statusLoader = statusLoader ?? { revision in
            try await client.status(catalogRevision: revision)
        }
    }

    private func invalidateGroups() {
        groupGeneration += 1
        recoveredGroups = []
        groupsDiscovered = false
        groupDiscoveryAttempted = false
        groupDiscoveryError = nil
    }
    var connected: Bool { reachable && status?.whatsapp.status == "connected" }

    func start() {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        do {
            var incoming = try await statusLoader(status?.masterSetup?.catalogRevision)
            if incoming.masterSetup?.catalogUnchanged == true {
                incoming.masterSetup?.platforms = status?.masterSetup?.platforms ?? []
            }
            status = incoming
            reachable = true
        }
        catch { reachable = false }
    }
    func perform(_ path: String, body: [String: Any]) async {
        guard !busy else { return }
        busy = true; error = nil; defer { busy = false }
        do { _ = try await client.request(path, body: body); await refresh() }
        catch { self.error = error.localizedDescription }
    }
    func command(_ text: String) async { await perform("/api/action", body: ["command": text]) }
    func preferences(background: Bool, awake: Bool) async {
        await perform("/api/preferences", body: ["backgroundEnabled": background, "keepAwake": awake])
    }
    // Navigation reuses this model's cache, including an empty result. Only an
    // explicit refresh/retry or group creation should fetch the catalogue again.
    // This is display data; the backend still validates membership on use.
    func recoverGroups(forceRefresh: Bool = false) async {
        guard connected, !loadingGroups else { return }
        guard forceRefresh || (!groupsDiscovered && !groupDiscoveryAttempted) else { return }
        let generation = groupGeneration
        loadingGroups = true; groupDiscoveryError = nil; groupDiscoveryAttempted = true
        defer { loadingGroups = false }
        do {
            let groups = try await groupLoader()
            guard generation == groupGeneration else { return }
            recoveredGroups = groups
            groupsDiscovered = true
        } catch {
            guard generation == groupGeneration else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled {
                groupDiscoveryAttempted = false
            } else {
                // Preserve a successful cached list on refresh failure. Don't
                // hammer WhatsApp each time the page is reopened after an error.
                groupDiscoveryError = error.localizedDescription
            }
        }
    }
    func toggle(_ provider: String) async {
        var enabled = status?.apps.filter(\.enabled).map(\.provider) ?? []
        if enabled.contains(provider) { enabled.removeAll { $0 == provider } } else { enabled.append(provider) }
        await perform("/api/apps", body: ["enabled": enabled])
    }
    func loadSessions(more: Bool = false) async {
        guard !loadingSessions else { return }
        guard !Task.isCancelled else { return }
        if more && nextCursor == nil { return }
        loadingSessions = true; sessionError = nil
        let requestedProvider = provider
        sessionGeneration += 1
        let generation = sessionGeneration
        let cursor = more ? nextCursor : nil
        let task = Task { try await sessionLoader(requestedProvider, cursor) }
        sessionTask = task
        defer {
            if generation == sessionGeneration {
                loadingSessions = false
                sessionTask = nil
            }
        }
        do {
            let page = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            try Task.checkCancellation()
            guard generation == sessionGeneration, requestedProvider == provider else { return }
            sessions = more ? sessions + page.sessions : page.sessions
            nextCursor = page.cursor
            sessionCache[requestedProvider] = SessionPage(sessions: sessions, cursor: nextCursor)
        } catch {
            guard generation == sessionGeneration, requestedProvider == provider else { return }
            if !Task.isCancelled && !(error is CancellationError) && (error as? URLError)?.code != .cancelled {
                sessionError = error.localizedDescription
            }
        }
    }
    func startService() async {
        guard !busy else { return }
        busy = true; error = nil; defer { busy = false }
        do { try await BackgroundService.start(installations: installations); await refresh() }
        catch { self.error = error.localizedDescription }
    }
}
