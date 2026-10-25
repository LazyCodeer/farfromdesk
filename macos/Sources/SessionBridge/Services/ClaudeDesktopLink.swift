import Foundation

// Claude's native OS continue entry point. Never pass prompts, paths, or an arbitrary URL.
enum ClaudeDesktopLink {
    static func resume(_ desktopID: String?) -> URL? {
        guard let id = desktopID, id.hasPrefix("local_"),
              UUID(uuidString: String(id.dropFirst(6))) != nil else { return nil }
        var components = URLComponents()
        components.scheme = "claude"
        components.host = "code"
        components.path = "/continue"
        components.queryItems = [URLQueryItem(name: "session", value: id)]
        return components.url
    }
}
