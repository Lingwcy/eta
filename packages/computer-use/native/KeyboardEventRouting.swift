import Foundation

enum KeyboardEventRouting {
  // A menu can temporarily direct physical keys to the target or our calibration client.
  // Return opaque events to the actual user input owner; never interpret or retain key data.
  static func destination(
    front: pid_t?, key: pid_t?, original: pid_t, helper: pid_t, targets: Set<pid_t>
  ) -> pid_t {
    guard let front, front > 0, let key, key > 0 else { return original }
    if targets.contains(front), key != helper { return key }
    return key == helper || targets.contains(key) ? front : key
  }
}
