#!/usr/bin/env node
/** Stage operator: reviewed plan → native Core/Shell installers → fully consistent authorization verification. */
import { createHash } from 'node:crypto';

import { DatabaseConfig, parseDatabaseConfig } from '@app/core-runtime';
import { StageAccountsFileSchema } from '@app/core-runtime/install/stage-accounts-file';
import { reconcileStageServicePrincipals } from '@app/core-runtime/install/stage-context-bootstrap';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import {
  bootstrapStageAccounts,
  loadStageAccountsConfiguration,
} from '../../apps/shell-super-app/api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import {
  akrosPlaygroundAccessTargets,
  akrosPlaygroundAccounts,
  akrosPlaygroundDefinition,
  akrosPlaygroundLegalEntityId,
  akrosPlaygroundModules,
  akrosPlaygroundRelationships,
  akrosPlaygroundServices,
  akrosPlaygroundTenantId,
  AkrosPlaygroundDefinitionSchema,
} from './akros-playground-policy.mts';
import { demoId } from './fixture-ids.mts';
import { agentBotPrincipal, companyHumanAccounts, demoHumanAccounts, siamparkRentalPersonas } from './permissions.mts';
import { readMissingServiceGrants, reconcileServiceGrants } from './reconcile-stage-service-grants.mts';
import { warmupAccounts } from './warmup-accounts.mts';

class AkrosProvisionError extends Schema.TaggedError<AkrosProvisionError>()('AkrosProvisionError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new AkrosProvisionError({ reason });
const modes = ['plan', 'apply', 'verify'] as const;
const Plan = Schema.Struct({
  compositionRevision: Schema.String,
  definition: Schema.String,
  desired: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(1),
});
export const akrosProvisionFingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/** The installer, not this script, owns all tenant, principal, binding, membership and module-state writes. */
const installAccounts = Effect.gen(function* installAkrosAccounts() {
  const environment = yield* Config.all({
    BETTER_AUTH_SECRET: Config.Redacted('BETTER_AUTH_SECRET'),
    BETTER_AUTH_URL: Config.String('BETTER_AUTH_URL'),
    DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
  });
  const password = yield* Config.Redacted('ONTOS_AKROS_PLAYGROUND_PASSWORD').pipe(
    Config.withDefault(Redacted.make('password1234')),
  );
  for (const moduleKey of akrosPlaygroundModules) {
    const file = {
      actionAuthorization: { actionAssertions: [], roleGrants: [] },
      retiredAccountEmails: [],
      retiredTenants: [],
      schemaVersion: 4,
      scopedRoles: akrosPlaygroundAccounts.map(({ principalId, roleKey }) => ({
        legalEntityId: akrosPlaygroundLegalEntityId,
        principalIds: [principalId],
        roleKey,
        tenantId: akrosPlaygroundTenantId,
      })),
      tenants: [
        {
          accounts: akrosPlaygroundAccounts.map(({ role: _role, roleKey: _roleKey, ...identity }) => ({
            ...identity,
            affiliation: 'employee',
            grants: { explicitActions: [], tenantRelations: [] },
            password: Redacted.value(password),
          })),
          defaultLocale: akrosPlaygroundDefinition.defaultLocale,
          displayName: akrosPlaygroundDefinition.displayName,
          legalEntity: {
            legalEntityId: akrosPlaygroundLegalEntityId,
            legalName: akrosPlaygroundDefinition.legalName,
            registrationCountry: akrosPlaygroundDefinition.registrationCountry,
            registrationNumber: akrosPlaygroundDefinition.registrationNumber,
          },
          moduleKey,
          moduleStateId: demoId('core.tenant-module-state', `akros-playground:${moduleKey}`),
          slug: akrosPlaygroundDefinition.slug,
          tenantId: akrosPlaygroundTenantId,
        },
      ],
    };
    const source = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(StageAccountsFileSchema)))(
      yield* Schema.decodeUnknownEffect(Schema.toEncoded(StageAccountsFileSchema))(file),
    );
    const configuration = yield* loadStageAccountsConfiguration(() => Effect.succeed({ mode: 0o600, source }), {
      BETTER_AUTH_SECRET: Redacted.value(environment.BETTER_AUTH_SECRET),
      BETTER_AUTH_URL: environment.BETTER_AUTH_URL,
      DATABASE_ADMIN_URL: Redacted.value(environment.DATABASE_ADMIN_URL),
      ONTOS_STAGE_ACCOUNTS_FILE: 'reviewed-akros-playground-operator-plan',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    });
    yield* bootstrapStageAccounts(configuration);
  }
  yield* reconcileStageServicePrincipals(
    akrosPlaygroundServices.map(({ displayName, principalId }) => ({
      displayName,
      legalEntityId: akrosPlaygroundLegalEntityId,
      principalId,
      tenantId: akrosPlaygroundTenantId,
    })),
    yield* ConfigProvider.ConfigProvider,
  );
});

