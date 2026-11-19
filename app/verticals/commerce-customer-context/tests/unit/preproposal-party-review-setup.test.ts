import { readFile } from 'node:fs/promises';
import {
  CreatePartyPayloadSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
  PartyCommandUnprocessableProblemSchema,
  CreatePartyResultSchema,
  DuplicateCandidateDetailResponseSchema,
  PartyMatchDecisionResponseSchema,
  ResolveDuplicateCandidateCreateResultSchema,
} from '@app/party-registry/api';
import { counterpartyCustomerOnboardWithAuthorization } from '@app/party-registry/api/client';
import { Effect, Exit, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { Headers } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  createRegisteredPreproposalParty,
  PreproposalNativeProtocolError,
} from '../support/preproposal-basis-native.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reference = (kind: string, resourceId: string) => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: `party.registry.${kind}`,
  tenantId,
});
const caseRef = reference('duplicate-candidate-case', '22222222-2222-4222-8222-222222222222');
const initialRef = reference('party-match-decision', '33333333-3333-4333-8333-333333333333');
const reviewedRef = reference('party-match-decision', '44444444-4444-4444-8444-444444444444');
const partyRef = reference('party', '55555555-5555-4555-8555-555555555555');
const candidate = {
  evidenceRefs: ['unit-attestation'],
  firstName: 'Unit-only reviewed human customer',
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: { method: 'DIRECT_INTERACTION', source: 'unit-only' },
  subjectEvidence: [
    {
      basis: 'DIRECT_INTERACTION',
      evidenceRef: 'unit-attestation',
      kind: 'ACTOR_ATTESTATION',
      observedSubject: 'PERSON',
      statement: 'Operator attests the concrete human subject',
      subjectKey: 'unit-subject',
    },
  ],
  validFrom: '2026-10-24T00:00:00.000Z',
};
const payload = Schema.decodeUnknownSync(CreatePartyPayloadSchema)({ candidate });
const ambiguous = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  caseRef,
  decisionRef: initialRef,
  outcome: 'AMBIGUOUS',
});
const direct = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  decisionRef: initialRef,
  outcome: 'CREATED',
  partyRef,
});
const explanations = [
  { evidenceRefs: candidate.evidenceRefs, reason: 'No exclusive identifier; review required', ruleKey: 'unit-rule' },
];
const detail = Schema.decodeUnknownSync(DuplicateCandidateDetailResponseSchema)({
  candidate,
  candidateParties: [],
  caseRef,
  evaluatedEvidence: explanations,
  lifecycleState: 'OPEN',
  matchRuleVersion: 'unit-rule',
  priorCaseRef: null,
  resolutionOutcome: null,
  resolutionReason: null,
  resolvedAt: null,
  revision: 7,
});
const evidenceEvaluation = {
  evidence: candidate.subjectEvidence,
  reasonCode: 'supported',
  subjectEligibilityVersion: 'party-concrete-subject.v1',
  subjectEligible: true,
  typeRuleVersion: 'party-subject-type.v1',
  typeSupported: true,
};
const originalDecision = Schema.decodeUnknownSync(PartyMatchDecisionResponseSchema)({
  caseRef,
  committedCreateOutcome: 'AMBIGUOUS',
  decidedAt: candidate.validFrom,
  decisionRef: initialRef,
  evidenceEvaluation,
  evidenceExplanation: explanations,
  matchRuleVersion: 'unit-rule',
  operation: 'CREATE',
  outcome: 'AMBIGUOUS',
  partyRef: null,
});
const createdDecision = Schema.decodeUnknownSync(PartyMatchDecisionResponseSchema)({
  ...originalDecision,
  caseRef: null,
  committedCreateOutcome: 'CREATED',
  decisionRef: reviewedRef,
  operation: 'REVIEW_CREATE',
  outcome: 'CREATED',
  partyRef,
});
const review = Schema.decodeUnknownSync(ResolveDuplicateCandidateCreateResultSchema)({
  caseRef,
  decisionRef: reviewedRef,
  lifecycleState: 'RESOLVED',
  outcome: 'CREATE_NEW',
  partyRef,
});
const options = { baseUrl: 'https://party.unit.invalid/party-registry-api', compositionRevision: 'unit-composition' };

