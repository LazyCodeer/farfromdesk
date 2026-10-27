import AppKit
import ApplicationServices
import CryptoKit

// One bounded JSON operation per process. No Apple Events, screenshots, CDP or keystroke fallback.
struct Failure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw Failure(code: code) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func str(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }
func elements(_ e: AXUIElement, _ name: String) -> [AXUIElement] { (attr(e, name) as? [AXUIElement]) ?? [] }
// Required window discovery must never convert denied, unsupported or timed-out AX queries to [].
func requiredWindows(_ root: AXUIElement, copy: (AXUIElement, CFString, UnsafeMutablePointer<CFTypeRef?>) -> AXError = AXUIElementCopyAttributeValue) throws -> [AXUIElement] {
    var value: CFTypeRef?
    let result = copy(root, "AXWindows" as CFString, &value)
    switch result {
    case .success: break
    case .apiDisabled: try fail("ACCESSIBILITY_PERMISSION_REQUIRED")
    case .cannotComplete: try fail("AX_APP_UNRESPONSIVE")
    case .attributeUnsupported: try fail("AX_WINDOWS_UNSUPPORTED")
    case .noValue: try fail("AX_WINDOWS_NO_VALUE")
    case .invalidUIElement: try fail("APP_STALE")
    default: try fail("AX_WINDOW_QUERY_FAILED")
    }
    guard let value = value, CFGetTypeID(value) == CFArrayGetTypeID(), let windows = value as? [AXUIElement] else { try fail("AX_WINDOWS_INVALID_RESPONSE") }
    return windows
}
func frame(_ e: AXUIElement) -> CGRect? {
    guard let p = attr(e, "AXPosition"), let s = attr(e, "AXSize"), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point), AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func rect(_ r: CGRect?) -> [Double] { guard let r = r else { return [] }; return [r.minX,r.minY,r.width,r.height].map { Double($0.rounded()) } }
