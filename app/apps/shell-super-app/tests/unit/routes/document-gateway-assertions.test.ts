import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import type { DocumentGatewayContextsRequest } from '../../../shared/document-gateway-api.ts';
import {
  documentGatewayAssertion,
  resetDocumentGatewayAssertions,
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

/** What one batch asked: which audiences it names, and the most assertions it asks of any one of them. */
const askedOf = (request: { readonly audiences: readonly string[] } | undefined) => {
  const audiences = request?.audiences ?? [];
  return {
    audiences: [...new Set(audiences)].toSorted(),
    most: Math.max(0, ...[...Map.groupBy(audiences, (audience) => audience).values()].map(({ length }) => length)),
  };
};

/** The document holds these assertions: its one batch answered them (the next batch answers what the test mocks). */
const holdAssertions = (assertions: readonly ReturnType<typeof assertion>[]) =>
  Effect.gen(function* hold() {
    const answered = yield* Deferred.make<boolean>();
    issueDocumentGatewayContextsMock.mockReturnValueOnce(
      Effect.succeed({ assertions }).pipe(Effect.tap(() => Deferred.succeed(answered, true))),
    );
    yield* warmDocumentGatewayAssertions(
      revision,
      assertions.map(({ audience }) => audience),
    );
    yield* Deferred.await(answered);
    yield* Effect.yieldNow;
  });

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

/** Answers every batch with one freshly tokened assertion per entry it asks for, and records what it was asked. */
const answeringBatches = () => {
  const asked: (readonly string[])[] = [];
  let issued = 0;
  issueDocumentGatewayContextsMock.mockImplementation((request: { readonly audiences: readonly string[] }) => {
    asked.push(request.audiences);
    return Effect.succeed({
      assertions: request.audiences.map((audience) => {
        issued += 1;
        return { ...assertion(audience), token: `token-${audience}-issued-${String(issued)}` };
      }),
    });
  });
  return { asked };
};

it.live('hands each read of one module its own pooled assertion, and asks a dry pool several in one batch', () =>
  Effect.gen(function* poolPerModule() {
    yield* resetDocumentGatewayAssertions;
    const audience = 'orders';
    const batches = answeringBatches();
    yield* warmDocumentGatewayAssertions(revision, [audience]);
    yield* Effect.sleep('20 millis');
    // The document holds one assertion of the module; five reads of it follow, as a list warming its rows does.
    const claimed = yield* Effect.forEach(
      [1, 2, 3, 4, 5],
      () => askAssertion({ audience, compositionRevision: revision }),
      { concurrency: 'unbounded' },
    );
    expect(claimed.every(({ status }) => status === 200)).toBe(true);
    // Every read got its own assertion, and none asked the single issuer.
    expect(new Set(claimed.map(({ body }) => body.token)).size).toBe(5);
    expect(gatewayRequests()).toHaveLength(0);
    // The waiting reads were answered by batches that asked for several assertions of this one module.
    // Five reads of one module cost at most two batches, each asking several assertions of it, never one call a read.
    expect(batches.asked.length).toBeLessThanOrEqual(2);
    expect(
      Math.max(...batches.asked.map((entries) => entries.filter((named) => named === audience).length)),
    ).toBeGreaterThan(1);
    expect(batches.asked.every((entries) => entries.every((named) => named === audience))).toBe(true);
  }),
);

it.live('mints no assertions a slow page never uses: a refill covers the reads waiting and one spare', () =>
  Effect.gen(function* refillStaysSmall() {
    yield* resetDocumentGatewayAssertions;
    const audience = 'orders';
    const batches = answeringBatches();
    yield* warmDocumentGatewayAssertions(revision, [audience]);
    yield* Effect.sleep('20 millis');
    // A burst first: eight reads of the module at once, as a list warming its rows.
    yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => askAssertion({ audience, compositionRevision: revision }), {
      concurrency: 'unbounded',
    });
    const afterBurst = batches.asked.length;
    // Then the page settles into one read at a time. Each refill asks for that read and one spare, never eight.
    for (const _read of [1, 2, 3, 4, 5, 6]) {
      yield* askAssertion({ audience, compositionRevision: revision });
      yield* Effect.sleep('5 millis');
    }
    const trickle = batches.asked.slice(afterBurst);
    expect(trickle.length).toBeGreaterThan(0);
    expect(Math.max(...trickle.map((entries) => entries.length))).toBeLessThanOrEqual(2);
    // Six single reads cost at most six assertions plus one spare left over, not eight per read.
    expect(trickle.flat().length).toBeLessThanOrEqual(7);
    expect(gatewayRequests()).toHaveLength(0);
  }),
);

