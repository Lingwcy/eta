import AppKit
import ApplicationServices
import Foundation

extension Bridge {
  func waitUntil(_ args: [String: Any]) throws -> [String: Any] {
    guard let id = args["id"] as? String, !id.isEmpty, id == snapshot,
      let app = application, let window, menuBarTarget == nil
    else { throw BridgeError("条件等待需要最新窗口观察", reason: "stale_frame") }
    guard let duration = args["timeoutMs"] as? Int, (250...10_000).contains(duration),
      let raw = args["condition"] as? [String: Any], let kind = raw["kind"] as? String
    else { throw BridgeError("Invalid wait condition or timeoutMs") }
    let condition: WaitCondition
    switch kind {
    case "present", "absent":
      guard let text = raw["text"] as? String, !text.isEmpty, text.utf16.count <= 1200,
        raw["role"] == nil || (raw["role"] as? String)?.isEmpty == false
      else { throw BridgeError("Invalid wait text or role") }
      condition = .presence(text: text, role: raw["role"] as? String, gone: kind == "absent")
    case "enabled", "value":
      guard let index = raw["elementIndex"] as? Int, visibleIndexes.contains(index) else {
        throw BridgeError("等待控件不属于当前观察", reason: "stale_frame")
      }
      if kind == "enabled", let enabled = raw["equals"] as? Bool {
        condition = .field(indexed[index], name: kAXEnabledAttribute, expected: enabled ? "1" : "0")
      } else if kind == "value", let value = raw["equals"] as? String, value.utf16.count <= 1200 {
        condition = .field(indexed[index], name: kAXValueAttribute, expected: value)
      } else { throw BridgeError("Invalid expected wait value") }
    default: throw BridgeError("Invalid wait condition kind")
    }

    let root = regionRoot ?? window
    let total = Double(duration) / 1000
    let budget = ObservationBudget(seconds: total)
    let pollUntil = budget.deadline - min(1, total / 2)
    let cancel = {
      try checkCancellation()
      try self.assertOwnership()
    }
    var last = "unknown"
    var lastKnown: String?
    var reason: String?
    var samples = 0
    var probeReads = 0
    var closed = false
    func windowIsClosed(_ reader: ObservationTree) throws -> Bool {
      if app.isTerminated { return true }
      guard try reader.prepare(window) else { return false }
      let (status, _) = reader.reader.attribute(window, kAXRoleAttribute)
      return status == .invalidUIElement
    }
    while budget.now() < pollUntil {
      let reader = ObservationTree(projection: "compact", cancel: cancel)
      reader.budget = ObservationBudget(seconds: min(0.35, pollUntil - budget.now()))
      defer { probeReads += reader.budget.readCount }
      if try windowIsClosed(reader) { closed = true; break }
      let evidence: WaitCondition.Evidence
      if regionRoot != nil, try !reader.belongs(root, to: window) {
        evidence = .init(issue: "region_unavailable")
      } else {
        evidence = try condition.sample(reader, root: root)
      }
      samples += 1
      last = condition.result(evidence)
      if last != "unknown" { lastKnown = last }
      reason = evidence.issue
      if last == "satisfied" || last == "ambiguous" { break }
      // Run the loop in short slices so SIGTERM and takeover can interrupt the delay.
      let wake = min(pollUntil, budget.now() + 0.15)
      while budget.now() < wake {
        try cancel()
        RunLoop.current.run(until: Date().addingTimeInterval(min(0.025, max(0, wake - budget.now()))))
      }
    }
    try cancel()
    var outcome: [String: Any] = ["last": last, "samples": samples, "probeReads": probeReads]
    if let lastKnown { outcome["lastKnown"] = lastKnown }
    if let reason { outcome["reason"] = reason }
    var state: [String: Any]?
    if !closed {
      var final: WaitCondition.Evidence?
      var target: [String: Any] = [
        "app": "pid:\(app.processIdentifier)", "previousId": id,
        "projection": args["projection"] as? String ?? "full", "presentation": presentation,
      ]
      if regionRoot != nil { target["rootIndex"] = 0 }
      do {
        state = try observe(target, budget: budget) { final = condition.evaluate($0) }
        // Keep the app selector stable for app hints and subsequent observations.
        if let appName = args["app"] as? String { state?["app"] = appName }
      } catch {
        try cancel()
        let reader = ObservationTree(projection: "compact", cancel: cancel)
        reader.budget = budget
        closed = try windowIsClosed(reader)
        if !closed, budget.remaining > 0, let error = error as? BridgeError,
          error.reason != "stale_frame" { throw error }
        if !closed { outcome["reason"] = "final_observation_unavailable" }
      }
      if let final {
        let status = condition.result(final)
        outcome["final"] = status
        if let issue = final.issue { outcome["reason"] = issue }
      }
    }
    if state == nil { snapshot = "" }
    outcome["status"] = WaitCondition.completion(
      last: last, final: outcome["final"] as? String, closed: closed, inBudget: budget.remaining > 0)
    var result: [String: Any] = ["outcome": outcome]
    if let state { result["state"] = state }
    return result
  }
}
