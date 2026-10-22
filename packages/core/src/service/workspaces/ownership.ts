import { Context, Effect, Layer, Semaphore } from "effect";

/** Hold from path validation through publication or removal; acquire inside the thread lock. */
export class WorkspaceOwnershipService extends Context.Service<
  WorkspaceOwnershipService,
  {
    coordinate<A, E, R>(action: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  }
>()("eta/core/service/workspaces/WorkspaceOwnershipService") {
  static readonly layer = Layer.sync(WorkspaceOwnershipService, () => {
    const gate = Semaphore.makeUnsafe(1);
    return WorkspaceOwnershipService.of({ coordinate: (action) => gate.withPermit(action) });
  });
}
