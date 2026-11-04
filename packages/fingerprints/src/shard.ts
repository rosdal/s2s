import type { CorpusVersion } from "./build.js";

/**
 * Shard `index` of `count`: each package stays whole (its versions build in one job), and
 * shards are balanced by version count, largest packages placed first.
 */
export function shard(versions: CorpusVersion[], index: number, count: number): CorpusVersion[] {
  const byName = new Map<string, CorpusVersion[]>();
  for (const v of versions) byName.set(v.name, [...(byName.get(v.name) ?? []), v]);
  const loads = Array.from({ length: count }, () => ({ size: 0, items: [] as CorpusVersion[] }));
  const groups = [...byName.values()].sort(
    (a, b) => b.length - a.length || (a[0]?.name ?? "").localeCompare(b[0]?.name ?? ""),
  );
  for (const list of groups) {
    const lightest = loads.reduce((min, l) => (l.size < min.size ? l : min));
    lightest.size += list.length;
    lightest.items.push(...list);
  }
  return loads[index]?.items ?? [];
}
