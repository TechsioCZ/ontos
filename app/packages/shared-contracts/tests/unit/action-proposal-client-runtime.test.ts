/**
 * O80/O85: the shared governed BFF runtime is the only place a generated browser client can ask for a
 * parked proposal. The intent is a closed literal, its absence sends no header at all, and the 202 the
 * endpoint declares decodes on the client's own success channel.
 *
 * The proof runs against a real `HttpRouter` serving the endpoint shape Codesmith emits
 * (`success: [ActionProposalAcceptedSchema, ResultSchema]`), so the 202 and the ordinary 200 travel
 * through Effect's HTTP status alternatives instead of a stubbed fetch.
 */
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { ActionIntent } from '@app/shared-contracts/client-runtime';
import { Context, Effect, Equal, Layer, Predicate, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

const ACTION_PATH = '/fixture-api/actions/create-hold';

const ProposalConflictSchema = Schema.TaggedStruct('ProposalConflict', {
  detail: Schema.String,
  status: Schema.Literal(409),
  title: Schema.String,
  type: Schema.String,
}).pipe(HttpApiSchema.asJson({ contentType: 'application/problem+json' }), HttpApiSchema.status(409));

const ContractResultSchema = Schema.Struct({ value: Schema.String });

/** The exact success shape the Action HTTP generator emits for a proposable, non-ephemeral Action. */
const ActionProposalClientFixtureApi = HttpApi.make('ActionProposalClientFixture').add(
  HttpApiGroup.make('createHoldAction').add(
    HttpApiEndpoint.post('execute', ACTION_PATH, {
      error: ProposalConflictSchema,
      payload: Schema.Struct({ amount: Schema.Finite }),
      success: [ActionProposalAcceptedSchema, ContractResultSchema],
    }),
  ),
);

const proposalWire = {
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-04T12:00:00.000Z',
  proposalId: '10000000-0000-4000-8000-000000000001',
} as const;

const proposalAccepted = Schema.decodeSync(ActionProposalAcceptedSchema)(proposalWire);

const proposalConflict = {
  _tag: 'ProposalConflict' as const,
  detail: 'The fixture command was refused.',
  status: 409 as const,
  title: 'Proposal conflict',
  type: 'urn:ontos:test:proposal-conflict',
};

interface FixtureRequest {
  readonly intent: string | null;
  readonly status: number;
}

/**
 * Serves the declared success alternatives: the `propose` intent parks a proposal (202), a conflict
 * payload refuses with Problem Details (409), and everything else runs (200).
 */
const withFixtureServer = <Value, Failure>(
  serve: (serverFetch: typeof fetch, requests: readonly FixtureRequest[]) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value> =>
  Effect.scoped(
    Effect.gen(function* fixtureServer() {
      const requests: FixtureRequest[] = [];
      const handlers = HttpApiBuilder.group(ActionProposalClientFixtureApi, 'createHoldAction', (group) =>
        group.handle('execute', ({ payload, request }) => {
          const intent = request.headers['x-action-intent'] ?? null;
          requests.push({ intent, status: intent === 'propose' ? 202 : 200 });
          if (intent === 'propose') {
            return Effect.succeed(proposalAccepted);
          }
          if (payload.amount === 409) {
            return Effect.fail(proposalConflict);
          }
          return Effect.succeed({ value: 'ran' });
        }),
      );
      const router = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(ActionProposalClientFixtureApi).pipe(
              Layer.provide(handlers),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      // `toWebHandler` already answers a Promise<Response>, so the client's own fetch seam can point at
      // the real router without a stubbed body.
      const routerFetch: typeof fetch = (input, init) => router.handler(new Request(input, init), Context.empty());
      return yield* serve(routerFetch, requests);
    }),
  ).pipe(Effect.orDie);

const makeClient = (serverFetch: typeof fetch, intent?: ActionIntent) =>
  makeGovernedEffectBffClient(
    {
      api: ActionProposalClientFixtureApi,
      credential: Redacted.make('Bearer fixture-assertion'),
      defaultApiPrefix: 'https://fixture.ontos.test',
      idempotencyKey: 'fixture-idempotency-key',
      intent,
      requestCorrelation: 'fixture-correlation',
    },
    { compositionRevision: 'fixture-revision' },
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, serverFetch));

const execute = (serverFetch: typeof fetch, intent?: ActionIntent) =>
  makeClient(serverFetch, intent).pipe(
    Effect.flatMap((client) => client.createHoldAction.execute({ payload: { amount: 1 } })),
  );

it.effect('transports an explicit proposal intent and decodes the declared 202 on the success channel', () =>
  withFixtureServer((serverFetch, requests) =>
    Effect.gen(function* proposeIntent() {
      const outcome = yield* execute(serverFetch, 'propose');

      expect(requests.map(({ intent }) => intent)).toEqual(['propose']);
      expect(requests.map(({ status }) => status)).toEqual([202]);
      expect(Equal.equals(outcome, proposalAccepted)).toBe(true);
    }),
  ),
);

it.effect('sends no intent header and decodes the ordinary 200 result when no intent is asked for', () =>
  withFixtureServer((serverFetch, requests) =>
    Effect.gen(function* ordinaryRun() {
      const outcome = yield* execute(serverFetch);

      expect(requests.map(({ intent }) => intent)).toEqual([null]);
      expect(requests.map(({ status }) => status)).toEqual([200]);
      expect(outcome).toEqual({ value: 'ran' });
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

it.effect('keeps declared Problem Details failures in the typed error channel beside the 202 alternative', () =>
  withFixtureServer((serverFetch) =>
    Effect.gen(function* declaredConflict() {
      const outcome = yield* Effect.flip(
        makeClient(serverFetch).pipe(
          Effect.flatMap((client) => client.createHoldAction.execute({ payload: { amount: 409 } })),
        ),
      );

      expect(Schema.is(ProposalConflictSchema)(outcome)).toBe(true);
    }),
  ),
);

it.effect('preserves credential, correlation, idempotency and composition transport headers', () =>
  withFixtureServer((serverFetch, requests) =>
    Effect.gen(function* transportHeaders() {
      const captured: Request[] = [];
      const recordingFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        captured.push(request);
        return serverFetch(request);
      };

      yield* execute(recordingFetch, 'propose');

      const [request] = captured;
      expect(request).toBeDefined();
      if (request === undefined) {
        throw new Error('Expected a captured request');
      }
      expect(request.headers.get('authorization')).toBe('Bearer fixture-assertion');
      expect(request.headers.get('x-correlation-id')).toBe('fixture-correlation');
      expect(request.headers.get('idempotency-key')).toBe('fixture-idempotency-key');
      expect(request.headers.get('x-ontos-composition-revision')).toBe('fixture-revision');
      // Only the explicit intent is added: no tracer-generated trace headers appear beside it.
      expect(request.headers.get('x-action-intent')).toBe('propose');
      expect(request.headers.has('traceparent')).toBe(false);
      expect(requests.map(({ intent }) => intent)).toEqual(['propose']);
    }),
  ),
);
