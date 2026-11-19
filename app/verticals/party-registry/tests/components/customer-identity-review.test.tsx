// @rstest-environment happy-dom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';

import { moduleChangeEvent, moduleWriteEvent } from '@app/shared-contracts/page-data';

import {
  DuplicateCandidateDetailApi,
  DuplicateCandidateDetailForbiddenProblemSchema,
  DuplicateCandidateDetailResponseSchema,
} from '../../shared/apis/duplicate-candidate-detail.ts';
import {
  DuplicateCandidateListApi,
  DuplicateCandidateListForbiddenProblemSchema,
  DuplicateCandidateListUnavailableProblemSchema,
} from '../../shared/apis/duplicate-candidate-list.ts';
import { PartyDetailApi, PartyDetailForbiddenProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import {
  partyRegistryCommandsApi,
  partyRegistryCommandRecoveryApi,
  PartyCommandConflictProblemSchema,
  PartyCommandForbiddenProblemSchema,
  PartyCommandUnavailableProblemSchema,
} from '../../shared/command-api.ts';
import type { executeDuplicateCandidateList } from '../../src/api/duplicate-candidate-list-client.ts';
import type { executeDuplicateCandidateDetail } from '../../src/api/duplicate-candidate-detail-client.ts';
import type { executePartyDetail } from '../../src/api/party-detail-client.ts';
import type { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import type {
  dismissDuplicateCandidate,
  markDuplicateCandidateNeedsEvidence,
  resolveDuplicateCandidateCreate,
  resolveDuplicateCandidateMatch,
  resolvePartyCommandCommit,
} from '../../src/api/party-command-client.ts';
import { useCustomerIdentityReview } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import { CustomerIdentityReviewPanel } from '../../src/routes/[lang]/prodej/zakaznici/customer-identity-review-panel.tsx';
import { expectHumanReadable } from '../support/visible-text.ts';

import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { mountInRoute, moduleText } from '../support/module-ui.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import { partyCommandSchemaErrorLive } from '../../api/party-command-problems.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const instant = '2026-10-15T10:00:00.000Z';
const candidateCase = Schema.decodeSync(DuplicateCandidateDetailResponseSchema)({
  candidate: {
    evidenceRefs: ['signup:42'],
    firstName: 'Submitted identity',
    officialIdentifiers: [],
    partyType: 'PERSON',
    provenance: { method: 'MANUAL_ENTRY', source: 'signup' },
    subjectEvidence: [],
    validFrom: instant,
  },
  candidateParties: [partyRef],
  caseRef: {
    ...partyRef,
    resourceId: '30000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.duplicate-candidate-case',
  },
  evaluatedEvidence: [],
  lifecycleState: 'OPEN',
  matchRuleVersion: 'party-exact-claims.v1',
  priorCaseRef: null,
  resolutionOutcome: null,
  resolutionReason: null,
  resolvedAt: null,
  revision: 3,
});
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  businessName: null,
  createdAt: instant,
  displayName: 'Existing identity',
  firstName: 'Existing identity',
  lastName: null,
  partyRef,
  partyType: 'PERSON',
  revision: 2,
  updatedAt: instant,
});
const queue = {
  items: [
    { caseRef: candidateCase.caseRef, displayName: 'Submitted identity', lifecycleState: 'OPEN' as const, revision: 3 },
  ],
  nextCaseRef: null,
};
const matched = {
  caseRef: candidateCase.caseRef,
  decisionRef: null,
  lifecycleState: 'RESOLVED' as const,
  outcome: 'MATCH_EXISTING' as const,
  partyRef,
};
const resolved: true[] = [];
const onResolved = () => {
  resolved.push(true);
};
type ReviewModel = ReturnType<typeof useCustomerIdentityReview>;
const renderReview = () =>
  Effect.gen(function* mountReview() {
    let current: ReviewModel | undefined;
    const Harness = () => {
      current = useCustomerIdentityReview(onResolved);
      return null;
    };
    yield* mountInRoute(<Harness />, { path: 'prodej/zakaznici', url: '/cs/prodej/zakaznici' });
    return {
      result: {
        get current(): ReviewModel {
          if (current === undefined) {
            throw new Error('Review was not mounted');
          }
          return current;
        },
      },
    };
  });
type Review = Effect.Success<ReturnType<typeof renderReview>>;
const renderPanel = (review: ReviewModel) =>
  mountInRoute(<CustomerIdentityReviewPanel review={review} />, {
    path: 'prodej/zakaznici',
    url: '/cs/prodej/zakaznici',
  });
const opened = (review: Review) =>
  Effect.gen(function* openReview() {
    act(() => review.result.current.openReview());
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.queue.status).toBe('ready')));
    act(() => review.result.current.selectCase(candidateCase.caseRef));
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.detail.status).toBe('ready')));
  });
const prepare = (review: Review) =>
  act(() => {
    review.result.current.setReason('Reviewed the signup evidence');
    review.result.current.setSelectedPartyId(partyRef.resourceId);
  });

type ListAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof executeDuplicateCandidateList>>,
  typeof DuplicateCandidateListForbiddenProblemSchema.Type | typeof DuplicateCandidateListUnavailableProblemSchema.Type
>;
let listAnswer: ListAnswer;
const listNext: ListAnswer[] = [];
const listCalls: Parameters<typeof executeDuplicateCandidateList>[0][] = [];
type DetailAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof executeDuplicateCandidateDetail>>,
  typeof DuplicateCandidateDetailForbiddenProblemSchema.Type
>;
let detailAnswer: DetailAnswer;
const detailNext: DetailAnswer[] = [];
const detailCalls: Parameters<typeof executeDuplicateCandidateDetail>[0][] = [];
type IdentityAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof executePartyDetail>>,
  typeof PartyDetailForbiddenProblemSchema.Type
>;
let identityAnswer: IdentityAnswer;
const identityNext: IdentityAnswer[] = [];
type ContactsAnswer = Effect.Effect<Effect.Success<ReturnType<typeof executePartyContactPoints>>>;
let contactsAnswer: ContactsAnswer;
const contactsNext: ContactsAnswer[] = [];
type MatchAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof resolveDuplicateCandidateMatch>>,
  | typeof PartyCommandForbiddenProblemSchema.Type
  | typeof PartyCommandConflictProblemSchema.Type
  | typeof PartyCommandUnavailableProblemSchema.Type
>;
let matchAnswer: MatchAnswer;
const matchNext: MatchAnswer[] = [];
const matchCalls: (readonly [
  Parameters<typeof resolveDuplicateCandidateMatch>[0],
  { readonly correlationId: string | undefined; readonly idempotencyKey: string | undefined },
])[] = [];
type CreateAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof resolveDuplicateCandidateCreate>>,
  | typeof PartyCommandForbiddenProblemSchema.Type
  | typeof PartyCommandConflictProblemSchema.Type
  | typeof PartyCommandUnavailableProblemSchema.Type
>;
let createAnswer: CreateAnswer;
const createNext: CreateAnswer[] = [];
const createCalls: (readonly [
  Parameters<typeof resolveDuplicateCandidateCreate>[0],
  { readonly correlationId: string | undefined; readonly idempotencyKey: string | undefined },
])[] = [];
type EvidenceAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof markDuplicateCandidateNeedsEvidence>>,
  | typeof PartyCommandForbiddenProblemSchema.Type
  | typeof PartyCommandConflictProblemSchema.Type
  | typeof PartyCommandUnavailableProblemSchema.Type
>;
let evidenceAnswer: EvidenceAnswer;
const evidenceNext: EvidenceAnswer[] = [];
const evidenceCalls: (readonly [
  Parameters<typeof markDuplicateCandidateNeedsEvidence>[0],
  { readonly correlationId: string | undefined; readonly idempotencyKey: string | undefined },
])[] = [];
type DismissAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof dismissDuplicateCandidate>>,
  | typeof PartyCommandForbiddenProblemSchema.Type
  | typeof PartyCommandConflictProblemSchema.Type
  | typeof PartyCommandUnavailableProblemSchema.Type
>;
let dismissAnswer: DismissAnswer;
const dismissNext: DismissAnswer[] = [];
const dismissCalls: (readonly [
  Parameters<typeof dismissDuplicateCandidate>[0],
  { readonly correlationId: string | undefined; readonly idempotencyKey: string | undefined },
])[] = [];
type CommitAnswer = Effect.Effect<
  Effect.Success<ReturnType<typeof resolvePartyCommandCommit>>,
  | typeof PartyCommandForbiddenProblemSchema.Type
  | typeof PartyCommandConflictProblemSchema.Type
  | typeof PartyCommandUnavailableProblemSchema.Type
