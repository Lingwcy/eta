import AppKit
import ApplicationServices
import Darwin
import Foundation

extension Bridge {
  func assertOwnership(_ applied: String = "no") throws {
    try focusGuard?.assertHealthy()
    if events.ownership.interrupted {
      throw BridgeError("目标应用发生了手动交互；旧观察已失效，请重新 observe 后继续", applied, reason: "stale_frame")
    }
  }
  func releaseFocus(closeGuard: Bool = true) {
    if let target = syntheticTarget,
      NSRunningApplication(processIdentifier: target.pid)?.isTerminated == false,
      WindowServerFocus.shared?.frontPID() != target.pid, !events.ownership.interrupted
    {
      do { try events.focus(target.pid, target.windowID, false) } catch { cleanupFailed = true }
    }
    syntheticTarget = nil
    if closeGuard {
      if let guarder = focusGuard { if !guarder.close() { cleanupFailed = true } }
      focusGuard = nil
    }
  }
  func hasMenu(_ window: AXUIElement) -> Bool {
    var budget = 128
    let deadline = Date().addingTimeInterval(0.15)
    func visit(_ element: AXUIElement, _ depth: Int) -> Bool {
      guard budget > 0, depth < 16, Date() < deadline else { return false }
      budget -= 1
      if string(element, kAXRoleAttribute) == kAXMenuRole { return true }
      return elements(element, kAXChildrenAttribute, min(budget, 64)).contains {
        visit($0, depth + 1)
      }
    }
    return visit(window, 0)
  }
  func finishInput(_ window: AXUIElement) {
    RunLoop.current.run(until: Date().addingTimeInterval(0.08))
    do { try focusGuard?.assertHealthy() } catch { cleanupFailed = true }
    let menuOpen = hasMenu(window)
    focusGuard?.endInput(menuOpen: menuOpen)
    if cleanupFailed {
      releaseFocus()
    } else if !events.ownership.interrupted && !menuOpen {
      releaseFocus(closeGuard: false)
    }
  }

