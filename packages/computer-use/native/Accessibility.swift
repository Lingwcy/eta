import AppKit
import ApplicationServices
import Darwin
import Foundation

// JSON-lines bridge. AX handles stay in this process and expire with their observation.
struct BridgeError: Error {
  let message: String
  let applied: String
  let reason: String?
  init(_ message: String, _ applied: String = "no", reason: String? = nil) {
    self.message = message
    self.applied = applied
    self.reason = reason
  }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value
}
func axNode(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
    return nil
  }
  return (value as! AXUIElement)
}
func appWindows(_ root: AXUIElement) -> [AXUIElement] {
  PublishedWindows.merge(
    listed: elements(root, kAXWindowsAttribute, 32),
    focused: axNode(root, kAXFocusedWindowAttribute), main: axNode(root, kAXMainWindowAttribute),
    equal: { CFEqual($0, $1) })
}
func validWindowSurface(_ element: AXUIElement, _ pid: pid_t) -> Bool {
  var owner: pid_t = 0
  guard AXUIElementGetPid(element, &owner) == .success, owner == pid else { return false }
  let role = string(element, kAXRoleAttribute)
  if role == kAXWindowRole { return true }
  // A modal sheet can be the app's AXFocusedWindow. Admit its native window only when
  // AX still anchors it to an actual window of this app; never accept an application root.
  guard role == kAXSheetRole,
    let host = axNode(element, kAXWindowAttribute) ?? axNode(element, kAXParentAttribute),
    !CFEqual(element, host), string(host, kAXRoleAttribute) == kAXWindowRole,
    AXUIElementGetPid(host, &owner) == .success, owner == pid,
    NativeWindowIdentity.windowID(host) != nil
  else { return false }
  return true
}
func elements(_ element: AXUIElement, _ name: String, _ maximum: Int = 800) -> [AXUIElement] {
  var count: CFIndex = 0
  guard AXUIElementGetAttributeValueCount(element, name as CFString, &count) == .success, count > 0
  else { return [] }
  var values: CFArray?
  guard
    AXUIElementCopyAttributeValues(element, name as CFString, 0, min(count, maximum), &values)
      == .success
  else { return [] }
  return values as? [AXUIElement] ?? []
}
func string(_ element: AXUIElement, _ name: String) -> String {
  guard let value = attribute(element, name) else { return "" }
  if let text = value as? String { return text }
  if let number = value as? NSNumber { return number.stringValue }
  return ""
}
func actions(_ element: AXUIElement) -> [String] {
  var values: CFArray?
  guard AXUIElementCopyActionNames(element, &values) == .success else { return [] }
  return values as? [String] ?? []
}
func set(_ element: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
  let result = AXUIElementSetAttributeValue(element, name as CFString, value)
  guard result == .success else {
    throw BridgeError(
      "AX set \(name) failed (\(result.rawValue)); observe again or use a screenshot", "unknown")
  }
}
func quoted(_ value: String) -> String {
  let data = try? JSONSerialization.data(withJSONObject: [String(value.prefix(1200))])
  let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
  return String(text.dropFirst().dropLast())
}

func rect(_ element: AXUIElement) throws -> CGRect {
  guard let p = attribute(element, kAXPositionAttribute),
    let s = attribute(element, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
    CFGetTypeID(s) == AXValueGetTypeID()
  else { throw BridgeError("目标窗口没有有效位置") }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
    AXValueGetValue(s as! AXValue, .cgSize, &size), size.width > 0, size.height > 0
  else { throw BridgeError("目标窗口位置无效") }
  return CGRect(origin: point, size: size)
}
func boundsJSON(_ r: CGRect) -> [String: Double] {
  ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}