func hash(_ value: Any) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
func actions(_ e: AXUIElement) -> [String] { var a: CFArray?; AXUIElementCopyActionNames(e, &a); return (a as? [String]) ?? [] }
func blockedApp(_ id: String) -> Bool {
    ["com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.keychainaccess", "com.apple.Passwords"].contains(id) || id.lowercased().contains("1password") || id.lowercased().contains("bitwarden")
}
func application(_ q: [String: Any]) throws -> NSRunningApplication {
    guard let pid = q["pid"] as? Int32, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
          app.bundleIdentifier == q["bundleId"] as? String,
          app.launchDate?.timeIntervalSince1970 == q["launched"] as? Double else { try fail("APP_STALE") }
    guard !blockedApp(app.bundleIdentifier ?? "") else { try fail("SENSITIVE_TARGET") }
    return app
}
func windowRecord(_ w: AXUIElement, _ index: Int) -> [String: Any] {
    ["index":index, "title":String(str(w,"AXTitle").prefix(240)), "identifier":str(w,"AXIdentifier"), "frame":rect(frame(w))]
}
func windowSummary(_ w:AXUIElement,_ index:Int,_ app:NSRunningApplication)->[String:Any] {
    var result=windowRecord(w,index);result["windowHash"]=hash(result)
    result["nativeWindowId"]=windowIdentity(w,app)
    result["role"]=str(w,"AXRole");result["subrole"]=str(w,"AXSubrole")
    return result
}
final class HeldWindow {
    let element:AXUIElement, pid:pid_t, launched:Double
    var touched=ProcessInfo.processInfo.systemUptime
    init(_ e:AXUIElement,_ owner:pid_t,_ launch:Double){element=e;pid=owner;launched=launch}
}
struct HeldControl {let element:AXUIElement;let fingerprint:String}
struct HeldSnapshot {let window:AXUIElement;let title:String;let controls:[String:HeldControl];let created:TimeInterval}
var heldWindows=[String:HeldWindow](),heldSnapshots=[String:HeldSnapshot]()
func windowIdentity(_ w:AXUIElement,_ app:NSRunningApplication)->String {nativeWindowIdentity(w,app.processIdentifier,app.launchDate!.timeIntervalSince1970)}
func nativeWindowIdentity(_ w:AXUIElement,_ pid:pid_t,_ launched:Double)->String {
    let now=ProcessInfo.processInfo.systemUptime
    heldWindows=heldWindows.filter{now-$0.value.touched<600}
    if let old=heldWindows.first(where:{$0.value.pid==pid && $0.value.launched==launched && CFEqual($0.value.element,w)}){old.value.touched=now;return old.key}
    if heldWindows.count>=500,let oldest=heldWindows.min(by:{$0.value.touched<$1.value.touched}){heldWindows.removeValue(forKey:oldest.key)}
    let id=UUID().uuidString;heldWindows[id]=HeldWindow(w,pid,launched);return id
}
func resolveWindowIdentity(_ id:String,_ pid:pid_t,_ launched:Double,_ windows:[AXUIElement])throws->AXUIElement {
    guard let held=heldWindows[id],held.pid==pid,held.launched==launched else {try fail("WINDOW_STALE")}
    guard windows.contains(where:{CFEqual($0,held.element)}) else {heldWindows.removeValue(forKey:id);try fail("WINDOW_STALE")}
    held.touched=ProcessInfo.processInfo.systemUptime;return held.element
}
func window(_ q:[String:Any],_ app:NSRunningApplication)throws->AXUIElement {
    guard let id=q["nativeWindowId"] as? String,let launched=app.launchDate?.timeIntervalSince1970 else {try fail("WINDOW_STALE")}
    let root=AXUIElementCreateApplication(app.processIdentifier);AXUIElementSetMessagingTimeout(root,2)
    return try resolveWindowIdentity(id,app.processIdentifier,launched,requiredWindows(root))
}
func contextHash(_ e:AXUIElement,_ w:AXUIElement)->String? {
    var node=e,context=[[String]]()
    for _ in 0..<24 {
        if CFEqual(node,w){context.append([str(w,"AXTitle")]);return hash(context)}
        context.append([str(node,"AXRole"),str(node,"AXIdentifier"),str(node,"AXTitle"),str(node,"AXDescription")])
        guard let parent=attr(node,"AXParent"),CFGetTypeID(parent)==AXUIElementGetTypeID() else {return nil}
        node=unsafeBitCast(parent,to:AXUIElement.self)
    }
    return nil
}
func controlFingerprint(_ e:AXUIElement,_ w:AXUIElement)->String? {
    guard let context=contextHash(e,w) else {return nil}
    var row=record(e,[]);row.removeValue(forKey:"frame");row.removeValue(forKey:"path");row["context"]=context;return hash(row)
}
func sensitive(_ e: AXUIElement) -> Bool {
    let role = str(e,"AXRole"), sub = str(e,"AXSubrole")
    if sub == "AXSecureTextField" || role == "AXSheet" || sub == "AXDialog" || sub == "AXSystemDialog" { return true }
    let label = [str(e,"AXTitle"),str(e,"AXDescription"),str(e,"AXHelp")].joined(separator:" ").lowercased()
    return ["password","passcode","verification code","credit card","api key","secret key","seed phrase"].contains { label.contains($0) }
}
func record(_ e: AXUIElement, _ path: [Int]) -> [String: Any] {
    let role = str(e,"AXRole"), secure = sensitive(e)
    let value = secure ? "" : String(str(e,"AXValue").prefix(500))
    return ["path":path,"role":role,"label":secure ? "Protected control" : String([str(e,"AXTitle"),str(e,"AXDescription")].filter{ !$0.isEmpty }.joined(separator:" ").prefix(300)),"value":value,"frame":rect(frame(e)),"enabled":(attr(e,"AXEnabled") as? Bool) ?? true,"protected":secure,"actions":secure ? [] : actions(e)]
}
func children(_ e: AXUIElement) -> [AXUIElement] { elements(e,"AXChildren") }
func snapshot(_ w: AXUIElement) -> [[String: Any]] {
    let bounds = frame(w) ?? .zero
    var rows = [[String: Any]](), visited = 0
    func visit(_ e: AXUIElement, _ path: [Int], _ depth: Int) {
        guard depth <= 18, visited < 1200, rows.count < 300 else { return }; visited += 1
        if (attr(e,"AXHidden") as? Bool) == true { return }
        if let r = frame(e), !r.isEmpty, !r.intersects(bounds) { return }
        let row = record(e,path)
        if sensitive(e) { rows.append(row); return }
        if frame(e) != nil && (!str(e,"AXTitle").isEmpty || !str(e,"AXDescription").isEmpty || !str(e,"AXValue").isEmpty || !actions(e).isEmpty) { rows.append(row) }
        for (i,c) in children(e).prefix(250).enumerated() { visit(c,path+[i],depth+1) }
    }
    visit(w,[],0); return rows
}
func target(_ w: AXUIElement, _ path: [Int]) throws -> AXUIElement {
    var e = w
    for i in path { let c = children(e); guard i >= 0, i < c.count else { try fail("CONTROL_STALE") }; e=c[i]; if sensitive(e) { try fail("SENSITIVE_TARGET") } }
    return e
}
import Foundation
import ApplicationServices

