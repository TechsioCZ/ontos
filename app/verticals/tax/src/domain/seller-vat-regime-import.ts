import { DateTime, Order, Schema } from 'effect';

import type { SellerVatRegimeImportEntry } from '../../shared/actions/seller-vat-regime-declaration.ts';
import {
  SellerVatRegimeEffectiveFromOriginSchema,
  SellerVatRegimeSchema,
} from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
import { RevisionSchema } from '../../shared/domain/tax-kernel/tax-domain-primitives.ts';

/** One revision an import stores, in revision order. */
export const ImportedSellerVatRegimeRevisionSchema = Schema.Struct({
  effectiveFrom: Schema.DateTimeUtc,
  effectiveFromOrigin: SellerVatRegimeEffectiveFromOriginSchema,
  reason: Schema.optionalKey(Schema.String),
  regime: SellerVatRegimeSchema,
  revision: RevisionSchema,
  sourceRecordRef: Schema.String,
});
export type ImportedSellerVatRegimeRevision = typeof ImportedSellerVatRegimeRevisionSchema.Type;

export const SellerVatRegimeImportPlanSchema = Schema.Union([
  Schema.TaggedStruct('AMBIGUOUS_SOURCE_HISTORY', {}),
  Schema.TaggedStruct('PLANNED', { revisions: Schema.Array(ImportedSellerVatRegimeRevisionSchema) }),
]);
export type SellerVatRegimeImportPlan = typeof SellerVatRegimeImportPlanSchema.Type;

const allDistinct = (keys: readonly (number | string)[]): boolean => new Set(keys).size === keys.length;

const byEffectiveFrom = Order.mapInput(
  DateTime.Order,
  (entry: { readonly effectiveFrom: DateTime.Utc }) => entry.effectiveFrom,
);

const plannedEntry = (
  { effectiveFrom, reason, regime, sourceRecordRef }: SellerVatRegimeImportEntry,
  migrationStartedAt: DateTime.Utc,
) => {
  const entry = {
    effectiveFrom: effectiveFrom ?? migrationStartedAt,
    effectiveFromOrigin: effectiveFrom === undefined ? ('MIGRATION_START' as const) : ('SOURCE' as const),
    regime,
    sourceRecordRef,
  };
  return reason === undefined ? entry : { ...entry, reason };
};

/**
 * Maps the source declarations of one seller to the revisions the import stores (907-Q08). Dated entries keep their
 * source `effectiveFrom`, past or scheduled, and become revisions 1..n in effect order. A current-only entry (no
 * date) is allowed only alone; it takes effect at `migrationStartedAt`, the start of usability in OntOS, and no
 * earlier history is inferred. Duplicate dates or source records, or a current-only entry beside dated ones, have no
 * single honest order and are rejected.
 */
export const planSellerVatRegimeImport = ({
  declarations,
  migrationStartedAt,
}: {
  readonly declarations: readonly SellerVatRegimeImportEntry[];
  readonly migrationStartedAt: DateTime.Utc;
}): SellerVatRegimeImportPlan => {
  const dated = declarations.flatMap(({ effectiveFrom }) => (effectiveFrom === undefined ? [] : [effectiveFrom]));
  const currentOnlyMixed = dated.length !== declarations.length && declarations.length > 1;
  if (
    currentOnlyMixed ||
    !allDistinct(dated.map(DateTime.toEpochMillis)) ||
    !allDistinct(declarations.map(({ sourceRecordRef }) => sourceRecordRef))
  ) {
    return { _tag: 'AMBIGUOUS_SOURCE_HISTORY' };
  }
  const revisions = declarations
    .map((declaration) => plannedEntry(declaration, migrationStartedAt))
    .toSorted(byEffectiveFrom)
    .map((entry, index) => ({ ...entry, revision: index + 1 }));
  return { _tag: 'PLANNED', revisions };
};

/** A stored revision of the seller, as the import compares it; only imported rows carry a run. */
export interface StoredSellerVatRegimeRevision extends ImportedSellerVatRegimeRevision {
  readonly migrationRunRef?: string;
}

export const SellerVatRegimeImportDispositionSchema = Schema.Union([
  Schema.TaggedStruct('INSERT', {}),
  Schema.TaggedStruct('REPLAY', {}),
  Schema.TaggedStruct('MIGRATION_RUN_CONFLICT', {}),
  Schema.TaggedStruct('SELLER_ALREADY_DECLARED', {}),
]);
export type SellerVatRegimeImportDisposition = typeof SellerVatRegimeImportDispositionSchema.Type;

const sameRevision = (stored: StoredSellerVatRegimeRevision, planned: ImportedSellerVatRegimeRevision): boolean =>
  stored.revision === planned.revision &&
  stored.regime === planned.regime &&
  DateTime.Equivalence(stored.effectiveFrom, planned.effectiveFrom) &&
  stored.effectiveFromOrigin === planned.effectiveFromOrigin &&
  stored.sourceRecordRef === planned.sourceRecordRef &&
  stored.reason === planned.reason;

/**
 * What an import does against the seller's stored revisions (907-Q08). Nothing stored: insert. Only this run's
 * revisions, with identical content: an exact replay that stores nothing and keeps the same start, whatever the
 * idempotency key. This run with other content: a run conflict. Any other revision (a direct declaration or another
 * run): the seller is already declared, and later changes go through the declare Action.
 */
export const sellerVatRegimeImportDisposition = ({
  migrationRunRef,
  planned,
  stored,
}: {
  readonly migrationRunRef: string;
  readonly planned: readonly ImportedSellerVatRegimeRevision[];
  readonly stored: readonly StoredSellerVatRegimeRevision[];
}): SellerVatRegimeImportDisposition => {
  if (stored.length === 0) {
    return { _tag: 'INSERT' };
  }
  if (stored.some((revision) => revision.migrationRunRef !== migrationRunRef)) {
    return { _tag: 'SELLER_ALREADY_DECLARED' };
  }
  const ordered = stored.toSorted((left, right) => left.revision - right.revision);
  const identical =
    ordered.length === planned.length &&
    ordered.every((revision, index) => {
      const plannedRevision = planned[index];
      return plannedRevision !== undefined && sameRevision(revision, plannedRevision);
    });
  return identical ? { _tag: 'REPLAY' } : { _tag: 'MIGRATION_RUN_CONFLICT' };
};
