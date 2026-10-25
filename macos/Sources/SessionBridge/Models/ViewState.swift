import SwiftUI

// Keep the established property wrapper on SDKs that also export a State macro.
// Command Line Tools may not ship that newer SwiftUIMacros plugin.
typealias ViewState<Value> = SwiftUI.State<Value>
