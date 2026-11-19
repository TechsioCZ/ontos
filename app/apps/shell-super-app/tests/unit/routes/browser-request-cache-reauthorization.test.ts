// @rstest-environment happy-dom
import { networkIdle, networkQuietExcept } from '@app/shared-contracts/testing/http-double';
import { HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { beforeAll, expect, it } from 'effect-rstest';

import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import { makeBrowserCacheNetwork } from '../../support/browser-cache-network.ts';

const revision = 'a'.repeat(64);
const fixture = makeBrowserCacheNetwork('reauthorization-fixture', revision);
const { base } = fixture;
const GatewayAnswerJson = Schema.fromJsonString(Schema.Struct({ token: Schema.String }));
let refused = new Set<string>();
let refuseAll = false;
const presented: string[] = [];
const setup = Effect.gen(function* setupOwner() {
  refused = new Set();
  refuseAll = false;
  presented.length = 0;
  yield* fixture.reset(false);
  fixture.answerWith(({ authorization }) => {
    const token = (authorization ?? '').replace(/^Bearer /u, '');
    presented.push(token);
    if (refuseAll || refused.has(token)) {
      return HttpServerResponse.jsonUnsafe(
        { title: 'Authentication required' },
        {
          headers: { 'www-authenticate': 'Bearer' },
          status: 401,
        },
      );
    }
    refused.add(token);
    return HttpServerResponse.jsonUnsafe({ value: 'ok' });
  });
});

/** What a remote does: one assertion from the Shell, then one owner call with it. */
const issue = Effect.promise(async () => {
  const response = await fixture.gatewayRequest();
  return Schema.decodeUnknownSync(GatewayAnswerJson)(await response.text()).token;
});

const call = (path: string, token: string, init: RequestInit = {}) =>
  Effect.promise(async () => {
    const response = await globalThis.fetch(`${base}${path}`, {
      body: '{}',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'POST',
      ...init,
    });
    return { body: await response.text(), status: response.status };
  });

const ok = { body: JSON.stringify({ value: 'ok' }), status: 200 };

beforeAll(() => {
  installBrowserRequestCache();
});

it.live('Authorization survives new Request with new Headers in the browser test environment', () =>
  Effect.sync(() => {
    const request = new Request('http://shell.test/reads/environment', {
      headers: new Headers({ authorization: 'Bearer environment-token' }),
    });
    expect(request.headers.get('authorization')).toBe('Bearer environment-token');
    expect(Headers).toBe(window.Headers);
    expect(Request).toBe(window.Request);
    expect(Response).toBe(window.Response);
  }),
);

it.live('sends a refused read once more with a fresh assertion, and every caller joined to it gets that answer', () =>
  setup.pipe(
    Effect.andThen(
      Effect.gen(function* cachedRead() {
        const token = yield* issue;
        refused.add(token);
        const answers = yield* Effect.forEach([1, 2], () => call('/reads/orders', token), { concurrency: 'unbounded' });
        expect(answers).toEqual([ok, ok]);
        // One physical read was refused and one was renewed for everybody joined to it.
        yield* networkIdle;
        expect(presented).toEqual(['t1', 't2']);
        expect(fixture.singles.length).toBe(2);
      }),
    ),
    Effect.provide(fixture.network),
  ),
);

const refusedOnce = (path: string, init: RequestInit) =>
  Effect.gen(function* uncachedRead() {
    const token = yield* issue;
    refused.add(token);
    expect(yield* call(path, token, init)).toEqual(ok);
    yield* networkIdle;
    expect(presented).toEqual(['t1', 't2']);
  });

it.live('sends a refused no-store read once more with a fresh assertion', () =>
  setup.pipe(Effect.andThen(refusedOnce('/reads/orders', { cache: 'no-store' })), Effect.provide(fixture.network)),
);

it.live('sends a refused search read once more with a fresh assertion', () =>
  setup.pipe(Effect.andThen(refusedOnce('/search/orders', {})), Effect.provide(fixture.network)),
);

it.live('answers a second refusal as it is, without asking again', () =>
  setup.pipe(
    Effect.andThen(
      Effect.gen(function* refusedTwice() {
        const token = yield* issue;
        refuseAll = true;
        for (const init of [{}, { cache: 'no-store' }] as const) {
          presented.length = 0;
          const answer = yield* call('/reads/orders', token, init);
          expect(answer.status).toBe(401);
          yield* networkIdle;
          expect(presented).toHaveLength(2);
        }
      }),
    ),
    Effect.provide(fixture.network),
  ),
);

it.live('never sends a write twice, even when its assertion is refused', () =>
  setup.pipe(
    Effect.andThen(
      Effect.gen(function* refusedWrite() {
        const token = yield* issue;
        refused.add(token);
        expect((yield* call('/commands/change', token)).status).toBe(401);
        yield* networkIdle;
        expect(presented).toEqual(['t1']);
        expect(fixture.singles.length).toBe(1);
      }),
    ),
    Effect.provide(fixture.network),
  ),
);

/** The owner's refusal arrives only after the context the read was sent in has ended. */
const refusedAfterBoundary = (init: RequestInit) =>
  Effect.gen(function* boundary() {
    const token = yield* issue;
    const answer = yield* fixture.hold('/reads/ended');
    const reading = yield* call('/reads/ended', token, init).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(answer.entered);
    yield* networkQuietExcept(1);
    yield* clearBrowserRequestCache;
    yield* Deferred.succeed(
      answer.release,
      HttpServerResponse.jsonUnsafe({ title: 'Authentication required' }, { status: 401 }),
    );
    const exit = yield* Fiber.await(reading);
    yield* networkIdle;
    expect(fixture.count).toBe(2);
    expect(fixture.singles.length).toBe(1);
    return exit;
  });

it.live('renews nothing for a shared read refused after its context ended, and rejects its callers', () =>
  setup.pipe(
    Effect.andThen(refusedAfterBoundary({})),
    Effect.provide(fixture.network),
    Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
  ),
);

it.live('renews nothing for a no-store read refused after its context ended, and keeps the refusal', () =>
  setup.pipe(
    Effect.andThen(refusedAfterBoundary({ cache: 'no-store' })),
    Effect.provide(fixture.network),
    Effect.map((exit) => expect(Exit.isSuccess(exit) ? exit.value.status : 'rejected').toBe(401)),
  ),
);
