import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Deferred, Effect, Option, Schema } from 'effect';

import {
  DuplicateCandidateDetailForbiddenProblemSchema,
  DuplicateCandidateDetailResponseSchema,
} from '../../shared/apis/duplicate-candidate-detail.ts';
import {
  DuplicateCandidateListForbiddenProblemSchema,
  DuplicateCandidateListUnavailableProblemSchema,
} from '../../shared/apis/duplicate-candidate-list.ts';
import { PartyDetailForbiddenProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import {
  PartyCommandConflictProblemSchema,
  PartyCommandForbiddenProblemSchema,
  PartyCommandUnavailableProblemSchema,
} from '../../shared/command-api.ts';
import { executeDuplicateCandidateList } from '../../src/api/duplicate-candidate-list-client.ts';
import { executeDuplicateCandidateDetail } from '../../src/api/duplicate-candidate-detail-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import {
  dismissDuplicateCandidate,
  markDuplicateCandidateNeedsEvidence,
  resolveDuplicateCandidateCreate,
  resolveDuplicateCandidateMatch,
  resolvePartyCommandCommit,
} from '../../src/api/party-command-client.ts';
import { useCustomerIdentityReview } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import { CustomerIdentityReviewPanel } from '../../src/routes/[lang]/prodej/zakaznici/customer-identity-review-panel.tsx';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string, values?: Readonly<Record<string, string>>) =>
      values?.['name'] === undefined ? key : `${key} ${values['name']}`,
  }),
}));

rstest.mock('../../src/api/duplicate-candidate-list-client.ts');
rstest.mock('../../src/api/duplicate-candidate-detail-client.ts');
rstest.mock('../../src/api/party-detail-client.ts');
rstest.mock('../../src/api/party-contact-points-client.ts');
rstest.mock('../../src/api/party-command-client.ts');

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
    displayName: 'Submitted identity',
    evidenceRefs: ['signup:42'],
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
  createdAt: instant,
  displayName: 'Existing identity',
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
const onResolved = rstest.fn();
const useReview = () =>
  useCustomerIdentityReview(() => {
    onResolved();
  });
type Review = ReturnType<typeof renderReview>;
const renderReview = () => renderHook(useReview);
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

beforeEach(() => {
  rstest.clearAllMocks();
  rstest.mocked(executeDuplicateCandidateList).mockReturnValue(Effect.succeed(queue));
  rstest.mocked(executeDuplicateCandidateDetail).mockReturnValue(Effect.succeed(candidateCase));
  rstest.mocked(executePartyDetail).mockReturnValue(
    Effect.succeed({
      currentFactAssertions: [],
      factHistory: Option.none(),
      party,
      resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
    }),
  );
  rstest.mocked(executePartyContactPoints).mockReturnValue(Effect.succeed({ items: [] }));
  rstest.mocked(resolveDuplicateCandidateMatch).mockReturnValue(Effect.succeed(matched));
  rstest.mocked(resolveDuplicateCandidateCreate).mockReturnValue(Effect.succeed({ ...matched, outcome: 'CREATE_NEW' }));
  rstest
    .mocked(markDuplicateCandidateNeedsEvidence)
    .mockReturnValue(
      Effect.succeed({ ...matched, lifecycleState: 'NEEDS_EVIDENCE', outcome: 'NEEDS_EVIDENCE', partyRef: null }),
    );
  rstest
    .mocked(dismissDuplicateCandidate)
    .mockReturnValue(
      Effect.succeed({ ...matched, lifecycleState: 'DISMISSED', outcome: 'DISMISSED_AS_NON_SUBJECT', partyRef: null }),
    );
});
afterEach(cleanup);

const reviewKey = 'party-registry.pages.customers.identityReview';

