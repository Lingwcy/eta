import ApplicationServices
import Foundation

let active: [String: Any] = [
  kCGSessionOnConsoleKey as String: true,
  kCGSessionLoginDoneKey as String: true,
]
precondition(DesktopSession.issue(in: active) == nil)
var locked = active
locked["CGSSessionScreenIsLocked"] = true
precondition(DesktopSession.issue(in: locked)?.contains("已锁定") == true)
var inactive = active
inactive[kCGSessionOnConsoleKey as String] = false
precondition(DesktopSession.issue(in: inactive) != nil)
var login = active
login[kCGSessionLoginDoneKey as String] = false
precondition(DesktopSession.issue(in: login) != nil)
precondition(DesktopSession.issue(in: [:]) != nil)
precondition(DesktopSession.issue(in: nil) != nil)
print("Native desktop-session policy: 6 cases passed; no desktop access.")

let titles = ["Notes", "Computer Use Benchmark - Google Chrome (Incognito)", "Release Notes"]
precondition(TargetSelection.matching("Computer Use Benchmark", in: titles) == [1])
precondition(TargetSelection.matching("computer use benchmark", in: titles) == [1])
precondition(TargetSelection.matching(titles[1], in: titles) == [1])
precondition(TargetSelection.matching("Notes", in: titles) == [0])
precondition(TargetSelection.matching("notes", in: titles) == [0, 2])
precondition(TargetSelection.matching("Missing", in: titles).isEmpty)
precondition(TargetSelection.matching("   ", in: titles).isEmpty)
precondition(TargetSelection.matching("Notes", in: ["Notes", "Notes"]) == [0, 1])
precondition(TargetSelection.matching("[draft]", in: ["Notes [draft]", "Notes draft"]) == [0])
precondition(TargetSelection.matching("Notes", in: []).isEmpty)
precondition(TargetSelection.matching("Chrome", in: ["Google Chrome", "TextEdit"]) == [0])
precondition(TargetSelection.matching("chrome", in: ["Google Chrome", "Chrome Canary"]) == [0, 1])
precondition(TargetSelection.matching("Google Chrome", in: ["Google Chrome", "Google Chrome Canary"]) == [0])
precondition(TargetSelection.matching("TextEdit", in: ["TextEdit", "TextEdit"]) == [0, 1])
print("Native application/window-name selection: 14 cases passed; no desktop access.")
let apps = [(name: "Google Chrome", regular: true),
            (name: "Google Chrome Helper (Capture)", regular: false),
            (name: "TextEdit", regular: true)]
precondition(TargetSelection.applicationAliases("Chrome", in: apps) == [0])
precondition(TargetSelection.applicationAliases("chrome", in: apps) == [0])
precondition(TargetSelection.applicationAliases("Chrome", in: apps + [("Chrome Canary", true)]) == [0, 3])
precondition(TargetSelection.applicationAliases("Helper", in: apps).isEmpty)
precondition(TargetSelection.applicationAliases("Chrome", in: [("Google Chrome Helper", false)]).isEmpty)
print("Native regular-application alias admission: 5 cases passed; no desktop access.")

// An isolated WindowServer fixture: no event taps, windows, focus RPCs or keyboard input.
final class FocusServerFixture: KeyFocusServer {
  var front: pid_t? = 10
  var key: pid_t? = 20
  var own: Int32 = 102
  var targetTheft: Int32 = 101
  var available = true
  var releaseOwnFailures = 0
  var releaseTarget = true
  var calls: [String] = []
  var afterBorrow: (() -> Void)?
  var afterRelease: ((Int32) -> Void)?
  var allowed = true
  private var priorKey: pid_t?

  func frontPID() -> pid_t? { front }
  func keyPID() -> pid_t? { key }
  func borrowKeyFocus() -> Int32? {
    calls.append("borrow")
    guard available else { return nil }
    priorKey = key
    key = 30
    afterBorrow?()
    return own
  }
  func releaseKeyFocus(_ id: Int32) -> Bool {
    calls.append("release:\(id)")
    if id == own {
      if releaseOwnFailures > 0 {
        releaseOwnFailures -= 1
        return false
      }
      if key == 30 { key = priorKey }
    } else if id == targetTheft && releaseTarget {
      if key == 20 { key = front }
    } else {
      afterRelease?(id)
      return false
    }
    afterRelease?(id)
    return true
  }
  func restore() -> FocusRecovery.Outcome {
    FocusRecovery.restore(front: 10, target: 20, server: self, allowed: { self.allowed })
  }
}

