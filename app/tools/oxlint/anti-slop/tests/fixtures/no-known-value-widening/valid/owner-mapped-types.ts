import type { MerchandiseCommand, NewOrderLine } from './owner-contract.ts';

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
interface DraftLine {
  readonly productId: string;
  readonly quantity: number;
  readonly variantId?: string;
}
type EditCommand = Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>;

export const draft: Mutable<DraftLine> = { productId: 'product', quantity: 1 };
export const command: Mutable<EditCommand> = { _tag: 'EditOrder', id: 'order' };
export const line: { -readonly [Key in keyof NewOrderLine]: NewOrderLine[Key] } = { productId: 'product', quantity: 1 };
export const movement: {
  -readonly [Key in keyof Extract<MerchandiseCommand, { readonly _tag: 'RecordStockMovement' }>]:
    Extract<MerchandiseCommand, { readonly _tag: 'RecordStockMovement' }>[Key]
} = { _tag: 'RecordStockMovement', productId: 'product', quantityDelta: 2 };
// Optional keys are added only when present, so no undefined keys appear on the wire.
if (draft.variantId !== undefined) line.variantId = draft.variantId;
