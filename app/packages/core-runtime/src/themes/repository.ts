import { and, eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';

import { tenantThemeAttachments, tenantThemes } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { TenantThemeDefinition } from './contract.ts';
import { tenantThemeUnavailable } from './errors.ts';

type TenantThemeRow = Pick<typeof tenantThemes.$inferSelect, 'defaults' | 'label' | 'modes' | 'themeKey' | 'tokens'>;

const toDefinition = (row: TenantThemeRow): TenantThemeDefinition => {
  const theme = { key: row.themeKey, label: row.label, modes: row.modes, tokens: row.tokens };
  return row.defaults === null ? theme : { ...theme, defaults: row.defaults };
};

const themeColumns = {
  defaults: tenantThemes.defaults,
  label: tenantThemes.label,
  modes: tenantThemes.modes,
  themeKey: tenantThemes.themeKey,
  tokens: tenantThemes.tokens,
};

/**
 * The theme store of one tenant inside one Core-owned scoped transaction. The tenant comes from the trusted scope,
 * never from a payload, and the members are the only theme operations a handler can perform.
 */
export const tenantThemeRepositoryFromTransaction = (transaction: ScopedTransactionExecutor, tenantId: string) => ({
  attach: (themeKey: string) =>
    transaction
      .insert(tenantThemeAttachments)
      .values({ tenantId, themeKey })
      .onConflictDoUpdate({ set: { themeKey, updatedAt: sql`now()` }, target: tenantThemeAttachments.tenantId })
      .pipe(Effect.asVoid, Effect.mapError(tenantThemeUnavailable)),

  /** The attached theme, or `undefined` when the tenant uses the default. */
  attached: () =>
    transaction
      .select(themeColumns)
      .from(tenantThemeAttachments)
      .innerJoin(
        tenantThemes,
        and(
          eq(tenantThemes.tenantId, tenantThemeAttachments.tenantId),
          eq(tenantThemes.themeKey, tenantThemeAttachments.themeKey),
        ),
      )
      .where(eq(tenantThemeAttachments.tenantId, tenantId))
      .limit(1)
      .pipe(
        Effect.map(([row]) => (row === undefined ? undefined : toDefinition(row))),
        Effect.mapError(tenantThemeUnavailable),
      ),

  detach: () =>
    transaction
      .delete(tenantThemeAttachments)
      .where(eq(tenantThemeAttachments.tenantId, tenantId))
      .pipe(Effect.asVoid, Effect.mapError(tenantThemeUnavailable)),

  exists: (themeKey: string) =>
    transaction
      .select({ themeKey: tenantThemes.themeKey })
      .from(tenantThemes)
      .where(and(eq(tenantThemes.tenantId, tenantId), eq(tenantThemes.themeKey, themeKey)))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(tenantThemeUnavailable),
      ),

  /** Inserts the theme, or replaces the one with the same key; an attached theme changes for its tenant at once. */
  save: (theme: TenantThemeDefinition) => {
    const fields = {
      defaults: theme.defaults ?? null,
      label: theme.label,
      modes: [...theme.modes],
      tokens: theme.tokens,
    };
    return transaction
      .insert(tenantThemes)
      .values({ ...fields, tenantId, themeKey: theme.key })
      .onConflictDoUpdate({
        set: { ...fields, updatedAt: sql`now()` },
        target: [tenantThemes.tenantId, tenantThemes.themeKey],
      })
      .pipe(Effect.asVoid, Effect.mapError(tenantThemeUnavailable));
  },
});
