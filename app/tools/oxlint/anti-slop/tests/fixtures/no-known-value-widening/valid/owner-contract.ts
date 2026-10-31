export interface NewOrderLine {
  readonly productId: string;
  readonly quantity: number;
  readonly variantId?: string;
}
export type MerchandiseCommand =
  | { readonly _tag: 'RecordStockMovement'; readonly productId: string; readonly quantityDelta: number; readonly note?: string }
  | { readonly _tag: 'EditOrder'; readonly id: string; readonly note?: string };