>;
let commitAnswer: CommitAnswer;
const commitNext: CommitAnswer[] = [];
const commitCalls: (readonly [
  Parameters<typeof resolvePartyCommandCommit>[0],
  { readonly correlationId: string | undefined; readonly idempotencyKey: string | undefined },
])[] = [];
let identityRead: ((input: Parameters<typeof executePartyDetail>[0]) => IdentityAnswer) | null;
beforeEach(() => {
  resolved.length = 0;
  listAnswer = Effect.succeed(queue);
  detailAnswer = Effect.succeed(candidateCase);
  identityAnswer = Effect.succeed({
    currentFactAssertions: [],
    party,
    resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
  });
  identityRead = null;
  contactsAnswer = Effect.succeed({ items: [] });
  matchAnswer = Effect.succeed(matched);
  createAnswer = Effect.succeed({ ...matched, outcome: 'CREATE_NEW' });
  evidenceAnswer = Effect.succeed({
    ...matched,
    lifecycleState: 'NEEDS_EVIDENCE',
    outcome: 'NEEDS_EVIDENCE',
    partyRef: null,
  });
  dismissAnswer = Effect.succeed({
    ...matched,
    lifecycleState: 'DISMISSED',
    outcome: 'DISMISSED_AS_NON_SUBJECT',
    partyRef: null,
  });
  commitAnswer = Effect.succeed({ _tag: 'PartyCommandCommitResolution', retryCommand: true, state: 'NOT_STARTED' });

  listCalls.length = 0;
  listNext.length = 0;
  detailCalls.length = 0;
  detailNext.length = 0;
  identityNext.length = 0;
  contactsNext.length = 0;
  matchCalls.length = 0;
  matchNext.length = 0;
  createCalls.length = 0;
  createNext.length = 0;
  evidenceCalls.length = 0;
  evidenceNext.length = 0;
  dismissCalls.length = 0;
  dismissNext.length = 0;
  commitCalls.length = 0;
  commitNext.length = 0;
});
const listApi = DuplicateCandidateListApi.prefix('/party-registry-api');
const detailApi = DuplicateCandidateDetailApi.prefix('/party-registry-api');
const identityApi = PartyDetailApi.prefix('/party-registry-api');
const contactsApi = PartyContactPointsApi.prefix('/party-registry-api');
const commandApi = partyRegistryCommandsApi.prefix('/party-registry-api');
const recoveryApi = partyRegistryCommandRecoveryApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    listApi,
    HttpApiBuilder.group(listApi, 'duplicateCandidateList', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          listCalls.push(payload);
          return listNext.shift() ?? listAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    detailApi,
    HttpApiBuilder.group(detailApi, 'duplicateCandidateDetail', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          detailCalls.push(payload);
          return detailNext.shift() ?? detailAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    identityApi,
    HttpApiBuilder.group(identityApi, 'partyDetail', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.suspend(() => identityNext.shift() ?? identityRead?.(payload) ?? identityAnswer),
      ),
    ),
  ),
  serveApi(
    contactsApi,
    HttpApiBuilder.group(contactsApi, 'partyContactPoints', (g) =>
      g.handle('execute', () => Effect.suspend(() => contactsNext.shift() ?? contactsAnswer)),
    ),
  ),
  serveApi(
    commandApi,
    HttpApiBuilder.group(commandApi, 'partyCommands', (g) =>
      g
        .handle('acceptRetailEnrollmentEvidence', () => Effect.die('Unexpected acceptRetailEnrollmentEvidence'))
        .handle('addContactPoint', () => Effect.die('Unexpected addContactPoint'))
        .handle('addPartyOfficialIdentifier', () => Effect.die('Unexpected addPartyOfficialIdentifier'))
        .handle('archiveParty', () => Effect.die('Unexpected archiveParty'))
        .handle('confirmDuplicateParties', () => Effect.die('Unexpected confirmDuplicateParties'))
        .handle('correctPartyFact', () => Effect.die('Unexpected correctPartyFact'))
        .handle('counterpartyCreate', () => Effect.die('Unexpected counterpartyCreate'))
        .handle('counterpartyCustomerOnboard', () => Effect.die('Unexpected counterpartyCustomerOnboard'))
        .handle('counterpartyRoleAdd', () => Effect.die('Unexpected counterpartyRoleAdd'))
        .handle('counterpartyRoleEnd', () => Effect.die('Unexpected counterpartyRoleEnd'))
        .handle('createPartyRelationship', () => Effect.die('Unexpected createPartyRelationship'))
        .handle('createParty', () => Effect.die('Unexpected createParty'))
        .handle('dismissDuplicateCandidate', ({ payload }) =>
          Effect.gen(function* receive() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            dismissCalls.push([
              payload,
              {
                correlationId: request.headers['x-correlation-id'],
                idempotencyKey: request.headers['idempotency-key'],
              },
            ]);
            return yield* dismissNext.shift() ?? dismissAnswer;
          }),
        )
        .handle('endContactPoint', () => Effect.die('Unexpected endContactPoint'))
        .handle('endPartyOfficialIdentifier', () => Effect.die('Unexpected endPartyOfficialIdentifier'))
        .handle('endPartyRelationship', () => Effect.die('Unexpected endPartyRelationship'))
        .handle('markDuplicateCandidateNeedsEvidence', ({ payload }) =>
          Effect.gen(function* receive() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            evidenceCalls.push([
              payload,
              {
                correlationId: request.headers['x-correlation-id'],
                idempotencyKey: request.headers['idempotency-key'],
              },
            ]);
            return yield* evidenceNext.shift() ?? evidenceAnswer;
          }),
        )
        .handle('matchParty', () => Effect.die('Unexpected matchParty'))
        .handle('requestSearchRebuild', () => Effect.die('Unexpected requestSearchRebuild'))
        .handle('resolveDuplicateCandidateCreate', ({ payload }) =>
          Effect.gen(function* receive() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            createCalls.push([
              payload,
              {
                correlationId: request.headers['x-correlation-id'],
                idempotencyKey: request.headers['idempotency-key'],
              },
            ]);
            return yield* createNext.shift() ?? createAnswer;
          }),
        )
        .handle('resolveDuplicateCandidateMatch', ({ payload }) =>
          Effect.gen(function* receive() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            matchCalls.push([
              payload,
              {
                correlationId: request.headers['x-correlation-id'],
                idempotencyKey: request.headers['idempotency-key'],
              },
            ]);
            return yield* matchNext.shift() ?? matchAnswer;
          }),
        )
        .handle('unarchiveParty', () => Effect.die('Unexpected unarchiveParty'))
        .handle('updateContactPoint', () => Effect.die('Unexpected updateContactPoint'))
        .handle('updatePartyOfficialIdentifier', () => Effect.die('Unexpected updatePartyOfficialIdentifier'))
        .handle('updatePartyRelationship', () => Effect.die('Unexpected updatePartyRelationship'))
        .handle('updateParty', () => Effect.die('Unexpected updateParty')),
    ).pipe(Layer.provide(partyCommandSchemaErrorLive)),
  ),
  serveApi(
    recoveryApi,
    HttpApiBuilder.group(recoveryApi, 'partyCommandRecovery', (g) =>
      g.handle('resolve', ({ payload }) =>
        Effect.gen(function* receiveCommit() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          commitCalls.push([
            payload,
            { correlationId: request.headers['x-correlation-id'], idempotencyKey: request.headers['idempotency-key'] },
          ]);
          return yield* commitNext.shift() ?? commitAnswer;
        }),
      ),
    ).pipe(Layer.provide(partyCommandSchemaErrorLive)),
  ),
);

