import { AGENT_ACCESS_PATHS } from '@app/shared-contracts/agent-access';
import { Clock, Effect, Fiber } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { loadAgentEntitiesWithRetry } from '../../src/routes/people/agent-data.ts';

const overview = {
  agents: [],
  audit: [],
  company: { legalEntityId: '71000000-0000-4000-8000-000000000022', legalName: 'Testovací firma' },
  members: [],
  modules: [],
  presets: [],
};

it.effect('automatically recovers an unavailable agent list with exponential backoff and no user refresh', () =>
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
    yield* TestClock.adjust('3 seconds');
    expect(yield* Fiber.join(result)).toEqual(overview);
    expect(attempts.map((time) => time - (attempts[0] ?? 0))).toEqual([0, 1000, 3000]);
  }),
);

it.effect('stops after three automatic retries so persistent failures can offer the accessible error fallback', () =>
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
    yield* TestClock.adjust('7 seconds');
    expect((yield* Fiber.join(read)).reason).toBe('error');
    expect(attempts).toBe(4);
  }),
);

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
