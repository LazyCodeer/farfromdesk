import Testing
import Foundation
@testable import SessionBridge

@MainActor
struct SessionLoadingTests {
    private final class Loader {
        struct Call {
            let provider: String
            let cursor: String?
            let completion: CheckedContinuation<SessionPage, Error>
        }
        var calls: [Call] = []
        private var waiter: (Int, CheckedContinuation<Void, Never>)?
        func load(_ provider: String, _ cursor: String?) async throws -> SessionPage {
            try await withCheckedThrowingContinuation { completion in
                calls.append(Call(provider: provider, cursor: cursor, completion: completion))
                if let waiter, calls.count >= waiter.0 {
                    self.waiter = nil
                    waiter.1.resume()
                }
            }
        }
        func started(_ count: Int) async {
            if calls.count >= count { return }
            await withCheckedContinuation { waiter = (count, $0) }
        }
        func succeed(_ index: Int, _ id: String, cursor: String? = nil) {
            calls[index].completion.resume(returning: SessionPage(sessions: [CodingSession(id: id, name: id, cwd: "/fixture", provider: calls[index].provider, status: "saved")], cursor: cursor))
        }
        func fail(_ index: Int, _ error: Error = BridgeFailure.message("Fixture failure")) {
            calls[index].completion.resume(throwing: error)
        }
    }

    @Test func providerSwitchLoadsImmediatelyAndStaleSuccessCannotOverwrite() async {
        let loader = Loader()
        let model = BridgeModel(sessionLoader: loader.load)
        let old = Task { await model.loadSessions() }
        await loader.started(1)
        model.provider = "claude"
        let current = Task { await model.loadSessions() }
        await loader.started(2)
        #expect(loader.calls.map(\.provider) == ["codex", "claude"])
        loader.succeed(0, "old")
        await old.value
        #expect(model.loadingSessions)
        #expect(model.sessions.isEmpty)
        loader.succeed(1, "current")
        await current.value
        #expect(model.sessions.map(\.id) == ["current"])
        #expect(!model.loadingSessions)
    }

    @Test func staleErrorAndSwitchBackCannotAffectNewGeneration() async {
        let loader = Loader()
        let model = BridgeModel(sessionLoader: loader.load)
        let old = Task { await model.loadSessions() }
        await loader.started(1)
        model.provider = "claude"
        model.provider = "codex"
        let current = Task { await model.loadSessions() }
        await loader.started(2)
        loader.succeed(1, "new")
        await current.value
        loader.fail(0)
        await old.value
        #expect(model.sessions.map(\.id) == ["new"])
        #expect(model.sessionError == nil)
        #expect(!model.loadingSessions)
    }

    @Test func concurrentSameProviderLoadIsSuppressedAndCancellationAllowsRetry() async {
        let loader = Loader()
        let model = BridgeModel(sessionLoader: loader.load)
        let first = Task { await model.loadSessions() }
        await loader.started(1)
        await model.loadSessions()
        #expect(loader.calls.count == 1)
        first.cancel()
        // A transport that returns after cancellation must not publish its result.
        loader.succeed(0, "cancelled")
        await first.value
        #expect(!model.loadingSessions)
        #expect(model.sessions.isEmpty)
        #expect(model.sessionError == nil)
        let retry = Task { await model.loadSessions() }
        await loader.started(2)
        loader.succeed(1, "retry")
        await retry.value
        #expect(model.sessions.map(\.id) == ["retry"])
    }

    @Test func refreshAndPaginationFailureKeepSameProviderRowsAndCursor() async {
        let loader = Loader()
        let model = BridgeModel(sessionLoader: loader.load)
        let initial = Task { await model.loadSessions() }
        await loader.started(1)
        loader.succeed(0, "first", cursor: "next")
        await initial.value
        let refresh = Task { await model.loadSessions() }
        await loader.started(2)
        loader.fail(1)
        await refresh.value
        #expect(model.sessions.map(\.id) == ["first"])
        #expect(model.nextCursor == "next")
        #expect(model.sessionError != nil)
        let more = Task { await model.loadSessions(more: true) }
        await loader.started(3)
        #expect(loader.calls[2].cursor == "next")
        loader.fail(2, URLError(.cancelled))
        await more.value
        #expect(model.sessions.map(\.id) == ["first"])
        #expect(model.nextCursor == "next")
        #expect(model.sessionError == nil)
        let retry = Task { await model.loadSessions(more: true) }
        await loader.started(4)
        loader.succeed(3, "second")
        await retry.value
        #expect(model.sessions.map(\.id) == ["first", "second"])
        await model.loadSessions(more: true)
        #expect(loader.calls.count == 4)
        model.provider = "claude"
        #expect(model.sessions.isEmpty)
        #expect(model.nextCursor == nil)
        model.provider = "codex"
        #expect(model.sessions.map(\.id) == ["first", "second"])
    }

    private func status(revision: String?, unchanged: Bool = false, provider: String? = nil, whatsapp: String = "connected") throws -> BridgeStatus {
        var setup: [String: Any] = ["platforms": provider.map { [["provider": $0, "label": $0, "available": true]] } ?? [], "prompt": "Fixture"]
        setup["catalogRevision"] = revision
        setup["catalogUnchanged"] = unchanged
        let data: [String: Any] = ["whatsapp": ["status": whatsapp], "apps": [], "bindings": [], "jobs": [], "approvals": [], "masterSetup": setup]
        return try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: data))
    }

    @Test func unchangedStatusPreservesCatalogButAppliesFreshStateAndNewRevisionReplacesIt() async throws {
        let full = try status(revision: "one", provider: "codex")
        let unchanged = try status(revision: "one", unchanged: true, whatsapp: "reconnecting")
        let replacement = try status(revision: "two", provider: "claude")
        var calls: [String?] = []
        let model = BridgeModel(statusLoader: { revision in
            calls.append(revision)
            return [full, unchanged, replacement][calls.count - 1]
        })
        await model.refresh()
        await model.refresh()
        #expect(model.status?.masterSetup?.platforms.map(\.provider) == ["codex"])
        #expect(model.status?.whatsapp.status == "reconnecting")
        await model.refresh()
        #expect(calls.count == 3)
        #expect(calls[0] == nil)
        #expect(calls[1] == "one")
        #expect(calls[2] == "one")
        #expect(model.status?.masterSetup?.platforms.map(\.provider) == ["claude"])
        #expect(model.status?.masterSetup?.catalogRevision == "two")
    }

    @Test func statusFailurePreservesCatalogAndAllowsNextRefresh() async throws {
        let previous = try status(revision: "one", provider: "codex")
        let legacy = try status(revision: nil, provider: "claude")
        var calls = 0
        let model = BridgeModel(statusLoader: { _ in
            calls += 1
            if calls == 1 { throw URLError(.timedOut) }
            return legacy
        })
        model.status = previous
        await model.refresh()
        #expect(!model.reachable)
        #expect(model.status?.masterSetup?.platforms.map(\.provider) == ["codex"])
        await model.refresh()
        #expect(model.reachable)
        #expect(model.status?.masterSetup?.platforms.map(\.provider) == ["claude"])
        #expect(model.status?.masterSetup?.catalogRevision == nil)
    }
}
