import { Context, Effect, Layer, Semaphore } from "effect";

/** Acquire before ThreadService's mutation lock; never hold while waiting for model execution. */
export class ScheduleGateService extends Context.Service<
  ScheduleGateService,
  {
    withThread<A, E, R>(threadId: string, action: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  }
>()("eta/core/service/schedules/ScheduleGateService") {
  static readonly layer = Layer.sync(ScheduleGateService, () => {
    const gates = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
    return ScheduleGateService.of({
      withThread: (threadId, action) =>
        Effect.suspend(() => {
          let gate = gates.get(threadId);
          if (!gate) {
            gate = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            gates.set(threadId, gate);
          }
          const current = gate;
          current.users++;
          return current.semaphore.withPermit(action).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                current.users--;
                if (current.users === 0) gates.delete(threadId);
              }),
            ),
          );
        }),
    });
  });
}
