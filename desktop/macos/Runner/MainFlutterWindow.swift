import Cocoa
import FlutterMacOS
import ServiceManagement

class MainFlutterWindow: NSWindow {
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

    super.awakeFromNib()
  }
}