const reviewKey = 'party-registry.pages.customers.identityReview';

/** The module's retry and reload copy: the queue and detail retries, the shared state retry and the detail reload. */
const retryOrReloadCopy = new Set(
  [
    `${reviewKey}.retryQueue`,
    `${reviewKey}.retryDetail`,
    'party-registry.pages.customers.state.retry',
    'party-registry.pages.customers.detail.reload',
  ].map((key) => moduleText('cs')(key)),
);
const copy = moduleText('cs');
afterEach(unmountAll);

const liveChange = (event = moduleChangeEvent) => {
  act(() => {
    window.dispatchEvent(new Event(event));
  });
};

it.layer(network, { excludeTestServices: true })('customer identity review', (suite) => {
  suite.effect(
    'the extracted panel presents loading, empty, denied and unavailable queue states with read retries',
    () =>
      Effect.gen(function* panelQueueStates() {
        yield* pinTestDocument;
        const pendingQueue = yield* Deferred.make<typeof queue>();
        listNext.push(Deferred.await(pendingQueue));
        const review = yield* renderReview();
        act(() => review.result.current.openReview());
        const panel = yield* renderPanel(review.result.current);
        expect(document.body.textContent).not.toContain(partyRef.resourceId);
        expect(document.body.textContent).not.toContain(candidateCase.caseRef.resourceId);
        expect(document.body.textContent).not.toContain(candidateCase.matchRuleVersion);
        expectHumanReadable();
        expect(screen.getByText(copy(`${reviewKey}.loading`))).toBeTruthy();
        expect(screen.queryByText(copy(`${reviewKey}.empty`))).toBeNull();
        yield* Deferred.succeed(pendingQueue, { items: [], nextCaseRef: null });
        yield* Effect.promise(() => waitFor(() => expect(review.result.current.queue.status).toBe('ready')));
        yield* panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
        expect(screen.getByText(copy(`${reviewKey}.empty`))).toBeTruthy();
        for (const [schema, tag, status, key] of [
          [DuplicateCandidateListForbiddenProblemSchema, 'DuplicateCandidateListForbiddenProblem', 403, 'forbidden'],
          [
            DuplicateCandidateListUnavailableProblemSchema,
            'DuplicateCandidateListUnavailableProblem',
            503,
            'unavailable',
          ],
        ] as const) {
          const failure = yield* Schema.decodeUnknownEffect(schema)({
            _tag: tag,
            detail: 'Read failed',
            retryable: true,
            status,
            title: 'Read failed',
            type: 'urn:test:read-failed',
          });
          listNext.push(Effect.fail(failure));
          // A shown page follows live changes; a failed one offers only an error-state retry.
          if (review.result.current.queue.status === 'ready') {
            liveChange();
          } else {
            fireEvent.click(screen.getByRole('button', { name: copy(`${reviewKey}.retryQueue`) }));
          }
          yield* Effect.promise(() => waitFor(() => expect(review.result.current.queue.status).toBe('failed')));
          yield* panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
          expect(screen.getByText(copy(`${reviewKey}.${key}`))).toBeTruthy();
          expect(screen.queryByText(copy(`${reviewKey}.empty`))).toBeNull();
        }
      }),
  );

  suite.effect('the extracted panel requires an explicit subject choice and renders a committed resolved case', () =>
    Effect.gen(function* panelResolution() {
      yield* pinTestDocument;
      const review = yield* renderReview();
      yield* opened(review);
      const panel = yield* renderPanel(review.result.current);
      expect(document.body.textContent).not.toContain(partyRef.resourceId);
      expect(document.body.textContent).not.toContain(candidateCase.caseRef.resourceId);
      expect(document.body.textContent).not.toContain(candidateCase.matchRuleVersion);
      expectHumanReadable();
      const confirm = () => screen.getByRole<HTMLButtonElement>('button', { name: copy(`${reviewKey}.match`) });
      expect(confirm().disabled).toBe(true);
      fireEvent.click(
        screen.getByRole('button', { name: copy(`${reviewKey}.selectParty`, { name: 'Existing identity' }) }),
      );
      fireEvent.change(screen.getByRole('textbox', { name: new RegExp(copy(`${reviewKey}.reason`), 'u') }), {
        target: { value: 'Compared submitted evidence' },
      });
      yield* panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
      expect(confirm().disabled).toBe(false);
      expect(
        screen
          .getByRole('button', { name: copy(`${reviewKey}.selectParty`, { name: 'Existing identity' }) })
          .getAttribute('aria-pressed'),
      ).toBe('true');
      listAnswer = Effect.succeed({ items: [], nextCaseRef: null });
      detailAnswer = Effect.succeed({
        ...candidateCase,
        lifecycleState: 'RESOLVED',
        resolutionOutcome: 'MATCH_EXISTING',
      });
      fireEvent.click(confirm());
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
      yield* panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
      expect(screen.getByText(copy(`${reviewKey}.states.RESOLVED`))).toBeTruthy();
      expect(screen.getByText(copy(`${reviewKey}.saved`))).toBeTruthy();
      expect(confirm().disabled).toBe(true);
      expect(screen.getByText(copy(`${reviewKey}.empty`))).toBeTruthy();
      expect(resolved).toHaveLength(1);
    }),
  );

  suite.effect('the queue exposes loading, empty, unavailable, and retried ready states', () =>
    Effect.gen(function* queueStates() {
      yield* pinTestDocument;
      const pendingQueue = yield* Deferred.make<typeof queue>();
      listNext.push(Deferred.await(pendingQueue));
      const review = yield* renderReview();
      expect(review.result.current.queue.status).toBe('idle');
      act(() => review.result.current.openReview());
      expect(review.result.current.queue.status).toBe('loading');
      yield* Deferred.succeed(pendingQueue, { items: [], nextCaseRef: null });
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.queue.status).toBe('ready')));
      expect(review.result.current.queue).toEqual({ status: 'ready', value: { items: [], nextCaseRef: null } });
      const failure = yield* Schema.decodeEffect(DuplicateCandidateListUnavailableProblemSchema)({
        _tag: 'DuplicateCandidateListUnavailableProblem',
        detail: 'Unavailable',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'urn:test:unavailable',
      });
      listNext.push(Effect.fail(failure));
      act(() => review.result.current.loadQueue());
      yield* Effect.promise(() =>
        waitFor(() => expect(review.result.current.queue).toEqual({ failure: 'unavailable', status: 'failed' })),
      );
      act(() => review.result.current.loadQueue());
      yield* Effect.promise(() =>
        waitFor(() => expect(review.result.current.queue).toEqual({ status: 'ready', value: queue })),
      );
    }),
  );

  suite.effect('a queue permission denial stays distinct from an empty pending queue', () =>
    Effect.gen(function* deniedQueue() {
      yield* pinTestDocument;
      const failure = yield* Schema.decodeEffect(DuplicateCandidateListForbiddenProblemSchema)({
        _tag: 'DuplicateCandidateListForbiddenProblem',
        detail: 'Denied',
        status: 403,
        title: 'Forbidden',
        type: 'urn:test:forbidden',
      });
      listAnswer = Effect.fail(failure);
      const review = yield* renderReview();
      act(() => review.result.current.openReview());
      yield* Effect.promise(() =>
        waitFor(() => expect(review.result.current.queue).toEqual({ failure: 'forbidden', status: 'failed' })),
      );
      yield* networkIdle;
      yield* settle;
      expect(detailCalls).toHaveLength(0);
    }),
  );

  suite.effect(
    'requires explicit selection and reason, sends the case revision, locks pending writes, and refreshes after commit',
    () =>
      Effect.gen(function* matchExisting() {
        yield* pinTestDocument;
        const pending = yield* Deferred.make<typeof matched>();
        matchAnswer = Deferred.await(pending);
        const review = yield* renderReview();
        yield* opened(review);
        act(() => review.result.current.resolve('MATCH_EXISTING'));
        expect(review.result.current.notice?.key).toBe('validation');
        yield* networkIdle;
        yield* settle;
        expect(matchCalls).toHaveLength(0);
        prepare(review);
        act(() => {
          review.result.current.resolve('MATCH_EXISTING');
          review.result.current.resolve('MATCH_EXISTING');
        });
        yield* waitUntil(() => matchCalls.length === 1);
        expect(review.result.current.busy).toBe(true);
        expect(matchCalls[0]).toEqual([
          {
            caseRef: candidateCase.caseRef,
            expectedRevision: 3,
            reason: 'Reviewed the signup evidence',
            selectedPartyRef: partyRef,
          },
          expect.objectContaining({ idempotencyKey: expect.any(String) }),
        ]);
        listAnswer = Effect.succeed({ items: [], nextCaseRef: null });
        detailAnswer = Effect.succeed({
          ...candidateCase,
          lifecycleState: 'RESOLVED',
          resolutionOutcome: 'MATCH_EXISTING',
        });
        yield* Deferred.succeed(pending, matched);
        yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
        expect(review.result.current.committed).toBe(true);
        expect(review.result.current.canResolve).toBe(false);
        expect(review.result.current.queue).toEqual({ status: 'ready', value: { items: [], nextCaseRef: null } });
        expect(resolved).toHaveLength(1);
      }),
  );

  suite.effect('matching submits the explicitly chosen second candidate, not the first suggestion', () =>
    Effect.gen(function* selectedCandidate() {
      yield* pinTestDocument;
      const secondPartyRef = { ...partyRef, resourceId: '20000000-0000-4000-8000-000000000002' };
      detailAnswer = Effect.succeed({ ...candidateCase, candidateParties: [partyRef, secondPartyRef] });
      identityRead = (input) =>
        Effect.succeed({
          currentFactAssertions: [],
          party: { ...party, partyRef: input.partyRef },
          resolution: {
            aliasChain: [],
            canonicalPartyRef: input.partyRef,
            kind: 'DIRECT',
            requestedPartyRef: input.partyRef,
          },
        });
      const review = yield* renderReview();
      yield* opened(review);
      act(() => {
        review.result.current.setReason('Compared both subjects');
        review.result.current.setSelectedPartyId(secondPartyRef.resourceId);
      });
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* waitUntil(() => matchCalls.length === 1);
      expect(matchCalls[0]?.[0].selectedPartyRef).toEqual(secondPartyRef);
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
    }),
  );

  const rejectsSelectedSubject = (state: 'archived' | 'alias' | 'forbidden' | 'not-candidate') => {
    suite.effect(`matching rejects a selected subject that is ${state}`, () =>
      Effect.gen(function* ineligibleCandidate() {
        yield* pinTestDocument;
        if (state === 'forbidden') {
          const failure = yield* Schema.decodeEffect(PartyDetailForbiddenProblemSchema)({
            _tag: 'PartyDetailForbiddenProblem',
            detail: 'Denied',
            status: 403,
            title: 'Forbidden',
            type: 'urn:test:forbidden',
          });
          identityAnswer = Effect.fail(failure);
        } else {
          identityAnswer = Effect.succeed({
            currentFactAssertions: [],
            party: { ...party, archivedAt: state === 'archived' ? Option.some(party.createdAt) : Option.none() },
            resolution: {
              aliasChain: state === 'alias' ? [partyRef] : [],
              canonicalPartyRef: partyRef,
              kind: state === 'alias' ? 'ALIAS' : 'DIRECT',
              requestedPartyRef: partyRef,
            },
          });
        }
        const review = yield* renderReview();
        yield* opened(review);
        prepare(review);
        if (state === 'not-candidate') {
          act(() => review.result.current.setSelectedPartyId('20000000-0000-4000-8000-000000000099'));
        }
        act(() => review.result.current.resolve('MATCH_EXISTING'));
        expect(review.result.current.notice?.key).toBe('validation');
        yield* networkIdle;
        yield* settle;
        expect(matchCalls).toHaveLength(0);
        expect(resolved).toHaveLength(0);
      }),
    );
  };
  for (const state of ['archived', 'alias', 'forbidden', 'not-candidate'] as const) {
    rejectsSelectedSubject(state);
  }

  suite.effect('a denied resolution retains the reason and chosen identity without claiming success', () =>
    Effect.gen(function* deniedResolution() {
      yield* pinTestDocument;
      const failure = yield* Schema.decodeEffect(PartyCommandForbiddenProblemSchema)({
        _tag: 'PartyCommandForbiddenProblem',
        detail: 'Denied',
        status: 403,
        title: 'Forbidden',
        type: 'urn:test:forbidden',
      });
      matchAnswer = Effect.fail(failure);
      const review = yield* renderReview();
      yield* opened(review);
      prepare(review);
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.notice?.key).toBe('forbidden')));
      expect(review.result.current.reason).toBe('Reviewed the signup evidence');
      expect(review.result.current.selectedPartyId).toBe(partyRef.resourceId);
      expect(resolved).toHaveLength(0);
    }),
  );

  suite.effect('the panel offers no manual reload and follows live changes and module writes while open', () =>
    Effect.gen(function* followsLiveChanges() {
      yield* pinTestDocument;
      const review = yield* renderReview();
      liveChange();
      yield* networkIdle;
      yield* settle;
      expect(listCalls).toHaveLength(0);
      yield* opened(review);
      prepare(review);
      yield* renderPanel(review.result.current);
      // No button carries any of the module's retry or reload copy (the queue and detail retries, the detail reload).
      const offered = screen.queryAllByRole('button').map((button) => button.textContent?.trim() ?? '');
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.filter((name) => retryOrReloadCopy.has(name) || /^(?:Zkusit znovu|Obnovit)/u.test(name))).toEqual(
        [],
      );
      listCalls.length = 0;
      detailCalls.length = 0;
      detailAnswer = Effect.succeed({ ...candidateCase, revision: 5 });
      liveChange();
      yield* Effect.promise(() =>
        waitFor(() => {
          const { detail } = review.result.current;
          expect(detail.status === 'ready' ? detail.value.candidateCase.revision : undefined).toBe(5);
        }),
      );
      yield* networkIdle;
      expect(listCalls).toHaveLength(1);
      expect(detailCalls).toHaveLength(1);
      // The background read never blanks the panel and keeps the reviewer's draft.
      expect(review.result.current.queue.status).toBe('ready');
      expect(review.result.current.reason).toBe('Reviewed the signup evidence');
      expect(review.result.current.selectedPartyId).toBe(partyRef.resourceId);
      liveChange(moduleWriteEvent);
      yield* waitUntil(() => listCalls.length === 2);
      act(() => review.result.current.closeReview(false));
      liveChange();
      yield* networkIdle;
      yield* settle;
      expect(listCalls).toHaveLength(2);
      unmountAll();
    }),
  );

  suite.effect('a revision or claim conflict reloads the case and requires a fresh subject choice', () =>
    Effect.gen(function* conflict() {
      yield* pinTestDocument;
      const failure = yield* Schema.decodeEffect(PartyCommandConflictProblemSchema)({
        _tag: 'PartyCommandConflictProblem',
        code: 'duplicate_candidate_conflict',
        detail: 'Changed',
        status: 409,
        title: 'Conflict',
        type: 'urn:test:conflict',
      });
      matchAnswer = Effect.fail(failure);
      const review = yield* renderReview();
      yield* opened(review);
      prepare(review);
      const reloaded = yield* Deferred.make<typeof candidateCase>();
      detailAnswer = Deferred.await(reloaded);
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.stale).toBe(true)));
      expect(review.result.current.notice?.key).toBe('conflict');
      expect(review.result.current.selectedPartyId).toBe('');
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* Deferred.succeed(reloaded, { ...candidateCase, revision: 4 });
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.canResolve).toBe(true)));
      // The reload has landed and the network is idle: a resolve sent while the case was stale would be recorded.
      yield* networkIdle;
      expect(matchCalls).toHaveLength(1);
      prepare(review);
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* waitUntil(() => matchCalls.length === 2);
      expect(matchCalls[1]?.[0].expectedRevision).toBe(4);
    }),
  );

  suite.effect('a successful resolution with a failed refresh is terminal and never resubmitted', () =>
    Effect.gen(function* refreshFailure() {
      yield* pinTestDocument;
      const failure = yield* Schema.decodeEffect(DuplicateCandidateListForbiddenProblemSchema)({
        _tag: 'DuplicateCandidateListForbiddenProblem',
        detail: 'Revoked',
        status: 403,
        title: 'Forbidden',
        type: 'urn:test:forbidden',
      });
      const review = yield* renderReview();
      yield* opened(review);
      prepare(review);
      listAnswer = Effect.fail(failure);
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.notice?.key).toBe('savedReloadFailed')));
      expect(review.result.current.committed).toBe(true);
      expect(review.result.current.queue).toEqual({ failure: 'forbidden', status: 'failed' });
      expect(review.result.current.detail.status).toBe('ready');
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* networkIdle;
      yield* settle;
      expect(matchCalls).toHaveLength(1);
      expect(resolved).toHaveLength(1);
    }),
  );

  suite.effect(
    'a failed committed detail refresh preserves the refreshed empty queue and allows read-only recovery',
    () =>
      Effect.gen(function* detailRefreshFailure() {
        yield* pinTestDocument;
        const failure = yield* Schema.decodeEffect(DuplicateCandidateDetailForbiddenProblemSchema)({
          _tag: 'DuplicateCandidateDetailForbiddenProblem',
          detail: 'Revoked',
          status: 403,
          title: 'Forbidden',
          type: 'urn:test:forbidden',
        });
        const review = yield* renderReview();
        yield* opened(review);
        prepare(review);
        listAnswer = Effect.succeed({ items: [], nextCaseRef: null });
        detailAnswer = Effect.fail(failure);
        act(() => review.result.current.resolve('MATCH_EXISTING'));
        yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
        expect(review.result.current.notice?.key).toBe('savedReloadFailed');
        expect(review.result.current.queue).toEqual({ status: 'ready', value: { items: [], nextCaseRef: null } });
        expect(review.result.current.detail).toEqual({ failure: 'forbidden', status: 'failed' });
        detailAnswer = Effect.succeed({
          ...candidateCase,
          lifecycleState: 'RESOLVED',
          resolutionOutcome: 'MATCH_EXISTING',
        });
        act(() => review.result.current.retryDetail());
        yield* Effect.promise(() => waitFor(() => expect(review.result.current.detail.status).toBe('ready')));
        expect(review.result.current.canResolve).toBe(false);
        yield* networkIdle;
        expect(matchCalls).toHaveLength(1);
      }),
  );

  for (const [resolution, command] of [
    ['CREATE_NEW', createCalls],
    ['NEEDS_EVIDENCE', evidenceCalls],
    ['DISMISSED_AS_NON_SUBJECT', dismissCalls],
  ] as const) {
    suite.effect(`${resolution} uses its existing Action with no invented Party selection or merge`, () =>
      Effect.gen(function* supportedResolution() {
        yield* pinTestDocument;
        const review = yield* renderReview();
        yield* opened(review);
        act(() => review.result.current.setReason('Reviewed the evidence'));
        act(() => review.result.current.resolve(resolution));
        yield* waitUntil(() => resolved.length === 1);
        expect(command[0]).toEqual([
          { caseRef: candidateCase.caseRef, expectedRevision: 3, reason: 'Reviewed the evidence' },
          expect.any(Object),
        ]);
        yield* networkIdle;
        yield* settle;
        expect(matchCalls).toHaveLength(0);
      }),
    );
  }

  suite.effect('uncertain writes require native commit proof and retry only the identical invocation identity', () =>
    Effect.gen(function* uncertainResolution() {
      yield* pinTestDocument;
      const failure = yield* Schema.decodeEffect(PartyCommandUnavailableProblemSchema)({
        _tag: 'PartyCommandUnavailableProblem',
        detail: 'Acknowledgement lost',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'urn:test:unavailable',
      });
      matchNext.push(Effect.fail(failure));
      matchAnswer = Effect.succeed(matched);
      commitAnswer = Effect.succeed({ _tag: 'PartyCommandCommitResolution', retryCommand: true, state: 'NOT_STARTED' });
      const review = yield* renderReview();
      yield* opened(review);
      prepare(review);
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.uncertain).toBe(true)));
      act(() => review.result.current.resolve('CREATE_NEW'));
      yield* networkIdle;
      yield* settle;
      expect(createCalls).toHaveLength(0);
      act(() => review.result.current.checkStatus());
      yield* waitUntil(() => resolved.length === 1);
      const calls = matchCalls;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(calls[1]);
      expect(commitCalls[0]).toEqual([
        { actionKey: 'party.registry.resolve-duplicate-candidate-match', idempotencyKey: calls[0]?.[1].idempotencyKey },
        expect.any(Object),
      ]);
    }),
  );

  suite.effect('changing cases clears the previous subject choice and reason before the new detail arrives', () =>
    Effect.gen(function* resetSelection() {
      yield* pinTestDocument;
      const review = yield* renderReview();
      yield* opened(review);
      prepare(review);
      const pendingDetail = yield* Deferred.make<typeof candidateCase>();
      detailAnswer = Deferred.await(pendingDetail);
      const next = {
        ...candidateCase,
        caseRef: { ...candidateCase.caseRef, resourceId: '30000000-0000-4000-8000-000000000002' },
      };
      act(() => review.result.current.selectCase(next.caseRef));
      expect(review.result.current.detail.status).toBe('loading');
      expect(review.result.current.selectedPartyId).toBe('');
      expect(review.result.current.reason).toBe('');
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      // The new detail read is held open, so the network cannot go idle here; the check below, once it is answered,
      // covers both resolves.
      yield* settle;
      expect(matchCalls).toHaveLength(0);
      yield* Deferred.succeed(pendingDetail, next);
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.detail.status).toBe('ready')));
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      expect(review.result.current.notice?.key).toBe('validation');
      yield* networkIdle;
      yield* settle;
      expect(matchCalls).toHaveLength(0);
    }),
  );

  suite.effect('late case detail responses cannot replace a newer staff selection', () =>
    Effect.gen(function* staleSelection() {
      yield* pinTestDocument;
      const previous = yield* Deferred.make<typeof candidateCase>();
      detailNext.push(Deferred.await(previous));
      const review = yield* renderReview();
      const next = {
        ...candidateCase,
        caseRef: { ...candidateCase.caseRef, resourceId: '30000000-0000-4000-8000-000000000002' },
      };
      act(() => review.result.current.selectCase(candidateCase.caseRef));
      yield* waitUntil(() => detailCalls.length === 1);
      detailAnswer = Effect.succeed(next);
      act(() => review.result.current.selectCase(next.caseRef));
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.detail.status).toBe('ready')));
      yield* Deferred.succeed(previous, candidateCase);
      yield* Effect.promise(() =>
        waitFor(() => {
          const { detail } = review.result.current;
          expect(detail.status === 'ready' ? detail.value.candidateCase.caseRef : undefined).toEqual(next.caseRef);
        }),
      );
    }),
  );
});
