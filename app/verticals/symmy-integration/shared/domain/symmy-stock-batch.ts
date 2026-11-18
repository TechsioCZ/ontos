import { InventorySourceAssertionProposalSchema } from '@app/inventory/source-assertion';
import { Schema } from 'effect';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const proposal = InventorySourceAssertionProposalSchema.fields;
const itemKey = boundedText.pipe(Schema.brand('SymmyStockItemKey'));
const locationKey = boundedText.pipe(Schema.brand('SymmyStockLocationKey'));

/**
 * One normalized absolute on-hand figure from the public stock route. The identifier kinds, the
 * meaning and the whole source scope are fixed by the route enrollment, never sent by the caller.
 */
export const SymmyStockRowSchema = Schema.Struct({
  businessObservedAt: proposal.businessObservedAt,
  itemKey,
  locationKey,
  quantity: proposal.quantity,
  revision: boundedText,
  sourceReference: proposal.sourceReference,
});
export type SymmyStockRow = typeof SymmyStockRowSchema.Type;

/** One request carries at most sixteen rows, which is the item limit of a synchronous plan. */
export const SymmyStockRowsSchema = Schema.NonEmptyArray(SymmyStockRowSchema).check(Schema.isMaxLength(16));
export type SymmyStockRows = typeof SymmyStockRowsSchema.Type;

/**
 * One stock position the route is enrolled for. A row is admitted only when its item key and
 * location key name an entry. Quantity, revision, times and source reference are never enrolled.
 */
export const SymmyStockScopeEntrySchema = Schema.Struct({
  customerConfigurationId: proposal.customerConfigurationId,
  issuerBackendId: proposal.issuer.fields.backendId,
  itemKey,
  locationKey,
  namespace: proposal.itemExternalKey.fields.namespace,
  positionRef: proposal.positionRef,
  scope: proposal.itemExternalKey.fields.externalScope,
});
export type SymmyStockScopeEntry = typeof SymmyStockScopeEntrySchema.Type;

/** The identity of a position inside the enrollment. Length prefixes keep two different pairs apart. */
export const symmyStockScopeKey = ({
  itemKey: item,
  locationKey: location,
}: {
  readonly itemKey: string;
  readonly locationKey: string;
}): string => `${item.length}:${item}${location.length}:${location}`;

export const SymmyStockScopeSchema = Schema.NonEmptyArray(SymmyStockScopeEntrySchema).check(
  Schema.isMaxLength(10_000),
  Schema.makeFilter(
    (entries) =>
      new Set(entries.map(symmyStockScopeKey)).size === entries.length ||
      'A stock scope entry names one item and location only once',
  ),
);
