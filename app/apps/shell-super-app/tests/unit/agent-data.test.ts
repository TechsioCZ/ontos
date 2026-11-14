import { AGENT_ACCESS_PATHS } from '@app/shared-contracts/agent-access';
import { Clock, Effect, Fiber } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
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

it.effect('recovers a quickly refused agent list soon, then a second later, with no user refresh', () =>
  Effect.gen(function* retryAgentList() {
    const attempts: number[] = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* respondToAgentRead() {
        expect(request.method).toBe('POST');
        expect(request.url).toBe(AGENT_ACCESS_PATHS.list);
        attempts.push(yield* Clock.currentTimeMillis);
        return HttpClientResponse.fromWeb(
          request,
          attempts.length < 3 ? Response.json({}, { status: 503 }) : Response.json(overview),
        );
      }),
    );
    const read = loadAgentEntitiesWithRetry.pipe(Effect.provideService(HttpClient.HttpClient, client));
    const result = yield* read.pipe(Effect.forkChild);
    yield* TestClock.adjust('2 seconds');
    expect(yield* Fiber.join(result)).toEqual(overview);
    expect(attempts.map((time) => time - (attempts[0] ?? 0))).toEqual([0, 250, 1250]);
  }),
);

it.effect('stops after two automatic retries so persistent failures offer the accessible error fallback soon', () =>
  Effect.gen(function* exhaustedAgentRetries() {
    let attempts = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        return HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }));
      }),
    );
    const read = yield* loadAgentEntitiesWithRetry.pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust('2 seconds');
    expect((yield* Fiber.join(read)).reason).toBe('error');
    expect(attempts).toBe(3);
  }),
);

const slowFailures: readonly (readonly [string, Effect.Effect<Response>])[] = [
  ['a timed-out', Effect.never],
  ['a slowly refused', Effect.sleep('6 seconds').pipe(Effect.as(Response.json({}, { status: 503 })))],
];

for (const [failure, answer] of slowFailures) {
  it.effect(`does not ask again after ${failure} agent-list read`, () =>
    Effect.gen(function* slowAgentFailure() {
      let attempts = 0;
      const client = HttpClient.make((request) =>
        Effect.suspend(() => {
          attempts += 1;
          return answer.pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)));
        }),
      );
      const read = yield* loadAgentEntitiesWithRetry.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
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
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          attempts += 1;
          return HttpClientResponse.fromWeb(request, Response.json({ detail: 'Přístup není dostupný.' }, { status }));
        }),
      );
      const failure = yield* loadAgentEntitiesWithRetry.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      requested.push(new Request(input).url);
      return Response.json(overview);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        globalThis.fetch = originalFetch;
      }),
    );
    yield* warmAgentEntities();
    expect(requested).toEqual([]);
    yield* warmAgentEntities('71000000-0000-4000-8000-000000000022');
    yield* Effect.sleep('50 millis');
    expect(requested).toHaveLength(1);
    expect(requested[0]?.endsWith(AGENT_ACCESS_PATHS.list)).toBe(true);
    yield* Effect.sync(() => agentEntitiesData.invalidate());
  }).pipe(Effect.scoped),
);
