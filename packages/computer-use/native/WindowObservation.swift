import AppKit
import ApplicationServices
import Darwin
import Foundation

extension Bridge {
  func observe(
    _ args: [String: Any], budget: ObservationBudget = ObservationBudget(),
    inspect: ((ObservationTree) throws -> Void)? = nil
  ) throws -> [String: Any] {
    let projection = args["projection"] as? String ?? "full"
    guard ["full", "compact", "overview"].contains(projection) else {
      throw BridgeError("Invalid observation projection")
    }
    let tree = ObservationTree(projection: projection) {
      try checkCancellation()
      try self.assertOwnership()
    }
    tree.budget = budget
    let previousHandles = indexed
    let previousID = args["previousId"] as? String
    let allowRootFallback = args["fallbackToWindow"] as? Bool == true
    let pinnedWindowID = windowID
    let requestedRoot = args["rootIndex"] as? Int
    if args["rootIndex"] != nil
      && (requestedRoot == nil || menuBarTarget != nil || args["surface"] != nil
        || previousID != observedSnapshot || (snapshot.isEmpty && !allowRootFallback)
        || !visibleIndexes.contains(requestedRoot!))
    {
      throw BridgeError("区域编号需要最新观察；请重新 observe", reason: "stale_frame")
    }
    presentation = args["presentation"] as? Bool == true
    if let issue = DesktopSession.issue { throw BridgeError(issue) }
    // Looking at the target or interacting with it does not revoke the task. Retire
    // protection for the previous foreground before admitting a fresh observation.
    if events.ownership.interrupted
      || (focusGuard != nil && focusGuard?.front != WindowServerFocus.shared?.frontPID())
    {
      if requestedRoot != nil || inspect != nil {
        snapshot = ""
        indexed = []
        visibleIndexes = []
        throw BridgeError("区域观察已失效；请重新观察原窗口", reason: "stale_frame")
      }
      releaseFocus()
      guard !cleanupFailed else { throw BridgeError("无法完成旧输入的清理；请重启 Eta", "unknown") }
      events.ownership.beginObservation()
    }
    try assertOwnership()
    snapshot = ""
    indexed = []
    visibleIndexes = []
    guard AXIsProcessTrusted() else { throw BridgeError("请在 macOS 辅助功能中允许 Eta（包括其辅助程序），然后重试") }
    guard let name = args["app"] as? String, !name.isEmpty else {
      throw BridgeError("observe requires app")
    }
    let running: [NSRunningApplication]
    if name.hasPrefix("pid:") {
      guard let pid = Int32(name.dropFirst(4)), pid > 0 else {
        throw BridgeError("Invalid process selector")
      }
      // A launch receipt already identifies the process. Do not require the
      // notification-driven NSWorkspace list to have published it as well.
      running = NSRunningApplication(processIdentifier: pid).map { $0.isTerminated ? [] : [$0] } ?? []
    } else {
      running = runningApplications()
    }
    var candidates = TargetSelection.applications(
      name,
      in: running.map {
        .init(pid: $0.processIdentifier, name: $0.localizedName ?? "",
          bundleIdentifier: $0.bundleIdentifier, path: $0.bundleURL?.path,
          regular: $0.activationPolicy == .regular)
      },
      installedPath: { installedApplicationURL(name)?.path }
    ).map { running[$0] }
    if let previousId = args["previousId"] as? String {
      guard previousId == observedSnapshot, let previousApp = application, !previousApp.isTerminated
      else { throw BridgeError("原观察应用已失效；请重新 observe") }
      candidates = candidates.filter { $0.processIdentifier == previousApp.processIdentifier }
    }
    guard !candidates.isEmpty else {
      throw BridgeError(
        "未找到运行中的应用 \(quoted(name))；若已 open，请使用 open 返回的 app 选择器；否则请先 open")
    }
    guard candidates.count == 1, let app = candidates.first else {
      let choices = candidates.map {
        "pid:\($0.processIdentifier) \(quoted($0.localizedName ?? ""))"
      }.joined(separator: ", ")
      throw BridgeError("运行中的应用匹配不唯一 \(quoted(name))；请指定实例：\(choices)")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.4)
    let previousMenuBar = menuBarTarget != nil
    if args["surface"] as? String == "menu_bar" {
      releaseFocus()
      let target = try MenuBarTarget.find(app)
      let bounds = try target.validate(app)
      application = app
      menuBarTarget = target
      window = nil
      regionRoot = nil
      windowID = target.windowID
      cursor = nil
      // Index only the selected wrapper. Its embedded application root would expose
      // unrelated windows, and the rest of the host menu bar belongs to other apps.
      let lines = ["[0] AXMenuBarItem AXTitle=\(quoted(app.localizedName ?? name)) actions=AXPress",
        "[Use click(elementIndex:0) to open this app's menu or popover; then inspect the returned state.]"]
      try checkCancellation()
      try assertOwnership()
      indexed = [target.item]
      visibleIndexes = [0]
      snapshot = UUID().uuidString
      observedSnapshot = snapshot
      return ["id": snapshot, "app": app.bundleIdentifier ?? name,
        "windowTitle": "\(app.localizedName ?? name) menu bar", "text": lines.joined(separator: "\n"),
        "windowId": windowID, "bounds": boundsJSON(bounds),
        "observation": [
          "scope": "menu_bar", "projection": projection, "complete": true, "exhaustive": false,
          "boundaries": [], "unknown": [], "visitedNodes": 1, "axReads": 0,
        ]]
    }
    // Selection uses legacy identity helpers with several bounded AX calls each.
    // Give the entire group a slice of the same monotonic observation deadline.
    func admitSelection(_ element: AXUIElement, calls: Double) throws {
      try checkCancellation()
      guard tree.budget.exhausted == nil else { throw BridgeError("目标窗口读取超时；请重新 observe") }
      AXUIElementSetMessagingTimeout(element, Float(min(0.4, tree.budget.remaining / calls)))
    }
    func readWindows() throws -> [AXUIElement] {
      try admitSelection(root, calls: 4)
      return try appWindows(root).filter {
        try admitSelection($0, calls: 8)
        return validWindowSurface($0, app.processIdentifier) && (try? rect($0)) != nil
      }
    }
    var windows = try readWindows()
    let ready = ProcessInfo.processInfo.systemUptime + 1.5
    while windows.isEmpty && ProcessInfo.processInfo.systemUptime < ready && !app.isTerminated {
      try checkCancellation()
      RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      windows = try readWindows()
    }
    let selected: AXUIElement?
    if let previousId = args["previousId"] as? String, !previousMenuBar {
      guard previousId == observedSnapshot, application?.processIdentifier == app.processIdentifier,
        let previous = window, windows.contains(where: { CFEqual($0, previous) })
      else {
        throw BridgeError("原观察窗口已失效；请重新 observe，不会自动切换到其他窗口")
      }
      selected = previous
    } else if let title = args["windowTitle"] as? String {
      let titles = try windows.map { element -> String in
        let title = try tree.read(element, kAXTitleAttribute)
        guard !title.isUnknown else { throw BridgeError("窗口标题读取未知；请重新 observe") }
        return title.value ?? ""
      }
      let matching = TargetSelection.matching(title, in: titles)
      guard matching.count == 1, let index = matching.first else {
        let choices = (matching.isEmpty ? titles : matching.map { titles[$0] })
          .map(quoted).joined(separator: ", ")
        throw BridgeError(
          "\(matching.isEmpty ? "未找到窗口" : "窗口标题不唯一") \(quoted(title))；请使用完整 windowTitle。可选标题: [\(choices)]")
      }
      selected = windows[index]
    } else if let focused = attribute(root, kAXFocusedWindowAttribute),
      CFGetTypeID(focused) == AXUIElementGetTypeID(),
      windows.contains(where: { CFEqual($0, focused) })
    {
      selected = (focused as! AXUIElement)
    } else {
      selected = windows.first
    }
    guard let selected else {
      throw BridgeError(
        "已找到运行中的应用 pid:\(app.processIdentifier)，但没有可观察窗口（可能仍在启动或尚未打开窗口）；请用该 PID 重新观察。仅菜单栏应用使用 surface:'menu_bar'")
    }
    // Some AX servers answer success with their application root in AXWindows. That is not
    // a window identity and must never be matched to a CGWindow by application-wide bounds.
    try admitSelection(selected, calls: 8)
    guard validWindowSurface(selected, app.processIdentifier), !CFEqual(selected, root)
    else { throw BridgeError("应用返回了无效的辅助功能窗口；请关闭目标菜单并重新 observe") }

    if application?.processIdentifier != app.processIdentifier
      || window.map({ !CFEqual($0, selected) }) != false
    {
      releaseFocus()
      cursor = nil
    }
    let selectedWindowID: UInt32
    do {
      selectedWindowID = try identifyWindow(app.processIdentifier, selected)
    } catch {
      guard previousID != nil && !previousMenuBar else { throw error }
      throw BridgeError("无法确认原观察窗口身份；请重新观察原窗口", reason: "stale_frame")
    }
    if previousID != nil && !previousMenuBar && selectedWindowID != pinnedWindowID {
      throw BridgeError("原观察窗口身份已变化；请重新 observe", reason: "stale_frame")
    }
    try admitSelection(selected, calls: 4)
    let selectedBounds = try rect(selected)
    let selectedTitle = try tree.read(selected, kAXTitleAttribute)
    var scope = "window"
    var fallback: String?
    var observationRoot = selected
    if let requestedRoot {
      let candidate = previousHandles[requestedRoot]
      if try tree.belongs(candidate, to: selected) {
        observationRoot = candidate
        scope = "region"
      } else if allowRootFallback {
        fallback = "root_unavailable"
        tree.projection = "full"
      } else {
        throw BridgeError("原区域已失效或离开原窗口；请重新 observe", reason: "stale_frame")
      }
    }
    var menus: [AXUIElement] = []
    if syntheticTarget?.windowID == selectedWindowID {
      try admitSelection(root, calls: 4)
      menus = elements(root, kAXChildrenAttribute, 32).filter {
        string($0, kAXRoleAttribute) == kAXMenuRole
      }
    }
    if scope == "region" && !menus.isEmpty {
      observationRoot = selected
      scope = "window"
      fallback = "menu_opened"
      tree.projection = "full"
    }
    try tree.walk(observationRoot)
    if scope == "region" && tree.nodes.contains(where: { $0.role.value == kAXMenuRole }) {
      scope = "window"
      fallback = "menu_opened"
      tree.projection = "full"
      tree.resetCandidate()
      try tree.walk(selected)
    }
    if scope == "window" {
      for menu in menus { try tree.walk(menu) }
    }
    guard !tree.nodes.isEmpty else {
      throw BridgeError("观察预算内未能读取目标；请重新 observe")
    }
    if selectedTitle.isUnknown {
      tree.unknown.append(["index": 0, "fields": ["windowTitle"]])
    }
    let id = UUID().uuidString
    let result = try tree.response([
      "id": id,
      "app": !name.hasPrefix("pid:") ? (app.bundleIdentifier ?? name) : "pid:\(app.processIdentifier)",
      "windowTitle": selectedTitle.value ?? "",
      "windowId": selectedWindowID, "bounds": boundsJSON(selectedBounds),
      "cursor": cursor.map { ["x": $0.x, "y": $0.y] } as Any? ?? NSNull(),
    ], scope: scope, fallback: fallback)
    try inspect?(tree)
    try checkCancellation()
    try assertOwnership()
    guard !app.isTerminated else { throw BridgeError("原观察应用已退出；请重新 observe") }
    // Publish the candidate atomically. Failed reads leave no usable old frame.
    menuBarTarget = nil
    application = app
    window = selected
    regionRoot = scope == "region" ? observationRoot : nil
    windowID = selectedWindowID
    indexed = tree.nodes.map(\.element)
    visibleIndexes = Set(tree.visibleNodes.map(\.index))
    snapshot = id
    observedSnapshot = id
    return result
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
        axID: NativeWindowIdentity.windowID(window), pid: pid, bounds: r, windows: windows,
        surface: string(window, kAXRoleAttribute) == "AXPopover"
          || ["AXSystemDialog", "AXFloatingWindow", "AXDialog"].contains(string(window, kAXSubroleAttribute))
          ? .transient : .window)
    else {
      throw BridgeError("无法确认目标窗口身份；不会通过位置猜测窗口，请重新 observe")
    }
    return number
  }
}
