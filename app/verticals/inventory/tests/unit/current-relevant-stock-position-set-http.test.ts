import { randomUUID } from 'node:crypto';

import {
  ActionRuntime,
  GatewayAssertionRedemptionService,
  ReadHandlerUnavailable,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { executeCurrentRelevantStockPositionSetWithAuthorization } from '@app/inventory/api/client';
import { RequestSchemaProblemSchema } from '@app/shared-contracts/problem-details';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Effect, Layer, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makeInventoryApiRuntime } from '../../api/index.ts';
import {
  CurrentRelevantStockPositionSetApi,
  CurrentRelevantStockPositionSetAuthenticationProblemSchema,
  CurrentRelevantStockPositionSetForbiddenProblemSchema,
  CurrentRelevantStockPositionSetInternalProblemSchema,
  CurrentRelevantStockPositionSetInvalidProblemSchema,
  CurrentRelevantStockPositionSetNotFoundProblemSchema,
  CurrentRelevantStockPositionSetPolicyConflictProblemSchema,
  CurrentRelevantStockPositionSetPolicyProblemSchema,
  CurrentRelevantStockPositionSetUnavailableProblemSchema,
} from '../../shared/apis/current-relevant-stock-position-set.ts';
import { currentRelevantStockPositionSetRead } from '../../src/api/current-relevant-stock-position-set.read.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  observation,
  position,
  positionSetDriverRows,
  request,
  scope,
} from '../support/current-relevant-stock-position-set.ts';

const broadRequest = { mode: 'POTENTIALLY_RELEVANT_POSITIONS', scope: request.scope } as const;
const unusedActionRuntime: ActionRuntimeService = {
  resolveActionCommit: () => Effect.die('Action runtime is outside the Position-set Read proof'),
  runAction: () => Effect.die('Action runtime is outside the Position-set Read proof'),
};

const makeRegisteredPositionSetRuntime = Effect.fn('PositionSetTest.makeRegisteredRuntime')(
  function* makeRegisteredPositionSetRuntime(options: {
    readonly denyPosition?: boolean;
    readonly ownerUnavailable?: boolean;
    readonly positions: typeof observation.positions;
  }) {
    const composition = yield* makeApplicationCompositionSnapshotFixture(
      ['inventory'],
      ultramodernApiMarker.buildMarker,
    );
    const compositionDocument = yield* Schema.encodeEffect(
      Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
    )(composition);
    const issuer = 'https://shell.inventory-runtime.test';
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'inventory-position-set-runtime',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: composition.composition.revision,
        principal: {
          authBindingId: scope.authBindingId,
          authContextRef: scope.authContextRef,
          authMethod: scope.authMethod,
          legalEntityId: scope.legalEntityId,
          principalId: scope.principalId,
          tenantId: scope.tenantId,
          trustedStorefrontId: scope.trustedStorefrontId,
        },
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: 1,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('inventory')
        .setSubject(scope.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    const harness = yield* makeReadTestHarness({
      businessPermissionDecision: (target) =>
        options.denyPosition === true &&
        target.target.kind === 'inventory_resource' &&
        target.target.resource.resourceType === 'commerce.inventory.stock-position'
          ? 'denied'
          : 'allowed',
      compositionRevision: composition.composition.revision,
      executeOwnerQuery: (query) => {
        expect(query.sql).toContain('from "inventory"."stock_items"');
        expect(query.sql).toContain('statement_timestamp()');
        expect(query.scope).toEqual({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
        expect(query.params).toContain(request.scope.customerConfigurationId);
        expect(query.params).toContain(request.scope.stockItemRef.resourceId);
        expect(query.params).toContain(scope.tenantId);
        expect(query.params).not.toContain(position.stockPositionId);
        return options.ownerUnavailable === true
          ? Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'private scripted owner outage' }) }))
          : Effect.succeed(positionSetDriverRows(options.positions));
      },
      operationTime: observation.observedAt,
      ownerAuthorizationDecision: 'allowed',
      permissionDecision: 'allowed',
      scope,
    });
    let redemptions = 0;
    const serverConfiguration = Layer.mergeAll(
      Layer.succeed(ActionRuntime, unusedActionRuntime),
      Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(compositionDocument) }),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      ),
    );
    const assembled = makeInventoryApiRuntime(
      harness.layer,
      serverConfiguration,
      Layer.succeed(GatewayAssertionRedemptionService, {
        consume: (assertion) =>
          Effect.sync(() => {
            expect(assertion.audience).toBe('inventory');
            redemptions += 1;
          }),
      }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => assembled.createHandler()),
      (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
    );
    const statuses: number[] = [];
    const routerFetch: typeof fetch = (url, init) =>
      runtime.handler(new Request(url, init)).then((response) => {
        statuses.push(response.status);
        return response;
      });
    return {
      read: (payload: typeof broadRequest | typeof request) =>
        executeCurrentRelevantStockPositionSetWithAuthorization(payload, `Bearer ${token}`, 'registered-position-set', {
          baseUrl: 'https://inventory.example',
          compositionRevision: composition.composition.revision,
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, routerFetch)),
      snapshot: () => ({ ...harness.snapshot(), redemptions, statuses: [...statuses] }),
    };
  },
);