var focusCases = 0
func scenario(_ label: String, _ body: (FocusServerFixture) -> Void) {
  body(FocusServerFixture())
  focusCases += 1
  print("PASS \(label)")
}
scenario("background menu releases its theft and leaves the original foreground key") { s in
  precondition(s.restore() == .restored)
  precondition(s.front == 10 && s.key == 10)
  precondition(s.calls == ["borrow", "release:102", "release:101"])
}
scenario("a user app switch before recovery receives no focus mutations") { s in
  s.front = 40
  s.key = 40
  precondition(s.restore() == .superseded && s.calls.isEmpty)
}
scenario("a foreground panel keeps its independently acquired key focus") { s in
  s.key = 40
  precondition(s.restore() == .superseded && s.calls.isEmpty)
}
scenario("a switch during calibration still releases only the helper's own token") { s in
  s.afterBorrow = {
    s.front = 40
    s.key = 40
  }
  precondition(s.restore() == .superseded)
  precondition(s.front == 40 && s.key == 40)
  precondition(s.calls == ["borrow", "release:102"])
}
scenario("a panel opened during calibration is never reclaimed") { s in
  s.afterRelease = { id in if id == 102 { s.key = 40 } }
  precondition(s.restore() == .superseded && s.key == 40)
  precondition(s.calls == ["borrow", "release:102"])
}
scenario("a switch during lookup prevents subsequent token releases") { s in
  s.own = 105
  s.afterRelease = { id in
    if id == 104 {
      s.front = 40
      s.key = 40
    }
  }
  precondition(s.restore() == .superseded)
  precondition(s.calls == ["borrow", "release:105", "release:104"])
  precondition(s.front == 40 && s.key == 40)
}
scenario("unavailable calibration does not guess another process's token") { s in
  s.available = false
  precondition(s.restore() == .failed(.unavailable))
  precondition(s.calls == ["borrow"] && s.key == 20)
}
scenario("a failed own-token release retries cleanup without touching foreign tokens") { s in
  s.releaseOwnFailures = 1
  precondition(s.restore() == .failed(.cleanup))
  precondition(s.calls == ["borrow", "release:102", "release:102"] && s.key == 20)
}
scenario("unrecoverable target focus is bounded and reported as failure") { s in
  s.releaseTarget = false
  precondition(s.restore() == .failed(.stillStolen))
  precondition(
    s.calls == ["borrow", "release:102", "release:101", "release:100", "release:99", "release:98"])
  precondition(s.front == 10 && s.key == 20)
}
scenario("unknown foreground ownership does not start calibration") { s in
  s.front = nil
  precondition(s.restore() == .superseded && s.calls.isEmpty)
}
scenario("unknown ownership during lookup never counts as recovered focus") { s in
  s.afterRelease = { id in if id == 102 { s.key = nil } }
  precondition(s.restore() == .superseded)
  precondition(s.calls == ["borrow", "release:102"])
}
scenario("a user target click without a foreground change prevents recovery") { s in
  s.allowed = false
  precondition(s.restore() == .superseded && s.calls.isEmpty)
}
scenario("a user target click during calibration releases only our own token") { s in
  s.afterBorrow = { s.allowed = false }
  precondition(s.restore() == .superseded)
  precondition(s.calls == ["borrow", "release:102"] && s.key == 20)
}
scenario("a user target click during lookup prevents further foreign releases") { s in
  s.own = 105
  s.afterRelease = { id in if id == 104 { s.allowed = false } }
  precondition(s.restore() == .superseded)
  precondition(s.calls == ["borrow", "release:105", "release:104"] && s.key == 20)
}
print("Native focus recovery: \(focusCases) cases passed; no desktop access.")

func menuAdmission(_ s: FocusServerFixture, open: Bool = true) -> FocusRecovery.Outcome {
  FocusRecovery.prepareInput(
    front: 10, targets: [20], menuOpen: open, server: s, allowed: { s.allowed })
}
scenario("an owned menu with no activation notice returns focus before the next input") { s in
  precondition(menuAdmission(s) == .restored && s.key == 10)
  precondition(s.calls == ["borrow", "release:102", "release:101"])
}
scenario("ordinary input does not recover unowned target focus") { s in
  precondition(menuAdmission(s, open: false) == .superseded && s.calls.isEmpty)
}
scenario("a ready foreground needs no menu recovery") { s in
  s.key = 10
  precondition(menuAdmission(s) == .restored && s.calls.isEmpty)
}
scenario("a system panel cannot be released as the preceding menu") { s in
  s.key = 40
  precondition(menuAdmission(s) == .superseded && s.calls.isEmpty)
}
scenario("a human app switch supersedes the previous menu") { s in
  s.front = 40
  precondition(menuAdmission(s) == .superseded && s.calls.isEmpty)
}
scenario("human takeover revokes menu recovery even with unchanged foreground") { s in
  s.allowed = false
  precondition(menuAdmission(s) == .superseded && s.calls.isEmpty)
}
scenario("a failed menu calibration cannot admit the next input") { s in
  s.available = false
  precondition(menuAdmission(s) == .failed(.unavailable) && s.calls == ["borrow"])
}
print("Native menu input admission: 7 cases passed; no desktop access.")

