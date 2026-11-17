import Foundation

func testControlState() throws {
  let checked = ControlState.checked
  let expanded = ControlState.expanded
  assert(checked.parse(.known("2")) == .mixed)
  assert(checked.parse(.absent) == .unsupported)
  assert(checked.parse(.unknown) == .unknown)
  assert(expanded.parse(.known("2")) == .unknown)
  assert(checked.delivery(role: "AXRadioButton", desired: false, actions: ["AXPress"], writable: true) == nil)
  assert(checked.delivery(role: "AXButton", desired: true, actions: ["AXPress"], writable: false) == nil)
  assert(expanded.delivery(role: "AXRow", desired: false, actions: ["AXExpand"], writable: false) == nil)
  assert(expanded.delivery(role: "AXRow", desired: false, actions: ["AXCollapse"], writable: true) == .action("AXCollapse"))
  assert(expanded.delivery(role: "AXDisclosureTriangle", desired: true, actions: ["AXPress"], writable: false) == .action("AXPress"))

  var actions = 0
  var preparations = 0
  var readbacks = 0
  func run(
    _ read: () throws -> ControlState.Read, outcome: ControlState.Read
  ) throws -> [String: Any] {
    try ControlState.change(
      desired: true, read: read, prepare: { preparations += 1 },
      deliver: { actions += 1 }, verify: { readbacks += 1; return outcome })
  }
  let noOp = try run({ .known(true) }, outcome: .known(false))
  assert(actions == 0 && preparations == 0 && readbacks == 0)
  assert(noOp["applied"] as? String == "no")
  assert((noOp["verification"] as? [String: Any])?["noOp"] as? Bool == true)
  for value in [ControlState.Read.mixed, .unknown, .unsupported] {
    do {
      _ = try run({ value }, outcome: .known(true))
      assertionFailure("Indeterminate state must block delivery")
    } catch let error as BridgeError {
      assert(error.applied == "no" && actions == 0 && preparations == 0)
    }
  }
  let alreadyChanged = try run({ .known(preparations > 0) }, outcome: .known(false))
  assert(alreadyChanged["applied"] as? String == "no" && actions == 0 && readbacks == 0)
  for (index, sample) in [(ControlState.Read.known(true), "satisfied"), (.known(false), "unsatisfied"), (.unknown, "unknown")].enumerated() {
    let result = try run({ .known(false) }, outcome: sample.0)
    assert(result["applied"] as? String == "yes")
    assert((result["verification"] as? [String: String])?["status"] == sample.1)
    assert(actions == index + 1 && readbacks == index + 1)
  }
  do {
    _ = try ControlState.change(desired: true, read: { .known(false) }, prepare: {},
      deliver: { actions += 1; throw BridgeError("uncertain delivery", "unknown") },
      verify: { assertionFailure("Delivery failure must stop"); return .unknown })
    assertionFailure("Uncertain delivery must surface")
  } catch let error as BridgeError {
    assert(error.applied == "unknown" && actions == 4)
  }
  do {
    _ = try ControlState.change(desired: true, read: { .known(false) }, prepare: {},
      deliver: { actions += 1 },
      verify: { throw BridgeError("user interrupted", "unknown", reason: "user_interrupted") })
    assertionFailure("Interruption must surface")
  } catch let error as BridgeError {
    assert(error.applied == "yes" && error.reason == "user_interrupted" && actions == 5)
  }
  print("State action no-op, single delivery, unavailable readback and cancellation passed")
}
