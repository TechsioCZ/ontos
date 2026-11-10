import { loadModuleCredentialEnrolment, PLATFORM_TENANT } from '@app/core-runtime/auth/module-credentials';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApiKeyService, makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import {
  admitIntegrationCredential,
  loadGatewayModuleBindings,
  ModuleCredentialEnrolmentSourceLive,
} from '../../api/auth/gateway-delegation-policy.ts';
import {
  provisionModuleCredentials,
  retireSupersededModuleCredentials,
} from '../../api/auth/module-credential-provisioning.service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import {
  coreRelations,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';

/** The calling modules this release installs, and one it does not (a credential of it must bind nothing). */
const INSTALLED = ['catalog', 'pricing'] as const;
const NOT_INSTALLED = 'commerce-cart';

/** One isolated database with Core and Better Auth, and the platform's provisioning services on it. */
const platform = Effect.gen(function* platformDatabase() {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([...INSTALLED]);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1287-shell-auth',
  });
  const configuration = {
    ...(yield* loadAuthConfig({ envPath: '/dev/null' })),
    connectionString: isolated.connections.runtime.connectionString,
  };
  const authDatabase = yield* makeAuthDatabase({
    connectionString: isolated.connections.runtime.connectionString,
    expectedRole: isolated.connections.runtime.expectedRole,
  });
  const coreDatabase = yield* makeTestDatabaseFromClient(
    yield* makeTestPgClient(isolated.connections.runtime.connectionString),
    coreRelations,
  );
  const keys = yield* makeApiKeyService().pipe(
    Effect.provideService(AuthConfig, configuration),
    Effect.provideService(AuthDatabase, authDatabase),
  );
  const services = Layer.mergeAll(
    Layer.succeed(ApiKeyService, keys),
    Layer.succeed(AuthDatabase, authDatabase),
    Layer.succeed(CoreDatabase, { executor: coreDatabase }),
  );
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  return { catalog, coreDatabase, keys, services, snapshot };
});

const verifies = (keys: typeof ApiKeyService.Service, secret: Redacted.Redacted) =>
  keys.verify(Redacted.value(secret)).pipe(Effect.exit, Effect.map(Exit.isSuccess));

it.live('provisions, rotates and retires platform module credentials, and the Shell binds exactly the live ones', () =>
  Effect.scoped(
    Effect.gen(function* platformProvisioning() {
      const { catalog, coreDatabase, keys, services, snapshot } = yield* platform;
      const appIds = [...INSTALLED, NOT_INSTALLED];
      const first = yield* provisionModuleCredentials({ appIds, operationId: 'first-boot' }).pipe(
        Effect.provide(services),
      );
      expect(first.failedAppIds).toEqual([]);
      expect([...first.credentials.keys()].toSorted()).toEqual(appIds.toSorted());

      // The platform tenant is the platform's own and holds one module principal per calling module.
      const [tenant] = yield* coreDatabase
        .select({ slug: tenants.slug, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.tenantId, PLATFORM_TENANT.tenantId));
      expect(tenant).toEqual({ slug: PLATFORM_TENANT.slug, status: 'active' });
      const modulePrincipals = yield* coreDatabase
        .select({ displayName: principals.displayName, kind: principals.kind, principalId: principals.principalId })
        .from(principals)
        .where(eq(principals.tenantId, PLATFORM_TENANT.tenantId));
      expect(modulePrincipals.map(({ displayName }) => displayName).toSorted()).toEqual(
        appIds.map((appId) => `module:${appId}`).toSorted(),
      );
      expect(modulePrincipals.every(({ kind }) => kind === 'service')).toBe(true);

      // A restart issues fresh keys to the same principals; both passes are bound until the handover.
      const second = yield* provisionModuleCredentials({ appIds, operationId: 'second-boot' }).pipe(
        Effect.provide(services),
      );
      const afterRestart = yield* coreDatabase
        .select({ principalId: principals.principalId })
        .from(principals)
        .where(eq(principals.tenantId, PLATFORM_TENANT.tenantId));
      expect(afterRestart.map(({ principalId }) => principalId).toSorted()).toEqual(
        modulePrincipals.map(({ principalId }) => principalId).toSorted(),
      );
      expect([...second.providerKeyIds].some((key) => first.providerKeyIds.has(key))).toBe(false);
      const overlapping = yield* loadModuleCredentialEnrolment(coreDatabase);
      expect(overlapping).toHaveLength(appIds.length * 2);
      for (const appId of appIds) {
        const secret = second.credentials.get(appId);
        expect(secret !== undefined && (yield* verifies(keys, secret))).toBe(true);
      }

      // The Shell binds every live credential of an installed module, pinned to its build and the live release.
      const shell = Layer.mergeAll(
        ModuleCredentialEnrolmentSourceLive.pipe(
          Layer.provide(Layer.succeed(CoreDatabase, { executor: coreDatabase })),
        ),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
      );
      const bindings = yield* loadGatewayModuleBindings.pipe(Effect.provide(shell));
      expect(bindings).toHaveLength(INSTALLED.length * 2);
      expect(bindings.every((binding) => binding.compositionRevision === snapshot.composition.revision)).toBe(true);
      expect(bindings.some((binding) => binding.sourceAppId === NOT_INSTALLED)).toBe(false);
      for (const binding of bindings) {
        const contract = catalog.contracts.find((entry) => entry.deployment.appId === binding.sourceAppId);
        expect(binding.sourceBuildMarker).toBe(contract?.deployment.buildMarker);
      }

      // Any module key, installed module or not, is refused as an ordinary API key.
      const cartKey = [...second.providerKeyIds].find(
        (key) => overlapping.find((entry) => entry.providerKeyId === key)?.appId === NOT_INSTALLED,
      );
      expect(cartKey).toBeDefined();
      for (const moduleKey of second.providerKeyIds) {
        const refused = yield* Effect.flip(admitIntegrationCredential(moduleKey).pipe(Effect.provide(shell)));
        expect(Schema.is(GatewayDelegationError)(refused) && refused.code === 'forbidden').toBe(true);
      }
      const ordinary = yield* Effect.exit(admitIntegrationCredential('an-ordinary-key').pipe(Effect.provide(shell)));
      expect(Exit.isSuccess(ordinary)).toBe(true);

      // The first (older) host never retires the second (newer) host's credentials.
      const olderHost = yield* retireSupersededModuleCredentials(first.providerKeyIds).pipe(Effect.provide(services));
      expect(olderHost).toEqual({ failed: 0, retired: 0 });
      expect(yield* loadModuleCredentialEnrolment(coreDatabase)).toHaveLength(appIds.length * 2);

      // Once the second host holds the authority, it retires the first pass: binding revoked, key disabled.
      const handover = yield* retireSupersededModuleCredentials(second.providerKeyIds).pipe(Effect.provide(services));
      expect(handover).toEqual({ failed: 0, retired: appIds.length });
      const live = yield* loadModuleCredentialEnrolment(coreDatabase);
      expect(live.map(({ providerKeyId }) => providerKeyId).toSorted()).toEqual([...second.providerKeyIds].toSorted());
      for (const appId of appIds) {
        const retired = first.credentials.get(appId);
        expect(retired !== undefined && (yield* verifies(keys, retired))).toBe(false);
      }
      const revoked = yield* coreDatabase
        .select({ status: principalAuthBindings.status })
        .from(principalAuthBindings)
        .where(eq(principalAuthBindings.tenantId, PLATFORM_TENANT.tenantId));
      expect(revoked.filter(({ status }) => status === 'revoked')).toHaveLength(appIds.length);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);
