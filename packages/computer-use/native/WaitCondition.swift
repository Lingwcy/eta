import ApplicationServices
import Foundation

enum WaitCondition {
  case presence(text: String, role: String?, gone: Bool)
  case field(AXUIElement, name: String, expected: String)

  struct Evidence {
    var matches = 0
    var issue: String?

    mutating func record(_ result: ObservationEvidence<Bool>) {
      if result.value == true { matches += 1 }
      if result.isUnknown { issue = issue ?? "field_unknown" }
    }
  }

  static func completion(last: String, final: String?, closed: Bool, inBudget: Bool) -> String {
    if closed { return "target_closed" }
    if last == "ambiguous" || final == "ambiguous" { return "ambiguous" }
    if final == "satisfied" && inBudget { return "satisfied" }
    return last == "satisfied" ? "unconfirmed" : "timeout"
  }

  func result(_ evidence: Evidence) -> String {
    switch self {
    case .presence(_, _, let gone):
      if gone && evidence.matches > 0 { return "unsatisfied" }
      if evidence.matches > 1 { return "ambiguous" }
      if evidence.matches == 1 { return "satisfied" }
      if evidence.issue != nil { return "unknown" }
      return gone ? "satisfied" : "unsatisfied"
    case .field:
      if evidence.issue != nil { return "unknown" }
      return evidence.matches == 1 ? "satisfied" : "unsatisfied"
    }
  }

  func match(_ read: (String) throws -> ObservationEvidence<String>) rethrows -> ObservationEvidence<Bool> {
    switch self {
    case .presence(let text, let role, _):
      if let role {
        let actual = try read(kAXRoleAttribute)
        if actual.isUnknown { return .unknown }
        if actual.value != role { return .known(false) }
      }
      var unknown = false
      for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        let value = try read(name)
        if value.value == text { return .known(true) }
        unknown = unknown || value.isUnknown
      }
      return unknown ? .unknown : .known(false)
    case .field(_, let name, let expected):
      guard let value = try read(name).value else { return .unknown }
      if name == kAXEnabledAttribute && !["0", "1"].contains(value) { return .unknown }
      return .known(value == expected)
    }
  }

  func evaluate(_ tree: ObservationTree) -> Evidence {
    var evidence = Evidence()
    for node in tree.nodes {
      if case .field(let target, _, _) = self, !CFEqual(node.element, target) { continue }
      let match = match { name -> ObservationEvidence<String> in
        if name == kAXRoleAttribute { return node.role }
        if name == kAXValueAttribute {
          return node.fields.first { $0.0 == "value" }?.1
            ?? (node.fields.first { $0.0 == kAXSubroleAttribute }?.1.value == kAXSecureTextFieldSubrole
                ? .absent : .unknown)
        }
        return node.fields.first { $0.0 == name }?.1 ?? .unknown
      }
      evidence.record(match)
      if case .field = self { return evidence }
    }
    if case .field = self { evidence.issue = "element_unobserved" }
    else if let boundary = tree.boundaries.first { evidence.issue = boundary.reason }
    return evidence
  }

  func sample(_ tree: ObservationTree, root: AXUIElement) throws -> Evidence {
    var evidence = Evidence()
    func read(_ element: AXUIElement, _ name: String) throws -> ObservationEvidence<String> {
      if name == kAXValueAttribute {
        let subrole = try tree.read(element, kAXSubroleAttribute)
        if subrole.isUnknown { return .unknown }
        if subrole.value == kAXSecureTextFieldSubrole { return .absent }
      }
      return try tree.read(element, name)
    }
    if case .field(let element, _, _) = self {
      guard try tree.belongs(element, to: root) else {
        evidence.issue = "element_unavailable"
        return evidence
      }
      evidence.record(try match { try read(element, $0) })
      return evidence
    }
    var visited: [CFHashCode: [AXUIElement]] = [:]
    var count = 0
    func walk(_ element: AXUIElement, depth: Int) throws {
      try tree.cancel()
      if let reason = tree.budget.exhausted { evidence.issue = reason; return }
      if depth > ObservationBudget.rawDepth { evidence.issue = "raw_depth"; return }
      if count >= ObservationBudget.nodes { evidence.issue = "nodes"; return }
      let hash = CFHash(element)
      if visited[hash]?.contains(where: { CFEqual($0, element) }) == true {
        evidence.issue = "cycle"
        return
      }
      visited[hash, default: []].append(element)
      count += 1
      evidence.record(try match { try read(element, $0) })
      if evidence.matches > 1 { return }
      guard try tree.prepare(element, count: true) else {
        evidence.issue = tree.budget.exhausted; return
      }
      let (status, total) = tree.reader.count(element)
      if status == .attributeUnsupported || status == .noValue { return }
      guard status == .success, total >= 0 else { evidence.issue = "children_unknown"; return }
      if total == 0 { return }
      let limit = min(total, ObservationBudget.nodes - count)
      if limit < total { evidence.issue = "nodes" }
      guard limit > 0, try tree.prepare(element) else { return }
      let (readStatus, children) = tree.reader.children(element, limit)
      guard readStatus == .success, let children, children.count == limit else {
        evidence.issue = "children_unknown"; return
      }
      for child in children {
        try walk(child, depth: depth + 1)
        if evidence.matches > 1 || tree.budget.exhausted != nil || count >= ObservationBudget.nodes {
          if evidence.matches <= 1 { evidence.issue = tree.budget.exhausted ?? "nodes" }
          return
        }
      }
    }
    try walk(root, depth: 0)
    return evidence
  }
}