// The actual published Party Registry clients run over this fake owner peer. Each case scripts the replies a
// route gives, in order, and every request is kept with its headers and JSON body for assertions.
const routeTable = [
  ['create', '/party-registry/actions/create-party'],
  ['decision', '/reads/party-match-decision'],
  ['detail', '/reads/duplicate-candidate-detail'],
  ['onboard', '/party-registry/actions/counterparty-customer-onboard'],
  ['review', '/party-registry/actions/resolve-duplicate-candidate-create'],
] as const;
type Route = (typeof routeTable)[number][0];
interface SentRequest {
  readonly body: Schema.Json;
  readonly headers: Headers.Headers;
  readonly route: Route | 'unknown';
}
/** Answers one request from the request the real client sent. */
type Reply = (request: SentRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse>;

const json = <Type, Encoded>(schema: Schema.Codec<Type, Encoded>, value: Type, status = 200) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(schema)(value), {
    contentType: status < 400 ? 'application/json' : 'application/problem+json',
    status,
  });
const reply =
  <Type, Encoded>(schema: Schema.Codec<Type, Encoded>, value: Type): Reply =>
  () =>
    Effect.sync(() => json(schema, value));

const makePartyRegistryPeer = Effect.fn('PartyRegistryPeer.make')(function* makePartyRegistryPeer(
  script: Partial<Record<Route, readonly Reply[]>>,
) {
  const pending = new Map(Object.entries(script).map(([route, replies]) => [route, [...replies]]));
  const sent: SentRequest[] = [];
  const answer = Effect.gen(function* answer() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const route = routeTable.find(([, path]) => request.url.endsWith(path))?.[0] ?? 'unknown';
    const received: SentRequest = { body: yield* Effect.orDie(request.json), headers: request.headers, route };
    sent.push(received);
    const scripted = pending.get(route)?.shift();
    return scripted === undefined
      ? HttpServerResponse.jsonUnsafe(
          { detail: `No scripted Party Registry reply for ${request.url}` },
          { status: 500 },
        )
      : yield* scripted(received);
  });
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(HttpRouter.add('*', '/*', answer), { disableLogger: true })),
    (resource) => Effect.promise(() => resource.dispose()),
  );
  const fetch: typeof globalThis.fetch = (input, init) => server.handler(new Request(input, init));
  const to = (route: Route) => sent.filter((request) => request.route === route);
  return { fetch, routes: () => sent.map((request) => request.route), sent: to };
});
type PartyRegistryPeer = Effect.Success<ReturnType<typeof makePartyRegistryPeer>>;

const reviewedScript = {
  create: [reply(CreatePartyResultSchema, ambiguous)],
  decision: [
    reply(PartyMatchDecisionResponseSchema, originalDecision),
    reply(PartyMatchDecisionResponseSchema, createdDecision),
    reply(PartyMatchDecisionResponseSchema, originalDecision),
  ],
  detail: [reply(DuplicateCandidateDetailResponseSchema, detail)],
  review: [reply(ResolveDuplicateCandidateCreateResultSchema, review)],
} satisfies Partial<Record<Route, readonly Reply[]>>;

const setup = (peer: PartyRegistryPeer, legalEntities: boolean[] = []) =>
  createRegisteredPreproposalParty({
    authorize: (legalEntity) =>
      Effect.sync(() => {
        legalEntities.push(legalEntity);
        return Redacted.make(`unit-manager-${legalEntity ? 'le' : 'tenant'}-assertion-${legalEntities.length}`);
      }),
    intent: 'unit-setup',
    options,
    payload,
    tenantId,
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, peer.fetch));

const refusal = (peer: PartyRegistryPeer) =>
  setup(peer).pipe(Effect.flip, Effect.flatMap(Schema.decodeUnknownEffect(PreproposalNativeProtocolError)));

it.effect('keeps a direct CREATED result without review or evidence reads', () =>
  Effect.gen(function* directCreated() {
    const peer = yield* makePartyRegistryPeer({ create: [reply(CreatePartyResultSchema, direct)] });
    const credentials: boolean[] = [];
    const result = yield* setup(peer, credentials);
    expect(result.initialCreate).toEqual(direct);
    expect(result.partyRef).toEqual(partyRef);
    expect(credentials).toEqual([false]);
    expect(peer.routes()).toEqual(['create']);
  }),
);