let ownership = InputOwnership(pid: 30, marker: 123)
ownership.pointerDown(sourcePID: 30, marker: 123)
precondition(!ownership.interrupted)
ownership.pointerDown(sourcePID: 30, marker: 0)
precondition(!ownership.interrupted)
ownership.pointerDown(sourcePID: 0, marker: 0)
precondition(ownership.interrupted)
ownership.pointerDown(sourcePID: 30, marker: 123)
precondition(ownership.interrupted)
let anotherProcess = InputOwnership(pid: 30, marker: 123)
anotherProcess.pointerDown(sourcePID: 40, marker: 123)
precondition(anotherProcess.interrupted)
let untaggedOtherProcess = InputOwnership(pid: 30, marker: 123)
untaggedOtherProcess.pointerDown(sourcePID: 40, marker: 0)
precondition(untaggedOtherProcess.interrupted)
let anotherAdmission = InputOwnership(pid: 30, marker: 456)
anotherAdmission.pointerDown(sourcePID: 30, marker: 123)
precondition(anotherAdmission.interrupted)
print(
  "Native input ownership: own clicks, human takeover, sticky yield and foreign sources passed.")

let bounds = CGRect(x: 100, y: 80, width: 600, height: 400)
let original = NativeWindowIdentity.Record(id: 42, pid: 20, layer: 0, bounds: bounds)
let overlapping = NativeWindowIdentity.Record(id: 43, pid: 20, layer: 0, bounds: bounds)
precondition(
  NativeWindowIdentity.resolve(axID: 42, pid: 20, bounds: bounds, windows: [original, overlapping])
    == 42)
precondition(
  NativeWindowIdentity.resolve(axID: nil, pid: 20, bounds: bounds, windows: [original]) == nil)
precondition(
  NativeWindowIdentity.resolve(axID: 42, pid: 20, bounds: bounds, windows: [overlapping]) == nil)
precondition(
  NativeWindowIdentity.resolve(axID: 42, pid: 99, bounds: bounds, windows: [original]) == nil)
precondition(
  NativeWindowIdentity.resolve(
    axID: 42, pid: 20, bounds: bounds.offsetBy(dx: 10, dy: 0), windows: [original]) == nil)
precondition(
  NativeWindowIdentity.resolve(axID: 42, pid: 20, bounds: bounds, windows: [original, original])
    == nil)
print("Native window identity: 6 cases passed; no window enumeration or desktop access.")

precondition(
  NativeWindowIdentity.keyboardRecipient(axPID: 20, axWindowID: 42, windows: [original]) == 20)
let hosted = NativeWindowIdentity.Record(id: 44, pid: 30, layer: 0, bounds: bounds)
precondition(
  NativeWindowIdentity.keyboardRecipient(axPID: 20, axWindowID: 44, windows: [hosted]) == 30)
precondition(NativeWindowIdentity.keyboardRecipient(axPID: 20, axWindowID: nil, windows: []) == 20)
precondition(
  NativeWindowIdentity.keyboardRecipient(axPID: 20, axWindowID: 44, windows: [original]) == nil)
precondition(
  NativeWindowIdentity.keyboardRecipient(axPID: 20, axWindowID: 44, windows: [hosted, hosted])
    == nil)
precondition(
  NativeWindowIdentity.keyboardRecipient(axPID: 0, axWindowID: 44, windows: [hosted]) == nil)
print("Native keyboard recipient identity: 6 cases passed; no event posting.")

