import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import {
  documentGatewayAssertion,
  resetDocumentGatewayAssertions,
  seedDocumentGatewayAssertions,
  warmDocumentGatewayAssertions,
} from '../../../src/routes/document-gateway-assertions.ts';

const { issueDocumentGatewayContextsMock } = rstest.hoisted(() => ({
  issueDocumentGatewayContextsMock: rstest.fn(),
}));

rstest.mock('../../../src/api/auth-client.ts', () => ({
  issueDocumentGatewayContexts: issueDocumentGatewayContextsMock,
}));

const revision = 'a'.repeat(64);
const otherRevision = 'b'.repeat(64);
/** Far beyond any test run: a fresh assertion. */
const FAR_EXPIRY = 4_102_444_800;
/** Long past: an assertion that must never be handed out again. */
const EXPIRED = 1;

const assertion = (audience: string, expiresAt = FAR_EXPIRY) => ({
  apiBaseUrl: `/shell-super-app-api/module-api/${audience}/build/${audience}-api`,
  audience,
  compositionRevision: revision,
  expiresAt,
  token: `token-${audience}-${expiresAt}`,
});

const withoutAudience = ({ audience: _audience, ...response }: ReturnType<typeof assertion>) => response;

const GatewayRequestBodySchema = Schema.fromJsonString(Schema.Struct({ audience: Schema.String }));

/** The platform fetch behind the Shell's wrapper: only requests the document assertions could not answer reach it. */
const platformFetch = rstest.fn<typeof globalThis.fetch>();
const originalFetch = globalThis.fetch;

const askAssertion = (body: Readonly<Record<string, string>>) =>
  Effect.promise(async () => {
    const response = await globalThis.fetch('/shell-super-app-api/auth/gateway-context', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    return { body: await response.json(), status: response.status };
  });

const write = (status: number) =>
  Effect.promise(async () => {
    platformFetch.mockResolvedValueOnce(new Response(null, { status }));
    await globalThis.fetch('/shell-super-app-api/module-api/sales/build/sales-api/commands/close-deal', {
      body: '{}',
      method: 'POST',
    });
  });

const isGatewayUrl = Schema.is(Schema.String.check(Schema.isEndingWith('/auth/gateway-context')));
const gatewayRequests = () => platformFetch.mock.calls.filter(([input]) => isGatewayUrl(input));

beforeAll(() => {
  globalThis.fetch = platformFetch;
  installBrowserRequestCache();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  platformFetch.mockReset();
  // The single issuer answers any audience it is asked for.
  platformFetch.mockImplementation(async (_input, init) => {
    const { audience } = Schema.decodeUnknownSync(GatewayRequestBodySchema)(init?.body);
    return Response.json(withoutAudience(assertion(audience)));
  });
  issueDocumentGatewayContextsMock.mockReset();
});

it.live('answers remotes from the assertions server rendering embedded, without a round trip', () =>
  Effect.gen(function* seeded() {
    yield* resetDocumentGatewayAssertions;
    const seededFinance = assertion('seeded-finance');
    yield* seedDocumentGatewayAssertions(revision, [seededFinance, assertion('seeded-pipeline')]);
    const answer = yield* askAssertion({ audience: 'seeded-finance', compositionRevision: revision });
    expect(answer).toEqual({ body: withoutAudience(seededFinance), status: 200 });
    expect(gatewayRequests()).toHaveLength(0);
    expect(issueDocumentGatewayContextsMock).not.toHaveBeenCalled();
  }),
);

it.live('obtains every audience of a client-side navigation in one batch that concurrent remotes join', () =>
  Effect.gen(function* batched() {
    yield* resetDocumentGatewayAssertions;
    const audiences = ['warm-a', 'warm-b', 'warm-c'];
    const release = yield* Deferred.make<boolean>();
    issueDocumentGatewayContextsMock.mockReturnValue(
      Deferred.await(release).pipe(Effect.as({ assertions: audiences.map((audience) => assertion(audience)) })),
    );
    yield* warmDocumentGatewayAssertions(revision, audiences);
    const asking = yield* Effect.forEach(
      audiences,
      (audience) => askAssertion({ audience, compositionRevision: revision }),
      { concurrency: 'unbounded' },
    ).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, true);
    const answers = yield* Fiber.join(asking);
    expect(answers.map(({ body }) => body)).toEqual(audiences.map((audience) => withoutAudience(assertion(audience))));
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(1);
    expect(issueDocumentGatewayContextsMock.mock.calls[0]?.[0]).toEqual({ audiences, compositionRevision: revision });
    expect(gatewayRequests()).toHaveLength(0);
    // Consumed slots need fresh tokens even though the original tokens have not expired.
    yield* warmDocumentGatewayAssertions(revision, audiences);
    yield* askAssertion({ audience: 'warm-a', compositionRevision: revision });
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(2);
  }),
);