it.effect('the extracted panel presents loading, empty, denied and unavailable queue states with read retries', () =>
  Effect.gen(function* panelQueueStates() {
    const pendingQueue = yield* Deferred.make<typeof queue>();
    rstest.mocked(executeDuplicateCandidateList).mockReturnValueOnce(Deferred.await(pendingQueue));
    const review = renderReview();
    act(() => review.result.current.openReview());
    const panel = render(<CustomerIdentityReviewPanel review={review.result.current} />);
    expect(screen.getByText(`${reviewKey}.loading`)).toBeTruthy();
    expect(screen.queryByText(`${reviewKey}.empty`)).toBeNull();
    yield* Deferred.succeed(pendingQueue, { items: [], nextCaseRef: null });
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.queue.status).toBe('ready')));
    panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
    expect(screen.getByText(`${reviewKey}.empty`)).toBeTruthy();
    for (const [schema, tag, status, key] of [
      [DuplicateCandidateListForbiddenProblemSchema, 'DuplicateCandidateListForbiddenProblem', 403, 'forbidden'],
      [DuplicateCandidateListUnavailableProblemSchema, 'DuplicateCandidateListUnavailableProblem', 503, 'unavailable'],
    ] as const) {
      const failure = yield* Schema.decodeUnknownEffect(schema)({
        _tag: tag,
        detail: 'Read failed',
        retryable: true,
        status,
        title: 'Read failed',
        type: 'urn:test:read-failed',
      });
      rstest.mocked(executeDuplicateCandidateList).mockReturnValueOnce(Effect.fail(failure));
      fireEvent.click(screen.getByRole('button', { name: `${reviewKey}.reloadQueue` }));
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.queue.status).toBe('failed')));
      panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
      expect(screen.getByText(`${reviewKey}.${key}`)).toBeTruthy();
      expect(screen.queryByText(`${reviewKey}.empty`)).toBeNull();
    }
  }),
);

it.effect('the extracted panel requires an explicit subject choice and renders a committed resolved case', () =>
  Effect.gen(function* panelResolution() {
    const review = renderReview();
    yield* opened(review);
    const panel = render(<CustomerIdentityReviewPanel review={review.result.current} />);
    const confirm = () => screen.getByRole<HTMLButtonElement>('button', { name: `${reviewKey}.match` });
    expect(confirm().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: `${reviewKey}.selectParty Existing identity` }));
    fireEvent.change(screen.getByRole('textbox', { name: /identityReview\.reason/u }), {
      target: { value: 'Compared submitted evidence' },
    });
    panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
    expect(confirm().disabled).toBe(false);
    expect(
      screen.getByRole('button', { name: `${reviewKey}.selectParty Existing identity` }).getAttribute('aria-pressed'),
    ).toBe('true');
    rstest.mocked(executeDuplicateCandidateList).mockReturnValue(Effect.succeed({ items: [], nextCaseRef: null }));
    rstest
      .mocked(executeDuplicateCandidateDetail)
      .mockReturnValue(
        Effect.succeed({ ...candidateCase, lifecycleState: 'RESOLVED', resolutionOutcome: 'MATCH_EXISTING' }),
      );
    fireEvent.click(confirm());
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
    panel.rerender(<CustomerIdentityReviewPanel review={review.result.current} />);
    expect(screen.getByText(`${reviewKey}.states.RESOLVED`)).toBeTruthy();
    expect(screen.getByText(`${reviewKey}.saved`)).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    expect(screen.getByText(`${reviewKey}.empty`)).toBeTruthy();
    expect(onResolved).toHaveBeenCalledTimes(1);
  }),
);

