import { registerHooks } from "node:module";

// Development workers use workspace sources without selecting missing sources in published dependencies.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier,
      specifier === "@eta/agent" || specifier.startsWith("@eta/agent/")
        ? { ...context, conditions: [...context.conditions, "source"] }
        : context,
    );
  },
});
