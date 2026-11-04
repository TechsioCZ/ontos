import type { StockMovementReason } from '../../../../../shared/domain/merchandise-model.ts';

export type ManualReason = Exclude<StockMovementReason, 'ORDER'>;

/** Typed movement fields. The product panel owns them, so Esc and outside clicks can see an unsent movement. */
export interface MovementDraft {
  readonly note: string;
  readonly quantity: number;
  /** The quantity input's text, kept as typed so "2,5" reaches validation instead of becoming 25. */
  readonly quantityText: string;
  readonly reason: ManualReason;
  /** Required on a product with variants: the storefront sells variant stock, not the product total. */
  readonly variantId?: string | undefined;
}

export const EMPTY_MOVEMENT_DRAFT: MovementDraft = { note: '', quantity: 1, quantityText: '1', reason: 'RECEIPT' };

/** True when the movement form holds something the user typed or picked beyond the empty defaults. */
export const isMovementDraftDirty = (draft: MovementDraft): boolean =>
  draft.reason !== EMPTY_MOVEMENT_DRAFT.reason ||
  draft.quantity !== EMPTY_MOVEMENT_DRAFT.quantity ||
  draft.note.trim() !== EMPTY_MOVEMENT_DRAFT.note ||
  draft.variantId !== undefined;
