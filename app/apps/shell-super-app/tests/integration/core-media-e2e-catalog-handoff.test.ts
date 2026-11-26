import {
  GatewayScopeGrantRegistrar,
  OntosModuleRequirementsSchema,
  defineOntosModuleManifest,
  defineRead,
  defineTenantModuleEntrypoint,
  defineVerticalRuntimeRegistration,
  makeActiveApplicationCompositionService,
  uploadAssetAction,
} from '@app/core-runtime';
import type { OperationalScope, TrustedPrincipalContext } from '@app/core-runtime';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { callAnswer, declaredCall } from '@app/core-runtime/sdk';
import { coreOperations } from '@app/core-runtime/sdk/core';
import { readAnswer } from '@app/core-runtime/sdk/read';
import type { NoAccessQuestions, ReadRunContext } from '@app/core-runtime/sdk/read';
import { GatewayActorClaimSchema } from '@app/shared-contracts';
import { makeModuleCallRoute } from '@app/shared-contracts/server/sdk-module-call-route';
import { NodeCrypto } from '@effect/platform-node';
import { Clock, Config, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { GatewayIssuer, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, principalOf, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld, ShellEdge } from '../support/core-media-e2e-fixture.ts';
import {
  downloadOf,
  patternBytes,
  putBytes,
  refOf,
  requireFaultInjection,
  reservationPayload,
  rowOf,
} from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: the Catalog Current handoff, acceptance statement 7 of #1428, as far as ONE world can honestly run it.
 *
 * What runs for real, in this process, in one request chain:
 *  - the Core read runtime, the call executor and requirement lookup: a consumer `{ run }` read declares exactly the call
 *    Catalog's `catalogDocumentCurrentRead` declares (`declaredCall(coreOperations.assetCurrent,
 *    'commerce.catalog.requirement.core-media-current')`, requirement `person` / `subject`, company `optional`);
 *  - the SDK module-call route `makeModuleCallRoute` (the published `@app/shared-contracts/server/sdk-module-call-route`):
 *    request encoding, headers, the operation URL, the answer decode, the status-to-outcome mapping;
 *  - the Shell's own gateway issuer signing the assertion of the requester on behalf of the module (`act` = the module);
 *  - the production Shell receiver `POST /core/operations/asset-current` on a real loopback HTTP server: signature,
 *    audience, release, `act`, durable redemption in PostgreSQL, the installed contract that declares the hosted
 *    requirement;
 *  - Core's Current V1 read as the REQUESTER over the v2 gate (real SpiceDB), PostgreSQL and the real S3 adapter against
 *    an S3-compatible EMULATOR (MinIO, NOT R2).
 *
 * What is substituted, and why (NOT a claim of more than this):
 *  1. CATALOG'S OWN READ AND ADAPTER (`runCatalogDocumentCurrent`, `coreMediaOwnerAvailability`, assignments in
 *     Catalog's tables) do not run here. They are Catalog's private source and a deployment of its own: this test must
 *     not import them, and Catalog's tables are not part of this world (the real Catalog server runs against the real
 *     Shell in `scripts/integration/core-media-catalog-handoff.test.mts`). The consumer read stands in for them and
 *     returns the typed call outcome the Catalog adapter classifies (`Ok` entries, `Forbidden`, `Unavailable`); the
 *     Catalog adapter's mapping of those outcomes is proven against the same SDK types in Catalog's own unit tests.
 *  2. THE CONSUMER'S OWN HOST: the read runs on Core's read test harness (scripted database and gate for the CONSUMER's
 *     own read and its evidence rows), never on Catalog's deployment. Everything downstream of `context.call` is real.
 *  3. THE DELEGATION EXCHANGE: `GatewayDelegation.acquire` (the seam `makeModuleCallRoute` is built over) signs with the
 *     Shell's real issuer in process instead of calling the Shell's delegation route with a module API key. The
 *     delegation issuer's admission rules (62 unit tests) and the module credential are therefore not exercised here.
 *  4. The requirement's `condition` and `evidence` keys, and the consumer read's own descriptor, are this fixture's, not
 *     Catalog's (the provider, entrypoint, schema version, callers and the declared call are Catalog's).
 *  5. AUTHENTICATION of the requester is the header-named actor of the E2E world, as in every `core-media-e2e-*` file.
 */

const platform = {
  makeActionRepository,
  makeActionRuntime,
  makeCompositionSnapshot,
  makeReadRuntime,
  makeShellAuthenticationApiRuntime,
};

const { apiPrefix } = shellAuthenticationApiContract;
const CATALOG_BUILD = 'catalog-build';
const CATALOG_MODULE = 'commerce.catalog';
const READ_KEY = 'commerce.catalog.api.catalog-document-current';
const REQUIREMENT_KEY = 'commerce.catalog.requirement.core-media-current';
const moduleActor = Schema.decodeUnknownSync(GatewayActorClaimSchema)({
  appId: 'catalog',
  buildMarker: CATALOG_BUILD,
  principalId: '60000000-0000-4000-8000-000000000001',
});

const hostedRequirement = {
  callers: [{ kind: 'person', legalEntityScope: 'subject' }],
  condition: 'commerce.catalog.condition.core-media-current',
  entrypointKey: READ_KEY,
  evidence: ['core.media.asset'],
  key: REQUIREMENT_KEY,
  provider: { entrypointKey: 'core.media.api.asset-current', moduleId: 'core.media', schemaVersion: '1' },
};
const requirementsEncoded = {
  coreCapabilities: [],
  intrinsic: [],
  operations: [hostedRequirement],
  schemaVersion: '1',
};
const catalogBase = makeModuleContractFixture({ appId: 'catalog', moduleId: CATALOG_MODULE });
const catalogContract = () => ({
  ...catalogBase,
  manifest: { ...catalogBase.manifest, requirements: requirementsEncoded },
});

// ---------------------------------------------------------------------------------------------
// The consumer: what Catalog's read declares, and nothing of its logic
// ---------------------------------------------------------------------------------------------

const calls = { ownerCurrent: declaredCall(coreOperations.assetCurrent, REQUIREMENT_KEY) } as const;
const ConsumerResultSchema = Schema.Struct({
  entries: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  outcome: Schema.String,
});
type ConsumerContext = ReadRunContext<Record<string, never>, typeof calls, NoAccessQuestions>;

const consumerRead = defineRead(
  {
    accessDeclaration: {
      key: `${READ_KEY}.read`,
      kind: 'read',
      modes: ['run'],
      placement: { group: 'catalog-document', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessKind: 'detail',
    calls,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: READ_KEY,
      moduleKey: CATALOG_MODULE,
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: `${READ_KEY}.evidence.v1` },
    inputSchema: coreOperations.assetCurrent.request,
    legalEntityScope: 'optional',
    owningModuleKey: CATALOG_MODULE,
    policies: [],
    readKey: READ_KEY,
    resultSchema: ConsumerResultSchema,
    schemaVersion: '1',
  },
  {
    run: (input: typeof coreOperations.assetCurrent.request.Type, context: ConsumerContext) =>
      context.call('ownerCurrent', input).pipe(
        Effect.map((outcome) =>
          readAnswer(
            Option.match(callAnswer(outcome), {
              onNone: () => ({ outcome: outcome._tag }),
              onSome: (value) => ({ entries: value.entries, outcome: outcome._tag }),
            }),
            { resultCount: 1 },
          ),
        ),
      ),
  },
  () => Effect.succeed({}),
);

const consumerRegistration = defineVerticalRuntimeRegistration({
  actions: [],
  manifest: defineOntosModuleManifest({
    ...catalogBase.manifest,
    publicSurface: { ...catalogBase.manifest.publicSurface, actions: [], api: {}, components: {} },
    requirements: Schema.decodeUnknownSync(OntosModuleRequirementsSchema)(requirementsEncoded),
  }),
  outboxWorkers: [],
  reads: [consumerRead],
});

// ---------------------------------------------------------------------------------------------
// The route: the real SDK module route over the real Shell issuer
// ---------------------------------------------------------------------------------------------

const noScopeGrants = Layer.succeed(GatewayScopeGrantRegistrar, { register: () => Effect.void });

/** One assertion signed by the Shell's real issuer for the audience, on behalf of the requester, relayed by the module. */
const issueAssertion = (world: MediaE2eWorld, principal: TrustedPrincipalContext, audience: string) =>
  Effect.gen(function* issueRelayedAssertion() {
    const privateJwk = yield* Config.Redacted('D20_E2E_GATEWAY_PRIVATE_JWK');
    const issuerName = yield* Config.String('ONTOS_GATEWAY_ISSUER');
    const configuration = yield* parseGatewayIssuerConfig({
      ONTOS_GATEWAY_ISSUER: issuerName,
      ONTOS_GATEWAY_PRIVATE_JWK: Redacted.value(privateJwk),
    });
    const clock = yield* Clock.Clock;
    const issuerLayer = makeGatewayIssuerLayer({
      currentTimeSeconds: clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000))),
      generateJti: Effect.sync(() => globalThis.crypto.randomUUID()),
      loadAdmission: Effect.succeed({
        audiences: new Map([
          ['catalog', CATALOG_BUILD],
          ['shell-super-app', ultramodernDeliveryUnit.buildMarker],
        ]),
        revision: world.compositionRevision,
      }),
      loadConfig: Effect.succeed(configuration),
    }).pipe(Layer.provide(noScopeGrants));
    const issued = yield* Effect.gen(function* issueWithIssuer() {
      const issuer = yield* GatewayIssuer;
      return yield* issuer.issue({
        actor: moduleActor,
        audience,
        compositionRevision: world.compositionRevision,
        principal,
      });
    }).pipe(Effect.provide(issuerLayer));
    return issued.token;
  }).pipe(Effect.orDie);

/** The requester the consumer's call relays: the consumer host knows no staff namespace, so the Shell-side scope is held here. */
interface RelayedRequester {
  principal: Option.Option<TrustedPrincipalContext>;
}

const moduleRouteOver = (world: MediaE2eWorld, edge: ShellEdge, relayed: RelayedRequester) =>
  makeModuleCallRoute({
    acquire: (request) =>
      Effect.gen(function* acquireDelegation() {
        const requester = yield* Option.match(relayed.principal, {
          onNone: () => Effect.die('No requester is being relayed'),
          onSome: Effect.succeed,
        });
        // `subject` keeps the requester's selected company; `tenant` would drop it (the issuer's rule).
        const { legalEntityId, ...tenantOnly } = requester;
        const relayedScope = request.legalEntityScope === 'subject' ? requester : tenantOnly;
        void legalEntityId;
        const token = yield* issueAssertion(world, relayedScope, request.audience);
        const authorization: `Bearer ${string}` = `Bearer ${token}`;
        return {
          apiBaseUrl: `${edge.origin}${apiPrefix}`,
          authorization,
          compositionRevision: world.compositionRevision,
        };
      }),
  }).pipe(Effect.provide(FetchHttpClient.layer));

// ---------------------------------------------------------------------------------------------
// The world's steps
// ---------------------------------------------------------------------------------------------

const person = (world: MediaE2eWorld, name: string): E2eActor => {
  const actor = world.people.get(name);
  if (actor === undefined) {
    throw new Error(`The world has no ${name}`);
  }
  return actor;
};

const uploaderCapabilities = [MEDIA_CAPABILITIES.upload, MEDIA_CAPABILITIES.confirm];
const readerCapabilities = [MEDIA_CAPABILITIES.download];

/** Reserves as the actor (optionally selecting a company) and puts the bytes through the Shell's byte edge. */
const readyAsset = Effect.fn('CoreMediaE2e.chainReadyAsset')(function* readyAsset(
  world: MediaE2eWorld,
  edge: ShellEdge,
  uploader: E2eActor,
  bytes: Uint8Array<ArrayBuffer>,
  key: string,
  legalEntityId?: string,
) {
  const principal = yield* principalOf(uploader);
  const reserved = yield* world.withStorage(
    world.actions.runAction({
      payload: reservationPayload(bytes),
      principal: legalEntityId === undefined ? principal : { ...principal, legalEntityId },
      registration: uploadAssetAction,
      transport: { correlationId: `e2e-chain-reserve-${key}`, idempotencyKey: key },
    }),
  );
  const id = reserved.mediaAssetRef.resourceId;
  const stored = yield* putBytes(edge, uploader, id, bytes);
  expect(stored.status, new TextDecoder().decode(stored.bytes)).toBe(200);
  return id;
});

/** What the requester's Catalog read gets back: the typed outcome of its call, run on the consumer host. */
const askAs = Effect.fn('CoreMediaE2e.chainAsk')(function* askAs(
  world: MediaE2eWorld,
  route: Effect.Success<ReturnType<typeof moduleRouteOver>>,
  relayed: RelayedRequester,
  requester: E2eActor,
  ids: readonly string[],
  options: { readonly legalEntityId?: string } = {},
) {
  const requesterPrincipal = yield* principalOf(requester);
  const relayedPrincipal =
    options.legalEntityId === undefined
      ? requesterPrincipal
      : { ...requesterPrincipal, legalEntityId: options.legalEntityId };
  relayed.principal = Option.some(relayedPrincipal);
  const { authenticationNamespaceId: _staffNamespace, ...consumerHostPrincipal } = relayedPrincipal;
  const scope: OperationalScope = { ...consumerHostPrincipal, correlationId: `e2e-chain-${requester.name}` };
  const snapshot = world.compositionSnapshot;
  const consumer = snapshot.composition.modules.find(({ deployment }) => deployment.appId === 'catalog');
  if (consumer === undefined) {
    return yield* Effect.die('The world composition does not install the consumer');
  }
  const harness = yield* makeReadTestHarness({
    access: 'allowed',
    applicationComposition: makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
    compositionRevision: world.compositionRevision,
    executeOwnerQuery: () => Effect.die('The consumer read runs no owner SQL'),
    expectedDeployment: consumer.deployment,
    moduleCallRoute: route,
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-24T10:00:00.000Z')),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: consumerRegistration,
    scope,
  });
  const [first, ...rest] = ids.map((id) => refOf(world.tenantId, id));
  if (first === undefined) {
    return yield* Effect.die('At least one asset is asked about');
  }
  return yield* harness.runtime.runRead({
    input: { mediaAssetRefs: [first, ...rest] },
    principal: trustVerifiedGatewayPrincipalContext(scope, world.compositionRevision),
    registration: consumerRead,
    transport: { correlationId: scope.correlationId },
  });
});

/** The entries of an answer, decoded by Core's own response schema (the one the SDK call decoded them with). */
const entriesOf = (answer: typeof ConsumerResultSchema.Type) =>
  Schema.decodeUnknownSync(coreOperations.assetCurrent.response)({ entries: answer.entries ?? [] }).entries;

const kindsOf = (answer: typeof ConsumerResultSchema.Type): readonly string[] =>
  entriesOf(answer).map((entry) => entry.kind);

const entryFor = (answer: typeof ConsumerResultSchema.Type, mediaAssetId: string) =>
  entriesOf(answer).find((entry) => entry.resourceRef.resourceId === mediaAssetId);

/** The same bytes with one byte changed: another object of the same length. */
const withByteChanged = (original: Uint8Array<ArrayBuffer>, index: number) =>
  original.map((byte, at) => (at === index ? (byte + 1) % 256 : byte));

/** What the requester's read answers for these assets, as the outcome and the kind of each entry. */
const kindsAnswered = Effect.fn('CoreMediaE2e.chainKinds')(function* kindsAnswered(
  world: MediaE2eWorld,
  route: Effect.Success<ReturnType<typeof moduleRouteOver>>,
  relayed: RelayedRequester,
  requester: E2eActor,
  ids: readonly string[],
) {
  const answer = yield* askAs(world, route, relayed, requester, ids);
  return { kinds: kindsOf(answer), outcome: answer.outcome };
});

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end: the Catalog Current handoff through the SDK route and the Shell receiver (acceptance statement 7)',
  (suite) => {
    suite.effect(
      'Core answers the exact refs through the SDK route: AVAILABLE for an owner-issued V1, ABSENT for an unknown asset and for another company, and a refusal is never a grant (the requester selects a company)',
      (ctx) =>
        withMediaE2eWorld(
          ctx,
          platform,
          (world) =>
            Effect.scoped(
              Effect.gen(function* handoff() {
                const uploader = person(world, 'uploader');
                const owner = person(world, 'owner');
                const asker = person(world, 'currentOnly');
                const outsider = person(world, 'outsider');
                yield* world.grant(uploader, uploaderCapabilities);
                yield* world.grant(asker, [MEDIA_CAPABILITIES.current]);
                const edge = yield* world.shell;
                const relayed: RelayedRequester = { principal: Option.none() };
                const route = yield* moduleRouteOver(world, edge, relayed);

                const companyless = yield* readyAsset(world, edge, uploader, patternBytes(70_001), 'chain-companyless');
                const ownCompany = yield* readyAsset(
                  world,
                  edge,
                  owner,
                  patternBytes(70_002),
                  'chain-company-a',
                  world.legalEntityId,
                );
                // Another company of the same tenant: a fixture row (throwaway database), and an asset stamped with it.
                const companyB = '8b1f0c3e-6d1a-4f6e-9a55-2f3b6c1d7e90';
                yield* world.admin.unsafe(
                  `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
                   values ($1::uuid, $2::uuid, 'E2E other company', 'CZ', 'E2E-OTHER-COMPANY', 'active')`,
                  [companyB, world.tenantId],
                );
                const otherCompany = yield* readyAsset(world, edge, uploader, patternBytes(70_003), 'chain-company-b');
                yield* world.admin.unsafe(
                  `update core.media_assets set legal_entity_id = $1::uuid where media_asset_id = $2::uuid`,
                  [companyB, otherCompany],
                );
                const reserved = (yield* world.withStorage(
                  world.actions.runAction({
                    payload: reservationPayload(patternBytes(70_004)),
                    principal: yield* principalOf(uploader),
                    registration: uploadAssetAction,
                    transport: { correlationId: 'e2e-chain-reserved', idempotencyKey: 'chain-reserved' },
                  }),
                )).mediaAssetRef.resourceId;
                const unknown = '8d0e5b0e-2c61-4f43-a5a3-5f7b3c0d9a11';
                const ids = [companyless, ownCompany, otherCompany, reserved, unknown];

                // No company selected: the whole tenant, every company's assets answer.
                const tenantWide = yield* askAs(world, route, relayed, asker, ids);
                expect(tenantWide.outcome).toBe('Ok');
                expect(kindsOf(tenantWide)).toEqual([
                  'AVAILABLE',
                  'AVAILABLE',
                  'AVAILABLE',
                  'CURRENT_UNVERIFIED',
                  'ABSENT',
                ]);
                // The owner selects company A: A's own and company-less assets answer, company B's is ABSENT exactly like
                // an asset that never existed (no new outcome, no existence oracle across companies).
                const selected = yield* askAs(world, route, relayed, owner, ids, {
                  legalEntityId: world.legalEntityId,
                });
                expect(selected.outcome).toBe('Ok');
                expect(kindsOf(selected)).toEqual(['AVAILABLE', 'AVAILABLE', 'ABSENT', 'CURRENT_UNVERIFIED', 'ABSENT']);
                expect(entryFor(selected, otherCompany)).toEqual({
                  kind: 'ABSENT',
                  resourceRef: refOf(world.tenantId, otherCompany),
                });
                expect(entryFor(selected, unknown)).toEqual({
                  kind: 'ABSENT',
                  resourceRef: refOf(world.tenantId, unknown),
                });
                // Current V1: revision 1, the exact ref, no revision id.
                expect(entryFor(selected, companyless)).toEqual({
                  current: { resourceRef: refOf(world.tenantId, companyless), revision: 1 },
                  kind: 'AVAILABLE',
                  resourceRef: refOf(world.tenantId, companyless),
                });

                // The requester lacks the Current right: the whole call is refused, nothing is a grant.
                const refused = yield* askAs(world, route, relayed, outsider, ids);
                expect(refused.outcome).toBe('Forbidden');
                expect(refused.entries).toBeUndefined();
              }),
            ).pipe(Effect.provide(NodeCrypto.layer)),
          { contracts: [catalogContract()], requires: ['ONTOS_GATEWAY_ISSUER', 'D20_E2E_GATEWAY_PRIVATE_JWK'] },
        ),
    );

    suite.effect(
      'a swapped object, a failed asset and an unreachable store are never AVAILABLE through the same chain (CONTROLLED FAULT INJECTION: out-of-band replacement at the emulator, S3 relay reset)',
      (ctx) =>
        withMediaE2eWorld(
          ctx,
          platform,
          (world) =>
            Effect.scoped(
              Effect.gen(function* faults() {
                const { faults: relay } = yield* requireFaultInjection(ctx, world);
                const uploader = person(world, 'uploader');
                const reader = person(world, 'downloader');
                const asker = person(world, 'currentOnly');
                yield* world.grant(uploader, uploaderCapabilities);
                yield* world.grant(reader, readerCapabilities);
                yield* world.grant(asker, [MEDIA_CAPABILITIES.current]);
                // The operator's enrolment of the one workload that may record proven corruption, and nothing else.
                yield* world.bindSystemWorkload('core.media.integrity');
                const edge = yield* world.shell;
                const relayed: RelayedRequester = { principal: Option.none() };
                const route = yield* moduleRouteOver(world, edge, relayed);
                const kinds = (ids: readonly string[]) => kindsAnswered(world, route, relayed, asker, ids);

                const original = patternBytes(786_433);
                const swapped = yield* readyAsset(world, edge, uploader, original, 'chain-swap');
                const corrupted = yield* readyAsset(world, edge, uploader, patternBytes(786_433), 'chain-corrupt');
                const outage = yield* readyAsset(world, edge, uploader, patternBytes(70_011), 'chain-outage');
                expect(yield* kinds([swapped, corrupted, outage])).toEqual({
                  kinds: ['AVAILABLE', 'AVAILABLE', 'AVAILABLE'],
                  outcome: 'Ok',
                });
                // A same-length swap that nobody downloaded: the provider pin recorded at confirm no longer matches.
                yield* world.replaceStoredObject(swapped, withByteChanged(original, 786_000));
                expect(yield* kinds([swapped, corrupted, outage])).toEqual({
                  kinds: ['CURRENT_UNVERIFIED', 'AVAILABLE', 'AVAILABLE'],
                  outcome: 'Ok',
                });

                // Proven corruption: a download that reads the whole object records `failed` through the bound workload.
                yield* world.replaceStoredObject(corrupted, withByteChanged(original, 786_100));
                const download = yield* edge.open({
                  actor: reader,
                  headers: { 'x-correlation-id': 'e2e-chain-corrupt' },
                  method: 'GET',
                  path: `/core/media/assets/${corrupted}/content`,
                });
                yield* Effect.promise(async () => await download.arrayBuffer()).pipe(Effect.exit);
                expect((yield* rowOf(world, corrupted))?.processing_status).toBe('failed');
                expect((yield* downloadOf(edge, reader, corrupted)).status).toBe(409);
                expect(yield* kinds([swapped, corrupted, outage])).toEqual({
                  kinds: ['CURRENT_UNVERIFIED', 'CURRENT_UNVERIFIED', 'AVAILABLE'],
                  outcome: 'Ok',
                });

                // The store is unreachable for the stat: UNAVAILABLE for that entry, never AVAILABLE and never ABSENT.
                relay.setRules([{ fault: { kind: 'reset-before' }, method: 'HEAD', times: 50 }]);
                const down = yield* kinds([outage]);
                relay.setRules([]);
                expect(down).toEqual({ kinds: ['UNAVAILABLE'], outcome: 'Ok' });
                expect(yield* kinds([outage])).toEqual({ kinds: ['AVAILABLE'], outcome: 'Ok' });
              }),
            ).pipe(Effect.provide(NodeCrypto.layer)),
          { contracts: [catalogContract()], requires: ['ONTOS_GATEWAY_ISSUER', 'D20_E2E_GATEWAY_PRIVATE_JWK'] },
        ),
    );
  },
);
