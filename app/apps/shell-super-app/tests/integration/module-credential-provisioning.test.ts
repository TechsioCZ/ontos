import {
  internalWorkloadPrincipalId,
  loadModuleCredentialEnrolment,
  PLATFORM_TENANT,
} from '@app/core-runtime/auth/module-credentials';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { Clock, DateTime, Duration, Effect, Exit, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { ApiKeyProviderUnavailableError, ApiKeyService, makeApiKeyService } from '../../api/auth/api-key-service.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { apikey } from '../../api/auth/db/schema.ts';
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
  MODULE_CREDENTIAL_LIFETIME,
  provisionModuleCredentials,
  retireOwnModuleCredentials,
  retireSupersededModuleCredentials,
} from '../../api/auth/module-credential-provisioning.service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  applicationCompositionAuthority,
  auditEvents,
  coreRelations,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { AccessReleaseStoreLive } from '../../../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { makeDatabaseIdentityEnrollmentLive } from '../../../../packages/core-runtime/src/db/database-identities.ts';
import { registerReleaseInternalWorkloads } from '../../../../packages/core-runtime/src/install/release-internal-workloads.ts';
import type { ReleaseInternalWorkloadTenantReport } from '../../../../packages/core-runtime/src/install/release-internal-workloads.ts';
import { writeTestTenantScopes } from '../../../../packages/core-runtime/src/testing/tenant-access.ts';
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../../../database/identity-enrollment.ts';
import { internalWorkloadDeclarations } from '../../../../scripts/demo/release-internal-workloads.mts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { liveModuleKeyIds } from '../../../../scripts/zerops/module-credential-liveness.mts';
import {
  INTERNAL_WORKLOAD_LABELS,
  MODULE_INTERNAL_WORKLOADS,
  ProvisioningOutputJsonSchema,
} from '../../../../scripts/zerops/module-credentials.mts';
import { validateManagedApiKeyTarget } from '../../../../packages/core-runtime/src/auth/managed-api-key-scope.ts';
import { findPostgresFailure } from '../../../../packages/core-runtime/src/database/postgres-failure.ts';

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
  return { adminDatabase, authDatabase, catalog, configuration, coreDatabase, isolated, keys, services, snapshot };
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
      // Every issue is its own boot of the named host.
      const issue = (hostId: string, release: ModuleCredentialRelease) =>
        provisionModuleCredentials({
          appIds: APP_IDS,
          bootId: crypto.randomUUID(),
          hostId,
          operationId: crypto.randomUUID(),
          release,
        }).pipe(Effect.provide(services));
      const retire = (hostId: string, release: ModuleCredentialRelease, current: ReadonlySet<string>) =>
        retireSupersededModuleCredentials({
          bootId: crypto.randomUUID(),
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

it.live(
  'disables a superseded key before revoking its binding, and reports a key it could neither bind nor disable',
  () =>
    Effect.scoped(
      Effect.gen(function* disableFirst() {
        const { adminDatabase, authDatabase, catalog, coreDatabase, keys } = yield* platform;
        const release: ModuleCredentialRelease = {
          ...moduleCredentialReleaseOf(catalog),
          buildMarkers: { ...moduleCredentialReleaseOf(catalog).buildMarkers, [NOT_INSTALLED]: 'commerce-cart-build' },
        };
        const servicesWith = (apiKeys: typeof ApiKeyService.Service) =>
          Layer.mergeAll(
            Layer.succeed(ApiKeyService, apiKeys),
            Layer.succeed(AuthDatabase, authDatabase),
            Layer.succeed(CoreDatabase, { executor: coreDatabase }),
          );
        const issueWith = (apiKeys: typeof ApiKeyService.Service, hostId: string) =>
          provisionModuleCredentials({
            appIds: APP_IDS,
            bootId: crypto.randomUUID(),
            hostId,
            operationId: crypto.randomUUID(),
            release,
          }).pipe(Effect.provide(servicesWith(apiKeys)));
        const bindingStatus = (providerKeyId: string) =>
          coreDatabase
            .select({ status: principalAuthBindings.status })
            .from(principalAuthBindings)
            .where(eq(principalAuthBindings.providerSubjectId, providerKeyId))
            .pipe(Effect.map(([row]) => row?.status));

        // Host A issues before its release takes the authority; host B, after it, retires A's keys.
        const hostA = yield* issueWith(keys, 'host-a');
        yield* Effect.sleep(Duration.millis(20));
        yield* adminDatabase
          .update(applicationCompositionAuthority)
          .set({ phase: 'active', revision: release.compositionRevision, revisionActivatedAt: sql`clock_timestamp()` })
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
        const hostB = yield* issueWith(keys, 'host-b');
        const statusAtDisable: (string | undefined)[] = [];
        const recordingKeys: typeof ApiKeyService.Service = {
          ...keys,
          setEnabled: (providerKeyId, enabled) =>
            bindingStatus(providerKeyId).pipe(
              Effect.orDie,
              Effect.tap((status) => Effect.sync(() => statusAtDisable.push(status))),
              Effect.andThen(keys.setEnabled(providerKeyId, enabled)),
            ),
        };
        const retired = yield* retireSupersededModuleCredentials({
          bootId: crypto.randomUUID(),
          compositionRevision: release.compositionRevision,
          current: hostB.providerKeyIds,
          hostId: 'host-b',
          operationId: crypto.randomUUID(),
        }).pipe(Effect.provide(servicesWith(recordingKeys)));
        expect(retired.retired).toBe(APP_IDS.length);
        // Every key was disabled while its binding was still active: nothing can use it in between.
        expect(statusAtDisable).toEqual(APP_IDS.map(() => 'active'));
        for (const providerKeyId of hostA.providerKeyIds) {
          expect(yield* bindingStatus(providerKeyId)).toBe('revoked');
        }

        // A key that cannot be bound (its id is already bound) and then cannot be disabled is reported, not ignored.
        const [alreadyBound] = [...hostB.providerKeyIds];
        const failingKeys: typeof ApiKeyService.Service = {
          ...keys,
          issueServerOwned: (input) =>
            keys
              .issueServerOwned(input)
              .pipe(
                Effect.map((issued) =>
                  input.name === 'module:catalog' && alreadyBound !== undefined
                    ? { ...issued, providerKeyId: alreadyBound }
                    : issued,
                ),
              ),
          setEnabled: (providerKeyId, enabled) =>
            providerKeyId === alreadyBound
              ? Effect.fail(
                  new ApiKeyProviderUnavailableError({
                    code: 'api_key_provider_unavailable',
                    reason: 'The provider refuses this test key',
                  }),
                )
              : keys.setEnabled(providerKeyId, enabled),
        };
        const operationId = crypto.randomUUID();
        const pass = yield* provisionModuleCredentials({
          appIds: APP_IDS,
          bootId: crypto.randomUUID(),
          hostId: 'host-c',
          operationId,
          release,
        }).pipe(Effect.provide(servicesWith(failingKeys)));
        expect(pass.failedAppIds).toEqual(['catalog']);
        const [audit] = yield* coreDatabase
          .select({ evidence: auditEvents.evidenceJson, outcome: auditEvents.outcome })
          .from(auditEvents)
          .where(
            and(eq(auditEvents.tenantId, PLATFORM_TENANT.tenantId), eq(auditEvents.targetResourceId, operationId)),
          );
        expect(audit?.outcome).toBe('failed');
        expect(JSON.stringify(audit?.evidence)).toContain(`"undisabled":["${alreadyBound ?? ''}"]`);
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
          `--boot=${crypto.randomUUID()}`,
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
        // Each key's end of life travels with it, so the host can rotate it in time.
        expect(output.keys[appId]?.expiresAt).toBeDefined();
      }
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);

it.live(
  "retires a host's own earlier boots' and rotated keys, never another host's, and lets every key end within a day",
  () =>
    Effect.scoped(
      Effect.gen(function* ownKeys() {
        const { adminDatabase, authDatabase, catalog, coreDatabase, keys, services } = yield* platform;
        const release: ModuleCredentialRelease = {
          ...moduleCredentialReleaseOf(catalog),
          buildMarkers: { ...moduleCredentialReleaseOf(catalog).buildMarkers, [NOT_INSTALLED]: 'commerce-cart-build' },
        };
        // The release already holds the authority when its containers boot: every key below is bound after it took it.
        yield* adminDatabase
          .update(applicationCompositionAuthority)
          .set({ phase: 'active', revision: release.compositionRevision, revisionActivatedAt: sql`clock_timestamp()` })
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
        yield* Effect.sleep(Duration.millis(20));
        const issue = (hostId: string, bootId: string) =>
          provisionModuleCredentials({
            appIds: APP_IDS,
            bootId,
            hostId,
            operationId: crypto.randomUUID(),
            release,
          }).pipe(Effect.provide(services));
        const retireOwn = (
          hostId: string,
          bootId: string,
          replaced: ReadonlySet<string>,
          earlierBoots: ReadonlySet<string> = new Set(),
        ) =>
          retireOwnModuleCredentials({
            bootId,
            compositionRevision: release.compositionRevision,
            earlierBoots,
            hostId,
            operationId: crypto.randomUUID(),
            replaced,
          }).pipe(Effect.provide(services));
        const verifiesAll = (pass: { readonly credentials: ReadonlyMap<string, Redacted.Redacted> }) =>
          Effect.forEach([...pass.credentials.values()], (secret) => verifies(keys, secret)).pipe(
            Effect.map((verified) => verified.every(Boolean)),
          );
        const verifiesNone = (pass: { readonly credentials: ReadonlyMap<string, Redacted.Redacted> }) =>
          Effect.forEach([...pass.credentials.values()], (secret) => verifies(keys, secret)).pipe(
            Effect.map((verified) => verified.every((one) => !one)),
          );

        // Boot K1 of host A's container, then another container of the same release that carries the same host name
        // (a deploy's new container may), then A's container restarts its host process as boot K2.
        const issuedAt = yield* Clock.currentTimeMillis;
        const bootOneId = crypto.randomUUID();
        const bootOne = yield* issue('host-a', bootOneId);
        const otherContainerBootId = crypto.randomUUID();
        const otherContainer = yield* issue('host-a', otherContainerBootId);
        const bootTwoId = crypto.randomUUID();
        const bootTwo = yield* issue('host-a', bootTwoId);

        // The real key provider issues at this lifetime and refuses one second less: it sits on the plugin's minimum.
        const principalId = (yield* loadModuleCredentialEnrolment(coreDatabase))[0]?.principalId ?? '';
        const underMinimum = yield* Effect.exit(
          keys.issueServerOwned({
            expiresInSeconds: Duration.toSeconds(MODULE_CREDENTIAL_LIFETIME) - 1,
            issuerPrincipalId: principalId,
            lifecycleOperationId: crypto.randomUUID(),
            name: 'module:under-minimum',
            ownerUserId: 'ontos-platform-module-credentials',
            tenantId: PLATFORM_TENANT.tenantId,
          }),
        );
        expect(Exit.isFailure(underMinimum)).toBe(true);

        // Every key ends a day after it was issued, whatever happens to its host.
        for (const issued of bootOne.keys.values()) {
          const lifetime = DateTime.toEpochMillis(issued.expiresAt) - issuedAt;
          expect(Math.abs(lifetime - Duration.toMillis(MODULE_CREDENTIAL_LIFETIME))).toBeLessThan(60_000);
          const stored = yield* keys.metadata(issued.providerKeyId);
          expect(stored.expiresAt).toBe(DateTime.formatIso(issued.expiresAt));
        }

        // The authority holder's retirement leaves every key of this release alone: all were bound after it took the
        // authority. Without a retirement of its own, boot K1's keys would stay usable until they end.
        expect(
          yield* retireSupersededModuleCredentials({
            bootId: bootTwoId,
            compositionRevision: release.compositionRevision,
            current: bootTwo.providerKeyIds,
            hostId: 'host-a',
            operationId: crypto.randomUUID(),
          }).pipe(Effect.provide(services)),
        ).toEqual({ failed: 0, holdsAuthority: true, retired: 0 });
        expect(yield* verifiesAll(bootOne)).toBe(true);

        // The other container, which recorded no earlier boot, retires nothing: not K1's or K2's keys, though they carry
        // its host name, so a deploy's new container never cuts off the one still serving.
        expect(yield* retireOwn('host-a', otherContainerBootId, new Set())).toEqual({
          failed: 0,
          retired: 0,
        });
        expect(yield* verifiesAll(bootOne)).toBe(true);
        expect(yield* verifiesAll(bootTwo)).toBe(true);

        // Boot K2 retires the keys of the ended boot its container recorded: exactly boot K1's, never the other
        // container's (same host name, a boot it never recorded) or its own.
        expect(yield* retireOwn('host-a', bootTwoId, new Set(), new Set([bootOneId]))).toEqual({
          failed: 0,
          retired: APP_IDS.length,
        });
        expect(yield* verifiesNone(bootOne)).toBe(true);
        expect(yield* verifiesAll(otherContainer)).toBe(true);
        expect(yield* verifiesAll(bootTwo)).toBe(true);

        // A rotation in boot K2: the rotated keys are handed over, then K2's earlier keys are retired the same way.
        const rotated = yield* issue('host-a', bootTwoId);
        // A renewal that names keys it never held (the other container's, same host name) retires none of them.
        expect(yield* retireOwn('host-a', bootTwoId, otherContainer.providerKeyIds)).toEqual({ failed: 0, retired: 0 });
        expect(yield* verifiesAll(otherContainer)).toBe(true);
        expect(yield* retireOwn('host-a', bootTwoId, bootTwo.providerKeyIds, new Set([bootOneId]))).toEqual({
          failed: 0,
          retired: APP_IDS.length,
        });
        expect(yield* verifiesNone(bootTwo)).toBe(true);
        expect(yield* verifiesAll(rotated)).toBe(true);
        expect(yield* verifiesAll(otherContainer)).toBe(true);

        // A renewal that replaced nothing retires nothing of this boot; another host never names A's keys as its own.
        expect(yield* retireOwn('host-a', bootTwoId, new Set())).toEqual({ failed: 0, retired: 0 });
        expect(yield* retireOwn('host-c', crypto.randomUUID(), new Set())).toEqual({ failed: 0, retired: 0 });
        expect(yield* verifiesAll(rotated)).toBe(true);

        // Every key the Shell binds now is A's rotated key or B's; each own retirement is audited with host and boot.
        const live = new Set(
          (yield* loadModuleCredentialEnrolment(coreDatabase)).map(({ providerKeyId }) => providerKeyId),
        );
        expect([...live].toSorted()).toEqual([...rotated.providerKeyIds, ...otherContainer.providerKeyIds].toSorted());
        const ownAudits = yield* coreDatabase
          .select({ evidence: auditEvents.evidenceJson })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.tenantId, PLATFORM_TENANT.tenantId),
              eq(auditEvents.eventType, 'platform.module_credentials.retired_own'),
            ),
          );
        expect(ownAudits).toHaveLength(6);
        const recorded = JSON.stringify(ownAudits);
        expect(recorded).toContain(`"bootId":"${bootTwoId}"`);
        expect(recorded).toContain('"hostId":"host-a"');
        for (const providerKeyId of [...bootOne.providerKeyIds, ...bootTwo.providerKeyIds]) {
          expect(recorded).toContain(providerKeyId);
        }
        for (const providerKeyId of otherContainer.providerKeyIds) {
          expect(recorded.includes(providerKeyId)).toBe(false);
        }
        // A key disabled in the key store while its binding stays active is not live for the host that holds it:
        // healing notices it within a minute, not at its next rotation.
        const [disabledKey, ...stillLive] = [...rotated.providerKeyIds];
        if (disabledKey !== undefined) {
          yield* keys.setEnabled(disabledKey, false);
          const bound = (yield* loadModuleCredentialEnrolment(coreDatabase)).map(({ providerKeyId }) => providerKeyId);
          expect(bound).toContain(disabledKey);
          const liveForHolder = yield* liveModuleKeyIds(coreDatabase, [...rotated.providerKeyIds]);
          expect(liveForHolder.has(disabledKey)).toBe(false);
          expect(stillLive.every((providerKeyId) => liveForHolder.has(providerKeyId))).toBe(true);
          yield* keys.setEnabled(disabledKey, true);
        }

        // The Auth store keeps each retired key, disabled.
        const disabled = yield* authDatabase.executor
          .select({ enabled: apikey.enabled, id: apikey.id })
          .from(apikey)
          .where(eq(apikey.referenceId, 'ontos-platform-module-credentials'));
        expect(
          disabled
            .filter(({ enabled }) => enabled === false)
            .map(({ id }) => id)
            .toSorted(),
        ).toEqual([...bootOne.providerKeyIds, ...bootTwo.providerKeyIds].toSorted());
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);

/** CRM's Party intake: the internal workload its own server acts as, registered by the operator per tenant (O73). */
const INTAKE_WORKLOAD = 'demo.crm.party-intake';
const CRM_MODULE = 'demo.crm';

/** One tenant's counts in a run's report. */
type PlatformDatabases = Effect.Success<typeof platform>;

/** The platform's release step over these databases, for the given declarations: one run per call. */
const releaseRegistration = (
  coreDatabase: PlatformDatabases['coreDatabase'],
  declarations: Parameters<typeof registerReleaseInternalWorkloads>[1]['declarations'],
) => {
  const enrollment = APP_DATABASE_IDENTITY_ENROLLMENT;
  const runtime = Layer.mergeAll(
    Layer.succeed(CoreDatabase, { executor: coreDatabase }),
    AccessReleaseStoreLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CoreDatabase, { executor: coreDatabase }),
          makeDatabaseIdentityEnrollmentLive(enrollment),
        ),
      ),
    ),
  );
  return (run: string) =>
    registerReleaseInternalWorkloads({ enrollment, executor: coreDatabase }, { declarations, runReference: run }).pipe(
      Effect.provide(runtime),
    );
};

