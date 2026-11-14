import { NodeCrypto } from '@effect/platform-node';
import { DatabaseIdentityEnrollmentContext } from '@app/core-runtime';
import { TenantAccessBootstrap } from '@app/core-runtime/access/bootstrap';
import { AccessMembershipStore } from '@app/core-runtime/access/intent/memberships';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriter } from '@app/core-runtime/access/intent/projection-writer';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Crypto } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import type { AuthDatabase } from '../../apps/shell-super-app/api/auth/db/client.ts';
import type {
  bootstrapStageAccounts,
  bootstrapStageAccountsFromEnvironment,
} from '../../apps/shell-super-app/api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../apps/shell-super-app/api/database-identity-enrollment.ts';
import { makeStageInstallationRuntime } from '../../apps/shell-super-app/scripts/bootstrap-stage-accounts.mts';
import { coreRelations } from '../../packages/core-runtime/src/db/schema.ts';

type InstallationServices = Layer.Success<ReturnType<typeof makeStageInstallationRuntime>>;
type UnprovidedBootstrapServices<Services> = Exclude<Services, AuthDatabase | Crypto.Crypto | InstallationServices>;
const bootstrapDependenciesAreComplete: [
  UnprovidedBootstrapServices<Effect.Services<ReturnType<typeof bootstrapStageAccounts>>>,
] extends [never]
  ? true
  : false = true;
const environmentDependenciesAreComplete: [
  UnprovidedBootstrapServices<Effect.Services<ReturnType<typeof bootstrapStageAccountsFromEnvironment>>>,
] extends [never]
  ? true
  : false = true;

it('provides every native stage bootstrap requirement, including enrollment, at the operator root', () => {
  expect(bootstrapDependenciesAreComplete).toBe(true);
  expect(environmentDependenciesAreComplete).toBe(true);
});

it.effect('builds the production installation graph with the actual Shell enrollment and no external I/O', () =>
  Effect.scoped(
    Effect.gen(function* nativeStageComposition() {
      const queries: string[] = [];
      const database = Layer.effect(
        CoreDatabase,
        Effect.gen(function* scriptedCoreDatabase() {
          return { executor: yield* makeWithDefaults({ relations: coreRelations }) };
        }),
      ).pipe(
        Layer.provide(
          scriptedPgClientLayer(
            Effect.succeed(
              testSqlConnection((query) => {
                queries.push(query);
                return Effect.succeed([]);
              }),
            ),
          ).pipe(Layer.provideMerge(Reactivity.layer)),
        ),
      );
      const context = yield* Layer.build(
        makeStageInstallationRuntime(database, Layer.mock(AccessProjectionCompiler, {})),
      );
      expect(Context.get(context, DatabaseIdentityEnrollmentContext)).toBe(SHELL_DATABASE_IDENTITY_ENROLLMENT);
      expect(Context.get(context, TenantAccessBootstrap).bootstrapTenantAccess).toBeDefined();
      expect(Context.get(context, AccessMembershipStore).loadTenantMemberships).toBeDefined();
      expect(Context.get(context, AccessProjectionWriter).reconcileTenant).toBeDefined();
      expect(queries).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
