import { registerHooks } from "node:module";

// Workspace Core and Agent have source exports; published Chord advertises files it does not ship.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier,
      specifier === "@eta/agent" ||
        specifier.startsWith("@eta/agent/") ||
        specifier === "@eta/core" ||
        specifier.startsWith("@eta/core/")
        ? { ...context, conditions: [...context.conditions, "source"] }
        : context,
    );
  },
});
