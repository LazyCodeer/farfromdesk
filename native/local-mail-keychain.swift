// Single long-lived Keychain broker. Its OS lock remains held until every
// synchronous Keychain operation has stopped, even if the parent disappears.
import Foundation
import Security
import LocalAuthentication
import Darwin

let service = "com.codecylabs.farfromdesk.local.email"
func die() -> Never { exit(1) }
#if MAIL_SYNTHETIC_TEST
guard CommandLine.arguments.count == 3, CommandLine.arguments[1].hasPrefix("/"), CommandLine.arguments[2].hasPrefix("/") else { die() }
var fixtureKeychain: SecKeychain?
guard SecKeychainOpen(CommandLine.arguments[2], &fixtureKeychain) == errSecSuccess, fixtureKeychain != nil else { die() }
#else
guard CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("/") else { die() }
#endif
let fd = open(CommandLine.arguments[1], O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
guard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else { die() }
defer { flock(fd, LOCK_UN); close(fd) }
func reply(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), data.count <= 16384 else { die() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
reply(["ready": true])
while let line = readLine() {
    guard line.utf8.count <= 16384,
          let data = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let action = request["action"], let slot = request["slot"],
          slot.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { reply(["ok": false]); continue }
    let context = LAContext()
    context.interactionNotAllowed = true
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                               kSecAttrService as String: service,
                               kSecAttrAccount as String: slot,
                               kSecUseAuthenticationContext as String: context]
    #if MAIL_SYNTHETIC_TEST
    if action == "write" { query[kSecUseKeychain as String] = fixtureKeychain! }
    else { query[kSecMatchSearchList as String] = [fixtureKeychain!] }
    #endif
    switch action {
    case "read":
        var item: CFTypeRef?
        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(read as CFDictionary, &item)
        if status == errSecItemNotFound { reply(["ok": true, "value": NSNull()]) }
        else if status == errSecSuccess, let bytes = item as? Data,
                let value = String(data: bytes, encoding: .utf8), value.utf8.count <= 4096 { reply(["ok": true, "value": value]) }
        else { reply(["ok": false]) }
    case "write":
        guard let value = request["value"], !value.isEmpty, value.utf8.count <= 4096,
              let bytes = value.data(using: .utf8) else { reply(["ok": false]); continue }
        var add = query
        add[kSecValueData as String] = bytes
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        reply(["ok": SecItemAdd(add as CFDictionary, nil) == errSecSuccess])
    case "remove":
        let status = SecItemDelete(query as CFDictionary)
        reply(["ok": status == errSecSuccess || status == errSecItemNotFound])
    default: reply(["ok": false])
    }
}
