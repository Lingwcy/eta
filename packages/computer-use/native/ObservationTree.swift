import ApplicationServices
import Foundation

// Keep AX transport failures intact at the traversal boundary. The same reader
// contract lets native controls exercise partial reads and graphs deterministically.
struct ObservationReader {
  var attribute: (AXUIElement, String) -> (AXError, CFTypeRef?) = { element, name in
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (result, value)
  }
  var actions: (AXUIElement) -> (AXError, [String]?) = { element in
    var value: CFArray?
    let result = AXUIElementCopyActionNames(element, &value)
    return (result, value as? [String])
  }
  var writable: (AXUIElement) -> (AXError, Bool) = { element in
    var value = DarwinBoolean(false)
    let result = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &value)
    return (result, value.boolValue)
  }
  var count: (AXUIElement) -> (AXError, Int) = { element in
    var value: CFIndex = 0
    let result = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &value)
    return (result, value)
  }
  var children: (AXUIElement, Int) -> (AXError, [AXUIElement]?) = { element, maximum in
    var value: CFArray?
    let result = AXUIElementCopyAttributeValues(
      element, kAXChildrenAttribute as CFString, 0, maximum, &value)
    return (result, value as? [AXUIElement])
  }
  var timeout: (AXUIElement, Float) -> Void = { element, timeout in
    AXUIElementSetMessagingTimeout(element, timeout)
  }
}

// Candidate records and handles are private until WindowObservation publishes the
// completed response. Rendering never reads AX or changes the index map.
final class ObservationTree {
  struct Node {
    let element: AXUIElement
    let index: Int
    let depth: Int
    let role: ObservationEvidence<String>
    let fields: [(String, ObservationEvidence<String>)]
    let available: ObservationEvidence<[String]>
    let writable: ObservationEvidence<Bool>
    let transparent: Bool

    func render(_ projection: String) -> String {
      var parts = ["\(String(repeating: "  ", count: depth))[\(index)] \(role.value ?? "AXUnknown")"]
      for (name, value) in fields {
        if projection != "full"
          && ["AXRoleDescription", "AXHelp", "AXSubrole"].contains(name) { continue }
        if name == kAXEnabledAttribute {
          if value.value == "0" { parts.append("disabled") }
        } else if let value = value.value, !value.isEmpty {
          parts.append("\(name)=\(quoted(value))")
        }
      }
      if writable.value == true { parts.append("settable") }
      if let actions = available.value, !actions.isEmpty {
        parts.append("actions=\(actions.joined(separator: ","))")
      }
      return parts.joined(separator: " ")
    }
  }

  var budget = ObservationBudget()
  var nodes: [Node] = []
  var boundaries: [ObservationBoundary] = []
  var unknown: [[String: Any]] = []
  var buckets: [CFHashCode: [AXUIElement]] = [:]
  var textBytes = 0
  var textLimitReached = false
  var visitedNodes = 0
  var projection: String
  let cancel: () throws -> Void
  let reader: ObservationReader

  init(
    projection: String, reader: ObservationReader = ObservationReader(),
    cancel: @escaping () throws -> Void
  ) {
    self.projection = projection
    self.reader = reader
    self.cancel = cancel
  }

  func prepare(_ element: AXUIElement, count: Bool = false) throws -> Bool {
    try cancel()
    guard let timeout = budget.admitRead(count: count) else { return false }
    reader.timeout(element, timeout)
    return true
  }

  func read(_ element: AXUIElement, _ name: String) throws -> ObservationEvidence<String> {
    guard try prepare(element) else { return .unknown }
    let (result, raw) = reader.attribute(element, name)
    if result == .attributeUnsupported || result == .noValue { return .absent }
    guard result == .success, let raw else { return .unknown }
    if let value = raw as? String { return .known(String(value.prefix(1201))) }
    if let value = raw as? NSNumber { return .known(value.stringValue) }
    return .unknown
  }

  func readActions(_ element: AXUIElement) throws -> ObservationEvidence<[String]> {
    guard try prepare(element) else { return .unknown }
    let (result, raw) = reader.actions(element)
    if result == .notImplemented || result == .attributeUnsupported { return .absent }
    guard result == .success, let values = raw, values.count <= 128,
      values.allSatisfy({ $0.utf8.count <= 128 })
    else { return .unknown }
    return .known(values)
  }

