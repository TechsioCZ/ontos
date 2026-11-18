// @rstest-environment happy-dom
import {
  GatewayContextApiGroup,
  GatewayReloadRequiredProblemSchema,
  GatewayUnavailableProblemSchema,
} from '@app/shared-contracts';
import type { GatewayContextRequest, GatewayContextResponse } from '@app/shared-contracts';
import { browserNetwork, networkIdle, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Exit, Fiber, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { beforeAll, beforeEach, expect, it } from 'effect-rstest';
import { waitUntil } from '@app/admin-ui/testing/module-ui';

import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import { DocumentGatewayApiGroup } from '../../../shared/document-gateway-api.ts';
import type { DocumentGatewayAssertion, DocumentGatewayContextsRequest } from '../../../shared/document-gateway-api.ts';
import {
  documentGatewayAssertion,
  resetDocumentGatewayAssertions,
  warmDocumentGatewayAssertions,
} from '../../../src/routes/document-gateway-assertions.ts';

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

type BatchAnswer = Effect.Effect<
  { readonly assertions: readonly DocumentGatewayAssertion[] },
  typeof GatewayUnavailableProblemSchema.Type | typeof GatewayReloadRequiredProblemSchema.Type
>;
const batchRequests: DocumentGatewayContextsRequest[] = [];
const singleRequests: GatewayContextRequest[] = [];
let batchAnswer: (request: DocumentGatewayContextsRequest) => BatchAnswer = (
  _request: DocumentGatewayContextsRequest,
) => Effect.succeed({ assertions: [] });
const queuedBatches: BatchAnswer[] = [];
let singleAnswer: (
  request: GatewayContextRequest,
) => Effect.Effect<GatewayContextResponse, typeof GatewayReloadRequiredProblemSchema.Type> = ({ audience }) =>
  Effect.succeed(withoutAudience(assertion(audience)));
let writeStatus = 204;

const Api = HttpApi.make('documentGatewayTest')
  .add(DocumentGatewayApiGroup)
  .add(GatewayContextApiGroup)
  .prefix('/shell-super-app-api');
const handlers = Layer.mergeAll(
  HttpApiBuilder.group(Api, 'documentGateway', (group) =>
    group.handle('issueDocumentGatewayContexts', ({ payload }) =>
      Effect.suspend(() => {
        batchRequests.push(payload);
        return queuedBatches.shift() ?? batchAnswer(payload);
      }),
    ),
  ),
  HttpApiBuilder.group(Api, 'gatewayContext', (group) =>
    group
      .handle('issueGatewayContext', ({ payload }) =>
        Effect.suspend(() => {
          singleRequests.push(payload);
          return singleAnswer(payload);
        }),
      )
      .handle('issueApiKeyGatewayContext', () => Effect.die('Unexpected API-key issuance'))
      .handle('issueDelegatedGatewayContext', () => Effect.die('Unexpected delegated issuance')),
  ),
);
const network = browserNetwork(
  serveApi(Api, handlers),
  HttpRouter.add(
    'POST',
    '/shell-super-app-api/module-api/sales/build/sales-api/commands/close-deal',
    Effect.sync(() => HttpServerResponse.empty({ status: writeStatus })),
  ),
);

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
    writeStatus = status;
    await globalThis.fetch('/shell-super-app-api/module-api/sales/build/sales-api/commands/close-deal', {
      body: '{}',
      method: 'POST',
    });
  });

const gatewayRequests = () => singleRequests;

/** What one batch asked: which audiences it names, and the most assertions it asks of any one of them. */
const askedOf = (request: { readonly audiences: readonly string[] } | undefined) => {
  const audiences = request?.audiences ?? [];
  return {
    audiences: [...new Set(audiences)].toSorted(),
    most: Math.max(0, ...[...Map.groupBy(audiences, (audience) => audience).values()].map(({ length }) => length)),
  };
};

