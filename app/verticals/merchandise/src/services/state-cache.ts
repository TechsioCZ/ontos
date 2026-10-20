// Process-local cache of the decoded merchandise aggregate, keyed by scope + revision + updatedAt.
// SKELETON (lane akros-sync-backend): task "persistence" replaces the stub bodies; keep the exported signatures.
import type { MerchandiseState } from '../../shared/apis/records.ts';
import type { ProductRecord } from '../../shared/domain/merchandise-model.ts';

/** Cache identity of one stored row version: `${tenantId}|${legalEntityId}|${revision}|${updatedAtMillis}`. */
export const stateCacheKey = (input: {
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly revision: number;
  readonly updatedAt: Date;
}): string => `${input.tenantId}|${input.legalEntityId}|${input.revision}|${input.updatedAt.getTime()}`;

/** Returns the cached decoded state for exactly this key, or undefined. */
export const getCachedState = (key: string): MerchandiseState | undefined => {
  void key;
  return undefined;
};

/** Stores the decoded state for this key (one entry per tenant|legalEntity scope). */
export const setCachedState = (key: string, state: MerchandiseState): void => {
  void key;
  void state;
};

/** Derived product records of one state object, computed once per state object. */
export const cachedProductRecords = (
  state: MerchandiseState,
  compute: (state: MerchandiseState) => readonly ProductRecord[],
): readonly ProductRecord[] => compute(state);
