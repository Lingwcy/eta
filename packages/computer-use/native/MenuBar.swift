import AppKit
import ApplicationServices

// macOS may host a status item in MenuBarAgent. Bind its AX wrapper through the
// embedded control's PID, never through the visible label of another app.
struct MenuBarTarget {
  let item: AXUIElement
  let host: AXUIElement
  let pid: pid_t
  let windowID: UInt32

  static func find(_ app: NSRunningApplication) throws -> MenuBarTarget {
    let pid = app.processIdentifier
    let root = AXUIElementCreateApplication(pid)
    if let extras = axNode(root, "AXExtrasMenuBar") {
      let items = elements(extras, kAXChildrenAttribute, 64).filter {
        actions($0).contains(kAXPressAction) && (try? rect($0)) != nil
      }
      if items.count == 1, let item = items.first,
        let id = NativeWindowIdentity.windowID(item) ?? NativeWindowIdentity.windowID(extras)
      { return .init(item: item, host: extras, pid: pid, windowID: id) }
    }
    var found: [MenuBarTarget] = []
    for agent in NSWorkspace.shared.runningApplications
    where agent.bundleIdentifier == "com.apple.MenuBarAgent" {
      let hostRoot = AXUIElementCreateApplication(agent.processIdentifier)
      AXUIElementSetMessagingTimeout(hostRoot, 0.4)
      for host in appWindows(hostRoot) {
        guard let id = NativeWindowIdentity.windowID(host) else { continue }
        for item in elements(host, kAXChildrenAttribute, 128) {
          let children = elements(item, kAXChildrenAttribute, 16)
          for child in children {
            var owner: pid_t = 0
            if AXUIElementGetPid(child, &owner) == .success, owner == pid,
              actions(child).contains(kAXPressAction), (try? rect(child)) != nil
            {
              found.append(.init(item: child, host: host, pid: agent.processIdentifier, windowID: id))
            }
          }
        }
      }
    }
    // Duplicate menu bars on multiple displays must be selected explicitly in future;
    // do not guess which screen's status item should open a panel.
    guard found.count == 1, let target = found.first else {
      throw BridgeError("找不到唯一的菜单栏图标；请确认图标可见，再 observe(app,surface:'menu_bar')")
    }
    return target
  }

  func validate(_ app: NSRunningApplication) throws -> CGRect {
    let current = try Self.find(app)
    guard current.pid == pid, current.windowID == windowID, CFEqual(current.item, item),
      CFEqual(current.host, host)
    else { throw BridgeError("菜单栏图标已变化；请重新 observe", reason: "stale_frame") }
    let records = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    let windows: [NativeWindowIdentity.Record] = records.compactMap { row in
      guard let id = row[kCGWindowNumber as String] as? UInt32,
        let owner = row[kCGWindowOwnerPID as String] as? pid_t,
        let layer = row[kCGWindowLayer as String] as? Int,
        let raw = row[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
      return .init(id: id, pid: owner, layer: layer, bounds: bounds)
    }
    guard NativeWindowIdentity.resolve(axID: windowID, pid: pid, bounds: try rect(host),
      windows: windows, surface: .menuBar) != nil
    else { throw BridgeError("菜单栏宿主窗口已失效；请重新 observe", reason: "stale_frame") }
    return try rect(item)
  }
}
