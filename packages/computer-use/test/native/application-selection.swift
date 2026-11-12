import Foundation

func testApplicationSelection() {
  let apps: [TargetSelection.Application] = [
    .init(pid: 10, name: "喵启动器", bundleIdentifier: "dev.mcl.launcher",
      path: "/Applications/mcl.app", regular: true),
    .init(pid: 20, name: "SJMCL", bundleIdentifier: "SJMCL",
      path: "/Applications/SJMCL.app", regular: true),
    .init(pid: 30, name: "MCL Helper", bundleIdentifier: "dev.mcl.helper",
      path: "/Applications/mcl.app/Contents/Frameworks/Helper.app", regular: false),
  ]
  var lookups = 0
  func installed() -> String? {
    lookups += 1
    return "/Applications/mcl.app"
  }
  precondition(TargetSelection.applications("MCL", in: apps, installedPath: installed) == [0])
  precondition(lookups == 1)
  precondition(TargetSelection.applications("dev.mcl.launcher", in: apps, installedPath: installed) == [0])
  precondition(TargetSelection.applications("/Applications/mcl.app", in: apps, installedPath: installed) == [0])
  precondition(TargetSelection.applications("sjmcl", in: apps, installedPath: installed) == [1])
  precondition(TargetSelection.applications("pid:10", in: apps, installedPath: installed) == [0])
  precondition(TargetSelection.applications("pid:99", in: apps, installedPath: installed).isEmpty)
  precondition(TargetSelection.applications("pid:invalid", in: apps, installedPath: installed).isEmpty)
  precondition(lookups == 1)
  precondition(TargetSelection.applications("MCL", in: Array(apps.dropFirst()), installedPath: installed).isEmpty)
  precondition(TargetSelection.applications("MCL", in: apps, installedPath: { nil }) == [1])
  precondition(TargetSelection.applications("Helper", in: apps, installedPath: { nil }).isEmpty)
  let second = TargetSelection.Application(pid: 40, name: "喵启动器", bundleIdentifier: "dev.mcl.launcher",
    path: "/Applications/mcl.app", regular: true)
  precondition(TargetSelection.applications("MCL", in: apps + [second], installedPath: installed) == [0, 3])
  precondition(TargetSelection.applications("dev.mcl.launcher", in: apps + [second], installedPath: installed) == [0, 3])
  precondition(TargetSelection.applications("pid:40", in: apps + [second], installedPath: installed) == [3])
  print("Native launch/observe application identity: 13 cases passed; no desktop access.")
}