it.effect('the queue exposes loading, empty, unavailable, and retried ready states', () =>
  Effect.gen(function* queueStates() {
    const pendingQueue = yield* Deferred.make<typeof queue>();
    rstest.mocked(executeDuplicateCandidateList).mockReturnValueOnce(Deferred.await(pendingQueue));
    const review = renderReview();
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
    rstest.mocked(executeDuplicateCandidateList).mockReturnValueOnce(Effect.fail(failure));
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

it.effect('a queue permission denial stays distinct from an empty pending queue', () =>
  Effect.gen(function* deniedQueue() {
    const failure = yield* Schema.decodeEffect(DuplicateCandidateListForbiddenProblemSchema)({
      _tag: 'DuplicateCandidateListForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    });
    rstest.mocked(executeDuplicateCandidateList).mockReturnValue(Effect.fail(failure));
    const review = renderReview();
    act(() => review.result.current.openReview());
    yield* Effect.promise(() =>
      waitFor(() => expect(review.result.current.queue).toEqual({ failure: 'forbidden', status: 'failed' })),
    );
    expect(executeDuplicateCandidateDetail).not.toHaveBeenCalled();
  }),
);

it.effect(
  'requires explicit selection and reason, sends the case revision, locks pending writes, and refreshes after commit',
  () =>
    Effect.gen(function* matchExisting() {
      const pending = yield* Deferred.make<typeof matched>();
      rstest.mocked(resolveDuplicateCandidateMatch).mockReturnValue(Deferred.await(pending));
      const review = renderReview();
      yield* opened(review);
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      expect(review.result.current.notice?.key).toBe('validation');
      expect(resolveDuplicateCandidateMatch).not.toHaveBeenCalled();
      prepare(review);
      act(() => {
        review.result.current.resolve('MATCH_EXISTING');
        review.result.current.resolve('MATCH_EXISTING');
      });
      yield* Effect.promise(() => waitFor(() => expect(resolveDuplicateCandidateMatch).toHaveBeenCalledTimes(1)));
      expect(review.result.current.busy).toBe(true);
      expect(resolveDuplicateCandidateMatch).toHaveBeenCalledWith(
        {
          caseRef: candidateCase.caseRef,
          expectedRevision: 3,
          reason: 'Reviewed the signup evidence',
          selectedPartyRef: partyRef,
        },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
      rstest.mocked(executeDuplicateCandidateList).mockReturnValue(Effect.succeed({ items: [], nextCaseRef: null }));
      rstest
        .mocked(executeDuplicateCandidateDetail)
        .mockReturnValue(
          Effect.succeed({ ...candidateCase, lifecycleState: 'RESOLVED', resolutionOutcome: 'MATCH_EXISTING' }),
        );
      yield* Deferred.succeed(pending, matched);
      yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
      expect(review.result.current.committed).toBe(true);
      expect(review.result.current.canResolve).toBe(false);
      expect(review.result.current.queue).toEqual({ status: 'ready', value: { items: [], nextCaseRef: null } });
      expect(onResolved).toHaveBeenCalledTimes(1);
    }),
);

it.effect('matching submits the explicitly chosen second candidate, not the first suggestion', () =>
  Effect.gen(function* selectedCandidate() {
    const secondPartyRef = { ...partyRef, resourceId: '20000000-0000-4000-8000-000000000002' };
    rstest
      .mocked(executeDuplicateCandidateDetail)
      .mockReturnValue(Effect.succeed({ ...candidateCase, candidateParties: [partyRef, secondPartyRef] }));
    rstest.mocked(executePartyDetail).mockImplementation((input) =>
      Effect.succeed({
        currentFactAssertions: [],
        factHistory: Option.none(),
        party: { ...party, partyRef: input.partyRef },
        resolution: {
          aliasChain: [],
          canonicalPartyRef: input.partyRef,
          kind: 'DIRECT',
          requestedPartyRef: input.partyRef,
        },
      }),
    );
    const review = renderReview();
    yield* opened(review);
    act(() => {
      review.result.current.setReason('Compared both subjects');
      review.result.current.setSelectedPartyId(secondPartyRef.resourceId);
    });
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    yield* Effect.promise(() => waitFor(() => expect(resolveDuplicateCandidateMatch).toHaveBeenCalledTimes(1)));
    expect(rstest.mocked(resolveDuplicateCandidateMatch).mock.calls[0]?.[0].selectedPartyRef).toEqual(secondPartyRef);
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
  }),
);

for (const state of ['archived', 'alias', 'forbidden', 'not-candidate'] as const) {
  it.effect(`matching rejects a selected subject that is ${state}`, () =>
    Effect.gen(function* ineligibleCandidate() {
      if (state === 'forbidden') {
        const failure = yield* Schema.decodeEffect(PartyDetailForbiddenProblemSchema)({
          _tag: 'PartyDetailForbiddenProblem',
          detail: 'Denied',
          status: 403,
          title: 'Forbidden',
          type: 'urn:test:forbidden',
        });
        rstest.mocked(executePartyDetail).mockReturnValue(Effect.fail(failure));
      } else {
        rstest.mocked(executePartyDetail).mockReturnValue(
          Effect.succeed({
            currentFactAssertions: [],
            factHistory: Option.none(),
            party: { ...party, archivedAt: state === 'archived' ? Option.some(party.createdAt) : Option.none() },
            resolution: {
              aliasChain: state === 'alias' ? [partyRef] : [],
              canonicalPartyRef: partyRef,
              kind: state === 'alias' ? 'ALIAS' : 'DIRECT',
              requestedPartyRef: partyRef,
            },
          }),
        );
      }
      const review = renderReview();
      yield* opened(review);
      prepare(review);
      if (state === 'not-candidate') {
        act(() => review.result.current.setSelectedPartyId('20000000-0000-4000-8000-000000000099'));
      }
      act(() => review.result.current.resolve('MATCH_EXISTING'));
      expect(review.result.current.notice?.key).toBe('validation');
      expect(resolveDuplicateCandidateMatch).not.toHaveBeenCalled();
      expect(onResolved).not.toHaveBeenCalled();
    }),
  );
}

it.effect('a denied resolution retains the reason and chosen identity without claiming success', () =>
  Effect.gen(function* deniedResolution() {
    const failure = yield* Schema.decodeEffect(PartyCommandForbiddenProblemSchema)({
      _tag: 'PartyCommandForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    });
    rstest.mocked(resolveDuplicateCandidateMatch).mockReturnValue(Effect.fail(failure));
    const review = renderReview();
    yield* opened(review);
    prepare(review);
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.notice?.key).toBe('forbidden')));
    expect(review.result.current.reason).toBe('Reviewed the signup evidence');
    expect(review.result.current.selectedPartyId).toBe(partyRef.resourceId);
    expect(onResolved).not.toHaveBeenCalled();
  }),
);

it.effect('a revision or claim conflict requires a governed detail reload before another resolution', () =>
  Effect.gen(function* conflict() {
    const failure = yield* Schema.decodeEffect(PartyCommandConflictProblemSchema)({
      _tag: 'PartyCommandConflictProblem',
      code: 'duplicate_candidate_conflict',
      detail: 'Changed',
      status: 409,
      title: 'Conflict',
      type: 'urn:test:conflict',
    });
    rstest.mocked(resolveDuplicateCandidateMatch).mockReturnValue(Effect.fail(failure));
    const review = renderReview();
    yield* opened(review);
    prepare(review);
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.stale).toBe(true)));
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    expect(resolveDuplicateCandidateMatch).toHaveBeenCalledTimes(1);
    rstest.mocked(executeDuplicateCandidateDetail).mockReturnValue(Effect.succeed({ ...candidateCase, revision: 4 }));
    act(() => review.result.current.refreshDetail());
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.canResolve).toBe(true)));
    prepare(review);
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    yield* Effect.promise(() => waitFor(() => expect(resolveDuplicateCandidateMatch).toHaveBeenCalledTimes(2)));
    expect(rstest.mocked(resolveDuplicateCandidateMatch).mock.calls[1]?.[0].expectedRevision).toBe(4);
  }),
);

