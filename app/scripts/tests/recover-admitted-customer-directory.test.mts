import { ConfigProvider, Effect, Option, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  AdmittedCustomerDirectoryRecoveryRuntime,
  DirectoryRecoveryRequestSchema,
  recoverAdmittedCustomerDirectory,
} from '../../verticals/commerce-customer-context/scripts/recover-admitted-customer-directory-program.mts';
import type { DirectoryRecoveryObservation } from '../../verticals/commerce-customer-context/scripts/recover-admitted-customer-directory-program.mts';
import {
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationSnapshotSchema,
  RetailEnrollmentRegistrationSchema,
} from '../../verticals/commerce-customer-context/shared/enrollment-contracts.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../verticals/commerce-customer-context/src/enrollment/attempts/errors.ts';
import {
  RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY,
  retailSelfEnrollmentRequestDigest,
} from '../../verticals/commerce-customer-context/src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from '../../verticals/commerce-customer-context/src/enrollment/orchestration/owner-transition-driver.ts';

const PARTY_OWNER = 'party.registry';
const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const sourceRevision = 'a'.repeat(40);
const compositionRevision = 'b'.repeat(64);
const request = Schema.decodeSync(DirectoryRecoveryRequestSchema)({
  attemptId: id(2),
  compositionRevision,
  ownerInvocationId: id(4),
  tenantId: id(7),
});
const actorPrincipalId = id(1);
const legalEntityId = id(10);
const at = '2026-10-28T15:41:00.000Z';
const expired = { leaseExpiresAt: '1960-01-01T00:00:00.000Z', leaseToken: id(8), workerId: 'original-worker' };
const partyRef = {
  moduleId: 'party.registry',
  resourceId: id(9),
  resourceType: 'party.registry.party',
  tenantId: request.tenantId,
} as const;
const APPROVAL_MISMATCH = 'approval-mismatch';
const AUTHORITY_UNAVAILABLE = 'authority-unavailable';
const OPERATION_MISMATCH = 'operation-mismatch';
const digest = retailSelfEnrollmentRequestDigest({
  intent: {
    partyRef,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: request.tenantId,
    },
    step: 'RETAIL_CUSTOMER_DIRECTORY',
  },
  ownerModuleKey: PARTY_OWNER,
  portalEnrollmentAttemptId: request.attemptId,
  transitionKey: RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY,
});

const directoryOperation = (overrides: Partial<typeof EnrollmentOwnerOperationSnapshotSchema.Encoded> = {}) =>
  Schema.decodeSync(EnrollmentOwnerOperationSnapshotSchema)({
    actorPrincipalId,
    createdAt: at,
    ownerInvocationId: request.ownerInvocationId,
    ownerModuleKey: PARTY_OWNER,
    portalEnrollmentAttemptId: request.attemptId,
    portalEnrollmentOwnerOperationId: id(3),
    requestDigest: digest,
    required: true,
    revision: 3,
    status: 'INDETERMINATE',
    tenantId: request.tenantId,
    transitionKey: RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY,
    updatedAt: at,
    ...overrides,
  });

const observation = (): DirectoryRecoveryObservation => ({
  attempt: Schema.decodeSync(EnrollmentAttemptSnapshotSchema)({
    compositionRevision,
    createdAt: at,
    createdByPrincipalId: actorPrincipalId,
    intentDigest: 'c'.repeat(64),
    intentKey: 'original-intent',
    journey: 'RETAIL_SELF_ENROLLMENT',
    portalEnrollmentAttemptId: request.attemptId,
    revision: 12,
    state: 'IN_PROGRESS',
    targetLegalEntityId: legalEntityId,
    tenantId: request.tenantId,
    updatedAt: at,
  }),
  core: {
    admissionClosed: true,
    authorityActive: true,
    authorityFresh: true,
    authorityRevision: compositionRevision,
    durablePresent: true,
  },
  operation: directoryOperation(),
  partyOperation: Schema.decodeSync(EnrollmentOwnerOperationSnapshotSchema)({
    actorPrincipalId,
    createdAt: at,
    ownerInvocationId: id(12),
    ownerModuleKey: PARTY_OWNER,
    portalEnrollmentAttemptId: request.attemptId,
    portalEnrollmentOwnerOperationId: id(13),
    requestDigest: 'e'.repeat(64),
    required: true,
    resultReference: partyRef.resourceId,
    revision: 2,
    status: 'SUCCEEDED',
    tenantId: request.tenantId,
    transitionKey: 'party.candidate.submit',
    updatedAt: at,
  }),
  registration: Option.some(
    Schema.decodeSync(RetailEnrollmentRegistrationSchema)({ displayName: 'Zákazník', email: 'customer@example.test' }),
  ),
});

