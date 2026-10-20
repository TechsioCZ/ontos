// Process-local cache of the decoded merchandise aggregate, keyed by scope + revision + updatedAt.
import type { MerchandiseState } from '../../shared/apis/records.ts';
import type { ProductRecord } from '../../shared/domain/merchandise-model.ts';

/** Cache identity of one stored row version: `${tenantId}|${legalEntityId}|${revision}|${updatedAtMillis}`. */
export const stateCacheKey = (input: {
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly revision: number;
  readonly updatedAt: Date;
}): string => `${input.tenantId}|${input.legalEntityId}|${input.revision}|${input.updatedAt.getTime()}`;

const entries = new Map<string, { readonly key: string; readonly state: MerchandiseState }>();
const scopeOf = (key: string) => key.split('|').slice(0, 2).join('|');

/** Returns the cached decoded state for exactly this key, or undefined. */
export const getCachedState = (key: string): MerchandiseState | undefined => {
  const entry = entries.get(scopeOf(key));
  return entry !== undefined && entry.key === key ? entry.state : undefined;
};

/** Stores the decoded state for this key (one entry per tenant|legalEntity scope). */
export const setCachedState = (key: string, state: MerchandiseState): void => {
  entries.set(scopeOf(key), { key, state });
};

const recordCache = new WeakMap<MerchandiseState, readonly ProductRecord[]>();

/** Derived product records of one state object, computed once per state object. */
export const cachedProductRecords = (
  state: MerchandiseState,
  compute: (state: MerchandiseState) => readonly ProductRecord[],
): readonly ProductRecord[] => {
  const hit = recordCache.get(state);
  if (hit !== undefined) return hit;
  const value = compute(state);
  recordCache.set(state, value);
  return value;
};