const main = (mode: (typeof modes)[number], path: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* provisionAkrosPlayground() {
    const environment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    });
    const configuration = yield* parseSpiceDbConfig({
      ...environment,
      SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
    });
    const rpc = yield* Effect.acquireRelease(
      Effect.try({
        catch: () => fail('Pinned stage authorization channel could not be opened'),
        try: () => openSpiceDbGrpcRpc(configuration, 10_000),
      }),
      (client) => Effect.sync(() => client.close()),
    );
    const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
    const published = new Set(snapshot.composition.modules.map(({ moduleId }) => moduleId));
    if (!akrosPlaygroundModules.every((moduleKey) => published.has(moduleKey))) {
      return yield* fail('The reviewed AKROS modules must all be published by the active composition');
    }
    const actions = yield* discoverCurrentActions(snapshot);
    const relationships = yield* Effect.try({
      catch: () => fail('The reviewed AKROS authorization policy is invalid'),
      try: () => akrosPlaygroundRelationships(actions),
    });
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(Plan))({
      compositionRevision: snapshot.composition.revision,
      definition: yield* Schema.encodeEffect(Schema.fromJsonString(AkrosPlaygroundDefinitionSchema))(
        akrosPlaygroundDefinition,
      ),
      desired: relationships.map((row) => v1.Relationship.toJsonString(row)),
      schemaVersion: 1,
    });
    const fingerprint = akrosProvisionFingerprint(text);
    const filesystem = yield* FileSystem.FileSystem;
    if (mode === 'plan') {
      yield* filesystem.writeFileString(path, text, { flag: 'wx', mode: 0o600 });
      const missing = yield* readMissingServiceGrants(rpc, relationships);
      return yield* Console.log({
        accounts: akrosPlaygroundAccounts.map(({ email, role }) => ({ email, role: role.label })),
        fingerprint,
        missing: missing.length,
        mode,
        tenantId: akrosPlaygroundTenantId,
      });
    }
    const stat = yield* filesystem.stat(path);
    const saved = yield* filesystem.readFileString(path);
    if (
      stat.type !== 'File' ||
      stat.mode % 0o100 !== 0 ||
      Option.isNone(reviewed) ||
      reviewed.value !== fingerprint ||
      saved !== text
    ) {
      return yield* fail('The exact owner-only plan, reviewed fingerprint and current composition are required');
    }
    if (mode === 'apply') {
      yield* installAccounts;
      yield* reconcileServiceGrants(rpc, relationships, 'apply');
    }
    yield* reconcileServiceGrants(rpc, relationships, 'verify');
    const denied = [
      ...new Set(
        [
          ...demoHumanAccounts,
          ...companyHumanAccounts,
          ...siamparkRentalPersonas,
          ...warmupAccounts,
          agentBotPrincipal,
        ].map(({ principalId }) => principalId),
      ),
    ];
    let checks = 0;
    for (const principalId of [...akrosPlaygroundAccounts.map((row) => row.principalId), ...denied]) {
      const expected = !denied.includes(principalId);
      for (const target of akrosPlaygroundAccessTargets) {
        const { permission, ...resource } = target;
        const result = yield* rpc.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
            permission,
            resource,
            subject: { object: { objectId: principalId, objectType: 'principal' } },
          }),
        );
        const allowed = result.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
        if (allowed !== expected) {
          return yield* fail(
            `AKROS isolation assertion failed for ${resource.objectType} and principal ${principalId}`,
          );
        }
        checks += 1;
      }
    }
    return yield* Console.log({ checks, demoPrincipalsDenied: denied.length, failures: 0, fingerprint, mode });
  }).pipe(Effect.scoped);

const command = Command.make(
  'akros-playground-provision',
  {
    mode: Flag.Literals('mode', modes),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan, reviewed }) =>
    main(mode, plan, reviewed).pipe(
      Effect.tapError(
        Effect.fnUntraced(function* reportProvisionFailure(failure) {
          return yield* Console.error(
            Schema.is(AkrosProvisionError)(failure)
              ? failure.reason
              : `AKROS provisioning stopped (${failure._tag}); secrets withheld`,
          );
        }),
      ),
    ),
);

if (import.meta.main) {
  const composition = ActiveApplicationCompositionConfigLive.pipe(
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provide(FetchHttpClient.layer),
  );
  const auth = AuthDatabaseFromDatabaseConfigLive.pipe(
    Layer.provide(
      Layer.effect(
        DatabaseConfig,
        Config.Redacted('DATABASE_ADMIN_URL').pipe(
          Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
        ),
      ),
    ),
  );
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(composition),
      Effect.provide(auth),
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