final class KeyboardGraph {
  var processes: [Int: pid_t] = [11: 10, 12: 10, 21: 20]
  var windows: [Int: Int] = [11: 1, 12: 1, 21: 1]
  var parents: [Int: Int] = [11: 1, 12: 1, 21: 11]
  var parentReads = 0
  var scope: KeyboardScope<Int> {
    KeyboardScope(
      equal: { $0 == $1 }, sameWindow: { $0 == $1 },
      process: { self.processes[$0] }, enclosingWindow: { self.windows[$0] },
      parent: {
        self.parentReads += 1
        return self.parents[$0]
      })
  }
}
var keyboardCases = 0
func keyboardScenario(_ label: String, _ body: (KeyboardGraph) -> Void) {
  body(KeyboardGraph())
  keyboardCases += 1
  print("PASS \(label)")
}
keyboardScenario("native editor keys bind to its focused control") { g in
  let target = g.scope.resolve(
    app: 10, window: 1, focusedWindow: 1, focusedElement: 11, requested: 11)
  precondition(target?.pid == 10 && target?.element == 11)
}
keyboardScenario("a hosted control receives keys through its own process") { g in
  let target = g.scope.resolve(
    app: 10, window: 1, focusedWindow: 1, focusedElement: 21, requested: 11)
  precondition(target?.pid == 20 && target?.element == 21)
}
keyboardScenario("an element index cannot type into a different field in the same window") { g in
  precondition(
    g.scope.resolve(app: 10, window: 1, focusedWindow: 1, focusedElement: 12, requested: 11) == nil)
}
keyboardScenario("remote process membership does not override a different AX window") { g in
  g.windows[21] = 2
  precondition(g.scope.resolve(app: 10, window: 1, focusedWindow: 1, focusedElement: 21) == nil)
}
keyboardScenario("a focus switch to another window refuses all keyboard input") { g in
  precondition(g.scope.resolve(app: 10, window: 1, focusedWindow: 2, focusedElement: 11) == nil)
}
keyboardScenario("app-level canvas input preserves the window-bound fallback") { g in
  let target = g.scope.resolve(app: 10, window: 1, focusedWindow: 1, focusedElement: nil)
  precondition(target?.pid == 10 && target?.element == nil)
  precondition(
    g.scope.resolve(app: 10, window: 1, focusedWindow: 1, focusedElement: nil, requested: 11) == nil
  )
}
keyboardScenario("parent ancestry can bind a control with no AXWindow attribute") { g in
  g.windows.removeValue(forKey: 21)
  precondition(g.scope.resolve(app: 10, window: 1, focusedWindow: 1, focusedElement: 21)?.pid == 20)
}
keyboardScenario("detached or cyclic hosted controls cannot borrow the observed window") { g in
  g.windows.removeValue(forKey: 21)
  g.parents[21] = 21
  precondition(g.scope.resolve(app: 10, window: 1, focusedWindow: 1, focusedElement: 21) == nil)
  precondition(g.parentReads == 32)
}
keyboardScenario("a stale focused process cannot receive input") { g in
  g.processes[21] = 0
  precondition(g.scope.resolve(app: 10, window: 1, focusedWindow: 1, focusedElement: 21) == nil)
}
keyboardScenario("focus changes within a window invalidate a composite input") { g in
  precondition(
    !g.scope.unchanged(KeyboardTarget(pid: 10, element: 11), KeyboardTarget(pid: 10, element: 12)))
  precondition(
    !g.scope.unchanged(KeyboardTarget(pid: 10, element: 11), KeyboardTarget(pid: 20, element: 11)))
  precondition(
    !g.scope.unchanged(KeyboardTarget(pid: 10, element: nil), KeyboardTarget(pid: 10, element: 11)))
  precondition(
    g.scope.unchanged(KeyboardTarget(pid: 20, element: 21), KeyboardTarget(pid: 20, element: 21)))
}
keyboardScenario("an observed sheet admits only controls whose ancestry passes through it") { g in
  g.windows[2] = 1
  g.parents[2] = 1
  g.parents[21] = 2
  precondition(g.scope.resolve(app: 10, window: 2, focusedWindow: 2, focusedElement: 21)?.pid == 20)
  g.parents[21] = 11
  precondition(g.scope.resolve(app: 10, window: 2, focusedWindow: 2, focusedElement: 21) == nil)
}
print("Native keyboard scope: \(keyboardCases) cases passed; no input posting or desktop access.")

precondition(PublishedWindows.merge(listed: [1, 2], focused: 1, main: 2, equal: ==) == [1, 2])
precondition(PublishedWindows.merge(listed: [], focused: 1, main: 1, equal: ==) == [1])
precondition(PublishedWindows.merge(listed: [1], focused: 2, main: 3, equal: ==) == [1, 2, 3])
precondition(PublishedWindows.merge(listed: [1], focused: nil, main: 2, equal: ==) == [1, 2])
precondition(PublishedWindows.merge(listed: [Int](), focused: nil, main: nil, equal: ==).isEmpty)
print("Native published windows: 5 cases passed; no application activation or desktop access.")