const configuration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: 'operator-service-api-key',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
  }),
);
const tokenFor = (tokenId: number) =>
  `${Base64Url.encode('{}')}.${Base64Url.encode(
    JSON.stringify({
      aud: 'party-registry',
      compositionRevision,
      exp: 1_700_000_300,
      iat: 1_700_000_000,
      iss: 'https://shell.example.test',
      jti: `70000000-0000-4000-8000-${String(tokenId).padStart(12, '0')}`,
      principal: {
        authBindingId: id(80),
        authContextRef: 'key:operator-service',
        authMethod: 'api_key',
        legalEntityId,
        principalId: id(60),
        tenantId: request.tenantId,
      },
      sub: id(60),
      targetBuildMarker: 'party-release-1',
      ver: 1,
    }),
  )}.test-signature`;

interface PartyAnswer {
  readonly body: Readonly<Record<string, string | number | boolean>>;
  readonly status: number;
}
const roleOverlap: PartyAnswer = {
  body: {
    _tag: 'PartyCommandConflictProblem',
    code: 'counterparty_role_overlap',
    detail: 'The command conflicts with the current state. Review the resource before trying again.',
    status: 409,
    title: 'Party Registry command conflict',
    type: 'https://ontos.dev/problems/party-command-conflict',
  },
  status: 409,
};
const outage: PartyAnswer = {
  body: {
    _tag: 'PartyCommandUnavailableProblem',
    detail: 'Party Registry is unavailable',
    retryable: true,
    status: 503,
    title: 'Party Registry unavailable',
    type: 'https://ontos.dev/problems/party-command-unavailable',
  },
  status: 503,
};

const scenario = (partyAnswer: PartyAnswer = roleOverlap) => {
  let current = observation();
  let claims = 0;
  let settlements = 0;
  let journalFailure = false;
  const commands: { readonly key: string | null; readonly url: string }[] = [];
  let issued = 0;
  const fakeFetch: typeof fetch = (target, init) => {
    const outgoing = new Request(target, init);
    if (outgoing.url.endsWith('/auth/api-key/gateway-context')) {
      issued += 1;
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/api/approved/party-registry',
          compositionRevision,
          expiresAt: 1_700_000_300,
          token: tokenFor(issued),
        }),
      );
    }
    if (outgoing.url.endsWith('/action-commits/resolve')) {
      // Party commits nothing for a refused command, so the original key was never started.
      return Promise.resolve(
        Response.json({ _tag: 'PartyCommandCommitResolution', retryCommand: true, state: 'NOT_STARTED' }),
      );
    }
    commands.push({ key: outgoing.headers.get('idempotency-key'), url: outgoing.url });
    return Promise.resolve(Response.json(partyAnswer.body, { status: partyAnswer.status }));
  };
  const store: CommerceEnrollmentOwnerAttemptStore = {
    claimTransition: () =>
      Effect.sync(() => {
        claims += 1;
        const { lease: attemptLease, ...attempt } = current.attempt;
        const { lease: operationLease, ...operation } = current.operation;
        void attemptLease;
        void operationLease;
        current = {
          ...current,
          attempt: { ...attempt, revision: attempt.revision + 1, state: 'RECONCILIATION_REQUIRED' },
          operation: { ...operation, revision: operation.revision + 1, status: 'INDETERMINATE' },
        };
        return { attempt: current.attempt, outcome: 'INDETERMINATE' as const };
      }),
    read: () => Effect.sync(() => current.attempt),
    readOwnerOperation: () => Effect.sync(() => current.operation),
    reconcileOutcome: (input, resolution) =>
      Effect.gen(function* settleOnlyApprovedOperation() {
        if (journalFailure || input.ownerInvocationId !== request.ownerInvocationId) {
          return yield* new CommerceEnrollmentAttemptUnavailable({
            code: 'attempt_unavailable',
            reason: 'Fixture native journal failure',
            retryable: true,
          });
        }
        settlements += 1;
        let operation = directoryOperation({
          completedAt: at,
          revision: current.operation.revision + 1,
          status: resolution.status,
        });
        if (resolution.failureCode !== undefined) {
          operation = { ...operation, failureCode: resolution.failureCode };
        }
        if (resolution.outcomeCode !== undefined) {
          operation = { ...operation, outcomeCode: resolution.outcomeCode };
        }
        current = {
          ...current,
          attempt: { ...current.attempt, revision: current.attempt.revision + 1 },
          core: { ...current.core, durablePresent: false },
          operation,
        };
        return { attempt: current.attempt, operation: current.operation, outcome: 'RECORDED' as const };
      }),
    recordOutcome: () => Effect.die('Operator must never call ordinary recordOutcome'),
  };
  return {
    change: (next: DirectoryRecoveryObservation) => {
      current = next;
    },
    commands,
    counts: () => ({ claims, issued, settlements }),
    current: () => current,
    failJournal: () => {
      journalFailure = true;
    },
    fakeFetch,
    runtime: { observe: () => Effect.sync(() => current), store: () => store },
  };
};

