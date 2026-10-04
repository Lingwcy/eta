const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (record(a) && record(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  return false;
}

/** Merge independent manifest fields; conflicting changes to the same value require review. */
export function mergeAgentManifest(
  base: unknown,
  local: unknown,
  upstream: unknown,
  path = "package.json",
): unknown {
  if (equal(local, base)) return upstream;
  if (equal(upstream, base) || equal(local, upstream)) return local;
  if (record(local) && record(upstream) && (base === undefined || record(base))) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(upstream),
      ...Object.keys(local),
      ...Object.keys(base ?? {}),
    ])) {
      const value = mergeAgentManifest(base?.[key], local[key], upstream[key], `${path}.${key}`);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  throw new Error(`Conflicting agent manifest field: ${path}`);
}