it.live('claims a seeded token once under concurrency and cannot resurrect it by seeding again', () =>
  Effect.gen(function* claimOnce() {
    yield* resetDocumentGatewayAssertions;
    const seeded = assertion('single-use');
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.succeed({ assertions: [] }));
    let issued = 0;
    platformFetch.mockImplementation(async () => {
      issued += 1;
      return Response.json({ ...withoutAudience(seeded), token: `fresh-single-${issued}` });
    });
    yield* seedDocumentGatewayAssertions(revision, [seeded]);
    const answers = yield* Effect.forEach(
      [1, 2, 3],
      () => askAssertion({ audience: 'single-use', compositionRevision: revision }),
      { concurrency: 'unbounded' },
    );
    expect(new Set(answers.map(({ body }) => body.token)).size).toBe(3);
    expect(answers.filter(({ body }) => body.token === seeded.token)).toHaveLength(1);
    yield* seedDocumentGatewayAssertions(revision, [seeded]);
    const later = yield* askAssertion({ audience: 'single-use', compositionRevision: revision });
    expect(later.body.token).not.toBe(seeded.token);
    expect(gatewayRequests()).toHaveLength(3);
  }),
);

it.live('gives a pending batch token to only one concurrent consumer of the same audience', () =>
  Effect.gen(function* pendingClaimOnce() {
    yield* resetDocumentGatewayAssertions;
    const batchAssertion = assertion('pending-single-use');
    const release = yield* Deferred.make<boolean>();
    let batches = 0;
    issueDocumentGatewayContextsMock.mockImplementation(() => {
      batches += 1;
      const token = `${batchAssertion.token}-${batches}`;
      return Deferred.await(release).pipe(Effect.as({ assertions: [{ ...batchAssertion, token }] }));
    });
    let issued = 0;
    platformFetch.mockImplementation(async () => {
      issued += 1;
      return Response.json({ ...withoutAudience(batchAssertion), token: `pending-fresh-${issued}` });
    });
    yield* warmDocumentGatewayAssertions(revision, [batchAssertion.audience]);
    const pending = yield* Effect.forEach(
      [1, 2, 3],
      () => askAssertion({ audience: batchAssertion.audience, compositionRevision: revision }),
      { concurrency: 'unbounded' },
    ).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, true);
    const answers = yield* Fiber.join(pending);
    expect(new Set(answers.map(({ body }) => body.token)).size).toBe(3);
    expect(answers.filter(({ body }) => body.token === `${batchAssertion.token}-1`)).toHaveLength(1);
  }),
);

it.live('renews the document assertions in one batch once they near expiry, never handing out an expiring one', () =>
  Effect.gen(function* renewed() {
    yield* resetDocumentGatewayAssertions;
    const audiences = ['renew-a', 'renew-b'];
    yield* seedDocumentGatewayAssertions(
      revision,
      audiences.map((audience) => assertion(audience, EXPIRED)),
    );
    issueDocumentGatewayContextsMock.mockReturnValue(
      Effect.succeed({ assertions: audiences.map((audience) => assertion(audience)) }),
    );
    const answers = yield* Effect.forEach(
      audiences,
      (audience) => askAssertion({ audience, compositionRevision: revision }),
      { concurrency: 'unbounded' },
    );
    expect(answers.map(({ body }) => body.expiresAt)).toEqual([FAR_EXPIRY, FAR_EXPIRY]);
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(1);
    expect(issueDocumentGatewayContextsMock.mock.calls[0]?.[0]).toEqual({ audiences, compositionRevision: revision });
    expect(gatewayRequests()).toHaveLength(0);
  }),
);

it.live('leaves other companies, other releases and unknown audiences to the single issuer', () =>
  Effect.gen(function* fallsBack() {
    yield* resetDocumentGatewayAssertions;
    yield* seedDocumentGatewayAssertions(revision, [assertion('known')]);
    yield* askAssertion({ audience: 'known', compositionRevision: revision, legalEntityId: 'other-company' });
    yield* askAssertion({ audience: 'known', compositionRevision: otherRevision });
    yield* askAssertion({ audience: 'unknown', compositionRevision: revision });
    expect(gatewayRequests()).toHaveLength(3);

    // An audience a remote asked for alone joins the document, so the next renewal covers it with the others.
    yield* resetDocumentGatewayAssertions;
    yield* seedDocumentGatewayAssertions(revision, [assertion('expiring', EXPIRED)]);
    yield* askAssertion({ audience: 'noted', compositionRevision: revision });
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.succeed({ assertions: [] }));
    yield* askAssertion({ audience: 'expiring', compositionRevision: revision });
    expect(issueDocumentGatewayContextsMock.mock.calls.at(-1)?.[0]).toEqual({
      audiences: ['expiring', 'noted'],
      compositionRevision: revision,
    });
  }),
);

it.live('lets each remote ask alone when the batch fails', () =>
  Effect.gen(function* batchFails() {
    yield* resetDocumentGatewayAssertions;
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.fail({ _tag: 'GatewayUnavailableProblem' }));
    yield* warmDocumentGatewayAssertions(revision, ['failing-a']);
    const answer = yield* askAssertion({ audience: 'failing-a', compositionRevision: revision });
    expect(answer).toEqual({ body: withoutAudience(assertion('failing-a')), status: 200 });
    expect(gatewayRequests()).toHaveLength(1);
  }),
);