precondition(
  ForegroundWindowAdmission.allows(front: 10, target: 20, observed: 1, focused: 2, equal: ==))
precondition(
  ForegroundWindowAdmission.allows(front: 10, target: 20, observed: 1, focused: nil, equal: ==))
precondition(
  ForegroundWindowAdmission.allows(front: 10, target: 10, observed: 1, focused: 1, equal: ==))
precondition(
  !ForegroundWindowAdmission.allows(front: 10, target: 10, observed: 1, focused: 2, equal: ==))
precondition(
  !ForegroundWindowAdmission.allows(front: 10, target: 10, observed: 1, focused: nil, equal: ==))
print("Native foreground window admission: 5 cases passed; no focus or input changes.")

final class OrderFixture {
  let foreground = WindowOrderRecovery.Window(id: 11, pid: 10, layer: 0)
  let target = WindowOrderRecovery.Window(id: 21, pid: 20, layer: 0)
  var front: pid_t? = 10
  var key: pid_t? = 10
  var matches = true
  var allowed = true
  var windows: [WindowOrderRecovery.Window] = []
  var reads = 0
  var raises = 0
  var raiseResult = WindowOrderRecovery.Outcome.restored
  var afterRead: ((Int) -> Void)?
  var recovery = WindowOrderRecovery(
    front: 10, target: 20, frontWindow: 11, targetWindow: 21)
  init() {
    windows = [target, foreground]
    recovery.temporaryKeyOwners = [20, 30]
  }
  func state() -> WindowOrderRecovery.State {
    reads += 1
    let result = WindowOrderRecovery.State(
      front: front, key: key, focusedWindowMatches: matches, windows: windows)
    afterRead?(reads)
    return result
  }
  func restore() -> WindowOrderRecovery.Outcome {
    recovery.restore(
      allowed: { self.allowed }, state: state,
      raise: {
        self.raises += 1
        return self.raiseResult
      })
  }
}
var orderCases = 0
func orderScenario(_ label: String, _ body: (OrderFixture) -> Void) {
  body(OrderFixture())
  orderCases += 1
  print("PASS \(label)")
}
orderScenario("restore only an originally occluded target") { f in
  f.windows = [f.foreground, f.target]
  precondition(f.recovery.admits(f.state()))
  precondition(f.restore() == .unchanged && f.raises == 0)
}
orderScenario("do not admit a target the user already placed above their window") { f in
  precondition(!f.recovery.admits(f.state()))
}
orderScenario("a raised target restores only the bound foreground window") { f in
  precondition(f.restore() == .restored && f.raises == 1 && f.reads == 2)
}
orderScenario("a user app switch never raises the old window") { f in
  f.front = 40
  f.key = 40
  precondition(f.restore() == .superseded && f.raises == 0)
}
orderScenario("a same-app foreground window switch never restores an old window") { f in
  f.matches = false
  precondition(f.restore() == .superseded && f.raises == 0)
}
orderScenario("a system panel owns its independently acquired keyboard") { f in
  f.key = 40
  precondition(f.restore() == .superseded && f.raises == 0)
}
orderScenario("temporary target or hosted-control focus defers ordering recovery") { f in
  for recipient: pid_t in [20, 30] {
    f.key = recipient
    precondition(f.restore() == .unchanged && f.raises == 0)
  }
  f.key = 10
  precondition(f.restore() == .restored && f.raises == 1)
}
orderScenario("closed or recycled windows cannot receive a recovery action") { f in
  f.windows = [f.target]
  precondition(f.restore() == .superseded && f.raises == 0)
  f.windows = [f.target, .init(id: 11, pid: 40, layer: 0)]
  precondition(f.restore() == .superseded && f.raises == 0)
}
orderScenario("a duplicate window record cannot authorize raising") { f in
  f.windows = [f.target, f.foreground, f.foreground]
  precondition(f.restore() == .superseded && f.raises == 0)
}
orderScenario("menu-level windows cannot authorize a normal-window recovery") { f in
  f.windows = [.init(id: 21, pid: 20, layer: 101), f.foreground]
  precondition(f.restore() == .superseded && f.raises == 0)
}
orderScenario("a focus switch during order enumeration is checked before mutation") { f in
  f.afterRead = { reads in if reads == 1 { f.matches = false } }
  precondition(f.restore() == .superseded && f.raises == 0 && f.reads == 2)
}
orderScenario("user takeover after the final query still prevents recovery") { f in
  f.afterRead = { reads in if reads == 2 { f.allowed = false } }
  precondition(f.restore() == .superseded && f.raises == 0)
}
orderScenario("a failed AX raise is reported without an activation fallback") { f in
  f.raiseResult = .failed
  precondition(f.restore() == .failed && f.raises == 1)
}
print("Native window-order recovery: \(orderCases) cases passed; no windows or activation.")

