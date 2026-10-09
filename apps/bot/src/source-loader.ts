import { registerHooks } from "node:module";

// Published dependencies need their normal exports; workspace packages use their TypeScript sources.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier,
      specifier === "@eta/core" ||
        specifier.startsWith("@eta/core/") ||
        specifier === "@eta/agent" ||
        specifier.startsWith("@eta/agent/")
        ? { ...context, conditions: [...context.conditions, "source"] }
        : context,
    );
  },
});
