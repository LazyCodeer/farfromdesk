import Foundation
import CoreGraphics
import Security

// macOS omits CGSSessionScreenIsLocked for an unlocked session. Absence is only
// accepted inside a positively identified active GUI session, never for a missing dictionary.
func evaluate(_ state: [String:Any]?, graphicAccess: Bool) -> String {
    guard graphicAccess else { return "NO_GRAPHIC_SESSION" }
    guard let state else { return "SESSION_UNAVAILABLE" }
    guard state[kCGSessionOnConsoleKey as String] as? Bool == true else { return "NOT_CONSOLE_SESSION" }
    guard state[kCGSessionLoginDoneKey as String] as? Bool == true else { return "LOGIN_UNCONFIRMED" }
    if let flag = state["CGSSessionScreenIsLocked"] {
        guard let number = flag as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() || CFGetTypeID(number) == CFNumberGetTypeID() else { return "LOCK_STATE_UNKNOWN" }
        return number.doubleValue == 0 ? "UNLOCKED" : "SESSION_LOCKED"
    }
    return "UNLOCKED"
}
if CommandLine.arguments.contains("--self-test") {
    let active:[String:Any] = [kCGSessionOnConsoleKey as String:true,kCGSessionLoginDoneKey as String:true]
    precondition(evaluate(active,graphicAccess:true) == "UNLOCKED")
    precondition(evaluate(active.merging(["CGSSessionScreenIsLocked":true]){$1},graphicAccess:true) == "SESSION_LOCKED")
    precondition(evaluate(active.merging(["CGSSessionScreenIsLocked":false]){$1},graphicAccess:true) == "UNLOCKED")
    precondition(evaluate(active.merging(["CGSSessionScreenIsLocked":1]){$1},graphicAccess:true) == "SESSION_LOCKED")
    precondition(evaluate(active.merging(["CGSSessionScreenIsLocked":"false"]){$1},graphicAccess:true) == "LOCK_STATE_UNKNOWN")
    precondition(evaluate(nil,graphicAccess:true) == "SESSION_UNAVAILABLE")
    precondition(evaluate(active,graphicAccess:false) == "NO_GRAPHIC_SESSION")
    precondition(evaluate([:],graphicAccess:true) == "NOT_CONSOLE_SESSION")
    precondition(evaluate([kCGSessionOnConsoleKey as String:true],graphicAccess:true) == "LOGIN_UNCONFIRMED")
    print("PASS: 9 session-state cases");exit(0)
}
var sessionID=SecuritySessionId(), attributes=SessionAttributeBits()
let status=SessionGetInfo(callerSecuritySession,&sessionID,&attributes)
let graphic=status == errSecSuccess && attributes.contains(.sessionHasGraphicAccess)
let reason=evaluate(CGSessionCopyCurrentDictionary() as? [String:Any],graphicAccess:graphic)
let data = try JSONSerialization.data(withJSONObject: ["unlocked": reason == "UNLOCKED", "reason": reason])
print(String(data:data,encoding:.utf8)!)
