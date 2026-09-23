import type { CatalogResourceRef } from './catalog-revision-reference.ts';

export const CONFIGURATION_UNIT_RESOURCE_TYPE = 'commerce.catalog.unit';

/** Measurement Unit identity is independent of purchase Quantity's Product Unit. */
export interface ConfigurationUnitRevision {
  readonly dimension: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly evidenceRefs: readonly string[];
  readonly lifecycleState: 'ACTIVE' | 'RETIRED';
  readonly meaning: string;
  readonly ref: CatalogResourceRef;
  readonly revision: number;
}

/** Only an owner-local scoped read may issue a confirmed Current result. */
export type ConfigurationUnitCurrent =
  | { readonly assessedAt: Date; readonly revision: ConfigurationUnitRevision; readonly status: 'CONFIRMED' }
  | { readonly status: 'NOT_FOUND' | 'NO_CURRENT' | 'CONFLICT' | 'RETIRED' };
