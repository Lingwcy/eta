import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Conversation } from "@eta/agent";
import { Context, Effect, Layer } from "effect";
import { TitleDoc } from "../../agent/extension/title/task.ts";
import { CatalogService } from "../catalog/index.ts";
import { adapter } from "../errors.ts";
import type { CoreError } from "../errors.ts";
import { applyGeneratedTitle } from "./policy.ts";

interface TitleRuntime {
  harness: Harness;
  conversation: Conversation;
  ref: { metadata: { id: string } };
  disposed: boolean;
}

/** Generated titles update catalog metadata, never manual names or the conversation transcript. */
export class ThreadTitleService extends Context.Service<
  ThreadTitleService,
  {
    watch(runtime: TitleRuntime): Effect.Effect<() => Promise<void>, CoreError>;
  }
>()("eta/core/service/titles/ThreadTitleService") {
  static readonly layer = Layer.effect(
    ThreadTitleService,
    Effect.gen(function* () {
      const catalog = yield* CatalogService;
      return ThreadTitleService.of({
        watch: (runtime) =>
          adapter("无法订阅会话标题", async () => {
            const watch = await runtime.harness.watchDoc(
              TitleDoc,
              runtime.conversation.id,
              BACKGROUND_CONTEXT,
            );
            let delivery = Promise.resolve();
            const publish = (value: NonNullable<typeof watch>["value"]) => {
              delivery = delivery.then(() =>
                Effect.runPromise(
                  Effect.gen(function* () {
                    const title = value?.title;
                    if (!title || runtime.disposed) return;
                    const current = (yield* catalog.read).threads.find(
                      (thread) => thread.sessionRef.metadata.id === runtime.ref.metadata.id,
                    );
                    if (current?.titleSource !== "temporary") return;
                    yield* catalog.update((state) => ({
                      ...state,
                      threads: state.threads.map((thread) =>
                        thread.id === current.id ? applyGeneratedTitle(thread, title) : thread,
                      ),
                    }));
                  }).pipe(Effect.catch((error) => Effect.logError(error.message))),
                ),
              );
              return delivery;
            };
            if (watch) {
              await publish(watch.value);
              watch.start(publish);
            }
            return async () => {
              await watch?.stop();
              await delivery;
            };
          }),
      });
    }),
  );
}