it.effect(
  'uses actual case revision, fresh LE manager assertions, real review decision and unchanged original history',
  () =>
    Effect.gen(function* reviewedCreate() {
      const peer = yield* makePartyRegistryPeer(reviewedScript);
      const credentials: boolean[] = [];
      const result = yield* setup(peer, credentials);
      expect(result.initialCreate).toEqual(ambiguous);
      expect(result.partyRef).toEqual(createdDecision.partyRef);
      expect(credentials).toEqual([false, true, true, true, true, true]);
      expect(peer.routes()).toEqual(['create', 'detail', 'decision', 'review', 'decision', 'decision']);
      const [create] = peer.sent('create');
      expect(create?.body).toEqual(Schema.encodeSync(CreatePartyPayloadSchema)(payload));
      expect(create?.headers.authorization).toBe('unit-manager-tenant-assertion-1');
      expect(create?.headers['x-correlation-id']).toBe('unit-setup:party');
      expect(create?.headers['idempotency-key']).toBe('unit-setup:party');
      expect(create?.headers['x-ontos-composition-revision']).toBe(options.compositionRevision);
      const [read] = peer.sent('detail');
      expect(read?.body).toEqual({ caseRef });
      expect(read?.headers.authorization).toBe('unit-manager-le-assertion-2');
      expect(read?.headers['x-correlation-id']).toBe('unit-setup:party-review-detail');
      const [resolve] = peer.sent('review');
      expect(resolve?.body).toEqual({
        caseRef,
        expectedRevision: 7,
        reason: expect.stringContaining('original direct-interaction PERSON attestation'),
      });
      expect(resolve?.headers.authorization).toBe('unit-manager-le-assertion-4');
      expect(resolve?.headers['x-correlation-id']).toBe('unit-setup:party-review-create');
      expect(resolve?.headers['idempotency-key']).toBe('unit-setup:party-review-create');
      const decisions = peer.sent('decision');
      expect(decisions.map(({ body }) => body)).toEqual([
        { decisionRef: initialRef },
        { decisionRef: reviewedRef },
        { decisionRef: initialRef },
      ]);
      expect(decisions.map(({ headers }) => headers.authorization)).toEqual([
        'unit-manager-le-assertion-3',
        'unit-manager-le-assertion-5',
        'unit-manager-le-assertion-6',
      ]);
    }),
);

it.effect('refuses MATCHED_EXISTING with the actual typed outcome and reason', () =>
  Effect.gen(function* matchedExisting() {
    const matched = Schema.decodeUnknownSync(CreatePartyResultSchema)({
      decisionRef: initialRef,
      outcome: 'MATCHED_EXISTING',
      partyRef,
    });
    const peer = yield* makePartyRegistryPeer({ create: [reply(CreatePartyResultSchema, matched)] });
    const failure = yield* refusal(peer);
    expect(failure.message).toContain('MATCHED_EXISTING');
    expect(failure.message).toContain('matching is not creation');
    expect(peer.routes()).toEqual(['create']);
  }),
);

it.effect('refuses a different case candidate before review', () =>
  Effect.gen(function* wrongCandidate() {
    const peer = yield* makePartyRegistryPeer({
      ...reviewedScript,
      detail: [
        reply(DuplicateCandidateDetailResponseSchema, {
          ...detail,
          candidate: { ...detail.candidate, firstName: 'Another subject' },
        }),
      ],
    });
    const failure = yield* refusal(peer);
    expect(failure.message).toContain('originating open case, candidate and evidence');
    expect(peer.routes()).toEqual(['create', 'detail']);
  }),
);

it.effect('refuses a review result tied to another originating case', () =>
  Effect.gen(function* wrongReviewCase() {
    const peer = yield* makePartyRegistryPeer({
      ...reviewedScript,
      review: [
        reply(ResolveDuplicateCandidateCreateResultSchema, {
          ...review,
          caseRef: { ...review.caseRef, resourceId: detail.caseRef.resourceId.replace('2', '6') },
        }),
      ],
    });
    const failure = yield* refusal(peer);
    expect(failure.message).toContain('originating case and tenant');
    expect(peer.routes()).toEqual(['create', 'detail', 'decision', 'review']);
  }),
);

it.effect('does not synthesize CREATED from a non-created public review decision', () =>
  Effect.gen(function* wrongDecision() {
    const matchedDecision = Schema.decodeUnknownSync(PartyMatchDecisionResponseSchema)({
      ...createdDecision,
      committedCreateOutcome: 'MATCHED_EXISTING',
      outcome: 'MATCHED',
    });
    const peer = yield* makePartyRegistryPeer({
      ...reviewedScript,
      decision: [
        reply(PartyMatchDecisionResponseSchema, originalDecision),
        reply(PartyMatchDecisionResponseSchema, matchedDecision),
      ],
    });
    const failure = yield* refusal(peer);
    expect(failure.message).toContain('MATCHED');
    expect(failure.message).toContain('literal CREATED');
    expect(peer.routes()).toEqual(['create', 'detail', 'decision', 'review', 'decision']);
  }),
);

