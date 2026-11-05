/**
 * O80/O85 contract parity for the Customer-owned Market retirement reservation Action: the published
 * `ReserveMarketRetirementApi` declares the same `202`/`200` success alternatives as the generated
 * endpoint, so the browser-safe published client decodes a parked proposal and an executed result on
 * distinct success channels. Ordinary execution never proposes implicitly — the closed `propose`
 * intent is the only way a caller can ask for the `202`.
 *
 * The proof runs against a real `HttpRouter` serving the published endpoint shape, so both statuses
 * travel through Effect's HTTP status alternatives instead of a stubbed body.
 */
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Context, Effect, Equal, Layer, Predicate, Schema } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

import {
  ReserveMarketRetirementApi,
  ReserveMarketRetirementPayloadSchema,
  ReserveMarketRetirementResultSchema,
} from '../../src/apis/reserve-market-retirement.ts';
import { executeReserveMarketRetirementWithAuthorization } from '../../src/api/reserve-market-retirement-client.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const marketRef = {
  moduleId: 'commerce.market-catalog' as const,
  resourceId: 'cz-launch',
  resourceType: 'commerce.market-catalog.market' as const,
  tenantId,
};
const reservePayload = Schema.decodeSync(ReserveMarketRetirementPayloadSchema)({
  assessmentDigest: 'b'.repeat(64),
  evaluatedAt: '2026-09-22T10:00:00.000Z',
  marketRef,
  marketRevision: 7,
  operation: 'RESERVE',
  reason: 'Retire Market',
  sourceEvidence: [
    {
      completenessEvidence: {
        nextApplicabilityBoundary: '2026-09-23T00:00:00.000Z',
        observedAt: '2026-09-22T09:59:59.000Z',
        ownerRevision: 'customer-context:41',
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'market:cz-launch:affected-use' },
      },
      currentness: 'CURRENT' as const,
      digest: 'a'.repeat(64),
      generation: 'customer-context-generation-19',
      ownerRevision: 'customer-context:41',
      sourceId: 'customer-commerce-policy',
    },
  ],
  tenantId,
});
const executedResult = Schema.decodeSync(ReserveMarketRetirementResultSchema)({
  assessmentDigest: 'b'.repeat(64),
  lifecycle: 'RESERVED',
  marketRef,
  marketRevision: 7,
  reservationToken: '11111111-1111-4111-8111-111111111111',
  reservationVersion: 7,
  tenantId,
});
const parkedProposal = Schema.decodeSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-04T12:00:00.000Z',
  proposalId: '10000000-0000-4000-8000-000000000001',
});

interface FixtureRequest {
  readonly intent: string | null;
  readonly status: number;
}

/**
 * Serves the published success alternatives: the `propose` intent parks a proposal (`202`), and
 * everything else executes the reservation (`200`).
 */
const withFixtureServer = <Value, Failure>(
  serve: (serverFetch: typeof fetch, requests: readonly FixtureRequest[]) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value> =>
  Effect.scoped(
    Effect.gen(function* fixtureServer() {
      const requests: FixtureRequest[] = [];
      const handlers = HttpApiBuilder.group(ReserveMarketRetirementApi, 'reserveMarketRetirement', (group) =>
        group.handle('execute', ({ request }) => {
          const intent = request.headers['x-action-intent'] ?? null;
          return Effect.succeed(intent === 'propose' ? parkedProposal : executedResult);
        }),
      );
      const router = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(ReserveMarketRetirementApi).pipe(
              Layer.provide(handlers),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      // `toWebHandler` already answers a `Promise<Response>`, so the client's own fetch seam can point
      // at the real router without a stubbed body.
      const routerFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        return router.handler(request, Context.empty()).then((response) => {
          requests.push({ intent: request.headers.get('x-action-intent'), status: response.status });
          return response;
        });
      };
      return yield* serve(routerFetch, requests);
    }),
  ).pipe(Effect.orDie);

const baseOptions = {
  baseUrl: 'https://fixture.ontos.test',
  compositionRevision: 'fixture-revision',
  idempotencyKey: 'fixture-idempotency-key',
} as const;

const execute = (serverFetch: typeof fetch, intent?: 'propose') =>
  executeReserveMarketRetirementWithAuthorization(
    reservePayload,
    'Bearer fixture-assertion',
    'fixture-correlation',
    intent === undefined ? baseOptions : { ...baseOptions, intent },
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, serverFetch));

it.effect('decodes the ordinary 200 reservation result and sends no intent when none is asked for', () =>
  withFixtureServer((serverFetch, requests) =>
    Effect.gen(function* ordinaryRun() {
      const outcome = yield* execute(serverFetch);

      expect(requests).toEqual([{ intent: null, status: 200 }]);
      expect(Equal.equals(outcome, executedResult)).toBe(true);
    }),
  ),
);

it.effect('decodes the declared 202 parked proposal when the closed propose intent is explicit', () =>
  withFixtureServer((serverFetch, requests) =>
    Effect.gen(function* proposeIntent() {
      const outcome = yield* execute(serverFetch, 'propose');

      expect(requests).toEqual([{ intent: 'propose', status: 202 }]);
      expect(Equal.equals(outcome, parkedProposal)).toBe(true);
    }),
  ),
);

it.effect('fails closed on an intent outside the closed literal without sending a request', () =>
  withFixtureServer((serverFetch, requests) =>
    Effect.gen(function* unsupportedIntent() {
      const outcome = yield* Effect.flip(
        // @ts-expect-error -- a JavaScript caller (or an untyped transport option) can supply any string, so
        // the runtime must refuse an intent outside the closed literal instead of transporting it.
        execute(serverFetch, 'approve'),
      );

      expect(Predicate.isTagged(outcome, 'SchemaError')).toBe(true);
      expect(requests).toEqual([]);
    }),
  ),
);
