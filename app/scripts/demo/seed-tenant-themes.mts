#!/usr/bin/env node
/**
 * Gives every active tenant without a theme of its own its demo theme (tenant-themes.mts): AKROS's tenant the kit's
 * AKROS brand in the calm admin look, every other tenant the kit's Business brand in the same look. The app host runs
 * it on every boot, after the migrations and before publication (scripts/zerops/app-host.mts, seedTenantThemes).
 *
 * The theme goes through Core's own theme store (themes/repository.ts) in the tenant's scope and the kit's brand
 * validator (themes/kit.ts), as the save-tenant-theme and attach-tenant-theme Actions store it. A tenant that has a
 * theme attached keeps it, and a tenant that keeps its demo theme saved but detached chose the default: neither is
 * written, so an administrator's choice is never overwritten. Rerunning changes nothing.
 *
 *   DATABASE_URL=… node scripts/demo/seed-tenant-themes.mts
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Cause, Config, Console, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Command } from 'effect/cli';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { stableUuid } from '../../packages/core-runtime/src/access/catalog/stable-id.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { CoreDatabase, CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { principals, tenants } from '../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../packages/core-runtime/src/db/scoped-transaction.ts';
import { TenantThemeDefinitionSchema } from '../../packages/core-runtime/src/themes/contract.ts';
import { TenantThemeKit } from '../../packages/core-runtime/src/themes/definition.ts';
import { TenantThemeKitLive } from '../../packages/core-runtime/src/themes/kit.ts';
import { tenantThemeRepositoryFromTransaction } from '../../packages/core-runtime/src/themes/repository.ts';
import { demoThemeOfTenant } from './tenant-themes.mts';

const LOG = '[tenant-themes]';

export class TenantThemeSeedFailure extends Schema.TaggedError<TenantThemeSeedFailure>()('TenantThemeSeedFailure', {
  message: Schema.String,
}) {}

const failure = (message: string) => new TenantThemeSeedFailure({ message });

/** What the seed did for one tenant. */
export type TenantThemeSeedOutcome =
  | { readonly outcome: 'attached'; readonly themeKey: string }
  | { readonly outcome: 'chose-default'; readonly themeKey: string }
  | { readonly outcome: 'kept'; readonly themeKey: string };

/**
 * Every active tenant with a person who can sign in, and one of those people: the tenant's scope names a principal,
 * and a tenant nobody signs in to has no look to keep.
 */
const tenantsToTheme = Effect.gen(function* tenantsToTheme() {
  const { executor } = yield* CoreDatabase;
  const rows = yield* executor
    .select({ principalId: principals.principalId, tenantId: principals.tenantId })
    .from(principals)
    .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
    .where(and(eq(tenants.status, 'active'), eq(principals.kind, 'human'), eq(principals.status, 'active')))
    .orderBy(principals.tenantId, principals.principalId)
    .pipe(Effect.mapError(() => failure('the active tenants could not be read')));
  // One person per tenant: the first, so every boot names the same one.
  return new Map(rows.toReversed().map((row) => [row.tenantId, row]));
});

/** The tenant-wide scope the theme store runs in, as the theme Actions run without a selected company. */
const scopeOf = (tenantId: string, principalId: string) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: stableUuid('ontos.tenant-theme-seed.auth-binding'),
    authContextRef: 'system:tenant-theme-seed',
    authMethod: 'session',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'tenant-theme-seed' })),
    Effect.mapError(() => failure(`tenant ${tenantId}: ${principalId} is not a trusted principal context`)),
  );

/** The tenant's demo theme, saved and attached in one transaction when the tenant has no theme of its own. */
export const seedTenantTheme = Effect.fn('TenantThemeSeed.tenant')(function* seedTenantTheme(
  tenantId: string,
  principalId: string,
) {
  const { executor } = yield* CoreDatabase;
  const enrollment = yield* DatabaseIdentityEnrollmentContext;
  const kit = yield* TenantThemeKit;
  const scope = yield* scopeOf(tenantId, principalId);
  const theme = yield* Schema.decodeUnknownEffect(TenantThemeDefinitionSchema)(demoThemeOfTenant(tenantId)).pipe(
    Effect.flatMap(kit.validate),
    Effect.mapError(() => failure(`tenant ${tenantId}: its demo theme does not pass the kit's brand validator`)),
  );
  return yield* executor
    .transaction((transaction) =>
      installOperationalScope(transaction, scope, enrollment).pipe(
        Effect.flatMap((scoped) =>
          Effect.gen(function* seedInScope(): Effect.fn.Return<TenantThemeSeedOutcome, unknown> {
            const themes = tenantThemeRepositoryFromTransaction(scoped, tenantId);
            const attached = yield* themes.attached();
            if (attached !== undefined) {
              return { outcome: 'kept', themeKey: attached.key };
            }
            if (yield* themes.exists(theme.key)) {
              return { outcome: 'chose-default', themeKey: theme.key };
            }
            yield* themes.save(theme);
            yield* themes.attach(theme.key);
            return { outcome: 'attached', themeKey: theme.key };
          }),
        ),
      ),
    )
    .pipe(Effect.mapError(() => failure(`tenant ${tenantId}: the theme store refused the write`)));
});

const outcomeText = {
  attached: (themeKey: string) => `now wears ${themeKey}`,
  'chose-default': (themeKey: string) => `keeps the default; ${themeKey} is saved but detached`,
  kept: (themeKey: string) => `keeps ${themeKey}`,
} satisfies Record<TenantThemeSeedOutcome['outcome'], (themeKey: string) => string>;

const describe = (tenantId: string, { outcome, themeKey }: TenantThemeSeedOutcome) =>
  `${LOG} tenant ${tenantId}: ${outcomeText[outcome](themeKey)}`;

export const seedTenantThemes = Effect.gen(function* seedTenantThemes() {
  const targets = yield* tenantsToTheme;
  const outcomes = yield* Effect.forEach(targets.values(), ({ principalId, tenantId }) =>
    seedTenantTheme(tenantId, principalId).pipe(
      Effect.tap((seeded) => Console.log(describe(tenantId, seeded))),
      Effect.tapError(({ message }) => Console.error(`${LOG} FAILED ${message}`)),
      Effect.exit,
    ),
  );
  const failed = outcomes.filter(Exit.isFailure).length;
  if (failed > 0) {
    return yield* failure(`${String(failed)} of ${String(outcomes.length)} tenants were not given their theme`);
  }
  return yield* Console.log(`${LOG} done: ${String(outcomes.length)} tenants`);
});

const RuntimeLive = Layer.unwrap(
  Effect.gen(function* tenantThemeSeedRuntime() {
    const url = yield* Config.Redacted('DATABASE_URL').pipe(Effect.mapError(() => failure('DATABASE_URL is required')));
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) }).pipe(
      Effect.mapError(() => failure('DATABASE_URL is not a runtime database address')),
    );
    return Layer.mergeAll(
      CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
      Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
      TenantThemeKitLive,
    );
  }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(
      Command.make('tenant-theme-seed', {}, () => seedTenantThemes),
      { version: '1.0.0' },
    ).pipe(
      Effect.provide(RuntimeLive),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Console.error(`${LOG} FAILED: ${Cause.pretty(exit.cause)}`) : Effect.void,
      ),
    ),
  );
}
