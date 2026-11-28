import { Match, Schema } from 'effect';

import { AccessCapabilityKeySchema, AccessRecordKeySchema } from '../../../../shared/access-admin-api.ts';

export const RoleModeSchema = Schema.Literals(['run', 'propose', 'approve']);
export type RoleMode = typeof RoleModeSchema.Type;
export const RoleSelectorSchema = Schema.Literals(['all', 'assigned', 'entrusted', 'team']);
export type RoleSelector = typeof RoleSelectorSchema.Type;
export const RoleLevelSchema = Schema.Literals(['basic', 'extended', 'manage']);
export type RoleLevel = typeof RoleLevelSchema.Type;

export const RoleCellViewSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(
    Schema.Struct({ currency: Schema.String, limitMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  ),
  capabilityKey: AccessCapabilityKeySchema,
  mode: RoleModeSchema,
  selector: Schema.Union([
    Schema.TaggedStruct('all', {}),
    Schema.TaggedStruct('assigned', {}),
    Schema.TaggedStruct('entrusted', {}),
    Schema.TaggedStruct('team', {}),
    Schema.TaggedStruct('targets', { recordKeys: Schema.NonEmptyArray(AccessRecordKeySchema) }),
  ]),
});
export type RoleCellView = typeof RoleCellViewSchema.Encoded;

export interface RoleCapabilityView {
  readonly amountInput?: string;
  readonly fieldClass?: string;
  readonly key: string;
  readonly kind: string;
  readonly modes: readonly RoleMode[];
  readonly moduleKey: string;
  readonly placement: { readonly group: string; readonly level: RoleLevel };
  readonly risk: 'routine' | 'sensitive' | 'critical';
  readonly selectors: readonly RoleSelector[];
}
export interface RoleView {
  readonly catalogSnapshotId: string;
  readonly cells: readonly RoleCellView[];
  readonly id: string;
  readonly legalEntityId?: string;
  readonly name: string;
  readonly revision: number;
  readonly revisionId: string;
}
export interface RoleTemplateView {
  readonly catalogSnapshotId: string;
  readonly cells: readonly RoleCellView[];
  readonly name: string;
  readonly templateKey: string;
}
export interface RolePreviewView {
  readonly added: readonly RoleCellView[];
  readonly affectedHumanCount: number;
  readonly affectedPeople: readonly string[];
  readonly dangerousEffects: readonly { readonly description: string; readonly id: string; readonly value: string }[];
  readonly previewToken: string;
  readonly removed: readonly RoleCellView[];
  readonly requiresNamedEffect: boolean;
}
export const RoleEditorStatusSchema = Schema.Literals([
  'idle',
  'loading',
  'saving',
  'saved',
  'conflict',
  'unavailable',
  'forbidden',
  'unauthenticated',
  'invalid',
]);
export type RoleEditorStatus = typeof RoleEditorStatusSchema.Type;

export const targetRecordKeys = (cell: RoleCellView): readonly string[] =>
  Match.value(cell.selector).pipe(
    Match.tag('targets', (selector) => selector.recordKeys),
    Match.tag('all', 'assigned', 'entrusted', 'team', () => []),
    Match.exhaustive,
  );
export const cellHasSelector = (cell: RoleCellView, selector: RoleSelector): boolean =>
  Match.value(cell.selector).pipe(
    Match.tag('all', () => selector === 'all'),
    Match.tag('assigned', () => selector === 'assigned'),
    Match.tag('entrusted', () => selector === 'entrusted'),
    Match.tag('team', () => selector === 'team'),
    Match.tag('targets', () => false),
    Match.exhaustive,
  );
export const roleCellSlot = (cell: RoleCellView): string => `${cell.capabilityKey}:${cell.mode}:${cell.selector._tag}`;

/** A level materializes only the displayed snapshot; it never records a future-following rule. */
export const cellsForLevel = (
  entries: readonly RoleCapabilityView[],
  moduleKey: string,
  level: RoleLevel,
): readonly RoleCellView[] =>
  entries.flatMap((entry) =>
    entry.moduleKey === moduleKey &&
    entry.placement.level === level &&
    entry.modes.includes('run') &&
    (entry.selectors.length === 0 || entry.selectors.includes('all'))
      ? [{ capabilityKey: entry.key, mode: 'run' as const, selector: { _tag: 'all' as const } }]
      : [],
  );
