import { loadModuleCredentialEnrolment, PLATFORM_TENANT } from '@app/core-runtime/auth/module-credentials';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { and, eq, like, sql } from 'drizzle-orm';
import { Clock, DateTime, Duration, Effect, Exit, Layer, Redacted, Schema, Stream } from 'effect';
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
          keep: ReadonlySet<string>,
          earlierBoots: ReadonlySet<string> = new Set(),
        ) =>
          retireOwnModuleCredentials({
            bootId,
            compositionRevision: release.compositionRevision,
            earlierBoots,
            hostId,
            keep,
            operationId: crypto.randomUUID(),
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
        expect(yield* retireOwn('host-a', otherContainerBootId, otherContainer.providerKeyIds)).toEqual({
          failed: 0,
          retired: 0,
        });
        expect(yield* verifiesAll(bootOne)).toBe(true);
        expect(yield* verifiesAll(bootTwo)).toBe(true);

        // Boot K2 retires the keys of the ended boot its container recorded: exactly boot K1's, never the other
        // container's (same host name, a boot it never recorded) or its own.
        expect(yield* retireOwn('host-a', bootTwoId, bootTwo.providerKeyIds, new Set([bootOneId]))).toEqual({
          failed: 0,
          retired: APP_IDS.length,
        });
        expect(yield* verifiesNone(bootOne)).toBe(true);
        expect(yield* verifiesAll(otherContainer)).toBe(true);
        expect(yield* verifiesAll(bootTwo)).toBe(true);

        // A rotation in boot K2: the rotated keys are handed over, then K2's earlier keys are retired the same way.
        const rotated = yield* issue('host-a', bootTwoId);
        expect(yield* retireOwn('host-a', bootTwoId, rotated.providerKeyIds, new Set([bootOneId]))).toEqual({
          failed: 0,
          retired: APP_IDS.length,
        });
        expect(yield* verifiesNone(bootTwo)).toBe(true);
        expect(yield* verifiesAll(rotated)).toBe(true);
        expect(yield* verifiesAll(otherContainer)).toBe(true);

        // A host that holds every key it was issued retires nothing; another host never names A's keys as its own.
        expect(yield* retireOwn('host-a', bootTwoId, rotated.providerKeyIds)).toEqual({ failed: 0, retired: 0 });
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
        expect(ownAudits).toHaveLength(5);
        const recorded = JSON.stringify(ownAudits);
        expect(recorded).toContain(`"bootId":"${bootTwoId}"`);
        expect(recorded).toContain('"hostId":"host-a"');
        for (const providerKeyId of [...bootOne.providerKeyIds, ...bootTwo.providerKeyIds]) {
          expect(recorded).toContain(providerKeyId);
        }
        for (const providerKeyId of otherContainer.providerKeyIds) {
          expect(recorded.includes(providerKeyId)).toBe(false);
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