  func readDisclosure(_ element: AXUIElement, role: String) throws -> (String, ObservationEvidence<String>) {
    let value = try read(element, kAXExpandedAttribute)
    guard case .absent = value, role != "AXButton" else { return (kAXExpandedAttribute, value) }
    let disclosing = try read(element, "AXDisclosing")
    // AppKit disclosure triangles can expose their 0/1 disclosure state as AXValue.
    if case .absent = disclosing, role == "AXDisclosureTriangle" {
      return (kAXValueAttribute, try read(element, kAXValueAttribute))
    }
    return ("AXDisclosing", disclosing)
  }

  func readWritable(_ element: AXUIElement) throws -> ObservationEvidence<Bool> {
    guard try prepare(element) else { return .unknown }
    let (result, writable) = reader.writable(element)
    if result == .attributeUnsupported || result == .noValue { return .absent }
    return result == .success ? .known(writable) : .unknown
  }

  func boundary(_ index: Int, _ reason: String, omitted: Int? = nil) {
    boundaries.append(.init(index: index, reason: reason, omittedChildren: omitted))
  }

  func resetCandidate() {
    nodes = []
    boundaries = []
    unknown = []
    buckets = [:]
    textBytes = 0
    textLimitReached = false
  }

  func belongs(_ element: AXUIElement, to window: AXUIElement) throws -> Bool {
    var current = element
    var visited: [AXUIElement] = []
    for _ in 0...ObservationBudget.rawDepth {
      guard let role = try read(current, kAXRoleAttribute).value, !role.isEmpty else { return false }
      if CFEqual(current, window) { return true }
      if visited.contains(where: { CFEqual($0, current) }) { return false }
      visited.append(current)
      guard try prepare(current) else { return false }
      let (result, raw) = reader.attribute(current, kAXParentAttribute)
      guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        return false
      }
      current = raw as! AXUIElement
    }
    return false
  }

  func walk(_ element: AXUIElement, rawDepth: Int = 0, depth: Int = 0, parent: Int = 0) throws {
    try cancel()
    if let reason = budget.exhausted { boundary(parent, reason); return }
    if textLimitReached { boundary(parent, "text_bytes"); return }
    guard rawDepth <= ObservationBudget.rawDepth else {
      boundary(parent, "raw_depth"); return
    }
    guard nodes.count < ObservationBudget.nodes else { boundary(parent, "nodes"); return }
    let hash = CFHash(element)
    if buckets[hash]?.contains(where: { CFEqual($0, element) }) == true {
      boundary(parent, "cycle"); return
    }
    buckets[hash, default: []].append(element)
    visitedNodes += 1
    let index = nodes.count
    let role = try read(element, kAXRoleAttribute)
    var fields: [(String, ObservationEvidence<String>)] = []
    for name in [
      kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
      kAXIdentifierAttribute, "AXPlaceholderValue", kAXEnabledAttribute,
    ] {
      fields.append((name, try read(element, name)))
    }
    let subrole = fields[0].1
    if let name = role.value, ControlState.expanded.supports(name) {
      fields.append(("expanded", try readDisclosure(element, role: name).1))
    }
    // Unknown subrole cannot prove this is safe to expose.
    if !subrole.isUnknown && subrole.value != kAXSecureTextFieldSubrole {
      fields.append(("value", try read(element, kAXValueAttribute)))
      fields.append(("selected", try read(element, kAXSelectedTextAttribute)))
    }
    if projection == "full" {
      fields.append((kAXRoleDescriptionAttribute, try read(element, kAXRoleDescriptionAttribute)))
      fields.append((kAXHelpAttribute, try read(element, kAXHelpAttribute)))
    }
    let available = try readActions(element)
    let writable = try readWritable(element)
    let enabled = fields.first { $0.0 == kAXEnabledAttribute }!.1
    let transparent = !enabled.isUnknown && enabled.value != "0" && ObservationBudget.transparent(
      role: role.value ?? "",
      fields: fields.filter { $0.0 != kAXEnabledAttribute }.map(\.1),
      actions: available, writable: writable)
    let node = Node(
      element: element, index: index, depth: depth, role: role, fields: fields,
      available: available, writable: writable, transparent: transparent)
    // Always expose the root and every boundary handle. Transparent wrappers
    // still consume raw traversal and index budgets.
    let visible = projection == "full" || !transparent || index == 0
    let size = visible ? node.render(projection).utf8.count + 1 : 0
    guard textBytes + size <= ObservationBudget.textBytes else {
      textLimitReached = true
      boundary(parent, "text_bytes"); return
    }
    textBytes += size
    nodes.append(node)
    if fields.contains(where: { ($0.1.value?.count ?? 0) > 1200 }) {
      boundary(index, "field_truncated")
    }
    var unread = fields.filter { $0.1.isUnknown }.map(\.0)
    if role.isUnknown { unread.append("role") }
    if available.isUnknown { unread.append("actions") }
    if writable.isUnknown { unread.append("settable") }
    if !unread.isEmpty { unknown.append(["index": index, "fields": unread]) }

    let nextDepth = depth + (projection != "full" && transparent ? 0 : 1)
    let namedRegion = index != 0
      && ["AXGroup", "AXScrollArea", "AXWebArea", "AXSplitGroup", "AXOutline", "AXTable"]
        .contains(role.value ?? "")
      && fields.contains { [kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute]
        .contains($0.0) && $0.1.value?.isEmpty == false }
    if projection == "overview" && (nextDepth > 3 || namedRegion) {
      // Do not count children merely to decorate an intentional shallow boundary.
      boundary(index, "projection"); return
    }
    if projection == "full" && nextDepth > 24 { boundary(index, "depth"); return }
    if let reason = budget.exhausted { boundary(index, reason); return }
    guard try prepare(element, count: true) else {
      boundary(index, budget.exhausted ?? "deadline"); return
    }
    let (result, count) = reader.count(element)
    if result == .attributeUnsupported || result == .noValue { return }
    guard result == .success, count >= 0 else { boundary(index, "children_unknown"); return }
    guard count > 0 else { return }
    let maximum = min(count, ObservationBudget.nodes - nodes.count)
    guard maximum > 0 else { boundary(index, "nodes", omitted: count); return }
    guard try prepare(element) else {
      boundary(index, budget.exhausted ?? "deadline", omitted: count); return
    }
    let (childResult, values) = reader.children(element, maximum)
    guard childResult == .success, let children = values, children.count == maximum
    else { boundary(index, "children_unknown"); return }
    for (offset, child) in children.enumerated() {
      if let reason = budget.exhausted {
        boundary(index, reason, omitted: count - offset); return
      }
      if nodes.count >= ObservationBudget.nodes || textLimitReached {
        boundary(index, nodes.count >= ObservationBudget.nodes ? "nodes" : "text_bytes",
          omitted: count - offset)
        return
      }
      try walk(child, rawDepth: rawDepth + 1, depth: nextDepth, parent: index)
    }
    if count > maximum { boundary(index, "child_list", omitted: count - maximum) }
  }

  var visibleNodes: [Node] {
    let boundaryIndexes = Set(boundaries.map(\.index))
    return nodes.filter { projection == "full" || !$0.transparent || $0.index == 0
      || boundaryIndexes.contains($0.index) }
  }

  var text: String { visibleNodes.map { $0.render(projection) }.joined(separator: "\n") }

  func response(_ base: [String: Any], scope: String, fallback: String?) throws -> [String: Any] {
    var result = base
    while true {
      try cancel()
      let text = self.text
      result["text"] = text
      result["observation"] = evidence(scope: scope, fallback: fallback)
      let data = try JSONSerialization.data(withJSONObject: result)
      let textOversized = text.utf8.count > ObservationBudget.textBytes
      if data.count <= ObservationBudget.responseBytes - 64 && !textOversized { return result }
      guard nodes.count > 1 else { throw BridgeError("观察响应超出编码大小限制") }
      nodes.removeLast(max(1, nodes.count / 4))
      unknown.removeAll { ($0["index"] as? Int ?? Int.max) >= nodes.count }
      boundaries.removeAll { $0.index >= nodes.count
        || $0.reason == "response_bytes" || $0.reason == "text_bytes" }
      boundary(0, textOversized ? "text_bytes" : "response_bytes")
    }
  }

  func evidence(scope: String, fallback: String?) -> [String: Any] {
    var result: [String: Any] = [
      "scope": scope, "projection": projection,
      "complete": boundaries.allSatisfy { $0.reason == "projection" } && unknown.isEmpty,
      "exhaustive": boundaries.isEmpty && unknown.isEmpty,
      "boundaries": boundaries.map(\.json), "unknown": unknown,
      "visitedNodes": visitedNodes, "axReads": budget.readCount,
    ]
    if let fallback { result["fallback"] = fallback }
    return result
  }
}