const run = (
  test: ReturnType<typeof scenario>,
  mode: 'check' | 'reconcile',
  approvalSha256?: string,
  source = sourceRevision,
) =>
  recoverAdmittedCustomerDirectory({ approvalSha256, mode, request, sourceRevision: source }).pipe(
    Effect.provideService(AdmittedCustomerDirectoryRecoveryRuntime, test.runtime),
    Effect.provideService(FetchHttpClient.Fetch, test.fakeFetch),
    Effect.provide(configuration),
  );

it.effect('check reads the journal, names the exact operation and calls neither Party nor the journal writer', () =>
  Effect.gen(function* readOnlyCheck() {
    const test = scenario();
    const first = yield* run(test, 'check');
    expect(yield* run(test, 'check')).toEqual(first);
    expect(first).toMatchObject({
      actorPrincipalId,
      attemptRevision: 12,
      attemptState: 'IN_PROGRESS',
      operationId: id(3),
      operationRevision: 3,
      operationStatus: 'INDETERMINATE',
      status: 'checked',
    });
    expect(first.approvalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain('customer@example.test');
    expect(test.counts()).toEqual({ claims: 0, issued: 0, settlements: 0 });
    expect(test.commands).toEqual([]);
  }),
);

it.effect('reconcile re-sends only the original customer-role key and records the Party refusal as terminal', () =>
  Effect.gen(function* reconcileRefusedDirectory() {
    const test = scenario();
    const check = yield* run(test, 'check');
    const result = yield* run(test, 'reconcile', check.approvalSha256);
    expect(result).toMatchObject({
      approvalSha256: check.approvalSha256,
      operationStatus: 'FAILED',
      outcomeCode: 'counterparty_role_overlap',
      status: 'reconciled',
    });
    expect(test.current().operation.failureCode).toBe('owner_rejected');
    expect(test.current().core.durablePresent).toBe(false);
    expect(test.counts()).toMatchObject({ claims: 0, settlements: 1 });
    expect(test.commands).toHaveLength(1);
    expect(test.commands[0]?.url.endsWith('/counterparty-customer-onboard')).toBe(true);
  }),
);

it.effect('fences an expired IN_PROGRESS claim natively before reconciling it', () =>
  Effect.gen(function* fenceExpiredClaim() {
    const test = scenario();
    const baseline = observation();
    test.change({ ...baseline, operation: directoryOperation({ lease: expired, status: 'IN_PROGRESS' }) });
    const check = yield* run(test, 'check');
    const result = yield* run(test, 'reconcile', check.approvalSha256);
    expect(result.operationStatus).toBe('FAILED');
    expect(test.counts()).toMatchObject({ claims: 1, settlements: 1 });
  }),
);

it.effect('rejects absent, changed and source-stale approval before any Party call or journal write', () =>
  Effect.gen(function* rejectUnapprovedMutation() {
    const test = scenario();
    const check = yield* run(test, 'check');
    expect((yield* Effect.flip(run(test, 'reconcile'))).reason).toBe('approval-required');
    expect((yield* Effect.flip(run(test, 'reconcile', 'f'.repeat(64)))).reason).toBe(APPROVAL_MISMATCH);
    expect((yield* Effect.flip(run(test, 'reconcile', check.approvalSha256, 'f'.repeat(40)))).reason).toBe(
      APPROVAL_MISMATCH,
    );
    test.change({ ...test.current(), attempt: { ...test.current().attempt, revision: 13 } });
    expect((yield* Effect.flip(run(test, 'reconcile', check.approvalSha256))).reason).toBe(APPROVAL_MISMATCH);
    expect(test.counts()).toEqual({ claims: 0, issued: 0, settlements: 0 });
  }),
);

it.effect('refuses evidence outside the exact admitted directory operation', () =>
  Effect.gen(function* rejectMismatchedEvidence() {
    const baseline = observation();
    const cases: readonly (readonly [DirectoryRecoveryObservation, string])[] = [
      [{ ...baseline, core: { ...baseline.core, admissionClosed: false } }, AUTHORITY_UNAVAILABLE],
      [{ ...baseline, core: { ...baseline.core, authorityFresh: false } }, AUTHORITY_UNAVAILABLE],
      [{ ...baseline, core: { ...baseline.core, authorityRevision: 'f'.repeat(64) } }, AUTHORITY_UNAVAILABLE],
      [{ ...baseline, core: { ...baseline.core, durablePresent: false } }, OPERATION_MISMATCH],
      [{ ...baseline, attempt: { ...baseline.attempt, state: 'COMPLETE' } }, 'scope-mismatch'],
      [{ ...baseline, attempt: { ...baseline.attempt, journey: 'EXISTING_ACCOUNT' } }, 'journey-unsupported'],
      [{ ...baseline, operation: directoryOperation({ status: 'SUCCEEDED' }) }, OPERATION_MISMATCH],
      [
        { ...baseline, operation: directoryOperation({ transitionKey: 'party.candidate.submit' }) },
        'operation-mismatch',
      ],
      [{ ...baseline, operation: directoryOperation({ actorPrincipalId: id(99) }) }, 'actor-mismatch'],
      [{ ...baseline, operation: directoryOperation({ requestDigest: 'f'.repeat(64) }) }, 'digest-mismatch'],
      [
        {
          ...baseline,
          operation: directoryOperation({ lease: { ...expired, leaseExpiresAt: '2999-01-01T00:00:00.000Z' } }),
        },
        'lease-live',
      ],
      [{ ...baseline, registration: Option.none() }, 'evidence-unavailable'],
    ];
    for (const [evidence, reason] of cases) {
      const test = scenario();
      test.change(evidence);
      expect((yield* Effect.flip(run(test, 'check'))).reason).toBe(reason);
      expect(test.counts()).toEqual({ claims: 0, issued: 0, settlements: 0 });
    }
  }),
);

it.effect('leaves a Party outage unsettled instead of guessing an outcome', () =>
  Effect.gen(function* keepOutageFenced() {
    const test = scenario(outage);
    const check = yield* run(test, 'check');
    expect((yield* Effect.flip(run(test, 'reconcile', check.approvalSha256))).reason).toBe('journal-unsettled');
    expect(test.current().operation.status).toBe('INDETERMINATE');
    expect(test.current().core.durablePresent).toBe(true);
    expect(test.counts().settlements).toBe(0);
  }),
);

it.effect('reports a journal write failure as unsettled', () =>
  Effect.gen(function* journalFailure() {
    const test = scenario();
    const check = yield* run(test, 'check');
    test.failJournal();
    expect((yield* Effect.flip(run(test, 'reconcile', check.approvalSha256))).reason).toBe('journal-unsettled');
    expect(test.current().core.durablePresent).toBe(true);
  }),
);
