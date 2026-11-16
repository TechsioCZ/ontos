import { randomUUID } from 'node:crypto';

import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionService,
  ReadRuntime,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
  getVerticalRuntimeActions,
} from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  DecisionCheck,
  LegalEntityCandidates,
} from '@app/core-runtime/access/enforcement';
import { OwnerActionApprovals, makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import type { TestGateAnswer } from '@app/core-runtime/access/enforcement';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { inertAccessEnforcementPorts, makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto, NodeHttpServer } from '@effect/platform-node';
import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { defineEffectBff, dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { assert, expect, it, rstest } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { commerceMarketCatalogApiRuntimeFromContext, MarketRetirementRuntimeBindings } from '../../api/index.ts';
import { commerceMarketCatalogApiContract } from '../../shared/api.ts';
import { MarketAdministrationResponseSchema } from '../../shared/apis/market-administration.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createMarketAction } from '../../src/actions/create-market.action.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { marketAdministrationRead } from '../../src/api/market-administration.read.ts';
import { commerceMarketCatalogBackendRegistration } from '../../vertical.runtime-declaration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const principal = {
  authBindingId: '33333333-3333-4333-8333-333333333333',
  authContextRef: 'better-auth-session:market-administration-http',
  authMethod: 'session',
  legalEntityId: sellerId,
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
} as const;
const marketId = '55555555-5555-4555-8555-555555555555';
const definitionRevisionId = '66666666-6666-4666-8666-666666666666';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const correlationId = 'market-administration-http';
const unusedActionRuntime: ActionRuntimeService = {
  resolveActionCommit: () => Effect.die('An administration Read must not resolve an Action commit'),
  resolveActionExecution: () => Effect.die('An administration Read must not resolve an Action execution'),
  runAction: () => Effect.die('An administration Read must not execute an Action'),
};
const scenarios = [
  { create: 'ALLOWED', initial: 'DENIED', name: 'Read RUN does not grant management', read: 'ALLOWED', status: 200 },
  { create: 'DENIED', initial: 'ALLOWED', name: 'management does not grant creation', read: 'ALLOWED', status: 200 },
  {
    afterOwner: 'MISSING',
    create: 'ALLOWED',
    initial: 'ALLOWED',
    name: 'a missing management grant after owner SQL cannot leave a stale positive hint',
    read: 'ALLOWED',
    status: 200,
  },
  {
    afterOwner: 'UNAVAILABLE',
    create: 'ALLOWED',
    initial: 'ALLOWED',
    name: 'unavailable management authority after owner SQL prevents disclosure',
    read: 'ALLOWED',
    status: 503,
  },
  {
    create: 'ALLOWED',
    initial: 'UNAVAILABLE',
    name: 'unavailable management authority before owner SQL prevents observation',
    read: 'ALLOWED',
    status: 503,
  },
  {
    create: 'ALLOWED',
    initial: 'ALLOWED',
    name: 'management grants do not bypass a denied Read RUN',
    read: 'DENIED',
    status: 403,
  },
] as const;

for (const scenario of scenarios) {
  it.live(`the actual administration HTTP root: ${scenario.name}`, () =>
    Effect.gen(function* administrationHttpRoot() {
      const { applicationComposition, expectedDeployment, snapshot } = yield* makeOwnerApplicationCompositionFixture({
        appId: 'commerce-market-catalog',
        buildMarker: ultramodernApiMarker.buildMarker,
        ownerRegistration: commerceMarketCatalogBackendRegistration,
      });
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
        snapshot,
      );
      const sourceServer = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
      const sourceAddress = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
        sourceServer.address,
      );
      let compositionReads = 0;
      yield* sourceServer.serve(
        Effect.sync(() => {
          compositionReads += 1;
          return HttpServerResponse.text(document);
        }),
      );
      const readKey = marketAdministrationRead.descriptor.accessDeclaration?.key;
      const createKey = createMarketAction.descriptor.accessDeclaration?.key;
      const retirementKey = retireMarketAction.descriptor.accessDeclaration?.key;
      assert(readKey !== undefined && createKey !== undefined && retirementKey !== undefined);
      const answers: Record<string, TestGateAnswer> = {};
      // Script only the actual registered Market Actions, not a scope-wide or unrelated grant.
      for (const { descriptor } of getVerticalRuntimeActions(commerceMarketCatalogBackendRegistration)) {
        if (descriptor.actionKey === 'commerce.market-catalog.request-search-rebuild') {
          continue;
        }
        const key = descriptor.accessDeclaration?.key;
        assert(key !== undefined);
        answers[key] = { outcome: 'ALLOWED' };
      }
      answers[readKey] = { outcome: scenario.read };
      answers[createKey] = { outcome: scenario.create };
      answers[retirementKey] = { outcome: scenario.initial };
      const ports = inertAccessEnforcementPorts();
      const gate = makeTestBoundAccessGate({ answers, defaultAnswer: { outcome: 'DENIED' } }, ports);
      let ownerReads = 0;
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        applicationComposition,
        compositionRevision: snapshot.composition.revision,
        executeOwnerQuery: ({ params, scope, sql }) => {
          expect(scope).toEqual({ legalEntityId: sellerId, tenantId });
          expect(sql).toContain('read_market_administration_state');
          expect(params).toEqual([tenantId, sellerId, expect.objectContaining({ oid: 3802, value: { marketId } })]);
          ownerReads += 1;
          if ('afterOwner' in scenario) {
            if (scenario.afterOwner === 'MISSING') {
              Reflect.deleteProperty(answers, retirementKey);
            } else {
              answers[retirementKey] = { outcome: scenario.afterOwner };
            }
          }
          return Effect.succeed([
            { payload: { currentDefinitionRevisionId: definitionRevisionId, marketId, revision: 3 } },
          ]);
        },
        expectedDeployment,
        operationTime: yield* DateTime.nowAsDate,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: commerceMarketCatalogBackendRegistration,
        scope: { ...principal, correlationId },
      });
      const { decideMany } = gate.accessDecision;
      const readsAtAuthorityCheck: number[] = [];
      const authorityChecks = rstest.spyOn(gate.accessDecision, 'decideMany').mockImplementation((questions) => {
        const { statements } = harness.snapshot();
        expect(statements.filter((entry) => /^begin/iu.test(entry))).toHaveLength(
          statements.filter((entry) => /^(?:commit|rollback)/iu.test(entry)).length,
        );
        readsAtAuthorityCheck.push(ownerReads);
        expect(questions.every(({ carrier }) => carrier.accessDeclaration?.kind === 'action')).toBe(true);
        expect(questions.every(({ mode, scope }) => scope.legalEntityId === sellerId && mode === 'run')).toBe(true);
        return decideMany(questions);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => authorityChecks.mockRestore()));
      const issuer = 'https://shell.market-administration-http.test';
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
      const publicJwk = {
        ...(yield* Effect.promise(() => exportJWK(publicKey))),
        alg: 'EdDSA',
        kid: 'market-administration-http',
        use: 'sig',
      };
      const token = yield* Effect.promise(() =>
        new SignJWT({
          compositionRevision: snapshot.composition.revision,
          principal,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: 1,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience('commerce-market-catalog')
          .setSubject(principal.principalId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .setJti(randomUUID())
          .sign(privateKey),
      );
      let redemptions = 0;
      const searchRuntime = yield* createCoreSearchQueryRuntime.pipe(
        Effect.provideService(CoreSearchProjectionStore, makeInMemoryCoreSearchProjectionStore()),
      );
      // This administration Read shares its exact case database, enrollment, resolver and
      // admission gate with the real owner approval constructor. The inert scripted ports
      // refuse any attempt to use this Read-only fixture as an approval authority.
      const ownerContext = yield* Layer.build(
        makeOwnerActionApprovalsLive(expectedDeployment, commerceMarketCatalogBackendRegistration).pipe(
          Layer.provide(
            Layer.mergeAll(
              harness.ownerServices,
              Layer.succeed(ActiveApplicationCompositionService, applicationComposition),
              Layer.succeed(AccessDecisionGate, gate.accessDecision),
              Layer.succeed(AccessDecisionLog, ports.decisionLog),
              Layer.succeed(AccessIntent, ports.intent),
              Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
              Layer.succeed(DecisionCheck, ports.check),
              Layer.succeed(LegalEntityCandidates, ports.candidates),
            ),
          ),
        ),
      );
      const runtime = yield* commerceMarketCatalogApiRuntimeFromContext.pipe(
        Effect.provideService(ReadRuntime, harness.runtime),
        Effect.provideService(MarketRetirementRuntimeBindings, {
          base: unusedActionRuntime,
          coreFactory: Layer.succeed(ActionRuntime, unusedActionRuntime),
          crypto: yield* Crypto.Crypto,
          readRuntime: harness.runtime,
          scopeResolver: { resolve: () => Effect.die('An administration Read must not resolve an Action scope') },
        }),
        Effect.provideService(OwnerActionApprovals, Context.get(ownerContext, OwnerActionApprovals)),
        Effect.provideService(AccessDecisionGate, gate.accessDecision),
        Effect.provideService(CoreSearchQueryRuntime, searchRuntime),
        Effect.provideService(GatewayAssertionRedemptionService, {
          consume: () =>
            Effect.sync(() => {
              redemptions += 1;
            }),
        }),
      );
      const configuration = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${sourceAddress.port}/composition`,
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      );
      const configured = defineEffectBff({
        api: runtime.api,
        layer: runtime.layer.pipe(Layer.provide(configuration)),
      });
      const handler = yield* Effect.acquireRelease(
        Effect.promise(() => resolveEffectBffModuleHandler({ default: configured }, {})).pipe(
          Effect.flatMap((resource) =>
            resource === null ? Effect.die('The actual owner HTTP runtime must resolve') : Effect.succeed(resource),
          ),
        ),
        (resource) =>
          resource.dispose === undefined ? Effect.void : Effect.promise(resource.dispose).pipe(Effect.orDie),
      );
      const dispatchErrors: string[] = [];
      const response = yield* Effect.promise(() =>
        dispatchEffectBffRequest(
          handler.handler,
          new Request(`http://localhost${commerceMarketCatalogApiContract.apiPrefix}/reads/market-administration`, {
            body: JSON.stringify({ marketRef }),
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'x-correlation-id': correlationId,
            },
            method: 'POST',
          }),
          {
            onError: (error) => {
              dispatchErrors.push(Predicate.isError(error) ? (error.stack ?? error.message) : String(error));
              return new Response('Unexpected test dispatcher failure', { status: 500 });
            },
            prefix: commerceMarketCatalogApiContract.apiPrefix,
          },
        ),
      );
      const body = yield* Effect.promise(() => response.text());
      expect(dispatchErrors, body).toEqual([]);
      expect(response.status, JSON.stringify({ body, snapshot: harness.snapshot() })).toBe(scenario.status);
      expect(redemptions).toBe(1);
      expect(compositionReads).toBeGreaterThan(0);
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body);
      const reachesOwner = scenario.read === 'ALLOWED' && scenario.initial !== 'UNAVAILABLE';
      expect(ownerReads).toBe(reachesOwner ? 1 : 0);
      let expectedAuthorityChecks: number[] = [];
      if (scenario.read !== 'DENIED') {
        expectedAuthorityChecks = reachesOwner ? [0, 1] : [0];
      }
      expect(readsAtAuthorityCheck).toEqual(expectedAuthorityChecks);
      expect(gate.accessDecision.askedDecisions.some(({ carrier }) => carrier.accessDeclaration?.key === readKey)).toBe(
        true,
      );
      if (scenario.status === 200) {
        const result = yield* Schema.decodeUnknownEffect(MarketAdministrationResponseSchema)(payload);
        expect(result.canCreateMarket).toBe(scenario.create === 'ALLOWED');
        expect(result.market).toEqual({
          canAdminister: scenario.initial === 'ALLOWED' && !('afterOwner' in scenario),
          currentDefinitionRevisionRef: {
            moduleId: 'commerce.market-catalog',
            resourceId: definitionRevisionId,
            resourceType: 'commerce.market-catalog.market-definition-revision',
            tenantId,
          },
          marketRef,
          revision: 3,
        });
      } else {
        expect(payload).toMatchObject({ status: scenario.status });
        expect(payload).not.toHaveProperty('market');
        expect(JSON.stringify(payload)).not.toContain(marketId);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}
