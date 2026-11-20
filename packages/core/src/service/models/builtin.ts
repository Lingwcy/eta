import type {
  Api,
  CreateModelsOptions,
  Model,
  ModelCost,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

type ModelSupplement = {
  readonly id: string;
  readonly name: string;
  readonly templateId: string;
  readonly contextWindow?: number;
  readonly cost?: ModelCost;
};

const GPT_6_2_ASTRA_COST: ModelCost = {
  input: 8,
  output: 40,
  cacheRead: 0.4,
  cacheWrite: 10,
  tiers: [
    {
      inputTokensAbove: 272000,
      input: 16,
      output: 60,
      cacheRead: 0.8,
      cacheWrite: 20,
    },
  ],
};

// Backports GPT-6.2 Astra and GPT-6.2 Sol from upstream pi (e56d35ce5 + cead615b4)
// until a published @earendil-works/pi-ai release includes them in its static catalog.
const CATALOG_SUPPLEMENTS: Readonly<Record<string, readonly ModelSupplement[]>> = {
  openai: [
    {
      id: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      templateId: "gpt-6.1-sol",
      contextWindow: 272000,
      cost: GPT_6_2_ASTRA_COST,
    },
    {
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      templateId: "gpt-6.1-sol",
    },
  ],
  "openai-codex": [
    {
      id: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      templateId: "gpt-6.1-sol",
      contextWindow: 272000,
      cost: GPT_6_2_ASTRA_COST,
    },
    {
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      templateId: "gpt-6.1-sol",
      contextWindow: 500000,
    },
  ],
  azure: [
    {
      id: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      templateId: "gpt-6.1-sol",
      contextWindow: 1050000,
      cost: GPT_6_2_ASTRA_COST,
    },
    {
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      templateId: "gpt-6.1-sol",
      contextWindow: 1050000,
    },
  ],
};

function cloneModel(template: Model<Api>, supplement: ModelSupplement): Model<Api> {
  const cost = supplement.cost ?? template.cost;
  return {
    ...template,
    id: supplement.id,
    name: supplement.name,
    contextWindow: supplement.contextWindow ?? template.contextWindow,
    cost: {
      ...cost,
      ...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
    },
    ...(template.thinkingLevelMap ? { thinkingLevelMap: { ...template.thinkingLevelMap } } : {}),
    ...(template.compat ? { compat: { ...template.compat } } : {}),
  };
}

function missingSupplements(
  models: readonly Model<Api>[],
  supplements: readonly ModelSupplement[],
): Model<Api>[] {
  const additions: Model<Api>[] = [];
  for (const supplement of supplements) {
    if (models.some((model) => model.id === supplement.id)) continue;
    const template = models.find((model) => model.id === supplement.templateId);
    if (!template) continue;
    additions.push(cloneModel(template, supplement));
  }
  return additions;
}

function supplementProvider(provider: Provider, supplements: readonly ModelSupplement[]): Provider {
  if (missingSupplements(provider.getModels(), supplements).length === 0) return provider;
  let lastChatSource: readonly Model<Api>[] | undefined;
  let lastChatResult: readonly Model<Api>[] = [];
  let lastAllSource:
    | readonly ReturnType<NonNullable<Provider["getAllModels"]>>[number][]
    | undefined;
  let lastAllResult: readonly ReturnType<NonNullable<Provider["getAllModels"]>>[number][] = [];
  const getModels = () => {
    const current = provider.getModels();
    if (current === lastChatSource) return lastChatResult;
    const additions = missingSupplements(current, supplements);
    lastChatSource = current;
    lastChatResult = additions.length > 0 ? [...current, ...additions] : current;
    return lastChatResult;
  };
  const getAllModels = () => {
    const current = provider.getAllModels?.() ?? provider.getModels();
    if (current === lastAllSource) return lastAllResult;
    const additions = missingSupplements(provider.getModels(), supplements);
    lastAllSource = current;
    lastAllResult = additions.length > 0 ? [...current, ...additions] : current;
    return lastAllResult;
  };
  return {
    ...provider,
    getModels,
    ...(provider.getAllModels ? { getAllModels } : {}),
  };
}

/** Supplements a `Models` collection with catalog entries not yet shipped in the installed `pi-ai` package. */
export function supplementBuiltinModels(models: MutableModels): MutableModels {
  for (const [providerId, supplements] of Object.entries(CATALOG_SUPPLEMENTS)) {
    const provider = models.getProvider(providerId);
    if (!provider) continue;
    const supplemented = supplementProvider(provider, supplements);
    if (supplemented !== provider) models.setProvider(supplemented);
  }
  return models;
}

/** Builds Eta's built-in model catalog with any backported model definitions applied. */
export function createBuiltinModels(options?: CreateModelsOptions): MutableModels {
  return supplementBuiltinModels(builtinModels(options));
}
