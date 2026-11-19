import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { RouteAnswerSchema } from '@app/core-runtime/execution/module-call-route';
import type { CallRouteRequest, RouteAnswer, SelectedCaller } from '@app/core-runtime/execution/module-call-route';
import { moduleOperation } from '@app/core-runtime/sdk';
import { Effect, Fiber, Match, Option, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { GatewayDelegationSourceError } from '../../src/gateway-context-server.ts';
import type { GatewayDelegationRequest } from '../../src/gateway-context-server.ts';
import { makeModuleCallRoute, operationUrl } from '../../src/sdk-module-call-route.ts';

/**
 * The governed HTTP route of `call`: the gateway delegation for the selected caller, the admitted
 * revision, the governed headers and the provider's answer as a route observation.
 */

const revision = 'a'.repeat(64);
const principalId = '10000000-0000-4000-8000-000000000001';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:sdk-module-call-route',
  authMethod: 'session',
  principalId,
  tenantId: '30000000-0000-4000-8000-000000000001',
});
const provider = {
  entrypointKey: 'commerce.customer-context.api.subject-restrictions',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
};
const operation = moduleOperation({
  kind: 'read',
  path: '/reads/subject-restrictions',
  provider,
  request: Schema.Struct({ subject: Schema.String }),
  response: Schema.Struct({ ok: Schema.Boolean }),
});
const requirementKey = 'commerce.market-catalog.requirement.subject';
const declarationKey = 'commerce.market-catalog.subject.read';
const asPerson: SelectedCaller = { kind: 'person', legalEntityScope: 'subject' };

const [answeredSchema, problemSchema, unreachableSchema] = RouteAnswerSchema.members;
const isAnswered = Schema.is(answeredSchema);
const isProblem = Schema.is(problemSchema);
const isUnreachable = Schema.is(unreachableSchema);

const requestOf = (caller: SelectedCaller, admittedRevision: string): CallRouteRequest => ({
  caller,
  encodedInput: { subject: 'S-1' },
  execution: {
    callerSource: { _tag: 'RequestPrincipal', principal },
    facts: {
      compositionRevision: admittedRevision,
      identity: { _tag: 'Request', via: 'person' },
      operationKey: 'commerce.market-catalog.api.verify-market-eligibility-v1',
      owningModuleKey: 'commerce.market-catalog',
    },
    scope: { ...principal, correlationId: 'correlation-route', traceId: 'trace-route' },
  },
  operation,
  requirement: {
    callers: [],
    compositionRevision: revision,
    provider,
    providerAppId: 'commerce-customer-context',
    requirementKey,
  },
});

interface Sent {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: string;
}

interface Script {
  readonly delegationFails?: boolean;
  /** `none` is a transport failure. */
  readonly response?: Option.Option<Response>;
}

const delegated = {
  apiBaseUrl: 'https://shell.example.test/modules/commerce-customer-context/build-1/customer-context-api',
  authorization: 'Bearer delegated-token' as const,
  compositionRevision: revision,
};

const bodyTextOf = (outgoing: HttpClientRequest.HttpClientRequest): string =>
  Predicate.hasProperty(outgoing.body, 'body') && Predicate.isUint8Array(outgoing.body.body)
    ? new TextDecoder().decode(outgoing.body.body)
    : '';

/** The scope an `Assertion` relays, or none for another subject. */
const assertedScopeOf = (delegation: GatewayDelegationRequest | undefined) =>
  Option.getOrUndefined(
    Option.flatMap(Option.fromUndefinedOr(delegation), ({ subject }) =>
      Match.value(subject).pipe(
        Match.tag('Assertion', ({ scope }) => Option.some(scope)),
        Match.orElse(() => Option.none()),
      ),
    ),
  );

/** The fields of a `RegisteredAssertion`, or none for another subject. */
const registeredOf = (delegation: GatewayDelegationRequest | undefined) =>
  Option.getOrUndefined(
    Option.flatMap(Option.fromUndefinedOr(delegation), ({ subject }) =>
      Match.value(subject).pipe(
        Match.tag('RegisteredAssertion', ({ _tag: _subjectKind, ...fields }) => Option.some(fields)),
        Match.orElse(() => Option.none()),
      ),
    ),
  );

/** Sends one request through the real route over a scripted delegation and HTTP client. */
const sendWith = (script: Script, request: CallRouteRequest) => {
  const delegations: GatewayDelegationRequest[] = [];
  const sent: Sent[] = [];
  const delegation = {
    acquire: (input: GatewayDelegationRequest) => {
      delegations.push(input);
      return script.delegationFails === true
        ? Effect.fail(new GatewayDelegationSourceError({ reason: 'no scope' }))
        : Effect.succeed(delegated);
    },
  };
  const http = HttpClient.make((outgoing, url) => {
    sent.push({
      body: bodyTextOf(outgoing),
      headers: outgoing.headers,
      method: outgoing.method,
      url: url.toString(),
    });
    return Option.match(script.response ?? Option.some(Response.json({ ok: true })), {
      onNone: () =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ description: 'connection refused', request: outgoing }),
          }),
        ),
      onSome: (value) => Effect.succeed(HttpClientResponse.fromWeb(outgoing, value)),
    });
  });
  return makeModuleCallRoute(delegation).pipe(
    Effect.flatMap((route) => route.send(request)),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.map((answer: RouteAnswer) => ({ answer, delegations, sent })),
  );
};

it('joins the delegated API base path and the operation path', () => {
  expect(operationUrl('https://gw.test/modules/a/b/api', '/reads/x').toString()).toBe(
    'https://gw.test/modules/a/b/api/reads/x',
  );
  expect(operationUrl('https://gw.test/api/', '/reads/x').toString()).toBe('https://gw.test/api/reads/x');
});