export const addExactLevel = (
  cells: readonly RoleCellView[],
  entries: readonly RoleCapabilityView[],
  moduleKey: string,
  level: RoleLevel,
): readonly RoleCellView[] => {
  const result = [...cells];
  for (const cell of cellsForLevel(entries, moduleKey, level)) {
    const exists = result.some(
      (existing) =>
        roleCellSlot(existing) === roleCellSlot(cell) ||
        (existing.capabilityKey === cell.capabilityKey &&
          existing.mode === cell.mode &&
          targetRecordKeys(existing).length > 0),
    );
    if (!exists) {
      result.push(cell);
    }
  }
  return result;
};
export const canSaveRolePreview = (
  preview: RolePreviewView | null,
  confirmations: readonly string[],
  status: RoleEditorStatus,
  writesAvailable: boolean,
): boolean => {
  const confirmed = new Set(confirmations);
  return (
    writesAvailable &&
    (status === 'idle' || status === 'unavailable') &&
    preview !== null &&
    (!preview.requiresNamedEffect || preview.dangerousEffects.length > 0) &&
    preview.dangerousEffects.every((effect) => confirmed.has(effect.id))
  );
};
export const parseAmountCeiling = (amount: string, currency: string): RoleCellView['amountCeiling'] | 'invalid' => {
  if (amount.trim() === '') {
    return undefined;
  }
  if (!/^\d+$/u.test(amount) || !/^[A-Z]{3}$/u.test(currency)) {
    return 'invalid';
  }
  const limitMinor = Number(amount);
  return Number.isSafeInteger(limitMinor) ? { currency, limitMinor } : 'invalid';
};

/** The typed amount and currency of every cell that carries a ceiling, keyed by its slot. */
export const amountEntries = (cells: readonly RoleCellView[]) => ({
  amounts: Object.fromEntries(
    cells.flatMap((cell) =>
      cell.amountCeiling === undefined ? [] : [[roleCellSlot(cell), String(cell.amountCeiling.limitMinor)]],
    ),
  ),
  currencies: Object.fromEntries(
    cells.flatMap((cell) =>
      cell.amountCeiling === undefined ? [] : [[roleCellSlot(cell), cell.amountCeiling.currency]],
    ),
  ),
});

/** The slots of the cells whose typed amount and currency do not form a ceiling. */
export const invalidAmountSlots = (
  cells: readonly RoleCellView[],
  amounts: Readonly<Record<string, string>>,
  currencies: Readonly<Record<string, string>>,
): readonly string[] =>
  cells.flatMap((cell) => {
    const slot = roleCellSlot(cell);
    return parseAmountCeiling(amounts[slot] ?? '', currencies[slot] ?? '') === 'invalid' ? [slot] : [];
  });

/**
 * The cells with the ceilings the person typed: a cell with a typed entry takes its ceiling, an empty
 * amount removes it, and a cell without an entry keeps the ceiling it has.
 */
export const withAmountCeilings = (
  cells: readonly RoleCellView[],
  amounts: Readonly<Record<string, string>>,
  currencies: Readonly<Record<string, string>>,
): readonly RoleCellView[] =>
  cells.map((cell) => {
    const slot = roleCellSlot(cell);
    const value = parseAmountCeiling(amounts[slot] ?? '', currencies[slot] ?? '');
    if (!(slot in amounts || slot in currencies) || value === 'invalid') {
      return cell;
    }
    const { amountCeiling: _previous, ...base } = cell;
    return value === undefined ? base : { ...base, amountCeiling: value };
  });

/**
 * The editor's server state: the cells the server previewed and would save, the preview, the edited
 * cells it was asked for (any other edit makes it stale) and the operation status.
 */
export interface RoleDraft {
  readonly cells: readonly RoleCellView[];
  readonly editorVersion: number;
  readonly preview: RolePreviewView | null;
  readonly previewedCells: readonly RoleCellView[];
  readonly status: RoleEditorStatus;
}
export const initialRoleDraft = (cells: readonly RoleCellView[]): RoleDraft => ({
  cells,
  editorVersion: 0,
  preview: null,
  previewedCells: cells,
  status: 'idle',
});
