import { Schema } from 'effect';

import { RoleIdSchema } from '../ids.ts';
import type { CatalogSnapshotEntry, Cell } from '../model.ts';
import { AccessModeSchema, AmountCeilingSchema, RecordSelectorSchema } from '../model.ts';
import { cellOf } from './cells.ts';

/**
 * What an adoption writes into one role: the supported modes it is granted in, the record scope it
 * reaches, and an optional amount ceiling. Adoption is the only path that adds cells.
 */
export const AdoptionTargetSchema = Schema.Struct({
  amountCeiling: Schema.optionalKey(AmountCeilingSchema),
  modes: Schema.NonEmptyArray(AccessModeSchema).check(Schema.isUnique()),
  roleId: RoleIdSchema,
  selector: RecordSelectorSchema,
});
export type AdoptionTarget = typeof AdoptionTargetSchema.Type;

export const targetsCells = (entry: CatalogSnapshotEntry, target: AdoptionTarget): readonly Cell[] =>
  target.modes.map((mode) => cellOf(entry.key, mode, target.selector, target.amountCeiling));

/** Adoption names the effect it grants; the same entry always produces the same label (D7c). */
export const capabilityEffectLabel = (entry: CatalogSnapshotEntry): string =>
  `${entry.key} [${entry.kind}/${entry.risk}]`;

/**
 * Modes and selectors are never invented at adoption time: only what the declaration supports can
 * be granted, and a money ceiling needs the declaration's one scalar money input (O18).
 */
export const targetIssue = (entry: CatalogSnapshotEntry, target: AdoptionTarget): string | undefined => {
  const supportedModes = new Set(entry.modes);
  const unsupportedMode = target.modes.find((mode) => !supportedModes.has(mode));
  if (unsupportedMode !== undefined) {
    return `capability ${entry.key} does not declare mode ${unsupportedMode}`;
  }
  if (entry.selectors.length === 0) {
    if (target.selector !== 'all') {
      return `capability ${entry.key} is not record-scoped; only the all selector is adoptable`;
    }
  } else if (!new Set(entry.selectors).has(target.selector)) {
    return `capability ${entry.key} does not declare selector ${target.selector}`;
  }
  if (target.amountCeiling !== undefined && !(entry.kind === 'action' && entry.amountInput !== undefined)) {
    return `capability ${entry.key} declares no single money input, so an amount ceiling cannot apply (O18)`;
  }
  return undefined;
};
