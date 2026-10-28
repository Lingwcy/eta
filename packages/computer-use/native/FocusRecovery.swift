import Foundation

protocol KeyFocusServer {
  func frontPID() -> pid_t?
  func keyPID() -> pid_t?
  func borrowKeyFocus() -> Int32?
  func releaseKeyFocus(_ id: Int32) -> Bool
}

enum FocusRecovery {
  enum Failure: Equatable {
    case unavailable, cleanup, stillStolen

    var message: String {
      switch self {
      case .unavailable: return "无法恢复前台键盘焦点；本次后台操作已停止"
      case .cleanup: return "前台焦点保护清理失败"
      case .stillStolen: return "无法归还前台键盘焦点；请关闭目标菜单后重试"
      }
    }
  }
  enum Outcome: Equatable {
    case restored, superseded
    case failed(Failure)
  }

  // A browser menu may acquire key focus without delivering the activation notice our
  // event tap watches. Reconcile only a menu left open by the preceding owned input.
  static func prepareInput(
    front: pid_t, targets: Set<pid_t>, menuOpen: Bool, server: any KeyFocusServer,
    allowed: () -> Bool
  ) -> Outcome {
    guard allowed(), server.frontPID() == front, let key = server.keyPID() else {
      return .superseded
    }
    if key == front { return .restored }
    guard menuOpen, targets.contains(key) else { return .superseded }
    return restore(front: front, target: key, server: server, allowed: allowed)
  }

  // The counter and bounded lookup follow Cua Driver (MIT; see THIRD_PARTY_NOTICES.txt).
  // The only foreign token we may release is below our calibration token while the same
  // background target still owns key focus. A user's newer owner always takes precedence.
  static func restore(
    front: pid_t, target: pid_t, server: any KeyFocusServer, allowed: () -> Bool = { true }
  ) -> Outcome {
    guard allowed(), server.frontPID() == front, server.keyPID() == target else {
      return .superseded
    }
    guard let own = server.borrowKeyFocus(), own != 0 else { return .failed(.unavailable) }
    var released = false
    defer {
      // Even when cleanup fails, make a final attempt to relinquish only our own token.
      if !released { _ = server.releaseKeyFocus(own) }
    }
    guard server.releaseKeyFocus(own) else { return .failed(.cleanup) }
    released = true
    for offset: Int32 in 1...4 {
      guard allowed(), server.frontPID() == front else { return .superseded }
      let key = server.keyPID()
      if key == front { return .restored }
      guard key == target else { return .superseded }
      let candidate = own &- offset
      if candidate != 0 { _ = server.releaseKeyFocus(candidate) }
    }
    guard allowed(), server.frontPID() == front else { return .superseded }
    let key = server.keyPID()
    if key == front { return .restored }
    return key == target ? .failed(.stillStolen) : .superseded
  }
}
