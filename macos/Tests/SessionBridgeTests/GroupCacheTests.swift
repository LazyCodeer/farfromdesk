import Testing
import Foundation
@testable import SessionBridge

@MainActor
struct GroupCacheTests {
    private func status(_ value: String) throws -> BridgeStatus {
        let data = try JSONSerialization.data(withJSONObject: ["whatsapp": ["status": value], "apps": [], "bindings": [], "jobs": [], "approvals": []])
        return try JSONDecoder().decode(BridgeStatus.self, from: data)
    }
    private func connected(_ model: BridgeModel) throws {
        model.status = try status("connected")
        model.reachable = true
    }

    @Test func revisitingReusesGroupsAndManualRefreshReplacesThem() async throws {
        var calls = 0
        let model = BridgeModel(groupLoader: {
            calls += 1
            return [.init(id: "sample", name: "Revision \(calls)")]
        })
        try connected(model)
        await model.recoverGroups()
        model.page = .activity
        model.page = .whatsapp
        await model.recoverGroups()
        await model.recoverGroups()
        #expect(calls == 1)
        #expect(model.recoveredGroups.first?.name == "Revision 1")
        await model.recoverGroups(forceRefresh: true)
        #expect(calls == 2)
        #expect(model.recoveredGroups.first?.name == "Revision 2")
    }

    @Test func emptyResultIsCached() async throws {
        var calls = 0
        let model = BridgeModel(groupLoader: { calls += 1; return [] })
        try connected(model)
        await model.recoverGroups()
        await model.recoverGroups()
        #expect(calls == 1)
        #expect(model.groupsDiscovered)
        #expect(model.recoveredGroups.isEmpty)
    }

    @Test func failureDoesNotRetryOnNavigationAndRefreshKeepsPriorResults() async throws {
        var calls = 0
        let model = BridgeModel(groupLoader: {
            calls += 1
            if calls != 2 { throw BridgeFailure.message("Fixture unavailable") }
            return [.init(id: "sample", name: "Saved group")]
        })
        try connected(model)
        await model.recoverGroups()
        await model.recoverGroups()
        #expect(calls == 1)
        #expect(model.groupDiscoveryError != nil)
        await model.recoverGroups(forceRefresh: true)
        #expect(model.groupsDiscovered)
        await model.recoverGroups(forceRefresh: true)
        await model.recoverGroups()
        #expect(calls == 3)
        #expect(model.recoveredGroups.first?.name == "Saved group")
        #expect(model.groupDiscoveryError != nil)
    }

    @Test func concurrentFetchIsCoalescedAndLogoutDiscardsItsResult() async throws {
        var calls = 0
        var continuation: CheckedContinuation<[RecoveredGroups.Group], Never>?
        let model = BridgeModel(groupLoader: {
            calls += 1
            return await withCheckedContinuation { continuation = $0 }
        })
        try connected(model)
        let pending = Task { await model.recoverGroups() }
        for _ in 0..<100 where continuation == nil { await Task.yield() }
        let completion = try #require(continuation)
        await model.recoverGroups(forceRefresh: true)
        #expect(calls == 1)
        model.status = try status("logged out")
        completion.resume(returning: [.init(id: "old", name: "Old account")])
        await pending.value
        #expect(model.recoveredGroups.isEmpty)
        #expect(!model.groupsDiscovered)
        #expect(!model.loadingGroups)
    }

    @Test func reconnectRetainsCacheButRePairingInvalidatesIt() async throws {
        var calls = 0
        let model = BridgeModel(groupLoader: { calls += 1; return [.init(id: "sample", name: "Group")] })
        try connected(model)
        await model.recoverGroups()
        model.status = try status("reconnecting")
        await model.recoverGroups()
        try connected(model)
        await model.recoverGroups()
        #expect(calls == 1)
        model.status = try status("scan QR")
        #expect(model.recoveredGroups.isEmpty)
        try connected(model)
        await model.recoverGroups()
        #expect(calls == 2)
    }
}
