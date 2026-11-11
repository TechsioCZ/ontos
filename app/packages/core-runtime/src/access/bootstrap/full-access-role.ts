import type { Result } from 'effect';

import type { AccessProjectionError } from '../compiler/projection-error.ts';
import { RECORD_SELECTORS_NARROWEST_FIRST, compileRoleTemplateCells } from '../compiler/cells.ts';
import type { CompiledRoleTemplate, RoleEditorSwitch, RoleTemplateIntent } from '../compiler/cells.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import { RoleIdSchema, RoleTemplateKeySchema } from '../ids.ts';
import type { RoleId, RoleTemplateKey } from '../ids.ts';
import type { CatalogSnapshot, CatalogSnapshotEntry, RecordSelector } from '../model.ts';

/** The one role every tenant starts with (O67-Q6): the label people see, never a technical key. */
export const FULL_ACCESS_ROLE_NAME = 'Plný přístup';

/** Its template identity: what a role revision of this role records as its origin. */
export const FULL_ACCESS_ROLE_TEMPLATE_KEY: RoleTemplateKey = RoleTemplateKeySchema.make('full_access');

/** The tenant's own "Plný přístup": the role its permission bootstrap created, derived from the tenant alone. */
export const fullAccessPresetRoleId = (tenantId: string): RoleId =>
  RoleIdSchema.make(stableUuid(['ontos.access.bootstrap.role', tenantId, FULL_ACCESS_ROLE_TEMPLATE_KEY].join(':')));

/** Widest first, so the first declared selector found is the widest one the capability allows. */
const SELECTORS_WIDEST_FIRST: readonly RecordSelector[] = [...RECORD_SELECTORS_NARROWEST_FIRST].toReversed();

/**
 * The widest record selector a capability declares. A capability that is not record-scoped has exactly
 * one cell and `all` is its name; a record-scoped capability gets the widest selector it declares, never
 * one it does not (O2, O10).
 */
export const widestSelectorOf = (entry: CatalogSnapshotEntry): RecordSelector =>
  entry.selectors.length === 0
    ? 'all'
    : (SELECTORS_WIDEST_FIRST.find((selector) => entry.selectors.includes(selector)) ?? 'all');

/**
 * "Full access" as a role template over one pinned catalog: every capability of the catalog, with every
 * mode it declares and the widest selector it declares. Nothing is invented — a capability this catalog
 * does not declare cannot be named. A later release reaches this role only through release activation
 * (`../release/activation.ts`), as an additions-only successor compiled from that release, never silently.
 *
 * Every capability is named as a switch rather than reached through a level row: a row would hand out
 * only routine capabilities at or below its level, and a new tenant's owner holds the whole catalog, not
 * the routine half of it (P1, P2).
 */
export const fullAccessRoleIntent = (catalog: CatalogSnapshot): RoleTemplateIntent => ({
  limits: [],
  rows: [],
  switches: catalog.entries.map((entry): RoleEditorSwitch => ({
    capabilityKey: entry.key,
    selector: widestSelectorOf(entry),
  })),
  templateKey: FULL_ACCESS_ROLE_TEMPLATE_KEY,
});

/** The cells of "Full access", compiled against the snapshot they are pinned to. */
export const compileFullAccessRole = (
  catalog: CatalogSnapshot,
): Result.Result<CompiledRoleTemplate, readonly AccessProjectionError[]> =>
  compileRoleTemplateCells(fullAccessRoleIntent(catalog), catalog);
