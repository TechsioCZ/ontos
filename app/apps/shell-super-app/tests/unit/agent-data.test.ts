// @rstest-environment happy-dom
import { AGENT_ACCESS_PATHS } from '@app/shared-contracts/agent-access';
import { browserNetwork, inProcessFetch } from '@app/shared-contracts/testing/http-double';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Clock, Deferred, Effect, Fiber } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  agentEntitiesData,
  loadAgentEntitiesWithRetry,
  warmAgentEntities,
} from '../../src/routes/people/agent-data.ts';

const overview = {
  agents: [],
  audit: [],
  company: { legalEntityId: '71000000-0000-4000-8000-000000000022', legalName: 'Testovací firma' },
  members: [],
  roles: [],
  rolesRevision: 'r0',
};

const agentEndpoint = (
  answer: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>,
) => HttpRouter.add('POST', AGENT_ACCESS_PATHS.list, answer);

it.effect('recovers a quickly refused agent list soon, then a second later, with no user refresh', () =>
  Effect.gen(function* retryAgentList() {
    const attempts: number[] = [];
    const clock = yield* Clock.Clock;
    const endpoint = agentEndpoint(
      Effect.gen(function* respondToAgentRead() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        expect(request.method).toBe('POST');
        expect(request.url).toBe(AGENT_ACCESS_PATHS.list);
        attempts.push(yield* Clock.currentTimeMillis);
        return attempts.length < 3
          ? HttpServerResponse.jsonUnsafe({}, { status: 503 })
          : HttpServerResponse.jsonUnsafe(overview);
      }).pipe(Effect.provideService(Clock.Clock, clock)),
    );
    const read = loadAgentEntitiesWithRetry.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(inProcessFetch(endpoint)),
    );
    const result = yield* read.pipe(Effect.forkChild);
    yield* TestClock.adjust('2 seconds');
    expect(yield* Fiber.join(result)).toEqual(overview);
    expect(attempts.map((time) => time - (attempts[0] ?? 0))).toEqual([0, 250, 1250]);
  }),
);

it.effect('stops after two automatic retries so persistent failures offer the accessible error fallback soon', () =>
  Effect.gen(function* exhaustedAgentRetries() {
    let attempts = 0;
    const endpoint = agentEndpoint(
      Effect.sync(() => {
        attempts += 1;
        return HttpServerResponse.jsonUnsafe({}, { status: 503 });
      }),
    );
    const read = yield* loadAgentEntitiesWithRetry.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(inProcessFetch(endpoint)),
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust('2 seconds');
    expect((yield* Fiber.join(read)).reason).toBe('error');
    expect(attempts).toBe(3);
  }),
);

const slowFailures: readonly (readonly [string, Effect.Effect<HttpServerResponse.HttpServerResponse>])[] = [
  ['a timed-out', Effect.never],
  ['a slowly refused', Effect.sleep('6 seconds').pipe(Effect.as(HttpServerResponse.jsonUnsafe({}, { status: 503 })))],
];

for (const [failure, answer] of slowFailures) {
  it.effect(`does not ask again after ${failure} agent-list read`, () =>
    Effect.gen(function* slowAgentFailure() {
      let attempts = 0;
      const clock = yield* Clock.Clock;
      const endpoint = agentEndpoint(
        Effect.suspend(() => {
          attempts += 1;
          return answer;
        }).pipe(Effect.provideService(Clock.Clock, clock)),
      );
      const read = yield* loadAgentEntitiesWithRetry.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(inProcessFetch(endpoint)),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('40 seconds');
      expect((yield* Fiber.join(read)).reason).toBe('error');
      expect(attempts).toBe(1);
    }),
  );
}

for (const [status, reason] of [
  [401, 'signedOut'],
  [403, 'forbidden'],
  [409, 'conflict'],
  [422, 'invalid'],
] as const) {
  it.effect(`does not retry a terminal ${status} agent-list response`, () =>
    Effect.gen(function* terminalAgentFailure() {
      let attempts = 0;
      const endpoint = agentEndpoint(
        Effect.sync(() => {
          attempts += 1;
          return HttpServerResponse.jsonUnsafe({ detail: 'Přístup není dostupný.' }, { status });
        }),
      );
      const failure = yield* loadAgentEntitiesWithRetry.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(inProcessFetch(endpoint)),
        Effect.flip,
      );
      expect(failure.reason).toBe(reason);
      expect(attempts).toBe(1);
    }),
  );
}

it.live('starts the selected company agent list when the People page loads, not when the tab is clicked', () =>
  Effect.gen(function* warmOnPageLoad() {
    const requested: string[] = [];
    const received = yield* Deferred.make<true>();
    const endpoint = agentEndpoint(
      Effect.gen(function* receiveWarmAgentList() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        requested.push(request.url);
        yield* Deferred.succeed(received, true);
        return HttpServerResponse.jsonUnsafe(overview);
      }),
    );
    yield* Effect.gen(function* verifyPageLoadWarmup() {
      yield* warmAgentEntities();
      expect(requested).toEqual([]);
      yield* warmAgentEntities('71000000-0000-4000-8000-000000000022');
      yield* Deferred.await(received);
      yield* agentEntitiesData.preload('71000000-0000-4000-8000-000000000022');
      expect(requested).toHaveLength(1);
      expect(requested[0]?.endsWith(AGENT_ACCESS_PATHS.list)).toBe(true);
      yield* Effect.sync(() => agentEntitiesData.invalidate());
    }).pipe(Effect.provide(browserNetwork(endpoint)));
  }).pipe(Effect.scoped),
);