const problems = makeGovernedReadProblems({
  authentication: CurrentRelevantStockPositionSetAuthenticationProblemSchema,
  forbidden: CurrentRelevantStockPositionSetForbiddenProblemSchema,
  internal: CurrentRelevantStockPositionSetInternalProblemSchema,
  invalid: CurrentRelevantStockPositionSetInvalidProblemSchema,
  notFound: CurrentRelevantStockPositionSetNotFoundProblemSchema,
  policyConflict: CurrentRelevantStockPositionSetPolicyConflictProblemSchema,
  policyIneligible: CurrentRelevantStockPositionSetPolicyProblemSchema,
  unavailable: CurrentRelevantStockPositionSetUnavailableProblemSchema,
});

describe('Current relevant StockPosition set HTTP request contract', () => {
  it.live('registered runtime and published client return the real broader owner-complete candidate set', () =>
    Effect.gen(function* registeredBroaderSet() {
      const runtime = yield* makeRegisteredPositionSetRuntime({ positions: [position] });
      const result = yield* runtime.read(broadRequest);
      expect(result.outcome).toBe('COMPLETE');
      if (result.outcome === 'COMPLETE') {
        expect(result.positionRefs.map((ref) => ref.resourceId)).toEqual([position.stockPositionId]);
        expect(result.completeness.scope.kind).toBe('SAFELY_BROADER_SCOPE');
        expect(result.sharingEligibility).toBe('NOT_EVALUATED');
        expect(result.verificationRule).toBe('OWNER_REVALIDATION_REQUIRED_AT_EACH_USE');
      }
      expect(runtime.snapshot().statuses).toEqual([200]);
      expect(runtime.snapshot().redemptions).toBe(1);
      expect(runtime.snapshot().ownerQueries).toHaveLength(1);
      expect(runtime.snapshot().evidenceWrites).toBe(1);
      expect(runtime.snapshot().stages).toContain('evidence_persisted');
      expect(runtime.snapshot().statements.at(-1)).toBe('COMMIT');
    }),
  );

  it.live('registered runtime preserves proven empty broader membership', () =>
    Effect.gen(function* registeredOwnerEmpty() {
      const runtime = yield* makeRegisteredPositionSetRuntime({ positions: [] });
      const result = yield* runtime.read(broadRequest);
      expect(result.outcome).toBe('COMPLETE');
      if (result.outcome === 'COMPLETE') {
        expect(result.positionRefs).toEqual([]);
        expect(result.completeness.scope.kind).toBe('SAFELY_BROADER_SCOPE');
        expect(result.sharingEligibility).toBe('NOT_EVALUATED');
      }
      expect(runtime.snapshot().statuses).toEqual([200]);
      expect(runtime.snapshot().ownerQueries).toHaveLength(1);
      expect(runtime.snapshot().evidenceWrites).toBe(1);
    }),
  );

  it.live('registered runtime releases no complete set when a candidate Position is forbidden', () =>
    Effect.gen(function* registeredMemberDenied() {
      const runtime = yield* makeRegisteredPositionSetRuntime({ denyPosition: true, positions: [position] });
      const failure = yield* runtime.read(broadRequest).pipe(Effect.flip);
      expect(Schema.is(CurrentRelevantStockPositionSetForbiddenProblemSchema)(failure)).toBe(true);
      expect(runtime.snapshot().statuses).toEqual([403]);
      expect(runtime.snapshot().redemptions).toBe(1);
      expect(runtime.snapshot().ownerQueries).toHaveLength(1);
      expect(runtime.snapshot().stages).not.toContain('handler_executed');
      expect(runtime.snapshot().statements.some((statement) => statement.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(
        true,
      );
      expect(runtime.snapshot().evidenceWrites).toBe(1);
    }),
  );

  it.live('registered runtime maps unavailable owner observation to a sanitized typed 503 instead of empty', () =>
    Effect.gen(function* registeredOwnerUnavailable() {
      const runtime = yield* makeRegisteredPositionSetRuntime({ ownerUnavailable: true, positions: [position] });
      const failure = yield* runtime.read(broadRequest).pipe(Effect.flip);
      expect(Schema.is(CurrentRelevantStockPositionSetUnavailableProblemSchema)(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('private scripted owner outage');
      expect(runtime.snapshot().statuses).toEqual([503]);
      expect(runtime.snapshot().ownerQueries).toHaveLength(1);
      expect(runtime.snapshot().evidenceWrites).toBe(0);
      expect(runtime.snapshot().statements.at(-1)).toBe('ROLLBACK');
    }),
  );

  it.live('registered exact mode remains UNPROVEN without a composed Commerce verifier', () =>
    Effect.gen(function* registeredExactUnavailable() {
      const runtime = yield* makeRegisteredPositionSetRuntime({ positions: [position] });
      const result = yield* runtime.read(request);
      expect(result).toEqual({ outcome: 'UNPROVEN', reason: 'COMMERCE_CONTEXT_UNVERIFIABLE' });
      expect(runtime.snapshot().statuses).toEqual([200]);
      expect(runtime.snapshot().redemptions).toBe(1);
      expect(runtime.snapshot().ownerQueries).toEqual([]);
      expect(runtime.snapshot().evidenceWrites).toBe(1);
    }),
  );

  it.effect('real codec rejection is typed by the generated client before authentication or owner effects', () =>
    Effect.gen(function* malformedRequest() {
      let authenticationCalls = 0;
      let coreCalls = 0;
      const handler = makeGovernedReadHttpHandler({
        authenticatePrincipal: () => {
          authenticationCalls += 1;
          return Effect.succeed(scope);
        },
        problems,
        registration: currentRelevantStockPositionSetRead,
      });
      const handlers = HttpApiBuilder.group(
        CurrentRelevantStockPositionSetApi,
        'currentRelevantStockPositionSet',
        (routes) => routes.handle('execute', handler),
      );
      const unusedRuntimeService = {
        runRead: () => {
          coreCalls += 1;
          return Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'unused' }));
        },
      };
      const requestContext = Context.make(ReadRuntime, unusedRuntimeService);
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(CurrentRelevantStockPositionSetApi).pipe(
              Layer.provide(handlers),
              Layer.provideMerge(RequestSchemaProblemLive),
              Layer.provide(Layer.succeed(ReadRuntime, unusedRuntimeService)),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
      );
      const badPayload = { ...request, mode: 'secret-invalid-mode' };
      const direct = yield* Effect.promise(() =>
        server.handler(
          new Request('https://inventory.example/reads/current-relevant-stock-position-set', {
            body: JSON.stringify(badPayload),
            headers: { 'content-type': 'application/json', 'x-correlation-id': 'invalid-http-test' },
            method: 'POST',
          }),
          requestContext,
        ),
      );
      expect(direct.status).toBe(400);
      expect(direct.headers.get('content-type')).toContain('application/problem+json');
      const problem = yield* Effect.promise(() => direct.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RequestSchemaProblemSchema)),
      );
      expect(problem.paths).toContain('mode');
      expect(JSON.stringify(problem)).not.toContain('secret-invalid-mode');
      const routerFetch: typeof fetch = (url, init) =>
        server.handler(new Request(url, { ...init, body: JSON.stringify(badPayload) }), requestContext);
      const clientResult = yield* executeCurrentRelevantStockPositionSetWithAuthorization(
        request,
        'Bearer controlled',
        'http-test',
        { baseUrl: 'https://inventory.example' },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, routerFetch), Effect.result);
      expect(Result.isFailure(clientResult)).toBe(true);
      if (Result.isFailure(clientResult)) {
        expect(Schema.is(RequestSchemaProblemSchema)(clientResult.failure)).toBe(true);
      }
      expect(authenticationCalls).toBe(0);
      expect(coreCalls).toBe(0);
    }),
  );
});
