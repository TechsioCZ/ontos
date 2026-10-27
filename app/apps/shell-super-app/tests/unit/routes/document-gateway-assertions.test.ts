import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import * as actualAuthClient from '../../../src/api/auth-client.ts' with { rstest: 'importActual' };
import { installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import {
  resetDocumentGatewayAssertions,
  seedDocumentGatewayAssertions,
  warmDocumentGatewayAssertions,
} from '../../../src/routes/document-gateway-assertions.ts';

const { issueDocumentGatewayContextsMock } = rstest.hoisted(() => ({
  issueDocumentGatewayContextsMock: rstest.fn(),
}));

rstest.mock('../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
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
    // Still fresh: warming again asks nothing.
    yield* warmDocumentGatewayAssertions(revision, audiences);
    expect(issueDocumentGatewayContextsMock).toHaveBeenCalledTimes(1);
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

it.live('announces every settled module write to page-data stores, but not a rejected command', () =>
  Effect.gen(function* announcesModuleWrites() {
    let announced = 0;
    const onWrite = () => {
      announced += 1;
    };
    globalThis.addEventListener(moduleWriteEvent, onWrite);
    const write = (status: number) =>
      Effect.promise(async () => {
        platformFetch.mockResolvedValueOnce(new Response(null, { status }));
        await globalThis.fetch('/shell-super-app-api/module-api/sales/build/sales-api/commands/close-deal', {
          body: '{}',
          method: 'POST',
        });
      });
    yield* write(204);
    expect(announced).toBe(1);
    yield* write(409);
    expect(announced).toBe(1);
    yield* write(500);
    expect(announced).toBe(2);
    globalThis.removeEventListener(moduleWriteEvent, onWrite);
  }),
);