it.live('never hands out a pooled assertion of a context that ended', () =>
  Effect.gen(function* poolEndsWithContext() {
    yield* resetDocumentGatewayAssertions;
    const audience = 'orders';
    const held = [
      { ...assertion(audience), token: `token-${audience}-held-1` },
      { ...assertion(audience), token: `token-${audience}-held-2` },
    ];
    issueDocumentGatewayContextsMock.mockReturnValueOnce(Effect.succeed({ assertions: held }));
    yield* warmDocumentGatewayAssertions(revision, [audience]);
    yield* Effect.sleep('20 millis');
    const first = yield* askAssertion({ audience, compositionRevision: revision });
    expect(held.map(({ token }) => token)).toContain(first.body.token);
    // A company or tenant switch (or a sign-out) drops every pool; an unclaimed token is never handed out.
    yield* clearBrowserRequestCache;
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.succeed({ assertions: [] }));
    const afterBoundary = yield* askAssertion({ audience, compositionRevision: revision });
    expect(held.map(({ token }) => token)).not.toContain(afterBoundary.body.token);
    // It came from the single issuer, which decides for the person signed in now.
    expect(gatewayRequests()).toHaveLength(1);
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
    yield* holdAssertions(audiences.map((audience) => assertion(audience, EXPIRED)));
    issueDocumentGatewayContextsMock.mockReturnValue(
      Effect.succeed({ assertions: audiences.map((audience) => assertion(audience)) }),
    );
    const answers = yield* Effect.forEach(
      audiences,
      (audience) => askAssertion({ audience, compositionRevision: revision }),
      { concurrency: 'unbounded' },
    );
    expect(answers.map(({ body }) => body.expiresAt)).toEqual([FAR_EXPIRY, FAR_EXPIRY]);
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(2);
    const renewal = askedOf(issueDocumentGatewayContextsMock.mock.calls[1]?.[0]);
    expect(renewal.audiences).toEqual([...audiences].toSorted());
    // One renewal for both, with at most the waiting read and its spare of either.
    expect(renewal.most).toBeLessThanOrEqual(2);
    expect(issueDocumentGatewayContextsMock.mock.calls[1]?.[0]?.compositionRevision).toBe(revision);
    expect(gatewayRequests()).toHaveLength(0);
  }),
);

