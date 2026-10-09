import type { CredentialStore } from "@earendil-works/pi-ai";

/** Deployments select environment variable names; keys never enter application configuration or responses. */
export function environmentCredentials(
  config: Readonly<Record<string, string>> = {},
): CredentialStore {
  const keys = new Map(
    Object.entries(config).flatMap(([provider, variable]) => {
      const key = process.env[variable];
      return key ? [[provider, key] as const] : [];
    }),
  );
  return {
    read: async (provider, options) => {
      options?.signal?.throwIfAborted();
      const key = keys.get(provider);
      return key === undefined ? undefined : { type: "api_key", key };
    },
    list: async (options) => {
      options?.signal?.throwIfAborted();
      return [...keys.keys()].map((providerId) => ({ providerId, type: "api_key" as const }));
    },
    modify: async () => {
      throw new Error("Bot credentials are managed by deployment environment variables.");
    },
    delete: async () => {
      throw new Error("Bot credentials are managed by deployment environment variables.");
    },
  };
}
