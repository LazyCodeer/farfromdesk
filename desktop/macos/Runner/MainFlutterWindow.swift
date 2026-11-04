import Cocoa
import FlutterMacOS
import ServiceManagement

class MainFlutterWindow: NSWindow {
  private var socialSharePicker: NSSharingServicePicker?
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    let startup = FlutterMethodChannel(name: "launch_at_startup", binaryMessenger: flutterViewController.engine.binaryMessenger)
    startup.setMethodCallHandler { call, result in
      switch call.method {
      case "launchAtStartupIsEnabled":
        result(SMAppService.mainApp.status == .enabled)
      case "launchAtStartupSetEnabled":
        guard let arguments = call.arguments as? [String: Any],
              let enabled = arguments["setEnabledValue"] as? Bool else {
          result(FlutterError(code: "invalid_arguments", message: "An explicit startup choice is required.", details: nil))
          return
        }
        do {
          if enabled { try SMAppService.mainApp.register() }
          else { try SMAppService.mainApp.unregister() }
          if enabled && SMAppService.mainApp.status != .enabled {
            result(FlutterError(code: "startup_approval", message: "Allow FarFromDesk in System Settings → General → Login Items.", details: nil))
          } else { result(nil) }
        } catch {
          result(FlutterError(code: "startup_registration", message: error.localizedDescription, details: nil))
        }
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    let socialShare = FlutterMethodChannel(name: "farfromdesk/social-share", binaryMessenger: flutterViewController.engine.binaryMessenger)
    socialShare.setMethodCallHandler { [weak self, weak flutterViewController] call, result in
      guard call.method == "show" else { result(FlutterMethodNotImplemented); return }
      guard let self = self, let view = flutterViewController?.view,
            let args = call.arguments as? [String: Any],
            let caption = args["caption"] as? String,
            let images = args["images"] as? [FlutterStandardTypedData],
            images.count <= 30,
            images.reduce(0, { $0 + $1.data.count }) <= 100 * 1024 * 1024 else {
        result(FlutterError(code: "invalid_share", message: "Invalid or oversized post.", details: nil)); return
      }
      do {
        var items: [Any] = caption.isEmpty ? [] : [caption]
        // Keep files in the OS temporary directory: destination apps may read
        // them asynchronously after the picker closes. Never delete on dismissal.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ffd-social-" + UUID().uuidString, isDirectory: true)
        if !images.isEmpty {
          try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
          for (index, image) in images.enumerated() {
            guard image.data.starts(with: [0xff, 0xd8, 0xff]) else {
              throw NSError(domain: "SocialShare", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid JPEG image."])
            }
            let url = folder.appendingPathComponent(String(format: "slide-%02d.jpg", index + 1))
            try image.data.write(to: url, options: .atomic)
            items.append(url)
          }
        }
        guard !items.isEmpty else { result(false); return }
        let picker = NSSharingServicePicker(items: items)
        self.socialSharePicker = picker
        picker.show(relativeTo: NSRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1), of: view, preferredEdge: .minY)
        // This reports chooser presentation only, never delivery or publication.
        result(true)
      } catch {
        result(FlutterError(code: "share_failed", message: "Could not prepare the share sheet.", details: nil))
      }
    }

    // Server mode: keep this app out of App Nap while it is on. This prevents
    // macOS from coalescing our timers when the window is hidden behind a
    // closed lid. It does not change sleep policy; the privileged helper and
    // caffeinate do that.
    let serverMode = FlutterMethodChannel(name: "farfromdesk/server-mode", binaryMessenger: flutterViewController.engine.binaryMessenger)
    serverMode.setMethodCallHandler { call, result in
      guard call.method == "setActive" else { result(FlutterMethodNotImplemented); return }
      guard let arguments = call.arguments as? [String: Any],
            let active = arguments["active"] as? Bool else {
        result(FlutterError(code: "invalid_arguments", message: "An explicit on or off choice is required.", details: nil))
        return
      }
      ServerModeActivity.shared.setActive(active)
      result(nil)
    }

    super.awakeFromNib()
  }
}

/// Holds one App Nap exemption for the lifetime of server mode.
final class ServerModeActivity {
  static let shared = ServerModeActivity()
  private var token: NSObjectProtocol?

  func setActive(_ active: Bool) {
    DispatchQueue.main.async {
      if active {
        guard self.token == nil else { return }
        // userInitiatedAllowingIdleSystemSleep blocks App Nap without also
        // claiming idle sleep, which the owner's keep-awake settings own.
        self.token = ProcessInfo.processInfo.beginActivity(
          options: [.userInitiatedAllowingIdleSystemSleep, .suddenTerminationDisabled, .automaticTerminationDisabled],
          reason: "Server mode keeps FarFromDesk running with the lid closed"
        )
      } else if let token = self.token {
        ProcessInfo.processInfo.endActivity(token)
        self.token = nil
      }
    }
  }
}
