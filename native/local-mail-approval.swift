import AppKit
import Foundation

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 400_000,
      let value = try? JSONSerialization.jsonObject(with: input) as? [String: String],
      let from = value["from"], let to = value["to"], let subject = value["subject"], let body = value["body"] else { exit(1) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let alert = NSAlert()
alert.messageText = "Approve this email?"
alert.informativeText = "Review the exact recipients, subject and message. Sending cannot be undone."
alert.addButton(withTitle: "Send email")
alert.addButton(withTitle: "Cancel")
let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 540, height: 320))
scroll.hasVerticalScroller = true
scroll.borderType = .bezelBorder
let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 525, height: 320))
text.isEditable = false
text.isSelectable = true
text.font = NSFont.systemFont(ofSize: 13)
text.string = "From: \(from)\nTo: \(to)\nSubject: \(subject)\n\n\(body)"
text.isVerticallyResizable = true
text.textContainer?.widthTracksTextView = true
scroll.documentView = text
alert.accessoryView = scroll
app.activate(ignoringOtherApps: true)
let approved = alert.runModal() == .alertFirstButtonReturn
let response = approved ? "{\"approved\":true}" : "{\"approved\":false}"
FileHandle.standardOutput.write(Data(response.utf8))
