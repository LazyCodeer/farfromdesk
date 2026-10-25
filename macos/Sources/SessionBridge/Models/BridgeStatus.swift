import Foundation

struct BridgeStatus: Decodable {
    struct Voice: Decodable { let ready: Bool; let local: Bool; let bundled: Bool }
    struct WhatsApp: Decodable { let status: String; let error: String?; let qr: String?; var phoneNumber: String? = nil }
    struct Agent: Decodable, Identifiable {
        var id: String { provider }
        let provider: String; let name: String; let enabled: Bool; let sessions: Int; let error: String?
    }
    struct Master: Decodable { var id: String? = nil; let name: String; let ready: Bool; let provider: String?; var executionMode: String? = nil }
    struct Preferences: Decodable { let backgroundEnabled: Bool; let keepAwake: Bool; let assertionActive: Bool; let error: String? }
    struct Destination: Decodable { let jid: String?; let kind: String; let name: String }
    struct Selected: Decodable { let name: String; let provider: String; let id: String? }
    struct Binding: Decodable, Identifiable {
        let id: String; let alias: String; let provider: String; let native_id: String; let enabled: Int
        let name: String?; let running: Bool?
    }
    struct Job: Decodable, Identifiable {
        let id: String; let binding_id: String; let status: String; let created_at: Double; let error: String?
        var preview: String? = nil
        var updated_at: Double? = nil
        var canClose: Bool? = nil
    }
    struct Approval: Decodable, Identifiable {
        var id: String { code }
        let code: String; let alias: String; let question: String; let kind: String
    }
    let whatsapp: WhatsApp
    let apps: [Agent]
    let master: Master?
    let selected: [Selected]?
    let bindings: [Binding]
    let jobs: [Job]
    let approvals: [Approval]
    let preferences: Preferences?
    let destination: Destination?
    var masterSetup: MasterSetup?
    var voice: Voice? = nil
    struct RequestCleanup: Decodable { let enabled: Bool; let afterHours: Int }
    var requestCleanup: RequestCleanup? = nil
    var pendingJobs: [Job]? = nil
    var unfinishedRequests: [Job] {
        pendingJobs ?? jobs.filter { ["queued", "dispatched", "submitted", "uncertain", "failed"].contains($0.status) }
    }
}

struct MasterSetup: Decodable {
    var attempts: [Operation]? = nil
    struct Platform: Decodable, Identifiable {
        struct DesktopSession: Decodable, Identifiable { let id: String; let name: String; let available: Bool; var desktopId: String? = nil; var cwd: String? = nil; var status: String? = nil; var updatedAt: Double? = nil }
        var id: String { provider + ":" + (executionMode ?? "cli") }
        let provider: String; let label: String; let available: Bool; let reason: String?
        var executionMode: String? = nil
        var discoveryError: String? = nil
        var sessions: [DesktopSession]? = nil
    }
    struct Operation: Decodable { let id: String; let status: String; let error: String?; let nativeId: String?; var bindingId: String? = nil; let cwd: String?; var needsTrust: Bool? = nil; var provider: String? = nil; var executionMode: String? = nil; var desktopParentId: String? = nil }
    var catalogRevision: String? = nil
    var catalogUnchanged: Bool? = nil
    var platforms: [Platform]; let operation: Operation?; let prompt: String
}
struct RecoveredGroups: Decodable {
    struct Group: Decodable, Identifiable { let id: String; let name: String }
    let groups: [Group]
}

struct CodingSession: Decodable, Identifiable {
    let id: String; let name: String; let cwd: String; let provider: String; let status: String
    var executionMode: String? = nil; var available: Bool? = nil; var desktopId: String? = nil; var updatedAt: Double? = nil
}
struct SessionPage: Decodable { let sessions: [CodingSession]; let cursor: String? }
struct APIError: Decodable { let error: String }

enum BridgeFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

enum NavigationPage: String, CaseIterable, Identifiable {
    case whatsapp = "Home", activity = "Activity", settings = "Settings"
    var id: Self { self }
    var symbol: String {
        switch self {
        case .whatsapp: "house"
        case .activity: "clock.arrow.circlepath"
        case .settings: "gearshape"
        }
    }
}