struct ActivationFailure: Error { let code: String }
// One activation request; bounded observation. Never repeats a raise or steals focus back.
func settleActivation(activate: () -> Bool, isFrontmost: () -> Bool, raise: (() -> AXError)?, isFocused: () -> Bool,
                      now: () -> TimeInterval, pump: () -> Void, budget: TimeInterval = 2) throws {
    let deadline = now() + budget
    guard activate() else { throw ActivationFailure(code:"APP_ACTIVATION_REFUSED") }
    while !isFrontmost() {
        guard now() < deadline else { throw ActivationFailure(code:"APP_ACTIVATION_TIMEOUT") }
        pump()
    }
    if let raise = raise {
        let result = raise()
        if result == .apiDisabled { throw ActivationFailure(code:"ACCESSIBILITY_PERMISSION_REQUIRED") }
        if result == .invalidUIElement { throw ActivationFailure(code:"WINDOW_STALE") }
        if result != .success && !isFocused() {
            throw ActivationFailure(code: result == .cannotComplete ? "AX_APP_UNRESPONSIVE" : "WINDOW_RAISE_REFUSED")
        }
    }
    while !isFocused() {
        guard isFrontmost() else { throw ActivationFailure(code:"TARGET_NOT_FRONTMOST") }
        guard now() < deadline else { throw ActivationFailure(code:"WINDOW_FOCUS_TIMEOUT") }
        pump()
    }
    guard isFrontmost() else { throw ActivationFailure(code:"TARGET_NOT_FRONTMOST") }
}

import ScreenCaptureKit

@available(macOS 14.0, *)
func captureSelectedWindow(_ q: [String:Any], _ selected: AXUIElement, _ app: NSRunningApplication, preflight: () -> Bool = CGPreflightScreenCaptureAccess) throws -> [String:Any] {
    guard preflight() else { try fail("SCREEN_RECORDING_PERMISSION_REQUIRED") }
    guard !sensitive(selected), !snapshot(selected).contains(where: { ($0["protected"] as? Bool) == true }) else { try fail("SENSITIVE_TARGET") }
    guard let expected=frame(selected), !expected.isEmpty else { try fail("WINDOW_UNAVAILABLE") }
    let expectedTitle = str(selected,"AXTitle")
    let lock=NSLock()
    var response: [String:Any]?
    var failure: String?
    func finish(_ value:[String:Any]?, _ error:String?) { lock.lock();response=value;failure=error;lock.unlock() }
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
            let matches = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && rect($0.frame) == rect(expected) && ($0.title ?? "") == expectedTitle }
            guard matches.count == 1 else { finish(nil,"CAPTURE_TARGET_AMBIGUOUS");return }
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
                  rect(frame(selected)) == rect(expected), str(selected,"AXTitle") == expectedTitle else { finish(nil,"WINDOW_STALE");return }
            let filter=SCContentFilter(desktopIndependentWindow:matches[0]), config=SCStreamConfiguration()
            let scale=min(2.0,3072.0/max(expected.width,expected.height))
            config.width=max(1,Int(expected.width*scale));config.height=max(1,Int(expected.height*scale));config.showsCursor=false
            let image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
            guard !snapshot(selected).contains(where: { ($0["protected"] as? Bool) == true }) else { finish(nil,"SENSITIVE_TARGET");return }
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
                  rect(frame(selected)) == rect(expected), str(selected,"AXTitle") == expectedTitle else { finish(nil,"WINDOW_STALE");return }
            guard let png=NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:]), png.count<=8*1024*1024 else { finish(nil,"SCREENSHOT_TOO_LARGE");return }
            finish(["pngBase64":png.base64EncodedString(),"frame":rect(expected),"width":image.width,"height":image.height,"captured":true,"delivery":"not prepared"],nil)
        } catch { finish(nil,"SCREENSHOT_FAILED") }
    }
    let deadline=ProcessInfo.processInfo.systemUptime+8
    while ProcessInfo.processInfo.systemUptime<deadline {
        lock.lock();let value=response, code=failure;lock.unlock()
        if let value=value { return value }
        if let code=code { try fail(code) }
        RunLoop.current.run(until:Date(timeIntervalSinceNow:0.02))
    }
    try fail("SCREENSHOT_TIMEOUT")
}