it.effect('a successful resolution with a failed refresh is terminal and never resubmitted', () =>
  Effect.gen(function* refreshFailure() {
    const failure = yield* Schema.decodeEffect(DuplicateCandidateListForbiddenProblemSchema)({
      _tag: 'DuplicateCandidateListForbiddenProblem',
      detail: 'Revoked',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    });
    const review = renderReview();
    yield* opened(review);
    prepare(review);
    rstest.mocked(executeDuplicateCandidateList).mockReturnValue(Effect.fail(failure));
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.notice?.key).toBe('savedReloadFailed')));
    expect(review.result.current.committed).toBe(true);
    expect(review.result.current.queue).toEqual({ failure: 'forbidden', status: 'failed' });
    expect(review.result.current.detail.status).toBe('ready');
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    expect(resolveDuplicateCandidateMatch).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
  }),
);

it.effect('a failed committed detail refresh preserves the refreshed empty queue and allows read-only recovery', () =>
  Effect.gen(function* detailRefreshFailure() {
    const failure = yield* Schema.decodeEffect(DuplicateCandidateDetailForbiddenProblemSchema)({
      _tag: 'DuplicateCandidateDetailForbiddenProblem',
      detail: 'Revoked',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    });
    const review = renderReview();
    yield* opened(review);
    prepare(review);
    rstest.mocked(executeDuplicateCandidateList).mockReturnValue(Effect.succeed({ items: [], nextCaseRef: null }));
    rstest.mocked(executeDuplicateCandidateDetail).mockReturnValue(Effect.fail(failure));
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.busy).toBe(false)));
    expect(review.result.current.notice?.key).toBe('savedReloadFailed');
    expect(review.result.current.queue).toEqual({ status: 'ready', value: { items: [], nextCaseRef: null } });
    expect(review.result.current.detail).toEqual({ failure: 'forbidden', status: 'failed' });
    rstest
      .mocked(executeDuplicateCandidateDetail)
      .mockReturnValue(
        Effect.succeed({ ...candidateCase, lifecycleState: 'RESOLVED', resolutionOutcome: 'MATCH_EXISTING' }),
      );
    act(() => review.result.current.refreshDetail());
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.detail.status).toBe('ready')));
    expect(review.result.current.canResolve).toBe(false);
    expect(resolveDuplicateCandidateMatch).toHaveBeenCalledTimes(1);
  }),
);

