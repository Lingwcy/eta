import AppKit
import ApplicationServices
import Foundation

extension Bridge {
  func settleControlState(
    desired: Bool, cancel: @escaping () throws -> Void,
    read: (ObservationTree) throws -> ControlState.Read
  ) throws -> ControlState.Read {
    let reader = ObservationTree(projection: "compact", cancel: cancel)
    reader.budget = ObservationBudget(seconds: 0.8)
    var latest = ControlState.Read.unknown
    while reader.budget.remaining > 0 {
      try cancel()
      latest = try read(reader)
      if latest == .known(desired) || reader.budget.remaining < 0.08 { break }
      RunLoop.current.run(until: Date().addingTimeInterval(0.06))
    }
    return latest
  }

  func setControlState(
    _ kind: ControlState, desired: Bool, element: AXUIElement,
    app: NSRunningApplication, window: AXUIElement
  ) throws -> [String: Any] {
    let scope = regionRoot ?? window
    let admittedWindow = windowID
    let reader = ObservationTree(projection: "compact") {
      try checkCancellation()
      try self.assertOwnership()
    }
    reader.budget = ObservationBudget(seconds: 1)
    var attribute: String?
    var role: String?
    var command: ControlState.Delivery?
    var prepared = false
    defer { if prepared { finishInput(window) } }
    func readState(_ reader: ObservationTree) throws -> ControlState.Read {
      guard !app.isTerminated, NativeWindowIdentity.windowID(window) == admittedWindow,
        try reader.belongs(scope, to: window), try reader.belongs(element, to: scope)
      else { return .unknown }
      let currentRole = try reader.read(element, kAXRoleAttribute)
      guard let name = currentRole.value else { return .unknown }
      guard kind.supports(name), role == nil || role == name else { return .unsupported }
      role = name
      if let attribute { return kind.parse(try reader.read(element, attribute)) }
      if kind == .expanded {
        let (name, value) = try reader.readDisclosure(element, role: name)
        attribute = name
        return kind.parse(value)
      }
      attribute = kAXValueAttribute
      return kind.parse(try reader.read(element, kAXValueAttribute))
    }
    func delivery() throws -> ControlState.Delivery {
      guard let role, let attribute else { throw BridgeError("无法确认原控件角色") }
      let enabled = kind.parse(try reader.read(element, kAXEnabledAttribute))
      if enabled != .known(true) && enabled != .unsupported {
        throw BridgeError("控件已禁用或无法确认可用状态；未发送状态操作")
      }
      let actions = try reader.readActions(element).value ?? []
      var writable = DarwinBoolean(false)
      let canWrite = try reader.prepare(element) &&
        AXUIElementIsAttributeSettable(element, attribute as CFString, &writable) == .success &&
        writable.boolValue
      guard let delivery = kind.delivery(role: role, desired: desired, actions: actions, writable: canWrite)
      else { throw BridgeError("控件没有支持该目标状态的操作") }
      return delivery
    }
    return try ControlState.change(
      desired: desired, read: { try readState(reader) },
      prepare: {
        _ = try delivery()
        try prepareInput(app, window)
        prepared = true
        command = try delivery()
      },
      deliver: {
        do {
          guard try reader.prepare(element) else { throw BridgeError("状态操作发送前超时") }
        } catch let error as BridgeError {
          throw BridgeError(error.message, reason: error.reason)
        }
        guard let command else { throw BridgeError("未找到状态操作") }
        let result: AXError
        switch command {
        case .action(let action):
          result = AXUIElementPerformAction(element, action as CFString)
        case .write:
          guard let attribute else { throw BridgeError("未找到可写状态属性") }
          let value: CFTypeRef = attribute == kAXValueAttribute
            ? NSNumber(value: desired ? 1 : 0)
            : (desired ? kCFBooleanTrue : kCFBooleanFalse)
          result = AXUIElementSetAttributeValue(element, attribute as CFString, value)
        }
        guard result == .success else {
          throw BridgeError("状态操作投递无法确认 (AX \(result.rawValue))；请先观察状态", "unknown")
        }
      },
      verify: {
        // Restore the foreground before polling the control for asynchronous effects.
        finishInput(window)
        prepared = false
        return try settleControlState(desired: desired, cancel: reader.cancel, read: readState)
      })
  }
}
