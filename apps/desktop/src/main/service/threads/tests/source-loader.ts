import { registerHooks } from "node:module";

// Workspace Agent has source exports; published Chord advertises source files it does not ship.
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