it.effect('refuses altered original create decision history', () =>
  Effect.gen(function* changedHistory() {
    const peer = yield* makePartyRegistryPeer({
      ...reviewedScript,
      decision: [
        reply(PartyMatchDecisionResponseSchema, originalDecision),
        reply(PartyMatchDecisionResponseSchema, createdDecision),
        reply(PartyMatchDecisionResponseSchema, { ...originalDecision, matchRuleVersion: 'changed-rule' }),
      ],
    });
    const failure = yield* refusal(peer);
    expect(failure.message).toContain('original create decision history');
  }),
);

it.effect('keeps review execution authority in manager setup and out of service action keys', () =>
  Effect.gen(function* setupGrantScope() {
    const source = yield* Effect.tryPromise(() =>
      readFile(new URL('../support/preproposal-basis-native.ts', import.meta.url), 'utf-8'),
    );
    const nativeKeys = source.slice(
      source.indexOf('const nativeActionKeys = ['),
      source.indexOf('const identitySetupActionKeys ='),
    );
    expect(nativeKeys).not.toContain('party.registry.resolve-duplicate-candidate-create');
    expect(source).toContain("const partySetupActionKeys = ['party.registry.resolve-duplicate-candidate-create']");
    expect(source).toContain('actionKeys: [...nativeActionKeys, ...identitySetupActionKeys, ...partySetupActionKeys]');
    expect(source).toContain('authorize: (legalEntity) => signBuyer(partyAudience, legalEntity, false)');
  }),
);

for (const missing of ['partyRef', 'decisionRef']) {
  it.effect(`refuses a review without its ${missing} proof`, () =>
    Effect.gen(function* absentReviewProof() {
      const unproven = Schema.decodeUnknownSync(ResolveDuplicateCandidateCreateResultSchema)({
        ...review,
        [missing]: null,
      });
      const peer = yield* makePartyRegistryPeer({
        ...reviewedScript,
        review: [reply(ResolveDuplicateCandidateCreateResultSchema, unproven)],
      });
      const failure = yield* refusal(peer);
      expect(failure.message).toContain('CREATE_NEW');
      expect(failure.message).toContain('Review must create a new Party and decision');
      expect(peer.routes()).toEqual(['create', 'detail', 'decision', 'review']);
    }),
  );
}

const approvedOnboarding = Schema.decodeUnknownSync(CounterpartyCustomerOnboardPayloadSchema)({
  counterpartyProvenance: {
    evidenceReference: 'unit:commercial-approval',
    method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
    reason: 'Operator approves this isolated commercial relationship with the selling Legal Entity',
    source: 'NATIVE_REGISTERED_OWNER_PROOF',
  },
  customerEvidence: {
    evidenceReference: 'unit:customer-approval',
    method: 'APPROVED_PURCHASING_RELATIONSHIP',
    reason: 'Operator approves this isolated CUSTOMER purchasing relationship',
    source: 'NATIVE_REGISTERED_OWNER_PROOF',
  },
  partyRef,
  validFrom: candidate.validFrom,
});
const onboardingRefusal = Schema.decodeUnknownSync(PartyCommandUnprocessableProblemSchema)({
  _tag: 'PartyCommandUnprocessableProblem',
  code: 'counterparty_evidence_insufficient',
  detail: 'The evidence does not establish both a commercial context and a CUSTOMER relationship',
  status: 422,
  title: 'Counterparty evidence insufficient',
  type: 'https://unit.invalid/problems/counterparty-evidence-insufficient',
});
const onboardingResult = Schema.decodeUnknownSync(CounterpartyCustomerOnboardResultSchema)({
  counterpartyCreated: true,
  counterpartyRef: reference('counterparty', '66666666-6666-4666-8666-666666666666'),
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  partyRef,
  rolePeriodCreated: true,
  rolePeriodRef: reference('counterparty-role-period', '88888888-8888-4888-8888-888888888888'),
  roleType: 'CUSTOMER',
  validFrom: candidate.validFrom,
  validTo: null,
});
// The owner peer answers the onboarding action like the owner's evidence predicate: only the two explicit approvals
// onboard; any other method is the owner's typed 422. The real published client decodes either reply.
const onboardingPeer = () =>
  makePartyRegistryPeer({
    onboard: [
      (request) =>
        Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)(request.body).pipe(
          Effect.orDie,
          Effect.map((input) =>
            input.counterpartyProvenance.method === 'APPROVED_COMMERCIAL_RELATIONSHIP' &&
            input.customerEvidence.method === 'APPROVED_PURCHASING_RELATIONSHIP'
              ? json(CounterpartyCustomerOnboardResultSchema, onboardingResult)
              : json(PartyCommandUnprocessableProblemSchema, onboardingRefusal, 422),
          ),
        ),
    ],
  });