  func prepareInput(_ app: NSRunningApplication, _ window: AXUIElement) throws {
    try assertOwnership()
    if let issue = DesktopSession.issue { throw BridgeError(issue) }
    guard let server = WindowServerFocus.shared, let front = server.frontPID() else {
      throw BridgeError("无法确认前台输入所有权")
    }
    let pid = app.processIdentifier
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.4)
    guard
      ForegroundWindowAdmission.allows(
        front: front, target: pid, observed: window,
        focused: front == pid ? axNode(root, kAXFocusedWindowAttribute) : nil,
        equal: { CFEqual($0, $1) })
    else {
      throw BridgeError(
        "当前输入窗口与观察不一致；本次未执行，请重新 observe 目标窗口", reason: "stale_frame")
    }
    guard front != pid else { return }
    if focusGuard?.front != front || focusGuard?.target != pid
      || focusGuard?.ordering.foregroundWindowMatches() == false
    {
      releaseFocus()
      let protection = BackgroundFocusGuard(
        front: front, target: pid, window: windowID, events: events, server: server)
      try protection.start()
      focusGuard = protection
    }
    try focusGuard?.arm()
    guard events.available else { throw BridgeError("当前 macOS 不支持后台输入") }
    try events.focus(pid, windowID, true)
    let priorTarget = syntheticTarget
    syntheticTarget = (pid, windowID)
    // Let AppKit accept the synthetic active state before AX actions that can self-activate.
    // AXFocusedWindow/AXMain writes can activate the real app. A directed click selects an
    // input window; keyboard delivery must refuse a different key window rather than repair it that way.
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    let focused = attribute(root, kAXFocusedWindowAttribute)
    let alreadyKey =
      focused.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window) } ?? false
    if priorTarget?.pid != pid || priorTarget?.windowID != windowID || !alreadyKey {
      try events.keyWindow(pid, windowID)
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    try checkCancellation()
    try assertOwnership("unknown")
    guard WindowServerFocus.shared?.frontPID() == front else {
      releaseFocus()
      throw BridgeError("准备后台输入时前台应用发生变化；已停止操作", "unknown")
    }
  }

  func protectKeyboardRecipient(_ recipient: pid_t, app: NSRunningApplication) throws {
    guard recipient > 0, recipient != getpid(), let server = WindowServerFocus.shared,
      let front = server.frontPID()
    else { throw BridgeError("无法确认键盘接收进程", "unknown") }
    if front == app.processIdentifier { return }
    guard recipient != front, let prior = focusGuard,
      prior.front == front, prior.target == app.processIdentifier
    else { throw BridgeError("键盘接收进程与当前前台冲突；已停止输入", "unknown") }
    if prior.recipients.contains(recipient) { return }
    let protection = BackgroundFocusGuard(
      front: front, target: app.processIdentifier, window: windowID, events: events, server: server,
      keyboardRecipient: recipient, ordering: prior.ordering)
    // Install every recipient's taps before sending keys. Drain the preceding guard before
    // arming the replacement; callbacks cannot outlive their input/focus owner.
    try protection.start()
    focusGuard = protection
    guard prior.close() else {
      cleanupFailed = true
      throw BridgeError("旧键盘焦点保护未完成清理", "unknown")
    }
    protection.ordering.admitKeyboardRecipient(recipient)
    try protection.arm()
    try assertOwnership("unknown")
  }

  func directed(
    _ args: [String: Any], _ operation: String, _ element: AXUIElement?,
    _ app: NSRunningApplication, _ window: AXUIElement
  ) throws -> [String: Any] {
    guard events.available else { throw BridgeError("当前 macOS 的后台输入接口不可用；不会切换为全局输入") }
    let bounds = try rect(window)
    if let expected = args["expectedBounds"] as? [String: Double], expected != boundsJSON(bounds) {
      throw BridgeError("目标窗口位置已变化；请重新 observe 后操作")
    }
    let pid = app.processIdentifier
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.4)
    guard try identifyWindow(pid, window) == windowID else { throw BridgeError("目标窗口身份已变化") }
    func point(_ name: String) throws -> CGPoint {
      guard let raw = args[name] as? [String: Double], let x = raw["x"], let y = raw["y"],
        x.isFinite, y.isFinite, bounds.contains(CGPoint(x: x, y: y))
      else { throw BridgeError("坐标超出目标窗口") }
      return CGPoint(x: x, y: y)
    }
    func middle(_ e: AXUIElement) throws -> CGPoint {
      let r = try rect(e).intersection(bounds)
      guard !r.isNull, !r.isEmpty else { throw BridgeError("控件不在当前窗口可见范围内") }
      return CGPoint(x: r.midX, y: r.midY)
    }
    var trajectory: DragTrajectory?
    let target: CGPoint?
    if operation == "drag" {
      let from = try point("from")
      let to = try point("to")
      let points: [CGPoint]
      if args["path"] != nil {
        guard let path = args["path"] as? [[String: Double]], path.count <= 256 else {
          throw BridgeError("drag path requires 2–256 points")
        }
        points = try path.map { raw in
          guard let x = raw["x"], let y = raw["y"] else {
            throw BridgeError("Invalid drag path point")
          }
          return CGPoint(x: x, y: y)
        }
      } else {
        points = [from, to]
      }
      guard points.first == from, points.last == to,
        args["durationMs"] == nil || args["durationMs"] is Int,
        let plan = DragTrajectory.make(
          points, bounds: bounds, durationMs: args["durationMs"] as? Int)
      else {
        throw BridgeError(
          "Invalid drag path or durationMs; all points must stay inside the observed window")
      }
      trajectory = plan
      target = plan.start
    } else if args["point"] != nil {
      target = try point("point")
    } else if let element {
      target = try middle(element)
    } else {
      target = nil
    }
    let keyCodes: [String: CGKeyCode] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
      "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
      "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35,
      "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "return": 36, "tab": 48, "space": 49,
      "backspace": 51, "escape": 53, "cmd": 55, "shift": 56, "alt": 58, "control": 59, "fn": 63,
      "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "left": 123,
      "right": 124, "down": 125, "up": 126, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
      "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105,
      "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
    ]
    let modifiers: [String: CGEventFlags] = [
      "cmd": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "control": .maskControl,
      "fn": .maskSecondaryFn,
    ]
    let chord = args["keys"] as? [String] ?? []
    if operation == "key"
      && (chord.isEmpty || chord.count > 8 || chord.contains(where: { keyCodes[$0] == nil }))
    {
      throw BridgeError("无效快捷键")
    }
    if operation == "type" && (args["text"] as? String).map({ $0.count <= 16000 }) != true {
      throw BridgeError("type requires text")
    }
    if operation == "click"
      && (target == nil || ![1, 2].contains(args["count"] as? Int ?? 1)
        || !["left", "right"].contains(args["button"] as? String ?? "left"))
    {
      throw BridgeError("无效点击参数")
    }
    let dx = args["deltaX"] as? Int ?? 0
    let dy = args["deltaY"] as? Int ?? 0
    if operation == "scroll"
      && (target == nil || !(-1000...1000).contains(dx) || !(-1000...1000).contains(dy))
    {
      throw BridgeError("无效滚动参数")
    }
    guard let front = WindowServerFocus.shared?.frontPID() else {
      throw BridgeError("无法确认前台输入所有权")
    }
    let background = front != pid
    func checkContext() throws {
      try checkCancellation()
      try assertOwnership("unknown")
      guard WindowServerFocus.shared?.frontPID() == front else {
        throw BridgeError("前台应用已变化；停止本次后台输入，请重新观察", "unknown")
      }
      guard
        ForegroundWindowAdmission.allows(
          front: front, target: pid, observed: window,
          focused: front == pid ? axNode(root, kAXFocusedWindowAttribute) : nil,
          equal: { CFEqual($0, $1) })
      else {
        throw BridgeError("输入窗口已变化；已停止后续输入，请重新 observe 后继续", "unknown", reason: "stale_frame")
      }
      guard !app.isTerminated,
        appWindows(AXUIElementCreateApplication(pid)).contains(where: {
          CFEqual($0, window)
        })
      else { throw BridgeError("目标窗口已关闭", "unknown") }
      guard try rect(window) == bounds else {
        throw BridgeError("输入过程中目标窗口已移动或缩放；已停止后续输入，请重新观察", "unknown")
      }
    }
    var completed = false
    var heldKeys: [(CGKeyCode, CGEventFlags, pid_t)] = []
    var heldButton: (NSEvent.EventType, CGPoint)?
    defer {
      var flags = heldKeys.last?.1 ?? []
      let modifierCodes: [CGKeyCode: CGEventFlags] = [
        55: .maskCommand, 56: .maskShift, 58: .maskAlternate, 59: .maskControl,
        63: .maskSecondaryFn,
      ]
      for (code, _, recipient) in heldKeys.reversed() {
        if let modifier = modifierCodes[code] { flags.remove(modifier) }
        do { try events.keyboard(code, false, flags, recipient) } catch { cleanupFailed = true }
      }
      if let (up, p) = heldButton {
        do { try events.mouse(up, p, bounds, pid, windowID) } catch { cleanupFailed = true }
      }
      if background {
        if completed {
          finishInput(window)
        } else {
          RunLoop.current.run(until: Date().addingTimeInterval(0.08))
          releaseFocus()
        }
      }
    }
    // Only target-local AppKit state changes. The foreground process remains untouched.
    try prepareInput(app, window)
    try checkContext()
    func click(_ p: CGPoint, _ right: Bool = false, _ count: Int = 1) throws {
      try events.mouse(.mouseMoved, p, bounds, pid, windowID)
      for number in 1...count {
        try checkContext()
        let up: NSEvent.EventType = right ? .rightMouseUp : .leftMouseUp
        heldButton = (up, p)
        try events.mouse(right ? .rightMouseDown : .leftMouseDown, p, bounds, pid, windowID, number)
        try events.mouse(up, p, bounds, pid, windowID, number)
        heldButton = nil
      }
      cursor = CGPoint(x: p.x - bounds.minX, y: p.y - bounds.minY)
    }
    if let element, operation == "type" { try set(element, kAXFocusedAttribute, kCFBooleanTrue) }
    var madeFocusClick = false
    if operation == "type", let target, element == nil {
      try click(target)
      madeFocusClick = true
    }
    let inputWindowID = windowID
    let scope = KeyboardScope<AXUIElement>(
      equal: { CFEqual($0, $1) },
      sameWindow: { a, b in
        CFEqual(a, b)
          || (NativeWindowIdentity.windowID(a) == inputWindowID
            && NativeWindowIdentity.windowID(b) == inputWindowID)
      },
      process: { node in
        var recipient: pid_t = 0
        guard AXUIElementGetPid(node, &recipient) == .success else { return nil }
        let id = NativeWindowIdentity.windowID(node)
        // ViewBridge surfaces can appear in the all-windows list while a direct
        // optionIncludingWindow query returns no record for the same native ID.
        let records =
          id == nil
          ? []
          : CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        let windows: [NativeWindowIdentity.Record] = records.compactMap { record in
          guard let id = record[kCGWindowNumber as String] as? UInt32,
            let pid = record[kCGWindowOwnerPID as String] as? pid_t,
            let layer = record[kCGWindowLayer as String] as? Int,
            let raw = record[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: raw)
          else { return nil }
          return .init(id: id, pid: pid, layer: layer, bounds: bounds)
        }
        return NativeWindowIdentity.keyboardRecipient(
          axPID: recipient, axWindowID: id, windows: windows)
      },
      enclosingWindow: {
        // WKWebView status panels can publish an inaccessible AXWindow proxy.
        // Treat that as absent so KeyboardScope requires the actual parent path;
        // a live, different AXWindow still rejects input.
        guard let node = axNode($0, kAXWindowAttribute),
          !string(node, kAXRoleAttribute).isEmpty else { return nil }
        return node
      },
      parent: { axNode($0, kAXParentAttribute) })
    var keyboardTarget: KeyboardTarget<AXUIElement>?
    func currentKeyboardTarget() throws -> KeyboardTarget<AXUIElement> {
      try checkContext()
      guard
        let current = scope.resolve(
          app: pid, window: window, focusedWindow: axNode(root, kAXFocusedWindowAttribute),
          focusedElement: axNode(root, kAXFocusedUIElementAttribute),
          requested: operation == "type" ? element : nil)
      else { throw BridgeError("无法确认目标窗口内的键盘接收控件；已停止后续输入，请重新观察并点击目标控件", "unknown") }
      if let original = keyboardTarget, !scope.unchanged(original, current) {
        throw BridgeError("键盘接收控件或进程已变化；已停止后续文字和按键，请重新观察", "unknown")
      }
      return current
    }
    if operation == "type" || operation == "key" {
      if let current = attribute(root, kAXFocusedWindowAttribute),
        CFGetTypeID(current) == AXUIElementGetTypeID(), !CFEqual(current, window)
      {
        try events.keyWindow(pid, windowID)
      }
      let ready = Date().addingTimeInterval(1)
      while Date() < ready {
        try checkContext()
        if let focused = attribute(root, kAXFocusedWindowAttribute),
          CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window)
        {
          break
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      }
      // Keys are PID-scoped, so the app's focused window must be the observed window.
      guard let focused = attribute(root, kAXFocusedWindowAttribute),
        CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window)
      else {
        throw BridgeError("目标窗口不是应用的输入窗口；请重新 observe 并点击目标窗口后输入", madeFocusClick ? "unknown" : "no")
      }
      keyboardTarget = try currentKeyboardTarget()
      try protectKeyboardRecipient(keyboardTarget!.pid, app: app)
      _ = try currentKeyboardTarget()
    }
    func press(_ keys: [String]) throws {
      var flags: CGEventFlags = []
      for key in keys {
        let recipient = try currentKeyboardTarget().pid
        if let modifier = modifiers[key] { flags.insert(modifier) }
        let code = keyCodes[key]!
        heldKeys.append((code, flags, recipient))
        try events.keyboard(code, true, flags, recipient)
      }
      for key in keys.reversed() {
        let code = keyCodes[key]!
        if let modifier = modifiers[key] { flags.remove(modifier) }
        try events.keyboard(code, false, flags, heldKeys.last!.2)
        heldKeys.removeLast()
      }
    }
    switch operation {
    case "click":
      try click(target!, args["button"] as? String == "right", args["count"] as? Int ?? 1)
    case "key": try press(chord)
    case "type":
      if args["overwrite"] as? Bool == true {
        try press(["cmd", "a"])
        try press(["backspace"])
      }
      let characters = Array(args["text"] as! String)
      for start in stride(from: 0, to: characters.count, by: 64) {
        let recipient = try currentKeyboardTarget().pid
        let text = String(characters[start..<min(start + 64, characters.count)])
        heldKeys.append((0, [], recipient))
        try events.keyboard(0, true, [], recipient, text)
        try events.keyboard(0, false, [], recipient, text)
        heldKeys.removeLast()
        RunLoop.current.run(until: Date().addingTimeInterval(0.001))
      }
      if args["enter"] as? Bool == true {
        try checkContext()
        try press(["return"])
      }
      if let target { cursor = CGPoint(x: target.x - bounds.minX, y: target.y - bounds.minY) }
    case "scroll":
      try events.scroll(target!, bounds, Int32(dx), Int32(dy), pid, windowID)
      cursor = CGPoint(x: target!.x - bounds.minX, y: target!.y - bounds.minY)
    case "drag":
      let plan = trajectory!
      try events.mouse(.mouseMoved, plan.start, bounds, pid, windowID)
      heldButton = (.leftMouseUp, plan.start)
      try events.mouse(.leftMouseDown, plan.start, bounds, pid, windowID)
      let began = ProcessInfo.processInfo.systemUptime
      for (index, p) in plan.samples.enumerated() {
        try checkContext()
        heldButton = (.leftMouseUp, p)
        try events.mouse(.leftMouseDragged, p, bounds, pid, windowID)
        let remaining =
          began + plan.duration * Double(index + 1) / Double(plan.samples.count)
          - ProcessInfo.processInfo.systemUptime
        if remaining > 0 { RunLoop.current.run(until: Date().addingTimeInterval(remaining)) }
      }
      let to = plan.samples.last!
      try events.mouse(.leftMouseUp, to, bounds, pid, windowID)
      heldButton = nil
      cursor = CGPoint(x: to.x - bounds.minX, y: to.y - bounds.minY)
    default: throw BridgeError("未知定向输入动作")
    }
    // Escape and other completed shortcuts may destroy a transient panel. All
    // events have already been sent; a vanished surface is not non-execution.
    if (try? rect(window)) != nil { try checkContext() }
    completed = true
    return [:]
  }

  func input(_ args: [String: Any]) throws -> [String: Any] {
    try assertOwnership()
    if args["operation"] as? String == "check_ownership" { return [:] }
    if let target = menuBarTarget {
      guard let app = application, !app.isTerminated,
        args["id"] as? String == snapshot, !snapshot.isEmpty
      else { throw BridgeError("菜单栏观察已失效；请重新 observe", reason: "stale_frame") }
      _ = try target.validate(app)
      let operation = args["operation"] as? String ?? ""
      if operation == "layout" { return try layout(args) }
      if operation == "capture" { return try capture(args) }
      guard args["elementIndex"] as? Int == 0,
        (operation == "click" && (args["button"] as? String ?? "left") == "left"
          && (args["count"] as? Int ?? 1) == 1)
          || (operation == "perform_action" && args["name"] as? String == kAXPressAction)
      else { throw BridgeError("菜单栏入口请使用 click(elementIndex:0) 打开，再观察面板") }
      snapshot = ""
      try checkCancellation()
      guard AXUIElementPerformAction(target.item, kAXPressAction as CFString) == .success
      else { throw BridgeError("菜单栏图标 AXPress 失败；请重新观察确认状态", "unknown") }
      return [:]
    }
    guard let id = args["id"] as? String, id == snapshot, !snapshot.isEmpty,
      let app = application, !app.isTerminated, let window
    else {
      throw BridgeError("辅助功能观察已失效；请重新 observe")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard appWindows(root).contains(where: { CFEqual($0, window) }) else {
      snapshot = ""
      throw BridgeError("目标窗口已关闭；请重新 observe")
    }
    var element: AXUIElement?
    if let index = args["elementIndex"] as? Int {
      guard indexed.indices.contains(index) else { throw BridgeError("elementIndex 不属于当前观察") }
      element = indexed[index]
      guard attribute(element!, kAXRoleAttribute) != nil else {
        throw BridgeError("目标控件已失效；请重新 observe")
      }
    }
    guard let operation = args["operation"] as? String else {
      throw BridgeError("operation required")
    }
    if operation == "layout" { return try layout(args) }
    if operation == "capture" { return try capture(args) }
    guard try identifyWindow(app.processIdentifier, window) == windowID else {
      throw BridgeError("目标窗口身份已变化；请重新 observe")
    }
    if let element, string(element, kAXEnabledAttribute) == "0" { throw BridgeError("目标控件被禁用") }
    // Consume the observation before the first mutation, including AX focus changes.
    snapshot = ""
    try checkCancellation()
    if ["click", "type", "key", "scroll", "drag"].contains(operation)
      && (element == nil || operation != "click" || args["button"] as? String == "right"
        || args["count"] as? Int == 2
        || (element.map { !actions($0).contains(kAXPressAction) } ?? false))
    {
      return try directed(args, operation, element, app, window)
    }
    guard let element else { throw BridgeError("该动作需要 elementIndex") }
    try prepareInput(app, window)
    defer { finishInput(window) }
    switch operation {
    case "click", "perform_action":
      let action = operation == "click" ? kAXPressAction : (args["name"] as? String ?? "")
      guard actions(element).contains(action) else {
        throw BridgeError("控件不支持 \(action)；请使用其公开 action 或截图坐标")
      }
      if let r = try? rect(element), let bounds = try? rect(window) {
        presentPointer(
          CGPoint(x: r.midX, y: r.midY), bounds, app.processIdentifier, windowID, "move")
      }
      let result = AXUIElementPerformAction(element, action as CFString)
      guard result == .success else {
        throw BridgeError("AX action failed (\(result.rawValue))", "unknown")
      }
    case "set_value":
      guard let value = args["text"] as? String else { throw BridgeError("text required") }
      try set(element, kAXValueAttribute, value as CFString)
    case "select_text":
      guard let phrase = args["text"] as? String, !phrase.isEmpty else {
        throw BridgeError("select_text requires nonempty text")
      }
      let value = string(element, kAXValueAttribute) as NSString
      let prefix = args["prefix"] as? String ?? ""
      let suffix = args["suffix"] as? String ?? ""
      let needle = prefix + phrase + suffix
      let range = value.range(of: needle)
      guard range.location != NSNotFound else { throw BridgeError("找不到待选文字") }
      let rest = NSRange(
        location: range.location + range.length,
        length: value.length - range.location - range.length)
      guard value.range(of: needle, range: rest).location == NSNotFound else {
        throw BridgeError("文字匹配不唯一；请提供 prefix/suffix")
      }
      let start = range.location + (prefix as NSString).length
      let length = (phrase as NSString).length
      let selectionType = args["selectionType"] as? String ?? "text"
      var selected = CFRange(
        location: selectionType == "cursor_after" ? start + length : start,
        length: selectionType == "text" ? length : 0)
      guard let selection = AXValueCreate(.cfRange, &selected) else {
        throw BridgeError("无法创建文字选择范围")
      }
      try set(element, kAXFocusedAttribute, kCFBooleanTrue)
      try set(element, kAXSelectedTextRangeAttribute, selection)
    default: throw BridgeError("Unknown AX operation")
    }
    if let r = try? rect(element), let bounds = try? rect(window) {
      let point = CGPoint(x: r.midX, y: r.midY)
      if operation == "click" {
        presentPointer(point, bounds, app.processIdentifier, windowID, "up")
      } else {
        presentPointer(point, bounds, app.processIdentifier, windowID, "move")
      }
    }
    // Successful close/cancel actions may destroy the surface before cursor bookkeeping.
    // That must not turn an already-applied action into an applied=no geometry error.
    if let target = try? rect(element), let b = try? rect(window) {
      cursor = CGPoint(x: target.midX - b.minX, y: target.midY - b.minY)
    }
    return [:]
  }
}
