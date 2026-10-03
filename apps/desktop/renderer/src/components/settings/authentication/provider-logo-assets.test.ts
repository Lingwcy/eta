import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vite-plus/test";
import { providerLogoUrl } from "./provider-logo-assets";

describe("provider logo assets", () => {
  it("bundles a local logo for every account and API key provider in pi-ai", () => {
    const providers = builtinModels()
      .getProviders()
      .filter(
        (provider) =>
          provider.auth.oauth !== undefined || provider.auth.apiKey?.login !== undefined,
      );
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(providerLogoUrl(provider.id), `${provider.name} has no bundled logo`).toMatch(
        /^(?:data:image\/(?:svg\+xml|png)[;,]|\/.*\/assets\/providers\/.+\.(svg|png)$)/,
      );
    }
  });

  it("lets an unknown provider use the avatar fallback", () => {
    expect(providerLogoUrl("custom-provider")).toBeUndefined();
  });
});
