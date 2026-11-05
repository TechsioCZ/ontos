import { Schema } from 'effect';

import type { AccessCellSchema } from '../../../../shared/access-admin-api.ts';

const ChangeDecisionSchema = Schema.Literals(['adopt', 'decline', 'undo']);
const ChangeStatusSchema = Schema.Literals(['pending', 'adopted', 'declined', 'undone']);
const ChangeRiskSchema = Schema.Literals(['routine', 'sensitive', 'critical']);
export type ChangeDecision = typeof ChangeDecisionSchema.Type;
export type ChangeStatus = typeof ChangeStatusSchema.Type;
export type ChangeRisk = typeof ChangeRiskSchema.Type;

export interface ChangeCellView {
  readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
  readonly capabilityKey: string;
  readonly mode: typeof AccessCellSchema.fields.mode.Type;
  readonly selector: typeof AccessCellSchema.fields.selector.Type;
}

export interface RoleChangeView {
  readonly after: readonly ChangeCellView[];
  readonly before: readonly ChangeCellView[];
  readonly expectedRevisionId: string;
  readonly roleId: string;
  readonly roleName: string;
}

/** Presentation data only. Missing safety metadata never enables a bulk decision. */
export interface ChangeItemView {
  readonly addedCells: readonly { readonly cell: ChangeCellView; readonly roleId: string }[];
  readonly affectedHolders: readonly string[];
  readonly batchEligible: boolean;
  readonly capabilityKey: string;
  readonly catalogSnapshotId: string;
  readonly id: string;
  readonly kind: 'new' | 'renamed' | 'split' | 'removed' | 'risk_changed';
  readonly lineage: readonly string[];
  readonly provenance: string | null;
  readonly removedCells: readonly { readonly cell: ChangeCellView; readonly roleId: string }[];
  readonly risk: ChangeRisk;
  readonly roleNames: Readonly<Record<string, string>>;
  readonly status: ChangeStatus;
  readonly suggestedRoles: readonly string[];
  readonly widening: boolean | null;
}

export interface ChangePreviewView {
  readonly affectedHumanCount: number | null;
  readonly catalogSnapshotId: string;
  readonly decision: ChangeDecision;
  readonly effects: readonly { readonly description: string; readonly itemId: string }[];
  readonly items: readonly ChangeItemView[];
  readonly legalEntityId: string | null;
  readonly requiresNamedEffect: boolean;
  readonly roleChanges: readonly RoleChangeView[] | null;
  readonly token: string;
  readonly undoSkips: ChangeReceiptView['skipped'] | null;
}

export interface ChangeReceiptView {
  readonly legalEntityId: string | null;
  readonly skipped: readonly {
    readonly capabilityKey: string;
    readonly reason:
      | 'already_present'
      | 'already_removed'
      | 'capability_not_published'
      | 'cell_revoked_later'
      | 'role_missing';
    readonly roleId: string;
    readonly slot: string;
  }[];
}

const ChangesNoticeSchema = Schema.Literals([
  'unauthenticated',
  'forbidden',
  'unavailable',
  'stalePreview',
  'failed',
  'saved',
]);
export type ChangesNotice = typeof ChangesNoticeSchema.Type;

export const isBatchEligible = (item: ChangeItemView): boolean =>
  item.status === 'pending' && item.risk === 'routine' && item.widening === false && item.batchEligible;

export const canPreviewDecision = (items: readonly ChangeItemView[], decision: ChangeDecision): boolean => {
  if (items.length === 0 || new Set(items.map((item) => item.id)).size !== items.length) {
    return false;
  }
  const [first] = items;
  if (items.some((item) => item.catalogSnapshotId !== first?.catalogSnapshotId)) {
    return false;
  }
  if (decision === 'undo') {
    return items.length === 1 && first?.status === 'adopted';
  }
  if (items.some((item) => item.status !== 'pending')) {
    return false;
  }
  return items.length === 1 || (decision === 'adopt' && items.every(isBatchEligible));
};

export const previewMatchesSelection = (
  preview: ChangePreviewView,
  items: readonly ChangeItemView[],
  decision: ChangeDecision,
): boolean =>
  preview.token.length > 0 &&
  preview.legalEntityId === null &&
  preview.decision === decision &&
  preview.items.length === items.length &&
  preview.catalogSnapshotId === items[0]?.catalogSnapshotId &&
  preview.items.every(
    (item) => item.catalogSnapshotId === preview.catalogSnapshotId && items.some((selected) => selected.id === item.id),
  ) &&
  canPreviewDecision(preview.items, decision);

export const canConfirmPreview = (preview: ChangePreviewView, confirmedItemIds: readonly string[]): boolean => {
  if (
    preview.legalEntityId !== null ||
    !canPreviewDecision(preview.items, preview.decision) ||
    preview.token.length === 0
  ) {
    return false;
  }
  if (preview.decision === 'decline') {
    return true;
  }
  const individual = preview.requiresNamedEffect || preview.items.some((item) => !isBatchEligible(item));
  if (!individual) {
    return true;
  }
  const confirmed = new Set(confirmedItemIds);
  return (
    preview.items.length === 1 &&
    preview.items.every((item) =>
      preview.effects.some((effect) => effect.itemId === item.id && effect.description.trim().length > 0),
    ) &&
    preview.effects.every((effect) => confirmed.has(effect.itemId))
  );
};