it.effect('the native onboarding caller supplies separate explicit commercial and CUSTOMER approvals', () =>
  Effect.gen(function* nativeApprovalPayload() {
    const peer = yield* onboardingPeer();
    const source = yield* Effect.tryPromise(() =>
      readFile(new URL('../support/preproposal-basis-native.ts', import.meta.url), 'utf-8'),
    );
    const block = source.slice(
      source.indexOf('    const onboardPayload ='),
      source.indexOf('    const counterparty ='),
    );
    // Read the actual source-caller inputs without evaluating the private fixture or owner code.
    const input = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
      ...approvedOnboarding,
      counterpartyProvenance: {
        ...approvedOnboarding.counterpartyProvenance,
        method: /counterpartyProvenance:\s*\{[\s\S]*?method: '(?<method>[^']+)'/u.exec(block)?.[1],
        reason: /counterpartyProvenance:\s*\{[\s\S]*?reason: '(?<reason>[^']+)'/u.exec(block)?.[1],
      },
      customerEvidence: {
        ...approvedOnboarding.customerEvidence,
        method: /customerEvidence:\s*\{[\s\S]*?method: '(?<method>[^']+)'/u.exec(block)?.[1],
        reason: /customerEvidence:\s*\{[\s\S]*?reason: '(?<reason>[^']+)'/u.exec(block)?.[1],
      },
    });
    const result = yield* counterpartyCustomerOnboardWithAuthorization(input, 'unit-manager-le-onboarding', {
      ...options,
      correlationId: 'unit:customer',
      idempotencyKey: 'unit:customer',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, peer.fetch), Effect.exit);
    expect(result).toEqual(Exit.succeed(onboardingResult));
    expect(input.counterpartyProvenance.method).toBe('APPROVED_COMMERCIAL_RELATIONSHIP');
    expect(input.customerEvidence.method).toBe('APPROVED_PURCHASING_RELATIONSHIP');
    expect(input.counterpartyProvenance.reason).toContain('Operator approves this isolated commercial relationship');
    expect(input.customerEvidence.reason).toContain('Operator approves this isolated CUSTOMER purchasing relationship');
    expect(input.counterpartyProvenance.evidenceReference).not.toBe(input.customerEvidence.evidenceReference);
  }),
);

for (const field of ['counterpartyProvenance', 'customerEvidence']) {
  it.effect(`unit public transport preserves typed422 for unsupported ${field}`, () =>
    Effect.gen(function* unapprovedRelationship() {
      const peer = yield* onboardingPeer();
      const input = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
        ...approvedOnboarding,
        [field]: {
          ...(field === 'counterpartyProvenance'
            ? approvedOnboarding.counterpartyProvenance
            : approvedOnboarding.customerEvidence),
          method: 'OPERATOR_ATTESTATION',
        },
      });
      const refused = yield* counterpartyCustomerOnboardWithAuthorization(input, 'unit-manager-le-onboarding', {
        ...options,
        correlationId: 'unit:rejected-customer',
        idempotencyKey: 'unit:rejected-customer',
      }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, peer.fetch),
        Effect.flip,
        Effect.flatMap(Schema.decodeUnknownEffect(PartyCommandUnprocessableProblemSchema)),
      );
      expect(refused.code).toBe('counterparty_evidence_insufficient');
      expect(refused.status).toBe(422);
      expect(refused.detail).toBe(onboardingRefusal.detail);
    }),
  );
}

it.effect('grants module credentials no Core permission between onboarding and profile creation', () =>
  Effect.gen(function* nativeCounterpartyReaderSetup() {
    const source = yield* Effect.tryPromise(() =>
      readFile(new URL('../support/preproposal-basis-native.ts', import.meta.url), 'utf-8'),
    );
    const onboardStart = source.indexOf(
      '    const counterparty = yield* counterpartyCustomerOnboardWithAuthorization(',
    );
    const profileCredential = source.indexOf(
      "    const profileCredential = yield* authorize('operator', contextAudience);",
      onboardStart,
    );
    const profileCreate = source.indexOf('    const profile = yield* requireExecutionResult(', profileCredential);
    // A module call is admitted by its declared actor and the buyer's subject, so no service principal is granted.
    const window = source.slice(onboardStart, profileCredential);
    expect(onboardStart).toBeGreaterThanOrEqual(0);
    expect(profileCredential).toBeGreaterThan(onboardStart);
    expect(profileCreate).toBeGreaterThan(profileCredential);
    expect(window).not.toContain('identities.cccReader.principalId');
    expect(window).not.toContain('identities.pricingIssuer.principalId');
    expect(window.match(/core\.grantResourceAccess\(/gu)).toBeNull();
  }),
);