it.live('leaves other companies, other releases and unknown audiences to the single issuer', () =>
  Effect.gen(function* fallsBack() {
    yield* resetDocumentGatewayAssertions;
    yield* holdAssertions([assertion('known')]);
    yield* askAssertion({ audience: 'known', compositionRevision: revision, legalEntityId: 'other-company' });
    yield* askAssertion({ audience: 'known', compositionRevision: otherRevision });
    yield* askAssertion({ audience: 'unknown', compositionRevision: revision });
    expect(gatewayRequests()).toHaveLength(3);

    // An audience a remote asked for alone joins the document, so the next renewal covers it with the others.
    yield* resetDocumentGatewayAssertions;
    yield* holdAssertions([assertion('expiring', EXPIRED)]);
    yield* askAssertion({ audience: 'noted', compositionRevision: revision });
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.succeed({ assertions: [] }));
    yield* askAssertion({ audience: 'expiring', compositionRevision: revision });
    const renewed = askedOf(issueDocumentGatewayContextsMock.mock.calls.at(-1)?.[0]);
    expect(renewed.audiences).toEqual(['expiring', 'noted']);
    expect(renewed.most).toBeLessThanOrEqual(2);
    expect(issueDocumentGatewayContextsMock.mock.calls.at(-1)?.[0]?.compositionRevision).toBe(revision);
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

it.effect('hands out an assertion only while more than the margin of its lifetime is left', () =>
  Effect.gen(function* margin() {
    yield* resetDocumentGatewayAssertions;
    issueDocumentGatewayContextsMock.mockReturnValue(Effect.succeed({ assertions: [] }));
    // The test clock starts at 0: 16 s of lifetime, the margin is 15 s.
    const justUsable = assertion('margin-usable', 16);
    const atMargin = assertion('margin-reached', 16);
    yield* holdAssertions([justUsable, atMargin]);
    yield* TestClock.adjust('999 millis');
    expect(yield* documentGatewayAssertion(justUsable.audience, revision)).toEqual(
      Option.some(withoutAudience(justUsable)),
    );
    yield* TestClock.adjust('1 millis');
    expect(yield* documentGatewayAssertion(atMargin.audience, revision)).toEqual(Option.none());
    // The expiring one was renewed with the others in one batch, not handed out.
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(2);
    const marginRenewal = askedOf(issueDocumentGatewayContextsMock.mock.calls[1]?.[0]);
    expect(marginRenewal.audiences).toEqual([justUsable.audience, atMargin.audience].toSorted());
    expect(marginRenewal.most).toBeLessThanOrEqual(2);
    expect(issueDocumentGatewayContextsMock.mock.calls[1]?.[0]?.compositionRevision).toBe(revision);
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
    // Every remote gets the refusal and asks for a reload, but only the first reaches the Shell: the document
    // answers the rest with that refusal itself, and no batch repeats it.
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(1);
    expect(gatewayRequests()).toHaveLength(1);
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

/** Every entry a batch asks for is answered with its own token, as the Shell issues them. */
const answerEveryEntry = () => {
  let minted = 0;
  issueDocumentGatewayContextsMock.mockImplementation(({ audiences }: DocumentGatewayContextsRequest) =>
    Effect.succeed({
      assertions: audiences.map((audience) => {
        minted += 1;
        return { ...assertion(audience), token: `batch-${audience}-${minted}` };
      }),
    }),
  );
};

const readAudience = (audience: string) => askAssertion({ audience, compositionRevision: revision });

it.live('serves the orders list and the warm-up of five order details from batches alone, one token per read', () =>
  Effect.gen(function* ordersList() {
    yield* resetDocumentGatewayAssertions;
    answerEveryEntry();
    // The document asks one assertion per audience as it renders.
    yield* holdAssertions([assertion('merchandise'), assertion('party-registry')]);
    issueDocumentGatewayContextsMock.mockClear();
    answerEveryEntry();
    let single = 0;
    platformFetch.mockImplementation(async (_input, init) => {
      const { audience } = Schema.decodeUnknownSync(GatewayRequestBodySchema)(init?.body);
      single += 1;
      return Response.json({ ...withoutAudience(assertion(audience)), token: `single-${audience}-${single}` });
    });
    // The page: three Merchandise reads and the customer names, together.
    const page = yield* Effect.forEach(['merchandise', 'merchandise', 'merchandise', 'party-registry'], readAudience, {
      concurrency: 'unbounded',
    });
    // Then the warm-up of the first five orders' details, one order after another (11 reads).
    const warm = yield* Effect.forEach(
      [2, 2, 2, 2, 3],
      (reads) =>
        Effect.forEach(
          Array.from({ length: reads }, () => 'merchandise'),
          readAudience,
          { concurrency: 'unbounded' },
        ),
      { concurrency: 1 },
    );
    const tokens = [...page, ...warm.flat()].map(({ body }) => body.token);
    expect(tokens).toHaveLength(15);
    expect(new Set(tokens).size).toBe(15);
    // With one assertion per audience and batch this load took 6 batches and 7 single requests after the document's
    // own batch (stage measured 13 gateway calls). Now each dry pool asks for the reads waiting or as many as were
    // used, at most 8: 4 batches, no single request, 7 assertions left unused to expire.
    const asked = issueDocumentGatewayContextsMock.mock.calls.map(([request]) => request.audiences);
    // With one assertion per audience and batch this load took 6 batches and 7 single requests after the document's
    // own batch (stage measured 13 gateway calls). Now every read is served from a batch and none asks alone.
    expect(gatewayRequests()).toHaveLength(0);
    expect(asked.length).toBeLessThan(tokens.length);
    // A batch never asks more than the reads waiting for that module and one spare, so nothing is minted in bulk.
    expect(Math.max(...asked.map((entries) => askedOf({ audiences: entries }).most))).toBeLessThanOrEqual(4);
    // Fifteen reads cost fifteen assertions plus at most one spare per batch; before, 8 were minted per dry read.
    expect(asked.flat().length).toBeGreaterThanOrEqual(tokens.length);
    expect(asked.flat().length).toBeLessThanOrEqual(tokens.length + asked.length);
  }),
);

const readLeftOver = askAssertion({ audience: 'left-over', compositionRevision: revision });

it.live('hands no assertion left over from a refill to a read after a context boundary', () =>
  Effect.gen(function* leftoverAtBoundary() {
    yield* resetDocumentGatewayAssertions;
    answerEveryEntry();
    yield* holdAssertions([assertion('left-over')]);
    // The third read's refill asks two (as many as were used), so one is left in the pool.
    const before = yield* Effect.forEach([1, 2, 3], () => readLeftOver, { concurrency: 1 });
    expect(issueDocumentGatewayContextsMock.mock.calls.at(-1)?.[0]).toEqual({
      audiences: ['left-over', 'left-over'],
      compositionRevision: revision,
    });
    // A company or tenant switch, or a sign-out, clears the cache: the next document starts with an empty pool.
    yield* clearBrowserRequestCache;
    yield* holdAssertions([assertion('left-over')]);
    const after = yield* readLeftOver;
    expect(new Set(before.map(({ body }) => body.token)).size).toBe(3);
    // The new document's own assertion, not the one the earlier refill left over.
    expect(after.body.token).toBe(assertion('left-over').token);
  }),
);