// Compiled into the Accessibility app helper. Vendor code keeps its original signature.
var desktopProcess: Process?
var desktopLiveness: Pipe?
var desktopDirectory: URL?
func startDesktopDriver() throws -> [String:Any] {
    if let p=desktopProcess,p.isRunning,let dir=desktopDirectory {
        return ["socket":dir.appendingPathComponent("driver.sock").path,"directory":dir.path]
    }
    guard let executable=Bundle.main.executableURL else {try fail("DESKTOP_DRIVER_MISSING")}
    let native=executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let binary=native.appendingPathComponent("cua-driver/cua-driver")
    guard let bytes=try? Data(contentsOf:binary) else {try fail("DESKTOP_DRIVER_MISSING")}
    let digest=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()
    guard digest=="92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f" else {try fail("DESKTOP_DRIVER_HASH_MISMATCH")}
    let dir=URL(fileURLWithPath:"/tmp/ffd-cua-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
    let p=Process(),pipe=Pipe(),socket=dir.appendingPathComponent("driver.sock")
    p.executableURL=binary
    p.arguments=["serve","--embedded","--socket",socket.path,"--pid-file",dir.appendingPathComponent("driver.pid").path,"--permission-mode","standard","--no-overlay"]
    var env=ProcessInfo.processInfo.environment.filter{!$0.key.hasPrefix("CUA_DRIVER_")}
    env["CUA_DRIVER_EMBEDDED"]="1";env["CUA_DRIVER_HOST_BUNDLE_ID"]=Bundle.main.bundleIdentifier
    env["CUA_DRIVER_PARENT_LIVENESS_STDIN"]="1";env["CUA_DRIVER_RS_TELEMETRY_ENABLED"]="0";env["CUA_DRIVER_RS_UPDATE_CHECK"]="0"
    p.environment=env;p.standardInput=pipe;p.standardOutput=FileHandle.nullDevice;p.standardError=FileHandle.nullDevice
    p.terminationHandler={_ in try? FileManager.default.removeItem(at:dir)}
    try p.run();desktopProcess=p;desktopLiveness=pipe;desktopDirectory=dir
    let deadline=ProcessInfo.processInfo.systemUptime+5
    while !FileManager.default.fileExists(atPath:socket.path) {
        guard p.isRunning,ProcessInfo.processInfo.systemUptime<deadline else {
            try? pipe.fileHandleForWriting.close();p.terminate();try fail("DESKTOP_DRIVER_FAILED")
        }
        Thread.sleep(forTimeInterval:0.02)
    }
    return ["socket":socket.path,"directory":dir.path]
}

func run(_ q: [String: Any]) throws -> [String: Any] {
    let action = q["action"] as? String ?? ""
    if action == "desktopDriverStart" { return try startDesktopDriver() }
    if action == "requestScreenRecording" {
        _ = CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        return ["captureTrusted":CGPreflightScreenCaptureAccess()]
    }
    if action == "status" || action == "requestPermission" {
        let trusted: Bool
        if action == "requestPermission" {
            trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
            NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        } else { trusted = AXIsProcessTrusted() }
        return ["trusted":trusted,"helperPath":Bundle.main.bundlePath,"screenRecordingRequired":false,"captureSupported":ProcessInfo.processInfo.operatingSystemVersion.majorVersion>=14,"captureTrusted":CGPreflightScreenCaptureAccess()]
    }
    if action == "discover" {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated && $0.bundleIdentifier != nil && $0.launchDate != nil && !blockedApp($0.bundleIdentifier!) }
        return ["apps":apps.map { ["pid":$0.processIdentifier,"bundleId":$0.bundleIdentifier!,"name":$0.localizedName ?? "App","launched":$0.launchDate!.timeIntervalSince1970] as [String:Any] }]
    }
    guard AXIsProcessTrusted() else { try fail("ACCESSIBILITY_PERMISSION_REQUIRED") }
    let app = try application(q), root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    if action == "activate" {
        do { try settleActivation(activate:{if app.isHidden && !app.unhide(){return false};return app.activate(options:[])},isFrontmost:{NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier},raise:nil,isFocused:{NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier},now:{ProcessInfo.processInfo.systemUptime},pump:{RunLoop.current.run(until:Date(timeIntervalSinceNow:0.02))}) }
        catch let error as ActivationFailure { try fail(error.code) }
        return ["activated":true,"windows":try requiredWindows(root).prefix(40).enumerated().map { i,w in windowSummary(w,i,app) },"windowQuery":"success","appActive":app.isActive,"appHidden":app.isHidden]
    }
    if action == "windows" {
        let windows = try requiredWindows(root)
        return ["windows":windows.prefix(40).enumerated().map { i,w in return windowSummary(w,i,app) },
                "windowQuery":"success", "appActive":app.isActive, "appHidden":app.isHidden]
    }
    let w = try window(q,app)
    if action == "select" {
        do { try settleActivation(activate:{if app.isHidden && !app.unhide(){return false};return app.activate(options:[])},isFrontmost:{NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier},raise:{AXUIElementPerformAction(w,"AXRaise" as CFString)},isFocused:{guard let focused=attr(root,"AXFocusedWindow") else {return false};return CFEqual(focused,w)},now:{ProcessInfo.processInfo.systemUptime},pump:{RunLoop.current.run(until:Date(timeIntervalSinceNow:0.02))}) }
        catch let error as ActivationFailure { try fail(error.code) }
        let current=try requiredWindows(root)
        guard let index=current.firstIndex(where:{CFEqual($0,w)}) else {try fail("WINDOW_STALE")}
        return ["selected":true,"focused":true,"window":windowSummary(w,index,app),"pageRead":false]
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { try fail("TARGET_NOT_FRONTMOST") }
    guard let focused = attr(root,"AXFocusedWindow"), CFEqual(focused,w) else { try fail("WINDOW_NOT_FOCUSED") }
    if action == "capture" {
        if #available(macOS 14.0, *) { return try captureSelectedWindow(q,w,app) }
        try fail("SCREENSHOT_UNSUPPORTED_OS")
    }
    let rows = action == "read" ? snapshot(w) : []
    if action == "read" {
        let now=ProcessInfo.processInfo.systemUptime
        heldSnapshots=heldSnapshots.filter{now-$0.value.created<120}
        var controls=[String:HeldControl](),output=[[String:Any]]()
        for row in rows {
            guard let path=row["path"] as? [Int],let e=try? target(w,path),let fingerprint=controlFingerprint(e,w) else {
                var evidence=row;evidence["enabled"]=false;evidence["actions"]=[String]();evidence["controlHash"]=hash(row);output.append(evidence);continue
            }
            let id=UUID().uuidString;controls[id]=HeldControl(element:e,fingerprint:fingerprint)
            var r=row;r["nativeControlId"]=id;r["controlHash"]=fingerprint;output.append(r)
        }
        if heldSnapshots.count>=100 {heldSnapshots.removeAll()}
        let revision=hash(["revision":UUID().uuidString]);heldSnapshots[revision]=HeldSnapshot(window:w,title:str(w,"AXTitle"),controls:controls,created:now)
        return ["controls":output,"snapshotHash":revision,"bounded":true,"returnedControls":output.count,"limitReached":rows.count>=300,"evidence":"Bounded Accessibility controls; omitted controls may still exist"]
    }
    guard ["click","type","scroll"].contains(action) else { try fail("UNSUPPORTED_ACTION") }
    guard let revision=q["snapshotHash"] as? String,let saved=heldSnapshots.removeValue(forKey:revision),ProcessInfo.processInfo.systemUptime-saved.created<120,
          CFEqual(saved.window,w),saved.title==str(w,"AXTitle"),let id=q["nativeControlId"] as? String,let control=saved.controls[id],control.fingerprint==q["controlHash"] as? String,
          controlFingerprint(control.element,w)==control.fingerprint else {try fail("CONTROL_STALE")}
    let e=control.element,row=record(e,[])
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier==app.processIdentifier,let focus=attr(root,"AXFocusedWindow"),CFEqual(focus,w) else {try fail("TARGET_NOT_FRONTMOST")}
    guard !sensitive(e), (row["enabled"] as? Bool) != false, let r=frame(e), !r.isEmpty else { try fail("CONTROL_UNAVAILABLE") }
    let closingRequested=action=="click" && str(e,"AXSubrole")=="AXCloseButton"
    let label = (row["label"] as? String ?? "").lowercased()
    let forbidden = "(?i)\\b(send|submit|buy|purchase|pay|checkout|agree|accept|allow|approve|trust|install|delete|erase|unlock|sign in|log in|log out|disconnect)\\b"
    guard label.range(of:forbidden,options:.regularExpression) == nil else { try fail("SENSITIVE_ACTION") }
    var result: AXError = .failure
    if action == "click" {
        guard actions(e).contains("AXPress") else { try fail("ACTION_UNSUPPORTED_BY_CONTROL") }
        result = AXUIElementPerformAction(e,"AXPress" as CFString)
    } else if action == "type" {
        guard ["AXTextField","AXTextArea","AXSearchField"].contains(str(e,"AXRole")), let text=q["text"] as? String, text.count <= 2000,
              text.rangeOfCharacter(from:.controlCharacters) == nil else { try fail("TEXT_INPUT_REFUSED") }
        var settable: DarwinBoolean=false
        guard AXUIElementIsAttributeSettable(e,"AXValue" as CFString,&settable) == .success, settable.boolValue else { try fail("ACTION_UNSUPPORTED_BY_CONTROL") }
        result = AXUIElementSetAttributeValue(e,"AXValue" as CFString,text as CFString)
    } else {
        let a = q["direction"] as? String == "up" ? "AXScrollUpByPage" : "AXScrollDownByPage"
        guard ["up","down"].contains(q["direction"] as? String ?? ""), actions(e).contains(a) else { try fail("ACTION_UNSUPPORTED_BY_CONTROL") }
        result = AXUIElementPerformAction(e,a as CFString)
    }
    guard result == .success else { try fail("ACTION_OUTCOME_UNKNOWN") }
    let deadline=ProcessInfo.processInfo.systemUptime+1.5
    let closing=closingRequested
    repeat {
        if action=="type",let text=q["text"] as? String,str(e,"AXValue")==text {return ["actionSent":true,"verified":true,"verification":"Exact target value read back","next":"Read fresh controls before another action."]}
        if closing,let windows=try? requiredWindows(root),!windows.contains(where:{CFEqual($0,w)}) {return ["actionSent":true,"verified":true,"verification":"Selected window absent after close","next":"Do not reuse the closed window reference."]}
        if action != "type" && !closing {break}
        RunLoop.current.run(until:Date(timeIntervalSinceNow:0.03))
    } while ProcessInfo.processInfo.systemUptime<deadline
    return ["actionSent":true,"verified":false,"next":"No requested outcome was verified. Read fresh evidence; never replay automatically."]
}
#if AX_IDENTITY_TEST
let a=AXUIElementCreateApplication(100),b=AXUIElementCreateApplication(200)
let id=nativeWindowIdentity(a,42,1)
precondition(nativeWindowIdentity(a,42,1)==id)
let reordered=try resolveWindowIdentity(id,42,1,[b,a]);precondition(CFEqual(reordered,a))
func stale(_ action:() throws -> Void){do{try action();fatalError("Expected stale target")}catch{precondition((error as? Failure)?.code=="WINDOW_STALE")}}
stale{_=try resolveWindowIdentity(id,43,1,[a])}
stale{_=try resolveWindowIdentity(id,42,2,[a])}
stale{_=try resolveWindowIdentity(id,42,1,[b])}
let restart=nativeWindowIdentity(a,42,1);heldWindows.removeAll();stale{_=try resolveWindowIdentity(restart,42,1,[a])}
print("PASS: retained identity survives enumeration order; owner, restart and destroyed-window mismatches rejected")
#elseif AX_CAPTURE_PERMISSION_TEST
if #available(macOS 14.0, *) {
    do { _ = try captureSelectedWindow([:],AXUIElementCreateApplication(getpid()),NSRunningApplication.current,preflight:{false});fatalError("Denied capture passed") }
    catch { precondition((error as? Failure)?.code == "SCREEN_RECORDING_PERMISSION_REQUIRED");print("PASS: denied capture returns before any window inspection or screen capture") }
}
#elseif AX_WINDOW_QUERY_TEST
// Injection tests exercise the native result boundary without reading any real app.
let fixtureRoot = AXUIElementCreateApplication(getpid())
func expectFailure(_ native: AXError, _ expected: String) {
    do { _ = try requiredWindows(fixtureRoot, copy: { _,_,_ in native }); fatalError("Expected \(expected)") }
    catch { precondition((error as? Failure)?.code == expected) }
}
expectFailure(.apiDisabled,"ACCESSIBILITY_PERMISSION_REQUIRED")
expectFailure(.cannotComplete,"AX_APP_UNRESPONSIVE")
expectFailure(.attributeUnsupported,"AX_WINDOWS_UNSUPPORTED")
expectFailure(.noValue,"AX_WINDOWS_NO_VALUE")
expectFailure(.invalidUIElement,"APP_STALE")
expectFailure(.failure,"AX_WINDOW_QUERY_FAILED")
do {
    let empty = try requiredWindows(fixtureRoot, copy: { _,_,out in out.pointee = [] as CFArray;return .success })
    precondition(empty.isEmpty)
    let one = try requiredWindows(fixtureRoot, copy: { _,_,out in out.pointee = [fixtureRoot] as CFArray;return .success })
    precondition(one.count == 1)
    do { _ = try requiredWindows(fixtureRoot, copy: { _,_,out in out.pointee = "wrong type" as CFString;return .success });fatalError("Invalid response accepted") }
    catch { precondition((error as? Failure)?.code == "AX_WINDOWS_INVALID_RESPONSE") }
    print("PASS: six native errors, successful empty/nonempty arrays, malformed value")
} catch { fatalError("Unexpected native fixture failure") }
#else
func dispatch(_ data:Data)->Data {
    var commandId:String?
    do {
        guard data.count<=32000,let input=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {try fail("INVALID_INPUT")}
        commandId=input["commandId"] as? String
        RunLoop.current.run(until:Date(timeIntervalSinceNow:0.001))
        let started=ProcessInfo.processInfo.systemUptime
        var result=try run(input);result["commandId"]=commandId;result["nativeElapsedMs"]=(ProcessInfo.processInfo.systemUptime-started)*1000
        return try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
    } catch {
        let code=(error as? Failure)?.code ?? "ACCESSIBILITY_UNAVAILABLE"
        return (try? JSONSerialization.data(withJSONObject:["error":code,"commandId":commandId ?? ""])) ?? Data()
    }
}
if CommandLine.arguments.contains("--server") {
    while let line=readLine(strippingNewline:true){FileHandle.standardOutput.write(dispatch(Data(line.utf8)));FileHandle.standardOutput.write(Data([10]))}
} else {FileHandle.standardOutput.write(dispatch(FileHandle.standardInput.readDataToEndOfFile()))}
#endif
