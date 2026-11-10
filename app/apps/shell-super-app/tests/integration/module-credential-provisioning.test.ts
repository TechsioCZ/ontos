import { loadModuleCredentialEnrolment, PLATFORM_TENANT } from '@app/core-runtime/auth/module-credentials';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { and, eq, like, sql } from 'drizzle-orm';
import { Clock, Duration, Effect, Exit, Layer, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { ApiKeyService, makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import {
  admitIntegrationCredential,
  deriveGatewayModuleBindings,
  loadGatewayModuleBindings,
  ModuleCredentialEnrolmentSource,
  ModuleCredentialEnrolmentSourceLive,
} from '../../api/auth/gateway-delegation-policy.ts';
import { moduleCredentialReleaseOf } from '../../api/auth/module-credential-attestation.ts';
import type { ModuleCredentialRelease } from '../../api/auth/module-credential-attestation.ts';
import {
  provisionModuleCredentials,
  retireSupersededModuleCredentials,
} from '../../api/auth/module-credential-provisioning.service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  coreRelations,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { ProvisioningOutputJsonSchema } from '../../../../scripts/zerops/module-credentials.mts';

/** The calling modules this release installs, and one it does not (a credential of it must bind nothing). */
const INSTALLED = ['catalog', 'pricing'] as const;
const NOT_INSTALLED = 'commerce-cart';
const APP_IDS = [...INSTALLED, NOT_INSTALLED];

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
  // The platform's provisioning runs as the shared runtime role with its real grants, never as an administrator.
  const authDatabase = yield* makeAuthDatabase({
    connectionString: isolated.connections.runtime.connectionString,
    expectedRole: isolated.connections.runtime.expectedRole,
  });
  const coreDatabase = yield* makeTestDatabaseFromClient(
    yield* makeTestPgClient(isolated.connections.runtime.connectionString),
    coreRelations,
  );
  // Only the test itself moves the authority, as another host's publication would.
  const adminDatabase = yield* makeTestDatabaseFromClient(
    yield* makeTestPgClient(isolated.connections.admin.connectionString),
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
  return { adminDatabase, catalog, configuration, coreDatabase, isolated, keys, services, snapshot };
});

const verifies = (keys: typeof ApiKeyService.Service, secret: Redacted.Redacted) =>
  keys.verify(Redacted.value(secret)).pipe(Effect.exit, Effect.map(Exit.isSuccess));

/** A release other than the installed one: its own revision and its own builds of the same modules. */
const otherRelease = (marker: string): ModuleCredentialRelease => ({
  buildMarkers: Object.fromEntries(APP_IDS.map((appId) => [appId, `${appId}-${marker}`] as const)),
  compositionRevision: marker.repeat(64).slice(0, 64),
});

it.live('provisions, attests, retires and audits platform module credentials across deploy overlaps', () =>
  Effect.scoped(
    Effect.gen(function* platformProvisioning() {
      const { adminDatabase, catalog, coreDatabase, keys, services, snapshot } = yield* platform;
      const [role] = yield* coreDatabase.execute<{ readonly rolbypassrls: boolean; readonly rolsuper: boolean }>(
        sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
        'objects',
      );
      expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
      // Host releases that also run commerce-cart, which the Shell's installed catalog does not install.
      const installedRelease: ModuleCredentialRelease = {
        ...moduleCredentialReleaseOf(catalog),
        buildMarkers: { ...moduleCredentialReleaseOf(catalog).buildMarkers, [NOT_INSTALLED]: 'commerce-cart-build' },
      };
      const releaseTwo = otherRelease('b');
      const releaseThree = otherRelease('c');
      const issue = (hostId: string, release: ModuleCredentialRelease) =>
        provisionModuleCredentials({ appIds: APP_IDS, hostId, operationId: crypto.randomUUID(), release }).pipe(
          Effect.provide(services),
        );
      const retire = (hostId: string, release: ModuleCredentialRelease, current: ReadonlySet<string>) =>
        retireSupersededModuleCredentials({
          compositionRevision: release.compositionRevision,
          current,
          hostId,
          operationId: crypto.randomUUID(),
        }).pipe(Effect.provide(services));
      /** Another host's publication: a different revision takes the authority now; a renewal keeps its moment. */
      const takeAuthority = (release: ModuleCredentialRelease) =>
        adminDatabase
          .update(applicationCompositionAuthority)
          .set({
            phase: 'active',
            revision: release.compositionRevision,
            revisionActivatedAt: sql`case when ${applicationCompositionAuthority.revision} = ${release.compositionRevision} then ${applicationCompositionAuthority.revisionActivatedAt} else clock_timestamp() end`,
          })
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      const liveKeys = Effect.map(
        loadModuleCredentialEnrolment(coreDatabase),
        (enrolment) => new Set(enrolment.map(({ providerKeyId }) => providerKeyId)),
      );
      const shell = Layer.mergeAll(
        ModuleCredentialEnrolmentSourceLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CoreDatabase, { executor: coreDatabase }),
              Layer.succeed(AuthDatabase, yield* AuthDatabase.pipe(Effect.provide(services))),
            ),
          ),
        ),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
      );

      // Host A boots release one and issues its keys before publishing; then its revision takes the authority.
      const hostABoot = yield* issue('host-a', installedRelease);
      expect(hostABoot.failedAppIds).toEqual([]);
      expect([...hostABoot.credentials.keys()].toSorted()).toEqual(APP_IDS.toSorted());
      yield* Effect.sleep(Duration.millis(20));
      yield* takeAuthority(otherRelease('d'));
      yield* takeAuthority(installedRelease);

      // The platform tenant is the platform's own and holds one module principal per calling module.
      const [tenant] = yield* coreDatabase
        .select({ slug: tenants.slug, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.tenantId, PLATFORM_TENANT.tenantId));
      expect(tenant).toEqual({ slug: PLATFORM_TENANT.slug, status: 'active' });
      const modulePrincipals = yield* coreDatabase
        .select({ displayName: principals.displayName, kind: principals.kind })
        .from(principals)
        .where(eq(principals.tenantId, PLATFORM_TENANT.tenantId));
      expect(modulePrincipals.map(({ displayName }) => displayName).toSorted()).toEqual(
        APP_IDS.map((appId) => `module:${appId}`).toSorted(),
      );
      expect(modulePrincipals.every(({ kind }) => kind === 'service')).toBe(true);

      // A host whose revision does not hold the authority retires nothing.
      expect(yield* retire('host-n', releaseTwo, new Set())).toEqual({ failed: 0, holdsAuthority: false, retired: 0 });

      // The new host N boots release two (not yet published) while the old host A restarts on release one.
      const hostNBoot = yield* issue('host-n', releaseTwo);
      const hostARestart = yield* issue('host-a', installedRelease);
      // A still holds the authority: it retires its own pre-authority keys, never N's keys bound after that moment.
      expect(yield* retire('host-a', installedRelease, hostARestart.providerKeyIds)).toEqual({
        failed: 0,
        holdsAuthority: true,
        retired: APP_IDS.length,
      });
      let live = yield* liveKeys;
      expect([...hostNBoot.providerKeyIds].every((key) => live.has(key))).toBe(true);
      expect([...hostABoot.providerKeyIds].some((key) => live.has(key))).toBe(false);
      for (const appId of APP_IDS) {
        const retired = hostABoot.credentials.get(appId);
        expect(retired !== undefined && (yield* verifies(keys, retired))).toBe(false);
      }

      // While release one is installed, only keys attested for it bind: A's restart keys, never N's.
      const bindings = yield* loadGatewayModuleBindings.pipe(Effect.provide(shell));
      expect(bindings).toHaveLength(INSTALLED.length);
      expect(bindings.every(({ providerKeyId }) => hostARestart.providerKeyIds.has(providerKeyId))).toBe(true);
      expect(bindings.every((binding) => binding.compositionRevision === snapshot.composition.revision)).toBe(true);
      expect(bindings.some((binding) => binding.sourceAppId === NOT_INSTALLED)).toBe(false);
      for (const binding of bindings) {
        const contract = catalog.contracts.find((entry) => entry.deployment.appId === binding.sourceAppId);
        expect(binding.sourceBuildMarker).toBe(contract?.deployment.buildMarker);
      }

      // N takes the authority: it retires A's keys (bound before release two took it), and only N's keys bind.
      yield* Effect.sleep(Duration.millis(20));
      yield* takeAuthority(releaseTwo);
      expect(yield* retire('host-n', releaseTwo, hostNBoot.providerKeyIds)).toEqual({
        failed: 0,
        holdsAuthority: true,
        retired: APP_IDS.length,
      });
      // The superseded host A finds it no longer holds the authority and retires nothing.
      expect(yield* retire('host-a', installedRelease, hostARestart.providerKeyIds)).toEqual({
        failed: 0,
        holdsAuthority: false,
        retired: 0,
      });
      const releaseTwoInstalled = {
        composition: { revision: releaseTwo.compositionRevision },
        contracts: INSTALLED.map((appId) => ({
          deployment: { appId, buildMarker: releaseTwo.buildMarkers[appId] ?? '' },
        })),
      };
      const attested = yield* (yield* ModuleCredentialEnrolmentSource.pipe(Effect.provide(shell))).loadAttested;
      const releaseTwoBindings = yield* deriveGatewayModuleBindings(attested, releaseTwoInstalled);
      expect(releaseTwoBindings).toHaveLength(INSTALLED.length);
      expect(releaseTwoBindings.every(({ providerKeyId }) => hostNBoot.providerKeyIds.has(providerKeyId))).toBe(true);

      // An observe-only host X (release three) boots; then the live host N restarts on release two.
      const hostXBoot = yield* issue('host-x', releaseThree);
      const hostNRestart = yield* issue('host-n', releaseTwo);
      // N's restart retires its own earlier boot's keys (bound before release two took the authority) and never X's
      // or its restart's keys (bound after that moment).
      expect(yield* retire('host-n', releaseTwo, hostNRestart.providerKeyIds)).toEqual({
        failed: 0,
        holdsAuthority: true,
        retired: APP_IDS.length,
      });
      live = yield* liveKeys;
      expect([...hostNBoot.providerKeyIds].some((key) => live.has(key))).toBe(false);
      expect([...hostXBoot.providerKeyIds, ...hostNRestart.providerKeyIds].every((key) => live.has(key))).toBe(true);

      // Two boots of release two (another container M): both hosts' keys stay live and both bind.
      const hostMBoot = yield* issue('host-m', releaseTwo);
      expect(yield* retire('host-m', releaseTwo, hostMBoot.providerKeyIds)).toEqual({
        failed: 0,
        holdsAuthority: true,
        retired: 0,
      });
      const twoBoots = yield* deriveGatewayModuleBindings(
        yield* (yield* ModuleCredentialEnrolmentSource.pipe(Effect.provide(shell))).loadAttested,
        releaseTwoInstalled,
      );
      expect(twoBoots).toHaveLength(INSTALLED.length * 2);
      expect(twoBoots.some(({ providerKeyId }) => hostXBoot.providerKeyIds.has(providerKeyId))).toBe(false);

      // Rollback: release one takes the authority again. Its new host retires every key bound before that moment.
      const rollbackBoot = yield* issue('host-r', installedRelease);
      yield* Effect.sleep(Duration.millis(20));
      yield* takeAuthority(installedRelease);
      const rolledBack = yield* retire('host-r', installedRelease, rollbackBoot.providerKeyIds);
      expect(rolledBack.holdsAuthority).toBe(true);
      live = yield* liveKeys;
      expect([...live].toSorted()).toEqual([...rollbackBoot.providerKeyIds].toSorted());
      const afterRollback = yield* loadGatewayModuleBindings.pipe(Effect.provide(shell));
      expect(afterRollback.every(({ providerKeyId }) => rollbackBoot.providerKeyIds.has(providerKeyId))).toBe(true);
      expect(afterRollback).toHaveLength(INSTALLED.length);

      // Any module key, installed module or not, is refused as an ordinary API key.
      for (const moduleKey of rollbackBoot.providerKeyIds) {
        const refused = yield* Effect.flip(admitIntegrationCredential(moduleKey).pipe(Effect.provide(shell)));
        expect(Schema.is(GatewayDelegationError)(refused) && refused.code === 'forbidden').toBe(true);
      }
      expect(
        Exit.isSuccess(yield* Effect.exit(admitIntegrationCredential('an-ordinary-key').pipe(Effect.provide(shell)))),
      ).toBe(true);

      // Every issue and retire pass left one system-actor audit row in the platform tenant: who, which release,
      // which modules and provider key ids, and never a key.
      const audits = yield* coreDatabase
        .select({
          eventType: auditEvents.eventType,
          evidence: auditEvents.evidenceJson,
          outcome: auditEvents.outcome,
          principalId: auditEvents.principalId,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, PLATFORM_TENANT.tenantId),
            like(auditEvents.eventType, 'platform.module_credentials.%'),
          ),
        );
      expect(audits.filter(({ eventType }) => eventType === 'platform.module_credentials.issued')).toHaveLength(7);
      expect(audits.filter(({ eventType }) => eventType === 'platform.module_credentials.retired')).toHaveLength(7);
      expect(audits.every(({ principalId }) => principalId === null)).toBe(true);
      const recorded = JSON.stringify(audits);
      for (const pass of [hostABoot, hostNBoot, hostARestart, hostXBoot, hostNRestart, hostMBoot, rollbackBoot]) {
        for (const secret of pass.credentials.values()) {
          expect(recorded.includes(Redacted.value(secret))).toBe(false);
        }
        for (const providerKeyId of pass.providerKeyIds) {
          expect(recorded.includes(providerKeyId)).toBe(true);
        }
      }
      expect(recorded.includes('"hostId":"host-n"')).toBe(true);
      expect(recorded.includes(releaseTwo.compositionRevision)).toBe(true);
      const denied = audits.filter(({ outcome }) => outcome === 'denied');
      expect(denied).toHaveLength(2);
      // The revoked bindings stay as evidence.
      const revoked = yield* coreDatabase
        .select({ status: principalAuthBindings.status })
        .from(principalAuthBindings)
        .where(eq(principalAuthBindings.tenantId, PLATFORM_TENANT.tenantId));
      expect(revoked.filter(({ status }) => status === 'active')).toHaveLength(APP_IDS.length);
      expect(revoked.filter(({ status }) => status === 'revoked')).toHaveLength(APP_IDS.length * 6);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);

