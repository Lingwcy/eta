import AppKit
import ApplicationServices
import Darwin
import Foundation

extension Bridge {
  func observe(_ args: [String: Any]) throws -> [String: Any] {
    presentation = args["presentation"] as? Bool == true
    if let issue = DesktopSession.issue { throw BridgeError(issue) }
    try assertOwnership()
    snapshot = ""
    indexed = []
    seen = []
    lines = []
    textSize = 0
    guard AXIsProcessTrusted() else { throw BridgeError("请在 macOS 辅助功能中允许 Eta（包括其辅助程序），然后重试") }
    guard let name = args["app"] as? String, !name.isEmpty else {
      throw BridgeError("observe requires app")
    }
    let explicitPID: pid_t?
    if name.hasPrefix("pid:") {
      guard let pid = Int32(name.dropFirst(4)), pid > 0 else {
        throw BridgeError("Invalid process selector")
      }
      explicitPID = pid
    } else {
      explicitPID = nil
    }
    var candidates = NSWorkspace.shared.runningApplications.filter {
      if let explicitPID { return $0.processIdentifier == explicitPID }
      return $0.bundleIdentifier == name || $0.localizedName == name || $0.bundleURL?.path == name
    }
    if let previousId = args["previousId"] as? String {
      guard previousId == observedSnapshot, let previousApp = application, !previousApp.isTerminated
      else { throw BridgeError("原观察应用已失效；请重新 observe") }
      candidates = candidates.filter { $0.processIdentifier == previousApp.processIdentifier }
    }
    guard candidates.count == 1, let app = candidates.first else {
      let choices = candidates.map { "pid:\($0.processIdentifier)" }.joined(separator: ", ")
      throw BridgeError("找不到唯一的运行中应用 \(name)；请先 open，或指定实例 \(choices)")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.4)
    var windows = appWindows(root)
    let ready = Date().addingTimeInterval(1.5)
    while windows.isEmpty && Date() < ready && !app.isTerminated {
      try checkCancellation()
      RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      windows = appWindows(root)
    }
    let selected: AXUIElement?
    if let previousId = args["previousId"] as? String {
      guard previousId == observedSnapshot, application?.processIdentifier == app.processIdentifier,
        let previous = window, windows.contains(where: { CFEqual($0, previous) })
      else {
        throw BridgeError("原观察窗口已失效；请重新 observe，不会自动切换到其他窗口")
      }
      selected = previous
    } else if let title = args["windowTitle"] as? String {
      let matching = windows.filter { string($0, kAXTitleAttribute) == title }
      guard matching.count == 1 else { throw BridgeError("未找到唯一窗口 \(title)；请重新指定 windowTitle") }
      selected = matching.first
    } else if let focused = attribute(root, kAXFocusedWindowAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID()
    {
      selected = (focused as! AXUIElement)
    } else {
      selected = windows.first
    }
    guard let selected else { throw BridgeError("应用没有可观察窗口；请先打开窗口或使用 screenshot") }
    // Some AX servers answer success with their application root in AXWindows. That is not
    // a window identity and must never be matched to a CGWindow by application-wide bounds.
    guard validWindowSurface(selected, app.processIdentifier), !CFEqual(selected, root)
    else { throw BridgeError("应用返回了无效的辅助功能窗口；请关闭目标菜单并重新 observe") }

    if application?.processIdentifier != app.processIdentifier
      || window.map({ !CFEqual($0, selected) }) != false
    {
      releaseFocus()
      cursor = nil
    }
    application = app
    window = selected
    windowID = try identifyWindow(app.processIdentifier, selected)
    deadline = Date().addingTimeInterval(8)
    walk(selected, 0)
    if syntheticTarget?.windowID == windowID {
      for menu in elements(root, kAXChildrenAttribute, 32)
      where string(menu, kAXRoleAttribute) == kAXMenuRole { walk(menu, 0) }
    }
    if indexed.count >= 800 || textSize >= 48000 || Date() >= deadline {
      lines.append(
        "[Tree truncated; use a screenshot or a narrower window to inspect missing controls.]")
    }
    snapshot = UUID().uuidString
    observedSnapshot = snapshot
    return [
      "id": snapshot,
      "app": explicitPID == nil ? (app.bundleIdentifier ?? name) : "pid:\(app.processIdentifier)",
      "windowTitle": string(selected, kAXTitleAttribute), "text": lines.joined(separator: "\n"),
      "windowId": windowID, "bounds": boundsJSON(try rect(selected)),
      "cursor": cursor.map { ["x": $0.x, "y": $0.y] } as Any? ?? NSNull(),
    ]
  }

  func identifyWindow(_ pid: pid_t, _ window: AXUIElement) throws -> UInt32 {
    let r = try rect(window)
    let info =
      CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    let windows: [NativeWindowIdentity.Record] = info.compactMap { item in
      guard let owner = item[kCGWindowOwnerPID as String] as? pid_t,
        let layer = item[kCGWindowLayer as String] as? Int,
        let id = item[kCGWindowNumber as String] as? UInt32,
        let raw = item[kCGWindowBounds as String] as? NSDictionary,
        let b = CGRect(dictionaryRepresentation: raw)
      else { return nil }
      return .init(id: id, pid: owner, layer: layer, bounds: b)
    }
    guard
      let number = NativeWindowIdentity.resolve(
        axID: NativeWindowIdentity.windowID(window), pid: pid, bounds: r, windows: windows)
    else {
      throw BridgeError("无法确认目标窗口身份；不会通过位置猜测窗口，请重新 observe")
    }
    return number
  }
  func walk(_ element: AXUIElement, _ depth: Int) {
    guard terminating == 0, depth <= 24, indexed.count < 800, textSize < 48000, Date() < deadline
    else { return }
    let hash = CFHash(element)
    // Hash is only a fast rejection filter; collisions must not hide different controls.
    if seen.contains(hash) && indexed.contains(where: { CFEqual($0, element) }) { return }
    seen.insert(hash)
    let index = indexed.count
    indexed.append(element)
    let role = string(element, kAXRoleAttribute)
    var parts = ["\(String(repeating: "  ", count: depth))[\(index)] \(role)"]
    for name in [
      kAXSubroleAttribute, kAXRoleDescriptionAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
      kAXHelpAttribute, kAXIdentifierAttribute, "AXPlaceholderValue",
    ] {
      let value = string(element, name)
      if !value.isEmpty { parts.append("\(name)=\(quoted(value))") }
    }
    if string(element, kAXSubroleAttribute) != kAXSecureTextFieldSubrole {
      let value = string(element, kAXValueAttribute)
      if !value.isEmpty { parts.append("value=\(quoted(value))") }
      let selected = string(element, kAXSelectedTextAttribute)
      if !selected.isEmpty { parts.append("selected=\(quoted(selected))") }
    }
    if string(element, kAXEnabledAttribute) == "0" { parts.append("disabled") }
    var writable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success
      && writable.boolValue
    {
      parts.append("settable")
    }
    let available = actions(element)
    if !available.isEmpty { parts.append("actions=\(available.joined(separator: ","))") }
    let line = parts.joined(separator: " ")
    lines.append(line)
    textSize += line.count
    for child in elements(element, kAXChildrenAttribute, max(0, 800 - indexed.count)) {
      walk(child, depth + 1)
    }
  }

}
