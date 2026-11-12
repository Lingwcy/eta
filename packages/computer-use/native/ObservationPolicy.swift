import Foundation

// An unsupported attribute is absent. Transport, permission and decoding failures
// remain unknown, so callers cannot turn a failed read into a negative condition.
enum ObservationEvidence<Value> {
  case known(Value)
  case absent
  case unknown

  var value: Value? {
    if case .known(let value) = self { return value }
    return nil
  }
  var isUnknown: Bool {
    if case .unknown = self { return true }
    return false
  }
}

struct ObservationBoundary {
  let index: Int
  let reason: String
  var omittedChildren: Int?

  var json: [String: Any] {
    var result: [String: Any] = ["index": index, "reason": reason]
    if let omittedChildren { result["omittedChildren"] = omittedChildren }
    return result
  }
}

struct ObservationBudget {
  static let nodes = 800
  static let rawDepth = 64
  static let textBytes = 48_000
  static let responseBytes = 256_000
  static let reads = 16_000
  let deadline: TimeInterval
  let now: () -> TimeInterval
  var readCount = 0

  init(seconds: TimeInterval = 8, now: @escaping () -> TimeInterval = {
    ProcessInfo.processInfo.systemUptime
  }) {
    self.now = now
    deadline = now() + seconds
  }

  var remaining: TimeInterval { max(0, deadline - now()) }
  var exhausted: String? {
    if remaining <= 0 { return "deadline" }
    if readCount >= Self.reads { return "read_budget" }
    return nil
  }

  mutating func admitRead(count: Bool = false) -> Float? {
    let available = remaining
    guard readCount < Self.reads, available > 0 else { return nil }
    readCount += 1
    // Counting children must leave time for the values. A slow count never gets
    // the entire remaining observation deadline.
    return Float(min(count ? 0.025 : 0.4, available / (count ? 2 : 1)))
  }

  static func transparent(
    role: String, fields: [ObservationEvidence<String>],
    actions: ObservationEvidence<[String]>, writable: ObservationEvidence<Bool>
  ) -> Bool {
    guard ["AXGroup", "AXUnknown", "AXGenericElement"].contains(role),
      !actions.isUnknown, actions.value?.isEmpty != false,
      !writable.isUnknown, writable.value != true
    else { return false }
    return fields.allSatisfy {
      switch $0 {
      case .absent: return true
      case .known(let value): return value.isEmpty
      case .unknown: return false
      }
    }
  }
}
