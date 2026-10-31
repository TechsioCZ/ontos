#!/usr/bin/env node
/** Explicit stage operator seed, never startup. Reuses native account/membership installation and demo read policy. */
import { NodeServices } from '@effect/platform-node';
import { DatabaseConfig, parseDatabaseConfig } from '@app/core-runtime';
import { StageAccountsFileSchema } from '@app/core-runtime/install/stage-accounts-file';
import { and, eq } from 'drizzle-orm';
import { Config, Console, Effect, Exit, Layer, Redacted, Schema } from 'effect';

import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import {
  bootstrapStageAccounts,
  loadStageAccountsConfiguration,
} from '../../apps/shell-super-app/api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import { legalEntities, tenants, tenantModuleStates } from '../../packages/core-runtime/src/db/schema.ts';
import {
  bootstrapRelationshipRequest,
  companyMembershipAdmissionRelationships,
} from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { demoTenantId } from './fixture-ids.mts';
import { principalRelationships } from './permissions.mts';
import { warmupAccounts } from './warmup-accounts.mts';

class WarmupSeedError extends Schema.TaggedError<WarmupSeedError>()('WarmupSeedError', {
  reason: Schema.String,
}) {}

/** Company membership admits the account, never independent Tenant membership. */
export const stageWarmupRelationships = (profile: (typeof warmupAccounts)[number]) =>
  companyMembershipAdmissionRelationships(
    principalRelationships(profile.principalId, profile.role, [], profile.legalEntityId, demoTenantId, profile.roleKey),
    [{ principalId: profile.principalId, tenantId: demoTenantId }],
  );

export const seedStageWarmup = Effect.gen(function* seedWarmup() {
  const environment = yield* Config.all({
    BETTER_AUTH_SECRET: Config.Redacted('BETTER_AUTH_SECRET'),
    BETTER_AUTH_URL: Config.String('BETTER_AUTH_URL'),
    DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
  });
  const spice = yield* parseSpiceDbConfig({
    ...environment,
    SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
  });
  const rpc = yield* Effect.acquireRelease(
    Effect.try({
      catch: () => new WarmupSeedError({ reason: 'Pinned SpiceDB channel could not be opened' }),
      try: () => openSpiceDbGrpcRpc(spice, 10_000),
    }),
    (client) => Effect.sync(() => client.close()),
  );
  const password = yield* Config.Redacted('ONTOS_WARMUP_PASSWORD').pipe(
    Config.withDefault(Redacted.make('password1234')),
  );
  const { executor } = yield* AuthDatabase;
  const [tenant] = yield* executor.select().from(tenants).where(eq(tenants.tenantId, demoTenantId));
  const [module] = yield* executor
    .select()
    .from(tenantModuleStates)
    .where(and(eq(tenantModuleStates.tenantId, demoTenantId), eq(tenantModuleStates.moduleKey, 'work.tasks')));
  if (tenant?.status !== 'active' || module?.state !== 'active') {
    return yield* new WarmupSeedError({ reason: 'Existing demo tenant and work.tasks installation must be active' });
  }
  for (const profile of warmupAccounts) {
    const [company] = yield* executor
      .select()
      .from(legalEntities)
      .where(and(eq(legalEntities.tenantId, demoTenantId), eq(legalEntities.legalEntityId, profile.legalEntityId)));
    if (company?.status !== 'active') {
      return yield* new WarmupSeedError({ reason: `Existing demo company is not active: ${profile.company}` });
    }
    const source = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(StageAccountsFileSchema)))({
      actionAuthorization: { actionAssertions: [], roleGrants: [] },
      retiredAccountEmails: [],
      retiredTenants: [],
      schemaVersion: 4,
      scopedRoles: [
        {
          legalEntityId: profile.legalEntityId,
          principalIds: [profile.principalId],
          roleKey: profile.roleKey,
          tenantId: demoTenantId,
        },
      ],
      tenants: [
        {
          accounts: [
            {
              affiliation: 'external',
              authBindingId: profile.authBindingId,
              displayName: profile.displayName,
              email: profile.email,
              grants: { explicitActions: [], tenantRelations: [] },
              password: Redacted.value(password),
              principalId: profile.principalId,
            },
          ],
          defaultLocale: tenant.defaultLocale,
          displayName: tenant.name,
          legalEntity: {
            legalEntityId: company.legalEntityId,
            legalName: company.legalName,
            registrationCountry: company.registrationCountry,
            registrationNumber: company.registrationNumber,
          },
          moduleKey: module.moduleKey,
          moduleStateId: module.tenantModuleStateId,
          slug: tenant.slug,
          tenantId: demoTenantId,
        },
      ],
    });
    const configuration = yield* loadStageAccountsConfiguration(() => Effect.succeed({ mode: 0o600, source }), {
      BETTER_AUTH_SECRET: Redacted.value(environment.BETTER_AUTH_SECRET),
      BETTER_AUTH_URL: environment.BETTER_AUTH_URL,
      DATABASE_ADMIN_URL: Redacted.value(environment.DATABASE_ADMIN_URL),
      ONTOS_STAGE_ACCOUNTS_FILE: 'inline-warmup-operator-seed',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT,
    });
    yield* bootstrapStageAccounts(configuration);
    const relationships = stageWarmupRelationships(profile);
    yield* rpc.writeRelationships(bootstrapRelationshipRequest(relationships));
    yield* Console.log(`Stage warm-up reader installed: ${profile.email}, company=${profile.legalEntityId}`);
  }
  return yield* Effect.void;
});

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    seedStageWarmup.pipe(
      Effect.scoped,
      Effect.provide(
        AuthDatabaseFromDatabaseConfigLive.pipe(
          Layer.provide(
            Layer.effect(
              DatabaseConfig,
              Effect.gen(function* adminConfig() {
                const admin = yield* Config.Redacted('DATABASE_ADMIN_URL');
                return yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(admin) });
              }),
            ),
          ),
        ),
      ),
      Effect.provide(NodeServices.layer),
      Effect.tapError(() => Console.error('Stage warm-up seed failed; no automatic retry and no credentials logged')),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
