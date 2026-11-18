import {
  AgentDecideRequestSchema,
  AgentItemKeySchema,
  AgentRevertRequestSchema,
} from '@app/shared-contracts/agent-proposals';
import { inProcessFetch } from '@app/shared-contracts/testing/http-double';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Fiber, Schema, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  agentMutationIntent,
  agentMutationUncertain,
  decideAgentItems,
  revertAgentBatch,
} from '../../../src/routes/agent-platform/agent-platform-client.ts';

interface ReceivedMutation {
  readonly body: string;
  readonly idempotencyKey: string | null;
  readonly signal: AbortSignal;
  readonly url: URL;
}

const mutationEndpoint = (
  path: 'decide' | 'revert',
  answer: (attempt: number) => HttpServerResponse.HttpServerResponse,
) => {
  const received: ReceivedMutation[] = [];
  const layer = inProcessFetch(
    HttpRouter.add(
      'POST',
      `/shell-super-app-api/agent-platform/${path}`,
      Effect.gen(function* receiveMutation() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const body = yield* request.text;
        received.push({
          body,
          idempotencyKey: webRequest.headers.get('idempotency-key'),
          signal: webRequest.signal,
          url: new URL(webRequest.url),
        });
        return answer(received.length);
      }).pipe(Effect.orDie),
    ),
  );
  return { layer, received };
};

const decision = Schema.decodeUnknownSync(AgentDecideRequestSchema)({
  batchKey: 'core:batch',
  decision: 'approve',
  itemKeys: ['core:item'],
  note: 'Reviewed',
});

it.effect('retries a lost decision response with the same ingress key and exact original payload', () => {
  const endpoint = mutationEndpoint('decide', (attempt) =>
    attempt === 1
      ? HttpServerResponse.stream(Stream.fail(new Error('connection lost')))
      : HttpServerResponse.jsonUnsafe({ results: [] }),
  );
  return Effect.gen(function* retryDecision() {
    const itemKeys = [...decision.itemKeys];
    const payload = { ...decision, itemKeys };
    const intent = yield* agentMutationIntent(undefined, payload);
    payload.itemKeys.push(AgentItemKeySchema.make('core:changed-after-dispatch'));
    const first = yield* decideAgentItems(intent);
    expect(agentMutationUncertain(first)).toBe(true);
    expect(yield* agentMutationIntent(intent, { ...decision, itemKeys: [...decision.itemKeys] })).toBe(intent);
    expect((yield* decideAgentItems(intent)).status).toBe('ok');
    expect(endpoint.received).toHaveLength(2);
    expect(endpoint.received[0]?.body).toBe(JSON.stringify(decision));
    expect(endpoint.received[1]?.body).toBe(endpoint.received[0]?.body);
    for (const request of endpoint.received) {
      expect(request.url).toEqual(new URL('/shell-super-app-api/agent-platform/decide', location.href));
      expect(request.idempotencyKey).toBe(intent.idempotencyKey);
    }
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(endpoint.layer));
});

it.effect('retains a revert intent after an unreadable success body and retries with the same header', () => {
  const endpoint = mutationEndpoint('revert', (attempt) =>
    attempt === 1
      ? HttpServerResponse.text('not the expected response')
      : HttpServerResponse.jsonUnsafe({ message: 'Restored', outcome: 'reverted' }),
  );
  return Effect.gen(function* retryRevert() {
    const intent = yield* agentMutationIntent(
      undefined,
      Schema.decodeUnknownSync(AgentRevertRequestSchema)({ batchKey: 'core:batch', note: 'Restore' }),
    );
    expect(agentMutationUncertain(yield* revertAgentBatch(intent))).toBe(true);
    expect((yield* revertAgentBatch(intent)).status).toBe('ok');
    expect(endpoint.received).toHaveLength(2);
    expect(endpoint.received[1]?.url).toEqual(new URL('/shell-super-app-api/agent-platform/revert', location.href));
    expect(endpoint.received[1]?.body).toBe(endpoint.received[0]?.body);
    expect(endpoint.received[1]?.idempotencyKey).toBe(intent.idempotencyKey);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(endpoint.layer));
});

it.effect('treats a lost response stream as uncertain instead of rejecting outside the transport boundary', () => {
  const endpoint = mutationEndpoint('decide', () =>
    HttpServerResponse.stream(Stream.fail(new Error('response stream lost'))),
  );
  return Effect.gen(function* lostBody() {
    expect(agentMutationUncertain(yield* decideAgentItems(yield* agentMutationIntent(undefined, decision)))).toBe(true);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(endpoint.layer));
});

it.effect('creates a new ingress key only for a new or changed action intent', () =>
  Effect.gen(function* changedIntent() {
    const first = yield* agentMutationIntent(undefined, decision);
    expect(yield* agentMutationIntent(first, decision)).toBe(first);
    expect((yield* agentMutationIntent(first, { ...decision, note: 'Different' })).idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
    expect((yield* agentMutationIntent(undefined, decision)).idempotencyKey).not.toBe(first.idempotencyKey);
  }),
);

it('distinguishes uncertain transport/server outcomes from terminal rejections', () => {
  for (const httpStatus of [0, 408, 409, 425, 429, 500, 503]) {
    expect(agentMutationUncertain({ httpStatus, message: 'Failed', status: 'failed' })).toBe(true);
  }
  for (const httpStatus of [400, 401, 403, 404, 422, 428]) {
    expect(agentMutationUncertain({ httpStatus, message: 'Rejected', status: 'failed' })).toBe(false);
  }
  expect(agentMutationUncertain({ status: 'ok', value: {} })).toBe(false);
});

it.effect('aborts a stalled response body at the transport deadline and keeps the exact retry intent', () =>
  Effect.gen(function* bodyDeadline() {
    const reading = yield* Deferred.make<boolean>();
    const stalledBody = yield* Deferred.make<Uint8Array>();
    const endpoint = mutationEndpoint('decide', (attempt) =>
      attempt === 1
        ? HttpServerResponse.stream(
            Stream.fromEffect(Deferred.succeed(reading, true).pipe(Effect.andThen(Deferred.await(stalledBody)))),
          )
        : HttpServerResponse.jsonUnsafe({ results: [] }),
    );
    yield* Effect.gen(function* verifyDeadline() {
      const intent = yield* agentMutationIntent(undefined, decision);
      const pending = yield* decideAgentItems(intent).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      expect(endpoint.received[0]?.signal.aborted).toBe(false);
      yield* TestClock.adjust('30 seconds');
      expect(agentMutationUncertain(yield* Fiber.join(pending))).toBe(true);
      expect(endpoint.received[0]?.signal.aborted).toBe(true);
      yield* Deferred.succeed(stalledBody, new Uint8Array(0));
      expect((yield* decideAgentItems(intent)).status).toBe('ok');
      expect(endpoint.received).toHaveLength(2);
      expect(endpoint.received[1]?.body).toBe(endpoint.received[0]?.body);
      expect(endpoint.received[1]?.idempotencyKey).toBe(intent.idempotencyKey);
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(endpoint.layer));
  }),
);