it.effect('relays a person as an Assertion and sends the governed headers', () =>
  Effect.gen(function* person() {
    const { answer, delegations, sent } = yield* sendWith({}, requestOf(asPerson, revision));
    expect(isAnswered(answer)).toBe(true);
    expect(answer).toMatchObject({ encoded: { ok: true } });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      audience: 'commerce-customer-context',
      legalEntityScope: 'subject',
      requestCorrelation: 'correlation-route',
    });
    expect(assertedScopeOf(delegations[0])).toBe(principal);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ subject: 'S-1' });
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: 'https://shell.example.test/modules/commerce-customer-context/build-1/customer-context-api/reads/subject-restrictions',
    });
    expect(sent[0]?.headers).toMatchObject({
      authorization: 'Bearer delegated-token',
      'x-correlation-id': 'correlation-route',
      'x-ontos-composition-revision': revision,
      'x-trace-id': 'trace-route',
    });
    expect(sent[0]?.headers).not.toHaveProperty('idempotency-key');
  }),
);

it.effect('builds a RegisteredAssertion with the requirement, the pinned principal and the recovery hash', () =>
  Effect.gen(function* registered() {
    const pinned = yield* sendWith(
      {},
      requestOf(
        {
          declarationKey,
          expectedPrincipalId: principalId,
          kind: 'registered',
          legalEntityScope: 'tenant',
          recoveryRequestHash: 'f'.repeat(64),
        },
        revision,
      ),
    );
    expect(pinned.delegations[0]?.legalEntityScope).toBe('tenant');
    expect(registeredOf(pinned.delegations[0])).toEqual({
      declarationKey,
      expectedPrincipalId: principalId,
      operationRequirementKey: requirementKey,
      recoveryRequestHash: 'f'.repeat(64),
      scope: principal,
    });
    const plain = yield* sendWith(
      {},
      requestOf({ declarationKey, kind: 'registered', legalEntityScope: 'tenant' }, revision),
    );
    expect(registeredOf(plain.delegations[0])).toEqual({
      declarationKey,
      operationRequirementKey: requirementKey,
      scope: principal,
    });
  }),
);

it.effect('refuses a delegation under another revision and maps a delegation failure to Unreachable', () =>
  Effect.gen(function* revisionAndDelegation() {
    const mismatch = yield* sendWith({}, requestOf(asPerson, 'b'.repeat(64)));
    expect(isProblem(mismatch.answer)).toBe(true);
    expect(mismatch.answer).toMatchObject({ code: 'composition_revision_mismatch', status: 503 });
    expect(mismatch.sent).toHaveLength(0);

    const failing = yield* sendWith({ delegationFails: true }, requestOf(asPerson, revision));
    expect(isUnreachable(failing.answer)).toBe(true);
    expect(failing.sent).toHaveLength(0);
  }),
);

it.effect('reports a provider problem with its status and code, and a transport failure as Unreachable', () =>
  Effect.gen(function* providerAnswers() {
    const rejected = yield* sendWith(
      {
        response: Option.some(
          Response.json(
            { _tag: 'StaleOffer', detail: 'The offer changed', reasonCode: 'stale_offer' },
            { status: 409 },
          ),
        ),
      },
      requestOf(asPerson, revision),
    );
    expect(isProblem(rejected.answer)).toBe(true);
    expect(rejected.answer).toMatchObject({ code: 'stale_offer', reason: 'The offer changed', status: 409 });

    const missing = yield* sendWith(
      { response: Option.some(new Response('not found', { status: 404 })) },
      requestOf(asPerson, revision),
    );
    expect(isProblem(missing.answer)).toBe(true);
    expect(missing.answer).toMatchObject({ status: 404 });

    const down = yield* sendWith({ response: Option.none() }, requestOf(asPerson, revision));
    expect(isUnreachable(down.answer)).toBe(true);
  }),
);

it.effect('answers Unreachable when the provider sends its headers and then stalls the body', () =>
  Effect.gen(function* stalledBody() {
    // Headers arrive at once; the body never ends.
    const stalled = new Response(new ReadableStream<Uint8Array>(), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
    const fiber = yield* Effect.forkChild(sendWith({ response: Option.some(stalled) }, requestOf(asPerson, revision)));
    yield* TestClock.adjust('21 seconds');
    const { answer, sent } = yield* Fiber.join(fiber);
    expect(sent).toHaveLength(1);
    expect(isUnreachable(answer)).toBe(true);
  }),
);

it.effect(
  'answers Unreachable when the body breaks after 200 headers, and unreadable for a body that is not JSON',
  () =>
    Effect.gen(function* brokenBody() {
      const broken = new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => {
            controller.error(new Error('connection reset'));
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
      const reset = yield* sendWith({ response: Option.some(broken) }, requestOf(asPerson, revision));
      expect(isUnreachable(reset.answer)).toBe(true);

      const garbled = yield* sendWith(
        { response: Option.some(new Response('{"ok":', { status: 200 })) },
        requestOf(asPerson, revision),
      );
      expect(isProblem(garbled.answer)).toBe(true);
      expect(garbled.answer).toMatchObject({ code: 'provider_answer_unreadable', status: 502 });
    }),
);

it.effect('sends the idempotency key of a write call', () =>
  Effect.gen(function* idempotency() {
    const { sent } = yield* sendWith({}, { ...requestOf(asPerson, revision), idempotencyKey: 'key-1' });
    expect(sent[0]?.headers).toMatchObject({ 'idempotency-key': 'key-1' });
  }),
);
