import type { InputModel, InputProvider } from "./types";

export function modelPickerProviders(
  models: readonly InputModel[],
  providers: readonly InputProvider[],
) {
  return [...new Set(models.map((model) => model.provider))].map((id) => ({
    id,
    name: providers.find((provider) => provider.id === id)?.name ?? id,
  }));
}

/** Search spans providers; clearing it returns to the selected provider filter. */
export function visiblePickerModels(
  models: readonly InputModel[],
  providers: readonly InputProvider[],
  providerId: string | null,
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return models.filter((model) =>
    search
      ? `${model.name} ${model.id} ${model.provider} ${providers.find((provider) => provider.id === model.provider)?.name ?? ""}`
          .toLocaleLowerCase()
          .includes(search)
      : providerId === null || model.provider === providerId,
  );
}
