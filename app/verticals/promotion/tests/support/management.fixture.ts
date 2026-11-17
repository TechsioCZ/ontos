import {
  ActiveApplicationCompositionService,
  ActionRuntime,
  OntosModuleDeploymentContractSchema,
  OwnerAuthorizationOverlay,
  applicationCompositionContentRevision,
  failClosedOwnerAuthorizationOverlay,
  loadDatabaseConnectionPair,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import type { ApplicationComposition } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeNativeReadTestContext, NativeReadTestError } from '@app/core-runtime/testing/native-reads';
import { publishTestApplicationCompositionAuthority, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { PgClient } from '@effect/sql-pg';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { Reactivity } from 'effect/reactivity';
import { promotionRegistration } from '../../vertical.registration.ts';

const digest = (value: string) => Hex.encode(sha256(utf8ToBytes(value)));

/**
 * Uses the actual Codesmith deployment artifact; never fabricates owner Actions or public descriptors.
 * Only immutable, read-only values: no test may mutate them, so one evaluation serves the whole module.
 */
const readPublishedComposition = Effect.fn('PromotionTest.publishedComposition')(function* composition() {
  const fs = yield* FileSystem.FileSystem;
  const document = yield* fs.readFileString(
    new URL('../../dist/public/.well-known/ontos-module-manifest.json', import.meta.url).pathname,
  );
  const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    document,
  );
  const base = yield* makeApplicationCompositionSnapshotFixture([]);
  const module: ApplicationComposition['modules'][number] = {
    allowedContributions: [],
    backend: { baseUrl: 'https://promotion.native-tests.example/', transport: 'node-http' },
    contract: {
      sha256: digest(document),
      url: 'https://promotion.native-tests.example/.well-known/ontos-module-manifest.json',
    },
    contractDocument: document,
    dependencies: [],
    deployment: contract.deployment,
    federation: { execution: 'server' },
    moduleId: contract.manifest.module.id,
    publicContract: { id: contract.manifest.module.id, sha256: digest(document), version: contract.schemaVersion },
    requiredCoreCapabilities: [],
    requiredShellAbi: base.composition.shell.contributionAbi,
    sharedSingletons: [],
  };
  const input = { ...base.composition, modules: [module] };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    composition: { ...input, revision: yield* applicationCompositionContentRevision(input) },
    observedAt: base.observedAt,
    validUntil: base.validUntil,
  });
  const spice = yield* loadSpiceDbConfig().pipe(
    Effect.mapError(
      (cause) =>
        new NativeReadTestError({
          cause: Redacted.make(cause),
          code: 'native_read_test_failed',
          reason: 'Promotion native fixture configuration is unavailable',
        }),
    ),
  );
  const spiceEnvironment = {
    SPICEDB_CA_CERT: spice.caCertificate,
    SPICEDB_ENDPOINT: spice.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.make(spice.preSharedKey),
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: spice.deploymentEnvironment,
  };
  const connections = yield* loadDatabaseConnectionPair();
  return { connections, contract, snapshot, spiceEnvironment };
});

/** Memoized for the whole test module; the first caller evaluates it, every later caller reads its result. */
let publishedComposition: ReturnType<typeof readPublishedComposition> | undefined;

/**
 * The manifest read, contract decode, digests, content revision, snapshot validation, connection pair and
 * SpiceDB configuration happen once per test module. The admin client stays per caller, so it is still
 * released with the caller's scope, and the composition authority is republished for every test in case a
 * concurrently running suite has overwritten the shared core row.
 */
export const loadPromotionTestComposition = Effect.fn('PromotionTest.composition')(function* composition() {
  const memoized = publishedComposition ?? (yield* Effect.cached(readPublishedComposition()));
  publishedComposition = memoized;
  const published = yield* memoized;
  const adminContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(published.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const admin = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
  yield* publishTestApplicationCompositionAuthority(admin, published.snapshot);
  return { ...published, admin };
});

interface PromotionTestAccessSpec {
  readonly defaultAnswer: { outcome: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE' };
}

export const createNativeManagementFixture = Effect.fn('PromotionTest.nativeManagementFixture')(
  function* nativeManagementFixture() {
    const composition = yield* loadPromotionTestComposition();
    const access: PromotionTestAccessSpec = { defaultAnswer: { outcome: 'ALLOWED' } };
    const authority = { snapshot: composition.snapshot };
    const accessGate = makeTestBoundAccessGate(access);
    const fixture = yield* makeNativeReadTestContext(
      {
        accessDecision: accessGate.bound,
        contextPermissions: [],
        expectedDeployment: composition.contract.deployment,
        moduleId: 'commerce.promotion',
        ownerFixtureRetention: 'retain-complete-context',
      },
      promotionRegistration,
    ).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.sync(() => authority.snapshot) }),
      Effect.provideService(OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay),
    );
    const actionRuntime = yield* Effect.fromOption(Option.fromUndefinedOr(fixture.actionRuntime));
    const layer = Layer.merge(fixture.layer, Layer.succeed(ActionRuntime, actionRuntime));
    const context = yield* Layer.build(layer);
    return { ...composition, access, accessGate, authority, fixture: { ...fixture, actionRuntime, context, layer } };
  },
);