for (const [resolution, command] of [
  ['CREATE_NEW', resolveDuplicateCandidateCreate],
  ['NEEDS_EVIDENCE', markDuplicateCandidateNeedsEvidence],
  ['DISMISSED_AS_NON_SUBJECT', dismissDuplicateCandidate],
] as const) {
  it.effect(`${resolution} uses its existing Action with no invented Party selection or merge`, () =>
    Effect.gen(function* supportedResolution() {
      const review = renderReview();
      yield* opened(review);
      act(() => review.result.current.setReason('Reviewed the evidence'));
      act(() => review.result.current.resolve(resolution));
      yield* Effect.promise(() => waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1)));
      expect(command).toHaveBeenCalledWith(
        { caseRef: candidateCase.caseRef, expectedRevision: 3, reason: 'Reviewed the evidence' },
        expect.any(Object),
      );
      expect(resolveDuplicateCandidateMatch).not.toHaveBeenCalled();
    }),
  );
}

it.effect('uncertain writes require native commit proof and retry only the identical invocation identity', () =>
  Effect.gen(function* uncertainResolution() {
    const failure = yield* Schema.decodeEffect(PartyCommandUnavailableProblemSchema)({
      _tag: 'PartyCommandUnavailableProblem',
      detail: 'Acknowledgement lost',
      retryable: true,
      status: 503,
      title: 'Unavailable',
      type: 'urn:test:unavailable',
    });
    rstest
      .mocked(resolveDuplicateCandidateMatch)
      .mockReturnValueOnce(Effect.fail(failure))
      .mockReturnValue(Effect.succeed(matched));
    rstest
      .mocked(resolvePartyCommandCommit)
      .mockReturnValue(
        Effect.succeed({ _tag: 'PartyCommandCommitResolution', retryCommand: true, state: 'NOT_STARTED' }),
      );
    const review = renderReview();
    yield* opened(review);
    prepare(review);
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.uncertain).toBe(true)));
    act(() => review.result.current.resolve('CREATE_NEW'));
    expect(resolveDuplicateCandidateCreate).not.toHaveBeenCalled();
    act(() => review.result.current.checkStatus());
    yield* Effect.promise(() => waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1)));
    const { calls } = rstest.mocked(resolveDuplicateCandidateMatch).mock;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(resolvePartyCommandCommit).toHaveBeenCalledWith(
      { actionKey: 'party.registry.resolve-duplicate-candidate-match', idempotencyKey: calls[0]?.[1].idempotencyKey },
      expect.any(Object),
    );
  }),
);

it.effect('changing cases clears the previous subject choice and reason before the new detail arrives', () =>
  Effect.gen(function* resetSelection() {
    const review = renderReview();
    yield* opened(review);
    prepare(review);
    const pendingDetail = yield* Deferred.make<typeof candidateCase>();
    rstest.mocked(executeDuplicateCandidateDetail).mockReturnValue(Deferred.await(pendingDetail));
    const next = {
      ...candidateCase,
      caseRef: { ...candidateCase.caseRef, resourceId: '30000000-0000-4000-8000-000000000002' },
    };
    act(() => review.result.current.selectCase(next.caseRef));
    expect(review.result.current.detail.status).toBe('loading');
    expect(review.result.current.selectedPartyId).toBe('');
    expect(review.result.current.reason).toBe('');
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    expect(resolveDuplicateCandidateMatch).not.toHaveBeenCalled();
    yield* Deferred.succeed(pendingDetail, next);
    yield* Effect.promise(() => waitFor(() => expect(review.result.current.detail.status).toBe('ready')));
    act(() => review.result.current.resolve('MATCH_EXISTING'));
    expect(review.result.current.notice?.key).toBe('validation');
    expect(resolveDuplicateCandidateMatch).not.toHaveBeenCalled();
  }),
);

it.effect('late case detail responses cannot replace a newer staff selection', () =>
  Effect.gen(function* staleSelection() {
    const previous = yield* Deferred.make<typeof candidateCase>();
    rstest.mocked(executeDuplicateCandidateDetail).mockReturnValueOnce(Deferred.await(previous));
    const review = renderReview();
    const next = {
      ...candidateCase,
      caseRef: { ...candidateCase.caseRef, resourceId: '30000000-0000-4000-8000-000000000002' },
    };
    act(() => review.result.current.selectCase(candidateCase.caseRef));
    rstest.mocked(executeDuplicateCandidateDetail).mockReturnValue(Effect.succeed(next));
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
