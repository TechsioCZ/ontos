import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import type { issueDocumentGatewayContexts as IssueDocumentGatewayContexts } from '../../../src/api/auth-client.ts';
import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';

const { issueDocumentGatewayContexts } = rstest.hoisted(() => ({
  issueDocumentGatewayContexts: rstest.fn<typeof IssueDocumentGatewayContexts>(),
}));
rstest.mock('../../../src/api/auth-client.ts', () => ({ issueDocumentGatewayContexts }));

const revision = 'a'.repeat(64);
const audience = 'reauthorization-fixture';
const base = `/shell-super-app-api/module-api/${audience}/build/fixture`;
const platformFetch = rstest.fn<typeof globalThis.fetch>();
const originalFetch = globalThis.fetch;
const GatewayAnswerJson = Schema.fromJsonString(Schema.Struct({ token: Schema.String }));

/** Tokens the owner refuses, as it does a redeemed, expired or retired one. Every token it accepts is redeemed. */
let refused = new Set<string>();
/** As for a release the owner no longer serves: every token is refused. */
let refuseAll = false;
let issued = 0;
let presented: string[] = [];

/** A single-use owner behind the Shell relay, and the Shell's single issuer. */
const owner = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const { url } = new Request(input, init);
  if (url.endsWith('/auth/gateway-context')) {
    issued += 1;
    return Response.json({
      apiBaseUrl: base,
      compositionRevision: revision,
      expiresAt: 4_102_444_800,
      token: `t${issued}`,
    });
  }
  const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /u, '');
  presented.push(token);
  if (refuseAll || refused.has(token)) {
    return Response.json(
      { title: 'Authentication required' },
      { headers: { 'www-authenticate': 'Bearer' }, status: 401 },
    );
  }
  refused.add(token);
  return Response.json({ value: 'ok' });
};

/** What a remote does: one assertion from the Shell, then one owner call with it. */
const issue = Effect.promise(async () => {
  const response = await globalThis.fetch('/shell-super-app-api/auth/gateway-context', {
    body: JSON.stringify({ audience, compositionRevision: revision }),
    method: 'POST',
  });
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
  globalThis.fetch = platformFetch;
  installBrowserRequestCache();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(async () => {
  refused = new Set();
  refuseAll = false;
  issued = 0;
  presented = [];
  platformFetch.mockReset();
  platformFetch.mockImplementation(owner);
  issueDocumentGatewayContexts.mockReturnValue(Effect.succeed({ assertions: [] }));
  await browserRuntime.runPromise(
    clearBrowserRequestCache.pipe(Effect.andThen(pinDocumentCompositionRevision(revision))),
  );
});

it.live('sends a refused read once more with a fresh assertion, and every caller joined to it gets that answer', () =>
  Effect.gen(function* cachedRead() {
    const token = yield* issue;
    refused.add(token);
    const answers = yield* Effect.forEach([1, 2], () => call('/reads/orders', token), { concurrency: 'unbounded' });
    expect(answers).toEqual([ok, ok]);
    // One physical read was refused and one was renewed for everybody joined to it.
    expect(presented).toEqual(['t1', 't2']);
    expect(issued).toBe(2);
  }),
);

const refusedOnce = (path: string, init: RequestInit) =>
  Effect.gen(function* uncachedRead() {
    const token = yield* issue;
    refused.add(token);
    expect(yield* call(path, token, init)).toEqual(ok);
    expect(presented).toEqual(['t1', 't2']);
  });

it.live('sends a refused no-store read once more with a fresh assertion', () =>
  refusedOnce('/reads/orders', { cache: 'no-store' }),
);

it.live('sends a refused search read once more with a fresh assertion', () => refusedOnce('/search/orders', {}));

it.live('answers a second refusal as it is, without asking again', () =>
  Effect.gen(function* refusedTwice() {
    const token = yield* issue;
    refuseAll = true;
    for (const init of [{}, { cache: 'no-store' }] as const) {
      presented = [];
      const answer = yield* call('/reads/orders', token, init);
      expect(answer.status).toBe(401);
      expect(presented).toHaveLength(2);
    }
  }),
);

it.live('never sends a write twice, even when its assertion is refused', () =>
  Effect.gen(function* refusedWrite() {
    const token = yield* issue;
    refused.add(token);
    expect((yield* call('/commands/change', token)).status).toBe(401);
    expect(presented).toEqual(['t1']);
    expect(issued).toBe(1);
  }),
);

/** The owner's refusal arrives only after the context the read was sent in has ended. */
const refusedAfterBoundary = (init: RequestInit) =>
  Effect.gen(function* boundary() {
    const token = yield* issue;
    const answer = yield* Deferred.make<Response>();
    platformFetch.mockImplementationOnce(async () => await browserRuntime.runPromise(Deferred.await(answer)));
    const reading = yield* call('/reads/ended', token, init).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.sleep('20 millis');
    yield* clearBrowserRequestCache;
    yield* Deferred.succeed(answer, Response.json({ title: 'Authentication required' }, { status: 401 }));
    const exit = yield* Fiber.await(reading);
    expect(platformFetch).toHaveBeenCalledTimes(2);
    expect(issued).toBe(1);
    return exit;
  });

it.live('renews nothing for a shared read refused after its context ended, and rejects its callers', () =>
  refusedAfterBoundary({}).pipe(Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true))),
);

it.live('renews nothing for a no-store read refused after its context ended, and keeps the refusal', () =>
  refusedAfterBoundary({ cache: 'no-store' }).pipe(
    Effect.map((exit) => expect(Exit.isSuccess(exit) ? exit.value.status : 'rejected').toBe(401)),
  ),
);
