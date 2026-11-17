import Foundation

enum ControlState: String {
  case checked = "set_checked"
  case expanded = "set_expanded"

  enum Read: Equatable {
    case known(Bool)
    case mixed
    case unsupported
    case unknown
  }

  enum Delivery: Equatable {
    case action(String)
    case write
  }

  func supports(_ role: String) -> Bool {
    switch self {
    case .checked: return ["AXCheckBox", "AXSwitch", "AXRadioButton"].contains(role)
    case .expanded: return ["AXButton", "AXDisclosureTriangle", "AXRow", "AXOutlineRow", "AXTreeItem"].contains(role)
    }
  }

  func parse(_ value: ObservationEvidence<String>) -> Read {
    switch value {
    case .absent: return .unsupported
    case .unknown: return .unknown
    case .known(let value):
      switch value.lowercased() {
      case "0", "false": return .known(false)
      case "1", "true": return .known(true)
      case "2", "mixed": return self == .checked ? .mixed : .unknown
      default: return .unknown
      }
    }
  }

  func delivery(role: String, desired: Bool, actions: [String], writable: Bool) -> Delivery? {
    guard supports(role) else { return nil }
    if self == .checked {
      if role == "AXRadioButton" && !desired { return nil }
      if actions.contains("AXPress") { return .action("AXPress") }
      return writable && role != "AXRadioButton" ? .write : nil
    }
    let direction = desired ? "AXExpand" : "AXCollapse"
    if actions.contains(direction) { return .action(direction) }
    if writable { return .write }
    return ["AXButton", "AXDisclosureTriangle"].contains(role) && actions.contains("AXPress")
      ? .action("AXPress") : nil
  }

  static func change(
    desired: Bool, read: () throws -> Read, prepare: () throws -> Void,
    deliver: () throws -> Void, verify: () throws -> Read
  ) throws -> [String: Any] {
    func alreadySatisfied(_ value: Read) throws -> Bool {
      switch value {
      case .known(let current): return current == desired
      case .mixed: throw BridgeError("控件处于混合状态；未发送状态操作")
      case .unsupported: throw BridgeError("控件不支持该状态操作")
      case .unknown: throw BridgeError("无法读取控件当前状态；未发送状态操作")
      }
    }
    let noOp: [String: Any] = ["applied": "no", "verification": ["status": "satisfied", "noOp": true]]
    do {
      if try alreadySatisfied(read()) { return noOp }
      try prepare()
      if try alreadySatisfied(read()) { return noOp }
    } catch let error as BridgeError {
      throw BridgeError(error.message, reason: error.reason)
    }
    try deliver()
    let outcome: Read
    do { outcome = try verify() }
    catch let error as BridgeError {
      throw BridgeError(error.message, "yes", reason: error.reason)
    } catch {
      throw BridgeError(error.localizedDescription, "yes")
    }
    var verification = ["status": "unknown"]
    if case .known(let current) = outcome {
      verification["status"] = current == desired ? "satisfied" : "unsatisfied"
    } else {
      verification["reason"] = outcome == .mixed ? "mixed_state" : "state_unavailable"
    }
    return ["applied": "yes", "verification": verification]
  }
}
