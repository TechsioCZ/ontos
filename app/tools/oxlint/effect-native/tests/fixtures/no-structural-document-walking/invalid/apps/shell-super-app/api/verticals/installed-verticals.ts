// expect-count: 4
import { Predicate } from 'effect';

export const installedVerticalIds = (topology: Record<string, unknown>): ReadonlySet<string> => {
  if (!Array.isArray(topology['verticals'])) {
    throw new TypeError('Topology verticals are missing');
  }
  const ids = new Set<string>();
  for (const value of topology['verticals']) {
    const entry = value as Record<string, unknown>;
    if (entry['kind'] !== 'vertical') {
      throw new Error('Topology contains a non-vertical installed candidate');
    }
    if (!Predicate.isString(entry['id'])) {
      throw new Error('Topology contains an invalid vertical ID');
    }
    if (typeof entry['label'] !== 'string') {
      throw new Error('Topology contains an invalid vertical label');
    }
    if ('legacyRemote' in entry) {
      throw new Error('Topology exposes a legacy remote');
    }
    ids.add(String(entry['id']));
  }
  return ids;
};
