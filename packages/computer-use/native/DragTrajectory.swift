import Foundation

struct DragTrajectory {
  let start: CGPoint
  let samples: [CGPoint]
  let duration: TimeInterval
  static func make(_ points: [CGPoint], bounds: CGRect, durationMs: Int?) -> DragTrajectory? {
    guard (2...256).contains(points.count), durationMs.map({ (0...10000).contains($0) }) ?? true,
      points.allSatisfy({ $0.x.isFinite && $0.y.isFinite && bounds.contains($0) })
    else { return nil }
    var samples: [CGPoint] = []
    let maximum = min(20, 1024 / (points.count - 1))
    for index in 1..<points.count {
      let from = points[index - 1]
      let to = points[index]
      let count =
        points.count == 2
        ? 20 : max(1, min(maximum, Int(ceil(hypot(to.x - from.x, to.y - from.y) / 6))))
      for step in 1...count {
        samples.append(
          CGPoint(
            x: from.x + (to.x - from.x) * Double(step) / Double(count),
            y: from.y + (to.y - from.y) * Double(step) / Double(count)))
      }
    }
    return .init(
      start: points[0], samples: samples,
      duration: durationMs.map { Double($0) / 1000 } ?? min(10, Double(samples.count) * 0.01))
  }
}