it.live('runs the provisioning program as the runtime role and hands its keys over only on the private channel', () =>
  Effect.scoped(
    Effect.gen(function* provisioningProgram() {
      const { catalog, configuration, isolated, keys } = yield* platform;
      const release = moduleCredentialReleaseOf(catalog);
      const builds = INSTALLED.map((appId) => `${appId}=${release.buildMarkers[appId] ?? ''}`);
      const workspace = new URL('../../../../', import.meta.url).pathname;
      const started = yield* Clock.currentTimeMillis;
      const handle = yield* ChildProcess.make(
        process.execPath,
        [
          'scripts/zerops/provision-module-credentials.mts',
          'issue',
          `--operation=${crypto.randomUUID()}`,
          '--host=integration-host',
          `--revision=${release.compositionRevision}`,
          ...builds,
        ],
        {
          additionalFds: { fd3: { type: 'output' } },
          cwd: workspace,
          // Exactly the Shell settings the app host passes; the real shared runtime role with its grants, and no
          // administrative URL at all.
          env: {
            BETTER_AUTH_SECRET: configuration.secret,
            BETTER_AUTH_URL: configuration.baseUrl,
            DATABASE_URL: isolated.connections.runtime.connectionString,
            NODE_ENV: 'test',
            ONTOS_DATABASE_POOL_SHARED: 'false',
          },
          extendEnv: false,
          stderr: 'pipe',
          stdout: 'pipe',
        },
      );
      const [channel, logs, code] = yield* Effect.all(
        [
          handle.getOutputFd(3).pipe(Stream.decodeText(), Stream.mkString),
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
          handle.stderr.pipe(Stream.runDrain),
        ],
        { concurrency: 'unbounded' },
      );
      // It closed its pools and exited on its own, promptly.
      expect(code).toBe(0);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(60_000);
      // Its log lines went to standard output and never mixed into the channel.
      expect(logs).toContain('[module-credentials] issued for');
      const output = yield* Schema.decodeEffect(ProvisioningOutputJsonSchema)(channel.trim());
      expect(Object.keys(output.credentials).toSorted()).toEqual([...INSTALLED].toSorted());
      for (const appId of INSTALLED) {
        const secret = output.credentials[appId];
        expect(secret !== undefined && (yield* verifies(keys, secret))).toBe(true);
        expect(secret !== undefined && logs.includes(Redacted.value(secret))).toBe(false);
      }
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);
