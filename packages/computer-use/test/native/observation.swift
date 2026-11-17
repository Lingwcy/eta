import ApplicationServices
import Foundation

func testObservation() throws {
  var clock: TimeInterval = 10
  var budget = ObservationBudget(seconds: 8, now: { clock })
  assert(budget.admitRead(count: true)! <= 0.025)
  clock = 17.99
  assert(budget.admitRead()! <= 0.011)
  clock = 18
  assert(budget.admitRead() == nil)
  assert(budget.exhausted == "deadline")

  let handles = (0..<900).map { AXUIElementCreateApplication(pid_t(100_000 + $0)) }
  func id(_ element: AXUIElement) -> Int {
    var pid: pid_t = 0
    assert(AXUIElementGetPid(element, &pid) == .success)
    return Int(pid) - 100_000
  }
  func reader(
    children: @escaping (Int) -> [Int],
    label: @escaping (Int) -> String = { "Region \($0)" }
  ) -> ObservationReader {
    ObservationReader(
      attribute: { element, name in
        if name == kAXRoleAttribute { return (.success, "AXGroup" as CFString) }
        if name == kAXTitleAttribute { return (.success, label(id(element)) as CFString) }
        return (.attributeUnsupported, nil)
      },
      actions: { _ in (.success, []) },
      writable: { _ in (.success, false) },
      count: { (.success, children(id($0)).count) },
      children: { element, maximum in
        (.success, children(id(element)).prefix(maximum).map { handles[$0] })
      },
      timeout: { _, _ in })
  }
  let graph = reader(children: { $0 < 8 ? [$0 + 1] : [] })
  let overview = ObservationTree(projection: "overview", reader: graph, cancel: {})
  try overview.walk(handles[0])
  assert(overview.nodes.count == 2)
  assert(overview.boundaries.last?.reason == "projection")
  assert(overview.boundaries.last?.omittedChildren == nil)
  assert(overview.evidence(scope: "window", fallback: nil)["complete"] as? Bool == true)
  assert(overview.evidence(scope: "window", fallback: nil)["exhaustive"] as? Bool == false)
  let region = ObservationTree(projection: "compact", reader: graph, cancel: {})
  try region.walk(handles[3])
  assert(region.nodes.count == 6)
  assert(region.text.contains("Region 8"))
  var owned = graph
  owned.attribute = { element, name in
    if name == kAXRoleAttribute { return (.success, "AXGroup" as CFString) }
    if name == kAXParentAttribute && id(element) > 0 {
      return (.success, handles[id(element) - 1])
    }
    return (.attributeUnsupported, nil)
  }
  let ownership = ObservationTree(projection: "compact", reader: owned, cancel: {})
  let belongs = try ownership.belongs(handles[8], to: handles[0])
  let otherWindow = try ownership.belongs(handles[8], to: handles[9])
  assert(belongs && !otherWindow)
  owned.attribute = { element, name in
    if name == kAXRoleAttribute { return (.success, "AXGroup" as CFString) }
    if name == kAXParentAttribute { return (.success, element) }
    return (.cannotComplete, nil)
  }
  let detached = ObservationTree(projection: "compact", reader: owned, cancel: {})
  let cyclicParent = try detached.belongs(handles[8], to: handles[0])
  assert(!cyclicParent)
  owned.attribute = { _, _ in (.invalidUIElement, nil) }
  let stale = ObservationTree(projection: "compact", reader: owned, cancel: {})
  let invalidRoot = try stale.belongs(handles[0], to: handles[0])
  assert(!invalidRoot)

  // Unknown naming evidence keeps a wrapper visible. Confirmed empty wrappers
  // reduce logical depth while the independent raw-depth budget still stops them.
  var wrapper = reader(children: { $0 < 100 ? [$0 + 1] : [] }, label: { _ in "" })
  let deep = ObservationTree(projection: "overview", reader: wrapper, cancel: {})
  try deep.walk(handles[0])
  assert(deep.nodes.count == ObservationBudget.rawDepth + 1)
  assert(deep.boundaries.last?.reason == "raw_depth")
  wrapper.attribute = { _, name in
    if name == kAXRoleAttribute { return (.success, "AXGroup" as CFString) }
    if name == kAXTitleAttribute { return (.cannotComplete, nil) }
    return (.attributeUnsupported, nil)
  }
  let unknown = ObservationTree(projection: "overview", reader: wrapper, cancel: {})
  try unknown.walk(handles[0])
  assert(unknown.nodes.count == 4)
  assert(!unknown.unknown.isEmpty)
  assert(unknown.evidence(scope: "window", fallback: nil)["complete"] as? Bool == false)

  var failed = graph
  failed.count = { _ in (.cannotComplete, 0) }
  let countFailure = ObservationTree(projection: "compact", reader: failed, cancel: {})
  try countFailure.walk(handles[0])
  assert(countFailure.boundaries.first?.reason == "children_unknown")
  assert(countFailure.boundaries.first?.omittedChildren == nil)
  failed.count = { _ in (.success, 8) }
  failed.children = { _, _ in (.cannotComplete, nil) }
  let listFailure = ObservationTree(projection: "compact", reader: failed, cancel: {})
  try listFailure.walk(handles[0])
  assert(listFailure.boundaries.first?.reason == "children_unknown")

  let appeared = WaitCondition.presence(text: "Region 8", role: "AXGroup", gone: false)
  let disappeared = WaitCondition.presence(text: "Region 8", role: "AXGroup", gone: true)
  let before = ObservationTree(projection: "compact", reader: reader(children: { _ in [] }), cancel: {})
  let firstSample = try appeared.sample(before, root: handles[0])
  assert(appeared.result(firstSample) == "unsatisfied")
  assert(disappeared.result(firstSample) == "satisfied")
  let after = ObservationTree(projection: "compact", reader: graph, cancel: {})
  let secondSample = try appeared.sample(after, root: handles[0])
  assert(appeared.result(secondSample) == "satisfied")
  assert(disappeared.result(secondSample) == "unsatisfied")
  let failedSample = try disappeared.sample(listFailure, root: handles[0])
  assert(disappeared.result(failedSample) == "unknown")
  assert(disappeared.result(disappeared.evaluate(overview)) == "unknown")
  assert(disappeared.result(disappeared.evaluate(unknown)) == "unknown")
  let duplicates = ObservationTree(
    projection: "compact", reader: reader(children: { $0 == 0 ? [1, 2] : [] },
      label: { _ in "Region 8" }), cancel: {})
  let duplicateSample = try appeared.sample(duplicates, root: handles[0])
  assert(appeared.result(duplicateSample) == "ambiguous")
  let replaced = WaitCondition.field(handles[2], name: kAXValueAttribute, expected: "Alex")
  assert(replaced.result(replaced.evaluate(before)) == "unknown")
  let unknownEnabled = WaitCondition.field(handles[0], name: kAXEnabledAttribute, expected: "0")
  let unknownState = try unknownEnabled.sample(before, root: handles[0])
  assert(unknownEnabled.result(unknownState) == "unknown")
  try before.walk(handles[0])
  let final = appeared.result(appeared.evaluate(before))
  assert(WaitCondition.completion(last: "satisfied", final: final, closed: false, inBudget: true) == "unconfirmed")
  assert(WaitCondition.completion(last: "satisfied", final: "satisfied", closed: true, inBudget: true) == "target_closed")
  assert(WaitCondition.completion(last: "unsatisfied", final: "satisfied", closed: false, inBudget: false) == "timeout")

  let cycle = ObservationTree(
    projection: "compact", reader: reader(children: { $0 == 0 ? [1] : [0] }), cancel: {})
  try cycle.walk(handles[0])
  assert(cycle.nodes.count == 2)
  assert(cycle.boundaries.last?.reason == "cycle")
  let readLimited = ObservationTree(projection: "compact", reader: graph, cancel: {})
  readLimited.budget.readCount = ObservationBudget.reads - 1
  try readLimited.walk(handles[0])
  assert(readLimited.budget.readCount == ObservationBudget.reads)
  assert(readLimited.boundaries.last?.reason == "read_budget")
  let textLimited = ObservationTree(
    projection: "compact",
    reader: reader(children: { $0 == 0 ? Array(1..<100) : [] },
      label: { _ in String(repeating: "界", count: 1201) }), cancel: {})
  try textLimited.walk(handles[0])
  assert(textLimited.text.utf8.count <= ObservationBudget.textBytes)
  assert(textLimited.boundaries.contains { $0.reason == "field_truncated" })
  assert(textLimited.boundaries.contains { $0.reason == "text_bytes" })
  let wide = ObservationTree(
    projection: "compact", reader: reader(children: { $0 == 0 ? Array(1..<900) : [] }), cancel: {})
  try wide.walk(handles[0])
  assert(wide.nodes.count <= ObservationBudget.nodes)
  assert(wide.boundaries.contains { $0.reason == "child_list" || $0.reason == "nodes" })

  let encoded = ObservationTree(projection: "compact", reader: graph, cancel: {})
  // Escaped control characters are small UTF-8 input but expand sixfold in JSON.
  for index in 0..<150 {
    encoded.nodes.append(.init(
      element: handles[index], index: index, depth: 0,
      role: .known(String(repeating: "\u{1}", count: 300)), fields: [],
      available: .known([]), writable: .known(false), transparent: false))
  }
  let response = try encoded.response([:], scope: "window", fallback: nil)
  let responseBytes = try JSONSerialization.data(withJSONObject: response).count
  assert(responseBytes < ObservationBudget.responseBytes)
  assert(encoded.boundaries.contains { $0.reason == "response_bytes" })
  assert(encoded.nodes.count < 150)

  var cancelled = false
  let stop = ObservationTree(projection: "compact", reader: graph) {
    if cancelled { throw NSError(domain: "cancelled", code: 1) }
  }
  cancelled = true
  do {
    try stop.walk(handles[0])
    assertionFailure("Cancellation must reject the candidate")
  } catch {
    assert(stop.nodes.isEmpty)
  }
  print("Observation evidence, budgets, projection, encoding and cancellation passed")
}
