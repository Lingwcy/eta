import AppKit
import ApplicationServices
import Foundation

extension Bridge {
  func selectOption(
    _ name: String, container: AXUIElement, app: NSRunningApplication, window: AXUIElement
  ) throws -> [String: Any] {
    let scope = regionRoot ?? window
    let admittedWindow = windowID
    let reader = ObservationTree(projection: "compact") {
      try checkCancellation()
      try self.assertOwnership()
    }
    reader.budget = ObservationBudget(seconds: 1.5)
    let role = try reader.read(container, kAXRoleAttribute).value
    let selectionAttribute: String?
    switch role {
    case kAXPopUpButtonRole: selectionAttribute = nil
    case kAXListRole: selectionAttribute = kAXSelectedChildrenAttribute
    case kAXOutlineRole, kAXTableRole: selectionAttribute = kAXSelectedRowsAttribute
    default: throw BridgeError("select 需要下拉框、列表或表格控件")
    }
    func ownsContainer(_ reader: ObservationTree) throws -> Bool {
      guard !app.isTerminated, NativeWindowIdentity.windowID(window) == admittedWindow,
        try reader.belongs(scope, to: window), try reader.belongs(container, to: scope)
      else { return false }
      return try reader.read(container, kAXRoleAttribute).value == role
    }
    var original: AXUIElement?
    var prepared = false
    defer { if prepared { finishInput(window) } }
    func readSelection(_ reader: ObservationTree) throws -> ControlState.Read {
      guard try ownsContainer(reader), let original else { return .unknown }
      if let selectionAttribute {
        guard try reader.belongs(original, to: container), try reader.prepare(container, count: true)
        else { return .unknown }
        var count: CFIndex = 0
        let key = selectionAttribute as CFString
        guard AXUIElementGetAttributeValueCount(container, key, &count) == .success, count >= 0
        else { return .unknown }
        guard count == 1 else { return .known(false) }
        guard try reader.prepare(container) else { return .unknown }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(container, key, 0, 1, &values) == .success,
          let selected = (values as? [AXUIElement])?.first
        else { return .unknown }
        return .known(CFEqual(selected, original))
      }
      guard let value = try reader.read(container, kAXValueAttribute).value else { return .unknown }
      return .known(value == name)
    }
    func children(_ node: AXUIElement) throws -> [AXUIElement] {
      guard try reader.prepare(node, count: true) else { throw BridgeError("选项读取超时") }
      let (status, count) = reader.reader.count(node)
      if status == .attributeUnsupported || status == .noValue { return [] }
      guard status == .success, (0...256).contains(count) else {
        throw BridgeError("选项列表不完整；未发送选择操作")
      }
      if count == 0 { return [] }
      guard try reader.prepare(node) else { throw BridgeError("选项读取超时") }
      let (result, values) = reader.reader.children(node, count)
      guard result == .success, let values, values.count == count else {
        throw BridgeError("选项列表不完整；未发送选择操作")
      }
      return values
    }
    func roleOf(_ node: AXUIElement) throws -> String {
      guard let role = try reader.read(node, kAXRoleAttribute).value else {
        throw BridgeError("无法确认选项角色；未发送选择操作")
      }
      return role
    }
    func hasLabel(_ node: AXUIElement, depth: Int) throws -> Bool {
      var unknown = false
      for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        let field = try reader.read(node, key)
        if field.value == name { return true }
        unknown = unknown || field.isUnknown
      }
      if depth > 0 {
        for child in try children(node) where try [kAXCellRole, kAXStaticTextRole].contains(roleOf(child)) {
          if try hasLabel(child, depth: depth - 1) { return true }
        }
      }
      if unknown { throw BridgeError("无法确认选项名称唯一；未发送选择操作") }
      return false
    }
    func findOption() throws -> AXUIElement {
      guard try ownsContainer(reader) else { throw BridgeError("原选择控件已失效", reason: "stale_frame") }
      let members: [AXUIElement]
      let roles: Set<String>
      let structural: Set<String>
      if selectionAttribute == nil {
        let menus = try children(container).filter { try roleOf($0) == kAXMenuRole }
        guard menus.count == 1 else { throw BridgeError("请先打开原下拉框并观察其选项，再调用 select") }
        members = try children(menus[0])
        roles = [kAXMenuItemRole]
        structural = ["AXSeparator"]
      } else {
        members = try children(container)
        roles = [kAXRowRole, "AXListItem", "AXOption", kAXMenuItemRole, kAXStaticTextRole]
        structural = [kAXColumnRole, "AXHeader"]
      }
      var found: AXUIElement?
      for option in members {
        let role = try roleOf(option)
        if structural.contains(role) { continue }
        guard roles.contains(role) else { throw BridgeError("选项结构不受支持；未发送选择操作") }
        if try !hasLabel(option, depth: selectionAttribute == nil ? 0 : 2) { continue }
        if let found, !CFEqual(found, option) {
          throw BridgeError("原控件存在多个同名选项；未发送选择操作")
        }
        found = option
      }
      guard let found else { throw BridgeError("原控件没有匹配选项；未发送选择操作") }
      guard try reader.belongs(found, to: container) else {
        throw BridgeError("无法确认选项归属；未发送选择操作", reason: "stale_frame")
      }
      return found
    }
    func validateDelivery(_ option: AXUIElement) throws {
      for node in [container, option] {
        let enabled = ControlState.checked.parse(try reader.read(node, kAXEnabledAttribute))
        if enabled != .known(true) && enabled != .unsupported {
          throw BridgeError("选择控件或选项已禁用，或可用状态未知")
        }
      }
      if let selectionAttribute {
        var writable = DarwinBoolean(false)
        guard try reader.prepare(container),
          AXUIElementIsAttributeSettable(container, selectionAttribute as CFString, &writable) == .success,
          writable.boolValue
        else { throw BridgeError("原控件不支持可读写的单项选择") }
      } else {
        guard try reader.readActions(option).value?.contains(kAXPressAction) == true else {
          throw BridgeError("选项没有公开 AXPress")
        }
      }
    }
    return try ControlState.change(
      desired: true,
      read: {
        let option = try findOption()
        if let original, !CFEqual(original, option) {
          throw BridgeError("原选项已被替换", reason: "stale_frame")
        }
        original = option
        return try readSelection(reader)
      },
      prepare: {
        guard let original else { throw BridgeError("缺少原选项") }
        try validateDelivery(original)
        try prepareInput(app, window)
        prepared = true
      },
      deliver: {
        let option: AXUIElement
        do {
          guard let selected = original else { throw BridgeError("缺少原选项") }
          try validateDelivery(selected)
          let target = selectionAttribute == nil ? selected : container
          guard try reader.prepare(target) else { throw BridgeError("选择投递前超时") }
          option = selected
        } catch let error as BridgeError {
          throw BridgeError(error.message, reason: error.reason)
        }
        let result: AXError
        if let selectionAttribute {
          result = AXUIElementSetAttributeValue(container, selectionAttribute as CFString, [option] as CFArray)
        } else {
          result = AXUIElementPerformAction(option, kAXPressAction as CFString)
        }
        guard result == .success else {
          throw BridgeError("选择投递无法确认 (AX \(result.rawValue))；请先观察状态", "unknown")
        }
      },
      verify: {
        finishInput(window)
        prepared = false
        return try settleControlState(desired: true, cancel: reader.cancel, read: readSelection)
      })
  }
}