/** The document holds these assertions: its one batch answered them (the next batch uses the configured handler). */
const holdAssertions = (assertions: readonly ReturnType<typeof assertion>[]) =>
  Effect.gen(function* hold() {
    const answered = yield* Deferred.make<boolean>();
    queuedBatches.push(Effect.succeed({ assertions }).pipe(Effect.tap(() => Deferred.succeed(answered, true))));
    yield* warmDocumentGatewayAssertions(
      revision,
      assertions.map(({ audience }) => audience),
    );
    yield* Deferred.await(answered);
    // The answer has travelled back and the document holds it.
    yield* networkIdle;
  });

/** Warms the document for `audiences` and waits until its batch was recorded, answered and taken into the pool. */
const warmed = (audiences: readonly string[]) =>
  Effect.gen(function* warmedPool() {
    const before = batchRequests.length;
    yield* warmDocumentGatewayAssertions(revision, audiences);
    yield* waitUntil(() => batchRequests.length > before);
    yield* networkIdle;
    expect(batchRequests).toHaveLength(before + 1);
  });

beforeAll(() => {
  installBrowserRequestCache();
});

beforeEach(() => {
  singleRequests.length = 0;
  batchRequests.length = 0;
  queuedBatches.length = 0;
  singleAnswer = ({ audience }) => Effect.succeed(withoutAudience(assertion(audience)));
  batchAnswer = () => Effect.succeed({ assertions: [] });
});

/** Answers every batch with one freshly tokened assertion per entry it asks for, and records what it was asked. */
const answeringBatches = () => {
  const asked: (readonly string[])[] = [];
  let issued = 0;
  batchAnswer = (request: { readonly audiences: readonly string[] }) => {
    asked.push(request.audiences);
    return Effect.succeed({
      assertions: request.audiences.map((audience) => {
        issued += 1;
        return { ...assertion(audience), token: `token-${audience}-issued-${String(issued)}` };
      }),
    });
  };
  return { asked };
};

it.live('hands each read of one module its own pooled assertion, and asks a dry pool several in one batch', () =>
  Effect.gen(function* poolPerModule() {
    yield* resetDocumentGatewayAssertions;
    const audience = 'orders';
    const batches = answeringBatches();
    yield* warmed([audience]);
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
  }).pipe(Effect.provide(network)),
);