it.live('never holds an embedded token again once a context boundary or another revision dropped the held set', () =>
  Effect.gen(function* embeddedOnce() {
    yield* resetDocumentGatewayAssertions;
    const embedded = assertion('embedded-once');
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.succeed({ assertions: [] }));
    let issued = 0;
    platformFetch.mockImplementation(async () => {
      issued += 1;
      return Response.json({ ...withoutAudience(embedded), token: `embedded-fresh-${issued}` });
    });
    yield* seedDocumentGatewayAssertions(revision, [embedded]);
    const first = yield* askAssertion({ audience: embedded.audience, compositionRevision: revision });
    expect(first.body.token).toBe(embedded.token);
    // A boundary that does not reload the document (a company switch that failed) drops the held set, and the Shell
    // renders again from the same server-rendered model. Its owner has already redeemed this token: a 401.
    yield* clearBrowserRequestCache;
    yield* seedDocumentGatewayAssertions(revision, [embedded]);
    const afterBoundary = yield* askAssertion({ audience: embedded.audience, compositionRevision: revision });
    expect(afterBoundary.body.token).not.toBe(embedded.token);
    // A loader that saw another revision replaces the held set; the document's own revision renders again.
    yield* warmDocumentGatewayAssertions(otherRevision, []);
    yield* seedDocumentGatewayAssertions(revision, [embedded]);
    const afterRevision = yield* askAssertion({ audience: embedded.audience, compositionRevision: revision });
    expect(afterRevision.body.token).not.toBe(embedded.token);
  }),
);

it.effect('hands out an assertion only while more than the margin of its lifetime is left', () =>
  Effect.gen(function* margin() {
    yield* resetDocumentGatewayAssertions;
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.succeed({ assertions: [] }));
    // The test clock starts at 0: 16 s of lifetime, the margin is 15 s.
    const justUsable = assertion('margin-usable', 16);
    const atMargin = assertion('margin-reached', 16);
    yield* seedDocumentGatewayAssertions(revision, [justUsable, atMargin]);
    yield* TestClock.adjust('999 millis');
    expect(yield* documentGatewayAssertion(justUsable.audience, revision)).toEqual(
      Option.some(withoutAudience(justUsable)),
    );
    yield* TestClock.adjust('1 millis');
    expect(yield* documentGatewayAssertion(atMargin.audience, revision)).toEqual(Option.none());
    // The expiring one was renewed with the others in one batch, not handed out.
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(1);
    expect(issueDocumentGatewayContextsMock.mock.calls[0]?.[0]).toEqual({
      audiences: [justUsable.audience, atMargin.audience],
      compositionRevision: revision,
    });
  }),
);

it.live('answers no remote with an assertion of a context that ended while its batch was on the way', () =>
  Effect.gen(function* boundaryMidFlight() {
    yield* resetDocumentGatewayAssertions;
    const release = yield* Deferred.make<boolean>();
    issueDocumentGatewayContextsMock.mockReturnValue(
      Deferred.await(release).pipe(Effect.as({ assertions: [assertion('mid-flight')] })),
    );
    yield* warmDocumentGatewayAssertions(revision, ['mid-flight']);
    const asking = yield* askAssertion({ audience: 'mid-flight', compositionRevision: revision }).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.sleep('50 millis');
    yield* clearBrowserRequestCache;
    yield* Deferred.succeed(release, true);
    expect(Exit.isFailure(yield* Fiber.await(asking))).toBe(true);
    expect(gatewayRequests()).toHaveLength(0);
  }),
);

it.live('asks no further batch for a release the Shell no longer issues for', () =>
  Effect.gen(function* retiredRelease() {
    const retired = 'c'.repeat(64);
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.fail({ _tag: 'GatewayReloadRequiredProblem' }));
    platformFetch.mockImplementation(async () => Response.json({ title: 'Reload required' }, { status: 409 }));
    yield* warmDocumentGatewayAssertions(retired, ['retired-a', 'retired-b']);
    const answers = yield* Effect.forEach(
      ['retired-a', 'retired-b', 'retired-a'],
      (audience) => askAssertion({ audience, compositionRevision: retired }),
      { concurrency: 1 },
    );
    expect(answers.map(({ status }) => status)).toEqual([409, 409, 409]);
    // The single issuer still answers each remote, which then asks for a reload; no batch repeats the refusal.
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(1);
    expect(gatewayRequests()).toHaveLength(3);
    yield* warmDocumentGatewayAssertions(retired, ['retired-c']);
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(1);
  }),
);

it.live('announces every settled module write to page-data stores, but not a rejected command', () =>
  Effect.gen(function* announcesModuleWrites() {
    let announced = 0;
    const onWrite = () => {
      announced += 1;
    };
    globalThis.addEventListener(moduleWriteEvent, onWrite);
    yield* write(204);
    expect(announced).toBe(1);
    yield* write(409);
    expect(announced).toBe(1);
    yield* write(500);
    expect(announced).toBe(2);
    globalThis.removeEventListener(moduleWriteEvent, onWrite);
  }),
);