let keyDestinations: [(pid_t?, pid_t?, pid_t)] = [
  (10, 10, 10), (10, 20, 10), (10, 30, 10), (10, 40, 40), (50, 50, 50),
  (20, 20, 20), (20, 21, 21), (20, 30, 20), (nil, 10, 20), (10, nil, 20),
]
for (front, key, expected) in keyDestinations {
  precondition(
    KeyboardEventRouting.destination(
      front: front, key: key, original: 20, helper: 30, targets: [20, 21]) == expected)
}
print("Native opaque keyboard routing: 10 cases passed; no key contents or event taps.")

let pointerBounds = CGRect(x: -300, y: 40, width: 600, height: 400)
func pointerWindow(_ id: UInt32, _ pid: pid_t, _ layer: Int = 0, _ presentation: Bool = false)
  -> PointerVisibility.Window
{
  .init(id: id, pid: pid, layer: layer, bounds: pointerBounds, presentation: presentation)
}
let pointerPoint = CGPoint(x: -200, y: 60)
precondition(
  PointerVisibility.visible(1, 10, pointerPoint, [pointerWindow(9, 99, 20), pointerWindow(1, 10)]))
precondition(
  !PointerVisibility.visible(1, 10, pointerPoint, [pointerWindow(2, 20), pointerWindow(1, 10)]))
precondition(
  !PointerVisibility.visible(
    1, 10, pointerPoint, [pointerWindow(2, 20, 101), pointerWindow(1, 10)]))
precondition(
  PointerVisibility.visible(
    1, 10, pointerPoint, [pointerWindow(2, 20, 3, true), pointerWindow(1, 10)]))
precondition(!PointerVisibility.visible(1, 10, pointerPoint, [pointerWindow(2, 10)]))
precondition(!PointerVisibility.visible(1, 10, CGPoint(x: 500, y: 500), [pointerWindow(1, 10)]))
print("Native pointer visibility: 6 cases passed; no windows or input.")

let dragBounds = CGRect(x: -100, y: 20, width: 600, height: 400)
let dragPoints = [
  CGPoint(x: 0, y: 50), CGPoint(x: 50, y: 90), CGPoint(x: 70, y: 60), CGPoint(x: 0, y: 50),
]
let drag = DragTrajectory.make(dragPoints, bounds: dragBounds, durationMs: 450)!
precondition(drag.start == dragPoints[0] && drag.samples.last == dragPoints.last)
precondition(dragPoints.dropFirst().allSatisfy { drag.samples.contains($0) })
precondition(drag.duration == 0.45)
precondition(
  DragTrajectory.make(Array(dragPoints.prefix(2)), bounds: dragBounds, durationMs: nil)!.samples
    .count == 20)
precondition(
  DragTrajectory.make(
    [dragPoints[0], CGPoint(x: 2000, y: 90), dragPoints[1]], bounds: dragBounds, durationMs: nil)
    == nil)
precondition(
  DragTrajectory.make(
    [dragPoints[0], CGPoint(x: CGFloat.nan, y: 40)], bounds: dragBounds, durationMs: nil) == nil)
precondition(DragTrajectory.make(dragPoints, bounds: dragBounds, durationMs: -1) == nil)
precondition(DragTrajectory.make(dragPoints, bounds: dragBounds, durationMs: 10001) == nil)
precondition(DragTrajectory.make([dragPoints[0]], bounds: dragBounds, durationMs: nil) == nil)
precondition(
  DragTrajectory.make(
    Array(repeating: dragPoints[0], count: 257), bounds: dragBounds, durationMs: nil) == nil)
precondition(
  DragTrajectory.make(
    Array(repeating: dragPoints, count: 64).flatMap { $0 }, bounds: dragBounds, durationMs: nil)!
    .samples.count <= 1024)
print(
  "Native continuous drag: corners, complete-route bounds, timing, finite coordinates and sampling limits passed."
)