it.live('mints no assertions a slow page never uses: a refill covers the reads waiting and one spare', () =>
  Effect.gen(function* refillStaysSmall() {
    yield* resetDocumentGatewayAssertions;
    const audience = 'orders';
    const batches = answeringBatches();
    yield* warmed([audience]);
    // A burst first: eight reads of the module at once, as a list warming its rows.
    yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => askAssertion({ audience, compositionRevision: revision }), {
      concurrency: 'unbounded',
    });
    const afterBurst = batches.asked.length;
    // Then the page settles into one read at a time. Each refill asks for that read and one spare, never eight.
    for (const _read of [1, 2, 3, 4, 5, 6]) {
      yield* askAssertion({ audience, compositionRevision: revision });
      // The refill this read asked for has landed before the next read comes.
      yield* networkIdle;
    }
    const trickle = batches.asked.slice(afterBurst);
    expect(trickle.length).toBeGreaterThan(0);
    expect(Math.max(...trickle.map((entries) => entries.length))).toBeLessThanOrEqual(2);
    // Six single reads cost at most six assertions plus one spare left over, not eight per read.
    expect(trickle.flat().length).toBeLessThanOrEqual(7);
    expect(gatewayRequests()).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('never hands out a pooled assertion of a context that ended', () =>
  Effect.gen(function* poolEndsWithContext() {
    yield* resetDocumentGatewayAssertions;
    const audience = 'orders';
    const held = [
      { ...assertion(audience), token: `token-${audience}-held-1` },
      { ...assertion(audience), token: `token-${audience}-held-2` },
    ];
    queuedBatches.push(Effect.succeed({ assertions: held }));
    yield* warmed([audience]);
    const first = yield* askAssertion({ audience, compositionRevision: revision });
    expect(held.map(({ token }) => token)).toContain(first.body.token);
    // A company or tenant switch (or a sign-out) drops every pool; an unclaimed token is never handed out.
    yield* clearBrowserRequestCache;
    batchAnswer = () => Effect.succeed({ assertions: [] });
    const afterBoundary = yield* askAssertion({ audience, compositionRevision: revision });
    expect(held.map(({ token }) => token)).not.toContain(afterBoundary.body.token);
    // It came from the single issuer, which decides for the person signed in now.
    expect(gatewayRequests()).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('obtains every audience of a client-side navigation in one batch that concurrent remotes join', () =>
  Effect.gen(function* batched() {
    yield* resetDocumentGatewayAssertions;
    const audiences = ['warm-a', 'warm-b', 'warm-c'];
    const release = yield* Deferred.make<boolean>();
    batchAnswer = () =>
      Deferred.await(release).pipe(Effect.as({ assertions: audiences.map((audience) => assertion(audience)) }));
    yield* warmDocumentGatewayAssertions(revision, audiences);
    const asking = yield* Effect.forEach(
      audiences,
      (audience) => askAssertion({ audience, compositionRevision: revision }),
      { concurrency: 'unbounded' },
    ).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, true);
    const answers = yield* Fiber.join(asking);
    expect(answers.map(({ body }) => body)).toEqual(audiences.map((audience) => withoutAudience(assertion(audience))));
    expect(batchRequests).toHaveLength(1);
    expect(batchRequests[0]).toEqual({ audiences, compositionRevision: revision });
    expect(gatewayRequests()).toHaveLength(0);
    // Consumed slots need fresh tokens even though the original tokens have not expired.
    yield* warmDocumentGatewayAssertions(revision, audiences);
    yield* askAssertion({ audience: 'warm-a', compositionRevision: revision });
    expect(batchRequests).toHaveLength(2);
  }).pipe(Effect.provide(network)),
);

it.live('gives a pending batch token to only one concurrent consumer of the same audience', () =>
  Effect.gen(function* pendingClaimOnce() {
    yield* resetDocumentGatewayAssertions;
    const batchAssertion = assertion('pending-single-use');
    const release = yield* Deferred.make<boolean>();
    let batches = 0;
    batchAnswer = () => {
      batches += 1;
      const token = `${batchAssertion.token}-${batches}`;
      return Deferred.await(release).pipe(Effect.as({ assertions: [{ ...batchAssertion, token }] }));
    };
    let issued = 0;
    singleAnswer = () =>
      Effect.sync(() => {
        issued += 1;
        return { ...withoutAudience(batchAssertion), token: `pending-fresh-${issued}` };
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
  }).pipe(Effect.provide(network)),
);

it.live('renews the document assertions in one batch once they near expiry, never handing out an expiring one', () =>
  Effect.gen(function* renewed() {
    yield* resetDocumentGatewayAssertions;
    const audiences = ['renew-a', 'renew-b'];
    yield* holdAssertions(audiences.map((audience) => assertion(audience, EXPIRED)));
    batchAnswer = () => Effect.succeed({ assertions: audiences.map((audience) => assertion(audience)) });
    const answers = yield* Effect.forEach(
      audiences,
      (audience) => askAssertion({ audience, compositionRevision: revision }),
      { concurrency: 'unbounded' },
    );
    expect(answers.map(({ body }) => body.expiresAt)).toEqual([FAR_EXPIRY, FAR_EXPIRY]);
    expect(batchRequests).toHaveLength(2);
    const renewal = askedOf(batchRequests[1]);
    expect(renewal.audiences).toEqual([...audiences].toSorted());
    // One renewal for both, with at most the waiting read and its spare of either.
    expect(renewal.most).toBeLessThanOrEqual(2);
    expect(batchRequests[1]?.compositionRevision).toBe(revision);
    expect(gatewayRequests()).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('leaves other companies, other releases and unknown audiences to the single issuer', () =>
  Effect.gen(function* fallsBack() {
    yield* resetDocumentGatewayAssertions;
    yield* holdAssertions([assertion('known')]);
    yield* askAssertion({
      audience: 'known',
      compositionRevision: revision,
      legalEntityId: '20000000-0000-4000-8000-000000000002',
    });
    yield* askAssertion({ audience: 'known', compositionRevision: otherRevision });
    yield* askAssertion({ audience: 'unknown', compositionRevision: revision });
    expect(gatewayRequests()).toHaveLength(3);

    // An audience a remote asked for alone joins the document, so the next renewal covers it with the others.
    yield* resetDocumentGatewayAssertions;
    yield* holdAssertions([assertion('expiring', EXPIRED)]);
    yield* askAssertion({ audience: 'noted', compositionRevision: revision });
    batchAnswer = () => Effect.succeed({ assertions: [] });
    yield* askAssertion({ audience: 'expiring', compositionRevision: revision });
    const renewed = askedOf(batchRequests.at(-1));
    expect(renewed.audiences).toEqual(['expiring', 'noted']);
    expect(renewed.most).toBeLessThanOrEqual(2);
    expect(batchRequests.at(-1)?.compositionRevision).toBe(revision);
  }).pipe(Effect.provide(network)),
);

it.live('lets each remote ask alone when the batch fails', () =>
  Effect.gen(function* batchFails() {
    yield* resetDocumentGatewayAssertions;
    batchAnswer = () =>
      Effect.fail(
        GatewayUnavailableProblemSchema.make({
          detail: 'Batch unavailable',
          retryable: true,
          status: 503,
          title: 'Gateway unavailable',
          type: 'https://ontos.dev/problems/gateway-unavailable',
        }),
      );
    yield* warmDocumentGatewayAssertions(revision, ['failing-a']);
    const answer = yield* askAssertion({ audience: 'failing-a', compositionRevision: revision });
    expect(answer).toEqual({ body: withoutAudience(assertion('failing-a')), status: 200 });
    expect(gatewayRequests()).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.effect('hands out an assertion only while more than the margin of its lifetime is left', () =>
  Effect.gen(function* margin() {
    yield* resetDocumentGatewayAssertions;
    batchAnswer = () => Effect.succeed({ assertions: [] });
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
    expect(batchRequests).toHaveLength(2);
    const marginRenewal = askedOf(batchRequests[1]);
    expect(marginRenewal.audiences).toEqual([justUsable.audience, atMargin.audience].toSorted());
    expect(marginRenewal.most).toBeLessThanOrEqual(2);
    expect(batchRequests[1]?.compositionRevision).toBe(revision);
  }).pipe(Effect.provide(network)),
);

it.live('answers no remote with an assertion of a context that ended while its batch was on the way', () =>
  Effect.gen(function* boundaryMidFlight() {
    yield* resetDocumentGatewayAssertions;
    const release = yield* Deferred.make<boolean>();
    batchAnswer = () => Deferred.await(release).pipe(Effect.as({ assertions: [assertion('mid-flight')] }));
    yield* warmDocumentGatewayAssertions(revision, ['mid-flight']);
    const asking = yield* askAssertion({ audience: 'mid-flight', compositionRevision: revision }).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.sleep('50 millis');
    yield* clearBrowserRequestCache;
    yield* Deferred.succeed(release, true);
    expect(Exit.isFailure(yield* Fiber.await(asking))).toBe(true);
    expect(gatewayRequests()).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('asks no further batch for a release the Shell no longer issues for', () =>
  Effect.gen(function* retiredRelease() {
    const retired = 'c'.repeat(64);
    batchAnswer = () =>
      Effect.fail(
        GatewayReloadRequiredProblemSchema.make({
          detail: 'Retired composition',
          reloadRequired: true,
          status: 409,
          title: 'Reload required',
          type: 'https://ontos.dev/problems/gateway-reload-required',
        }),
      );
    singleAnswer = () =>
      Effect.fail(
        GatewayReloadRequiredProblemSchema.make({
          detail: 'Retired composition',
          reloadRequired: true,
          status: 409,
          title: 'Reload required',
          type: 'https://ontos.dev/problems/gateway-reload-required',
        }),
      );
    yield* warmDocumentGatewayAssertions(retired, ['retired-a', 'retired-b']);
    const answers = yield* Effect.forEach(
      ['retired-a', 'retired-b', 'retired-a'],
      (audience) => askAssertion({ audience, compositionRevision: retired }),
      { concurrency: 1 },
    );
    expect(answers.map(({ status }) => status)).toEqual([409, 409, 409]);
    // Every remote gets the refusal and asks for a reload, but only the first reaches the Shell: the document
    // answers the rest with that refusal itself, and no batch repeats it.
    expect(batchRequests).toHaveLength(1);
    expect(gatewayRequests()).toHaveLength(1);
    yield* warmDocumentGatewayAssertions(retired, ['retired-c']);
    yield* networkIdle;
    expect(batchRequests).toHaveLength(1);
  }).pipe(Effect.provide(network)),
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
  }).pipe(Effect.provide(network)),
);

/** Every entry a batch asks for is answered with its own token, as the Shell issues them. */
const answerEveryEntry = () => {
  let minted = 0;
  batchAnswer = ({ audiences }: DocumentGatewayContextsRequest) =>
    Effect.succeed({
      assertions: audiences.map((audience) => {
        minted += 1;
        return { ...assertion(audience), token: `batch-${audience}-${minted}` };
      }),
    });
};

const readAudience = (audience: string) => askAssertion({ audience, compositionRevision: revision });

it.live('serves the orders list and the warm-up of five order details from batches alone, one token per read', () =>
  Effect.gen(function* ordersList() {
    yield* resetDocumentGatewayAssertions;
    answerEveryEntry();
    // The document asks one assertion per audience as it renders.
    yield* holdAssertions([assertion('merchandise'), assertion('party-registry')]);
    batchRequests.length = 0;
    answerEveryEntry();
    let single = 0;
    singleAnswer = ({ audience }) =>
      Effect.sync(() => {
        single += 1;
        return { ...withoutAudience(assertion(audience)), token: `single-${audience}-${single}` };
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
    const asked = batchRequests.map((request) => request.audiences);
    // With one assertion per audience and batch this load took 6 batches and 7 single requests after the document's
    // own batch (stage measured 13 gateway calls). Now every read is served from a batch and none asks alone.
    expect(gatewayRequests()).toHaveLength(0);
    expect(asked.length).toBeLessThan(tokens.length);
    // A batch never asks more than the reads waiting for that module and one spare, so nothing is minted in bulk.
    expect(Math.max(...asked.map((entries) => askedOf({ audiences: entries }).most))).toBeLessThanOrEqual(4);
    // Fifteen reads cost fifteen assertions plus at most one spare per batch; before, 8 were minted per dry read.
    expect(asked.flat().length).toBeGreaterThanOrEqual(tokens.length);
    expect(asked.flat().length).toBeLessThanOrEqual(tokens.length + asked.length);
  }).pipe(Effect.provide(network)),
);

const readLeftOver = askAssertion({ audience: 'left-over', compositionRevision: revision });

it.live('hands no assertion left over from a refill to a read after a context boundary', () =>
  Effect.gen(function* leftoverAtBoundary() {
    yield* resetDocumentGatewayAssertions;
    answerEveryEntry();
    yield* holdAssertions([assertion('left-over')]);
    // The third read's refill asks two (as many as were used), so one is left in the pool.
    const before = yield* Effect.forEach([1, 2, 3], () => readLeftOver, { concurrency: 1 });
    expect(batchRequests.at(-1)).toEqual({
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
  }).pipe(Effect.provide(network)),
);