/** The companies a principal's active workload binding acts for, by its active company bindings. */
const activeCompaniesOf = (adminDatabase: PlatformDatabases['adminDatabase'], principalId: string) =>
  adminDatabase
    .select({ legalEntityId: accessWorkloadCompanyBindings.legalEntityId })
    .from(accessWorkloadCompanyBindings)
    .innerJoin(
      accessWorkloadBindings,
      eq(accessWorkloadBindings.bindingId, accessWorkloadCompanyBindings.workloadBindingId),
    )
    .where(
      and(
        eq(accessWorkloadBindings.principalId, principalId),
        eq(accessWorkloadBindings.status, 'active'),
        eq(accessWorkloadCompanyBindings.status, 'active'),
      ),
    );

const counts = (reports: readonly ReleaseInternalWorkloadTenantReport[], tenantId: string) => {
  const report = reports.find((candidate) => candidate.tenantId === tenantId);
  return report === undefined
    ? undefined
    : {
        failed: report.failed,
        registered: report.registered,
        retired: report.retired,
        unchanged: report.unchanged,
      };
};

it.live(
  'registers internal workloads per tenant and company at release, keys exactly those in the same pass, and retires what is no longer wanted',
  () =>
    Effect.scoped(
      Effect.gen(function* releaseSequence() {
        const { adminDatabase, catalog, coreDatabase, keys, services } = yield* platform;
        const enrollment = APP_DATABASE_IDENTITY_ENROLLMENT;
        const [tenantOne, tenantTwo] = [crypto.randomUUID(), crypto.randomUUID()];
        const [companyA, companyB, companyC] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
        const owners = [crypto.randomUUID(), crypto.randomUUID()];
        const foreignPrincipal = crypto.randomUUID();
        // A company that is not active, and a principal created (before Core assigned every id) with exactly the id the
        // platform would derive for it, but without the platform's marker: never the platform's.
        const companyX = crypto.randomUUID();
        const squatter = internalWorkloadPrincipalId({
          legalEntityId: companyX,
          tenantId: tenantOne,
          workloadKey: INTAKE_WORKLOAD,
        });
        const now = yield* DateTime.nowAsDate;
        // Product state the release step derives everything from: two tenants serving people, CRM installed in both,
        // two companies in the first and one in the second.
        yield* adminDatabase.insert(tenants).values(
          [tenantOne, tenantTwo].map((tenantId, index) => ({
            defaultLocale: 'cs',
            name: `Customer ${String(index)}`,
            slug: `customer-${tenantId}`,
            status: 'active',
            tenantId,
          })),
        );
        yield* adminDatabase.insert(legalEntities).values(
          [
            [companyA, tenantOne],
            [companyB, tenantOne],
            [companyC, tenantTwo],
          ].map(([legalEntityId = '', tenantId = ''], index) => ({
            legalEntityId,
            legalName: `Company ${String(index)}`,
            registrationCountry: 'CZ',
            registrationNumber: `0000000${String(index)}`,
            status: 'active',
            tenantId,
          })),
        );
        yield* adminDatabase.insert(legalEntities).values({
          legalEntityId: companyX,
          legalName: 'Company X',
          registrationCountry: 'CZ',
          registrationNumber: '00000009',
          status: 'suspended',
          tenantId: tenantOne,
        });
        yield* adminDatabase.insert(principals).values([
          ...[tenantOne, tenantTwo].map((tenantId, index) => ({
            displayName: 'Owner',
            kind: 'human' as const,
            principalId: owners[index] ?? '',
            status: 'active' as const,
            tenantId,
          })),
          // A registration someone made by hand: never adopted, never keyed.
          {
            displayName: 'CRM Party intake (by hand)',
            kind: 'service' as const,
            principalId: foreignPrincipal,
            status: 'active' as const,
            tenantId: tenantOne,
          },
          {
            displayName: 'CRM · zakládání klientů · Company X',
            kind: 'service' as const,
            principalId: squatter,
            status: 'active' as const,
            tenantId: tenantOne,
          },
        ]);
        yield* adminDatabase
          .insert(tenantModuleStates)
          .values([tenantOne, tenantTwo].map((tenantId) => ({ moduleKey: CRM_MODULE, state: 'active', tenantId })));
        for (const [index, tenantId] of [tenantOne, tenantTwo].entries()) {
          yield* writeTestTenantScopes(coreDatabase, {
            databaseIdentities: enrollment,
            legalEntityIds: tenantId === tenantOne ? [companyA, companyB] : [companyC],
            principalId: owners[index] ?? '',
            tenantId,
          });
        }
        const foreignBinding = crypto.randomUUID();
        yield* adminDatabase.insert(accessWorkloadBindings).values({
          bindingId: foreignBinding,
          createdAt: now,
          incarnation: crypto.randomUUID(),
          principalId: foreignPrincipal,
          status: 'active',
          tenantId: tenantOne,
          workloadKey: INTAKE_WORKLOAD,
        });
        yield* adminDatabase.insert(accessWorkloadCompanyBindings).values({
          companyBindingId: crypto.randomUUID(),
          createdAt: now,
          incarnation: crypto.randomUUID(),
          legalEntityId: companyA,
          status: 'active',
          tenantId: tenantOne,
          workloadBindingId: foreignBinding,
        });
        const squatterBinding = crypto.randomUUID();
        yield* adminDatabase.insert(accessWorkloadBindings).values({
          bindingId: squatterBinding,
          createdAt: now,
          incarnation: crypto.randomUUID(),
          principalId: squatter,
          status: 'active',
          tenantId: tenantOne,
          workloadKey: INTAKE_WORKLOAD,
        });
        yield* adminDatabase.insert(accessWorkloadCompanyBindings).values({
          companyBindingId: crypto.randomUUID(),
          createdAt: now,
          incarnation: crypto.randomUUID(),
          legalEntityId: companyX,
          status: 'active',
          tenantId: tenantOne,
          workloadBindingId: squatterBinding,
        });
        const release: ModuleCredentialRelease = {
          ...moduleCredentialReleaseOf(catalog),
          buildMarkers: { ...moduleCredentialReleaseOf(catalog).buildMarkers, crm: 'crm-build' },
        };
        const declarations = internalWorkloadDeclarations(
          MODULE_INTERNAL_WORKLOADS,
          new Set([INTAKE_WORKLOAD]),
          INTERNAL_WORKLOAD_LABELS,
        );
        const register = releaseRegistration(coreDatabase, declarations);
        const provision = provisionModuleCredentials({
          appIds: ['catalog', 'crm'],
          bootId: crypto.randomUUID(),
          hostId: 'host-r',
          operationId: crypto.randomUUID(),
          release,
          workloads: MODULE_INTERNAL_WORKLOADS,
        }).pipe(Effect.provide(services));
        const entry = (tenantId: string, legalEntityId: string) =>
          `crm/${INTAKE_WORKLOAD}/${tenantId}/${legalEntityId}`;
        // First deploy: registration runs before the boot's key provisioning, so every registration is keyed at once.
        // The platform tenant (made by provisioning) is skipped; the two tenants are decided on their own.
        yield* provision;
        const first = yield* register('run-1');
        expect(first.some(({ tenantId }) => tenantId === PLATFORM_TENANT.tenantId)).toBe(false);
        expect(counts(first, tenantOne)).toEqual({ failed: null, registered: 2, retired: 0, unchanged: 0 });
        expect(counts(first, tenantTwo)).toEqual({ failed: null, registered: 1, retired: 0, unchanged: 0 });
        const keyed = yield* provision;
        expect([...keyed.workloadCredentials.keys()].toSorted()).toEqual(
          [entry(tenantOne, companyA), entry(tenantOne, companyB), entry(tenantTwo, companyC)].toSorted(),
        );
        for (const secret of keyed.workloadCredentials.values()) {
          expect(yield* verifies(keys, secret)).toBe(true);
        }
        // Each registration is its own principal, bound to exactly its company; the hand-made one is left alone.
        const principalOf = (tenantId: string, legalEntityId: string) =>
          internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey: INTAKE_WORKLOAD });
        const registered = yield* adminDatabase
          .select({
            kind: principals.kind,
            principalId: principals.principalId,
            status: principals.status,
            tenantId: principals.tenantId,
          })
          .from(principals)
          .where(
            inArray(principals.principalId, [
              principalOf(tenantOne, companyA),
              principalOf(tenantOne, companyB),
              principalOf(tenantTwo, companyC),
              foreignPrincipal,
            ]),
          );
        expect(registered.every(({ kind, status }) => kind === 'service' && status === 'active')).toBe(true);
        expect(registered).toHaveLength(4);
        const activeCompanyOf = (principalId: string) => activeCompaniesOf(adminDatabase, principalId);
        expect(yield* activeCompanyOf(principalOf(tenantOne, companyB))).toEqual([{ legalEntityId: companyB }]);
        expect(yield* activeCompanyOf(principalOf(tenantTwo, companyC))).toEqual([{ legalEntityId: companyC }]);
        expect(yield* activeCompanyOf(foreignPrincipal)).toEqual([{ legalEntityId: companyA }]);

        // A person reads what each registration is; the platform knows its own by marker and derived id, not by name.
        const named = yield* adminDatabase
          .select({
            displayName: principals.displayName,
            platformRole: principals.platformRole,
            principalId: principals.principalId,
          })
          .from(principals)
          .where(
            inArray(principals.principalId, [
              principalOf(tenantOne, companyA),
              principalOf(tenantOne, companyB),
              principalOf(tenantTwo, companyC),
              squatter,
            ]),
          );
        const nameOf = (principalId: string) => named.find((row) => row.principalId === principalId);
        expect(nameOf(principalOf(tenantOne, companyA))).toMatchObject({
          displayName: 'CRM · zakládání klientů · Company 0',
          platformRole: 'internal_workload',
        });
        expect(nameOf(principalOf(tenantOne, companyB))?.displayName).toBe('CRM · zakládání klientů · Company 1');
        expect(nameOf(principalOf(tenantTwo, companyC))?.displayName).toBe('CRM · zakládání klientů · Company 2');
        // The squatter has the derived id but no marker: not adopted, not retired, not keyed (the keyed list above).
        expect(nameOf(squatter)).toMatchObject({ platformRole: null });
        expect(yield* activeCompanyOf(squatter)).toEqual([{ legalEntityId: companyX }]);

        // Only the platform keys the platform's principals: no tenant-managed key may be issued to, enabled, disabled
        // or revoked on its workload principal, and none issued to a principal someone bound to its workload by hand
        // (whose existing keys stay manageable, so an administrator can still revoke them).
        const keyTarget = (principalId: string, issuing: boolean) =>
          Effect.exit(
            validateManagedApiKeyTarget(adminDatabase, {
              issuing,
              legalEntityId: companyA,
              principalId,
              scope: 'tenant-managed',
              tenantId: tenantOne,
            }),
          );
        expect(Exit.isFailure(yield* keyTarget(principalOf(tenantOne, companyA), true))).toBe(true);
        expect(Exit.isFailure(yield* keyTarget(principalOf(tenantOne, companyA), false))).toBe(true);
        expect(Exit.isFailure(yield* keyTarget(foreignPrincipal, true))).toBe(true);
        expect(Exit.isSuccess(yield* keyTarget(foreignPrincipal, false))).toBe(true);

        // Re-running changes nothing.
        const again = yield* register('run-2');
        expect(counts(again, tenantOne)).toEqual({ failed: null, registered: 0, retired: 0, unchanged: 2 });
        expect(counts(again, tenantTwo)).toEqual({ failed: null, registered: 0, retired: 0, unchanged: 1 });

        // A renamed company: its registration follows the new name, and nothing else changes.
        yield* adminDatabase
          .update(legalEntities)
          .set({ legalName: 'Company A, s.r.o.' })
          .where(eq(legalEntities.legalEntityId, companyA));
        const renamed = yield* register('run-rename');
        expect(renamed.find(({ tenantId }) => tenantId === tenantOne)).toMatchObject({
          failed: null,
          registered: 0,
          renamed: 1,
          retired: 0,
          unchanged: 1,
        });
        const [afterRename] = yield* adminDatabase
          .select({ displayName: principals.displayName })
          .from(principals)
          .where(eq(principals.principalId, principalOf(tenantOne, companyA)));
        expect(afterRename?.displayName).toBe('CRM · zakládání klientů · Company A, s.r.o.');

        // Company B is suspended and CRM is uninstalled in the second tenant: those registrations are retired (never
        // deleted) and get no key; the hand-made registration stays exactly as it was.
        yield* adminDatabase
          .update(legalEntities)
          .set({ status: 'suspended' })
          .where(eq(legalEntities.legalEntityId, companyB));
        yield* adminDatabase
          .update(tenantModuleStates)
          .set({ state: 'inactive' })
          .where(and(eq(tenantModuleStates.tenantId, tenantTwo), eq(tenantModuleStates.moduleKey, CRM_MODULE)));
        const retired = yield* register('run-3');
        expect(counts(retired, tenantOne)).toEqual({ failed: null, registered: 0, retired: 1, unchanged: 1 });
        expect(counts(retired, tenantTwo)).toEqual({ failed: null, registered: 0, retired: 1, unchanged: 0 });
        const statusOf = (principalId: string) =>
          adminDatabase
            .select({ status: principals.status })
            .from(principals)
            .where(eq(principals.principalId, principalId))
            .pipe(Effect.map(([row]) => row?.status));
        expect(yield* statusOf(principalOf(tenantOne, companyB))).toBe('disabled');
        expect(yield* statusOf(principalOf(tenantTwo, companyC))).toBe('disabled');
        expect(yield* activeCompanyOf(principalOf(tenantOne, companyB))).toEqual([]);
        expect(yield* activeCompanyOf(foreignPrincipal)).toEqual([{ legalEntityId: companyA }]);
        const afterRetirement = yield* provision;
        expect([...afterRetirement.workloadCredentials.keys()]).toEqual([entry(tenantOne, companyA)]);

        // Company B is active again: the same principal takes the workload again, with a fresh binding.
        yield* adminDatabase
          .update(legalEntities)
          .set({ status: 'active' })
          .where(eq(legalEntities.legalEntityId, companyB));
        const back = yield* register('run-4');
        expect(counts(back, tenantOne)).toEqual({ failed: null, registered: 1, retired: 0, unchanged: 1 });
        expect(yield* statusOf(principalOf(tenantOne, companyB))).toBe('active');
        expect(yield* activeCompanyOf(principalOf(tenantOne, companyB))).toEqual([{ legalEntityId: companyB }]);
        const restored = yield* provision;
        expect([...restored.workloadCredentials.keys()].toSorted()).toEqual(
          [entry(tenantOne, companyA), entry(tenantOne, companyB)].toSorted(),
        );

        // Each converging run left one audit row per tenant it changed, by that tenant's release actor; never a key.
        const audits = yield* adminDatabase
          .select({ evidence: auditEvents.evidenceJson, tenantId: auditEvents.tenantId })
          .from(auditEvents)
          .where(eq(auditEvents.eventType, 'core.access.internal-workloads-registered-by-release'));
        // The first tenant converged four times: registration, the company rename, retirement and the company's return.
        expect(audits.filter(({ tenantId }) => tenantId === tenantOne)).toHaveLength(4);
        expect(audits.filter(({ tenantId }) => tenantId === tenantTwo)).toHaveLength(2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);

it.live(
  'reports a derived id another tenant took, keeps registering the rest, heals once it is free, and converges when two hosts run at once',
  () =>
    Effect.scoped(
      Effect.gen(function* releaseHealing() {
        const { adminDatabase, coreDatabase } = yield* platform;
        const enrollment = APP_DATABASE_IDENTITY_ENROLLMENT;
        const [tenantOne, tenantTwo] = [crypto.randomUUID(), crypto.randomUUID()];
        const [companyA, companyB, companyC, companyD] = [
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
        ];
        const owners = [crypto.randomUUID(), crypto.randomUUID()];
        const principalOf = (tenantId: string, legalEntityId: string) =>
          internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey: INTAKE_WORKLOAD });
        // Another tenant's principal sits at the id the platform derives for company B of the first tenant.
        const squatted = principalOf(tenantOne, companyB);
        // A principal someone named like the platform's old registrations, with a random id: never the platform's.
        const lookalike = crypto.randomUUID();
        yield* adminDatabase.insert(tenants).values(
          [tenantOne, tenantTwo].map((tenantId, index) => ({
            defaultLocale: 'cs',
            name: `Healing ${String(index)}`,
            slug: `healing-${tenantId}`,
            status: 'active',
            tenantId,
          })),
        );
        yield* adminDatabase.insert(legalEntities).values(
          [
            [companyA, tenantOne],
            [companyB, tenantOne],
            [companyC, tenantTwo],
          ].map(([legalEntityId = '', tenantId = ''], index) => ({
            legalEntityId,
            legalName: `Healing company ${String(index)}`,
            registrationCountry: 'CZ',
            registrationNumber: `1000000${String(index)}`,
            status: 'active',
            tenantId,
          })),
        );
        yield* adminDatabase.insert(principals).values([
          ...[tenantOne, tenantTwo].map((tenantId, index) => ({
            displayName: 'Owner',
            kind: 'human' as const,
            principalId: owners[index] ?? '',
            status: 'active' as const,
            tenantId,
          })),
          {
            displayName: 'Agent placed at a derived id',
            kind: 'agent' as const,
            principalId: squatted,
            status: 'active' as const,
            tenantId: tenantTwo,
          },
          {
            displayName: `internal-workload:${INTAKE_WORKLOAD}:${companyA}`,
            kind: 'service' as const,
            principalId: lookalike,
            status: 'active' as const,
            tenantId: tenantOne,
          },
        ]);
        yield* adminDatabase
          .insert(tenantModuleStates)
          .values([tenantOne, tenantTwo].map((tenantId) => ({ moduleKey: CRM_MODULE, state: 'active', tenantId })));
        for (const [index, tenantId] of [tenantOne, tenantTwo].entries()) {
          yield* writeTestTenantScopes(coreDatabase, {
            databaseIdentities: enrollment,
            legalEntityIds: tenantId === tenantOne ? [companyA, companyB] : [companyC],
            principalId: owners[index] ?? '',
            tenantId,
          });
        }
        const declarations = internalWorkloadDeclarations(
          MODULE_INTERNAL_WORKLOADS,
          new Set([INTAKE_WORKLOAD]),
          INTERNAL_WORKLOAD_LABELS,
        );
        const register = releaseRegistration(coreDatabase, declarations);
        const activeBindingsOf = (principalId: string) => activeCompaniesOf(adminDatabase, principalId);

        // Company B's registration cannot be made, and says why by name; company A's is made all the same.
        const first = yield* register('heal-1');
        const firstOne = first.find(({ tenantId }) => tenantId === tenantOne);
        expect(firstOne?.failed).toContain(`id taken by another principal (tenant ${tenantTwo})`);
        expect(yield* activeBindingsOf(principalOf(tenantOne, companyA))).toEqual([{ legalEntityId: companyA }]);
        expect(yield* activeBindingsOf(squatted)).toEqual([]);
        // The lookalike is neither adopted nor touched.
        const [lookalikeRow] = yield* adminDatabase
          .select({ platformRole: principals.platformRole, status: principals.status })
          .from(principals)
          .where(eq(principals.principalId, lookalike));
        expect(lookalikeRow).toEqual({ platformRole: null, status: 'active' });
        expect(yield* activeBindingsOf(lookalike)).toEqual([]);

        // The id is free again: the next run makes company B's registration and nothing else changes.
        yield* adminDatabase.delete(principals).where(eq(principals.principalId, squatted));
        const healed = yield* register('heal-2');
        expect(counts(healed, tenantOne)).toEqual({ failed: null, registered: 1, retired: 0, unchanged: 1 });
        expect(yield* activeBindingsOf(principalOf(tenantOne, companyB))).toEqual([{ legalEntityId: companyB }]);

        // An administrator set the platform's registration aside by hand (archived): the platform owns it, so the
        // next run makes it active again with its binding, and reports it as healed.
        yield* adminDatabase
          .update(principals)
          .set({ status: 'archived' })
          .where(eq(principals.principalId, principalOf(tenantOne, companyA)));
        const afterArchive = yield* register('heal-archived');
        expect(afterArchive.find(({ tenantId }) => tenantId === tenantOne)).toMatchObject({ failed: null, healed: 1 });
        const [restoredRow] = yield* adminDatabase
          .select({ status: principals.status })
          .from(principals)
          .where(eq(principals.principalId, principalOf(tenantOne, companyA)));
        expect(restoredRow?.status).toBe('active');
        expect(yield* activeBindingsOf(principalOf(tenantOne, companyA))).toEqual([{ legalEntityId: companyA }]);

        // Two hosts run the step at the same moment for a new company: whatever either reports, the next run finds
        // exactly one registration, one binding and one company binding.
        yield* adminDatabase.insert(legalEntities).values({
          legalEntityId: companyD,
          legalName: 'Healing company 3',
          registrationCountry: 'CZ',
          registrationNumber: '10000003',
          status: 'active',
          tenantId: tenantTwo,
        });
        yield* Effect.all([register('host-1'), register('host-2')], { concurrency: 2 });
        const settled = yield* register('heal-3');
        expect(counts(settled, tenantTwo)).toEqual({ failed: null, registered: 0, retired: 0, unchanged: 2 });
        expect(yield* activeBindingsOf(principalOf(tenantTwo, companyD))).toEqual([{ legalEntityId: companyD }]);
        const workloadBindings = yield* adminDatabase
          .select({ bindingId: accessWorkloadBindings.bindingId })
          .from(accessWorkloadBindings)
          .where(
            and(
              eq(accessWorkloadBindings.principalId, principalOf(tenantTwo, companyD)),
              eq(accessWorkloadBindings.status, 'active'),
            ),
          );
        expect(workloadBindings).toHaveLength(1);

        // An earlier build registered company E of the first tenant before the marker existed: its principal holds the
        // derived id without the marker. It is reported by name and never adopted; once removed, the id is made.
        const companyE = crypto.randomUUID();
        yield* adminDatabase.insert(legalEntities).values({
          legalEntityId: companyE,
          legalName: 'Healing company 4',
          registrationCountry: 'CZ',
          registrationNumber: '10000004',
          status: 'active',
          tenantId: tenantOne,
        });
        yield* adminDatabase.insert(principals).values({
          displayName: `internal-workload:${INTAKE_WORKLOAD}:${companyE}`,
          kind: 'service',
          principalId: principalOf(tenantOne, companyE),
          status: 'active',
          tenantId: tenantOne,
        });
        const unmarked = yield* register('heal-unmarked');
        expect(unmarked.find(({ tenantId }) => tenantId === tenantOne)?.failed).toContain(
          `${INTAKE_WORKLOAD} in company ${companyE}: derived id held by an unmarked principal of the same tenant created by an earlier build`,
        );
        const [unmarkedRow] = yield* adminDatabase
          .select({ platformRole: principals.platformRole, status: principals.status })
          .from(principals)
          .where(eq(principals.principalId, principalOf(tenantOne, companyE)));
        expect(unmarkedRow).toEqual({ platformRole: null, status: 'active' });
        expect(yield* activeBindingsOf(principalOf(tenantOne, companyE))).toEqual([]);
        yield* adminDatabase.delete(principals).where(eq(principals.principalId, principalOf(tenantOne, companyE)));
        const madeAfterRemoval = yield* register('heal-unmarked-removed');
        expect(madeAfterRemoval.find(({ tenantId }) => tenantId === tenantOne)).toMatchObject({
          failed: null,
          registered: 1,
        });
        expect(yield* activeBindingsOf(principalOf(tenantOne, companyE))).toEqual([{ legalEntityId: companyE }]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);

it.live('refuses any change to a principal platform role in the database, even by the runtime role', () =>
  Effect.scoped(
    Effect.gen(function* platformRoleIsImmutable() {
      const { adminDatabase, coreDatabase } = yield* platform;
      const tenantId = crypto.randomUUID();
      const [workload, releaseActor, unmarked] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      yield* adminDatabase.insert(tenants).values({
        defaultLocale: 'cs',
        name: 'Platform role',
        slug: `platform-role-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* adminDatabase.insert(principals).values([
        {
          displayName: 'CRM · zakládání klientů · Firma',
          kind: 'service' as const,
          platformRole: 'internal_workload',
          principalId: workload,
          status: 'active' as const,
          tenantId,
        },
        {
          displayName: 'Release actor',
          kind: 'system' as const,
          platformRole: 'access_release_actor',
          principalId: releaseActor,
          status: 'active' as const,
          tenantId,
        },
        {
          displayName: 'Hand-made service',
          kind: 'service' as const,
          principalId: unmarked,
          status: 'active' as const,
          tenantId,
        },
      ]);
      // Every write runs as the shared runtime role, in the tenant's scope, as the application's writers do.
      const asRuntime = (principalId: string, platformRole: (typeof principals.$inferInsert)['platformRole']) =>
        coreDatabase.transaction((transaction) =>
          transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`).pipe(
            Effect.andThen(
              transaction
                .update(principals)
                .set({ platformRole })
                .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId))),
            ),
          ),
        );
      for (const [principalId, platformRole] of [
        [workload, null],
        [workload, 'access_release_actor'],
        [releaseActor, null],
        [unmarked, 'internal_workload'],
      ] as const) {
        const refusal = yield* Effect.flip(asRuntime(principalId, platformRole));
        expect(Option.getOrThrow(findPostgresFailure(refusal)).code).toBe('23514');
      }
      const rows = yield* adminDatabase
        .select({ platformRole: principals.platformRole, principalId: principals.principalId })
        .from(principals)
        .where(eq(principals.tenantId, tenantId));
      expect(Object.fromEntries(rows.map((row) => [row.principalId, row.platformRole]))).toEqual({
        [releaseActor]: 'access_release_actor',
        [unmarked]: null,
        [workload]: 'internal_workload',
      });
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer))),
);
