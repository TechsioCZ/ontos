import { Cause, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import { userBanHoldsAt } from '../../api/auth/gateway-delegation-authentication.service.ts';
import {
  ORIGINATOR_EVIDENCE_MAX_AGE_DAYS,
  OriginatorEvidenceRowSchema,
  admitInvocationEvidence,
  decodeOriginatorEvidenceRows,
} from '../../api/auth/gateway-originator-evidence.ts';

const nowSeconds = 1_700_000_000;
const tenantId = '50000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';
const bindingId = '10000000-0000-4000-8000-000000000001';
const userId = 'better-auth-user-1';
const declaredAction = 'privacy.core.dispatch-privacy-measure';
const impersonator = '40000000-0000-4000-8000-000000000009';

interface RecordedRow {
  readonly actionKey: string;
  readonly authBindingId: string | null;
  readonly authContextRef: string | null;
  readonly authMethod: string | null;
  readonly bindingAuthenticationNamespaceId: string | null;
  readonly bindingPrincipalId: string | null;
  readonly bindingProviderSubjectId: string | null;
  readonly bindingRevoked: boolean | null;
  readonly bindingStatus: string | null;
  readonly bindingSubjectType: string | null;
  readonly impersonatedByPrincipalId: string | null;
  readonly legalEntityId: string | null;
  readonly principalId: string | null;
  readonly principalKind: string | null;
  readonly principalStatus: string | null;
  readonly startedAtEpochSeconds: number | null;
  readonly status: string;
}

/** One row exactly as the Core select returns it: a succeeded session invocation of a declared Action with an active binding. */
const recordedSessionRow = (overrides: Partial<RecordedRow> = {}): RecordedRow => ({
  actionKey: declaredAction,
  authBindingId: bindingId,
  authContextRef: 'better-auth-session:original-session',
  authMethod: 'session',
  bindingAuthenticationNamespaceId: 'ontos.staff.better-auth.v1',
  bindingPrincipalId: principalId,
  bindingProviderSubjectId: userId,
  bindingRevoked: false,
  bindingStatus: 'active',
  bindingSubjectType: 'user',
  impersonatedByPrincipalId: null,
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId,
  principalKind: 'human',
  principalStatus: 'active',
  startedAtEpochSeconds: nowSeconds - 3600,
  status: 'succeeded',
  ...overrides,
});

const decodeRecorded = Schema.decodeUnknownSync(Schema.Array(OriginatorEvidenceRowSchema));
const admitWith = (
  rows: readonly RecordedRow[],
  overrides: Partial<{ originatorActions: readonly string[]; subjectUserBanned: boolean }> = {},
) =>
  admitInvocationEvidence(decodeRecorded(rows), {
    nowSeconds,
    originatorActions: [declaredAction],
    subjectUserBanned: false,
    tenantId,
    ...overrides,
  });
const admit = (rows: readonly RecordedRow[]) => admitWith(rows);

/** The typed code of a failed admission; anything else is not a delegation refusal. */
const failureCodeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) {
    return null;
  }
  const failure = Cause.squash(exit.cause);
  return Schema.is(GatewayDelegationError)(failure) ? failure.code : null;
};

it.effect('admits the requester recorded on a succeeded invocation with its stored authentication', () =>
  Effect.gen(function* admitted() {
    const { principal, workload } = yield* admit([recordedSessionRow()]);
    expect(workload).toBe(false);
    expect(principal).toEqual({
      authBindingId: bindingId,
      authContextRef: 'better-auth-session:original-session',
      authenticationNamespaceId: 'ontos.staff.better-auth.v1',
      authMethod: 'session',
      legalEntityId: '30000000-0000-4000-8000-000000000001',
      principalId,
      tenantId,
    });
  }),
);

it.effect('admits a recorded API-key requester without any live key or session', () =>
  Effect.gen(function* apiKeyRequester() {
    const { principal, workload } = yield* admit([
      recordedSessionRow({
        authContextRef: 'better-auth-api-key:key-1',
        authMethod: 'api_key',
        bindingSubjectType: 'api_key',
        legalEntityId: null,
        principalKind: 'service',
      }),
    ]);
    expect(principal.authMethod).toBe('api_key');
    expect(principal.legalEntityId).toBeUndefined();
    // A service principal is a workload requester: only it may later name the company of tenant-context work.
    expect(workload).toBe(true);
  }),
);

it.effect('admits the requester of an invocation of an Action the calling module declares', () =>
  Effect.gen(function* declared() {
    const { principal } = yield* admitWith([recordedSessionRow({ actionKey: 'commerce.order.commit-order' })], {
      originatorActions: ['commerce.order.commit-order', declaredAction],
    });
    expect(principal.principalId).toBe(principalId);
  }),
);

it.effect('admits a requester whose user is not banned now', () =>
  Effect.gen(function* notBanned() {
    const { principal } = yield* admitWith([recordedSessionRow()], { subjectUserBanned: false });
    expect(principal.principalId).toBe(principalId);
  }),
);

const banAt = (banned: boolean | null, banExpires: Date | null) => ({ banExpires, banned });
const banNow = nowSeconds * 1000;
it('holds a ban that is open-ended or not yet expired, and no other ban', () => {
  expect(userBanHoldsAt(banAt(true, null), nowSeconds)).toBe(true);
  expect(userBanHoldsAt(banAt(true, new Date(banNow + 1000)), nowSeconds)).toBe(true);
  expect(userBanHoldsAt(banAt(true, new Date(banNow - 1000)), nowSeconds)).toBe(false);
  expect(userBanHoldsAt(banAt(false, null), nowSeconds)).toBe(false);
  expect(userBanHoldsAt(banAt(null, null), nowSeconds)).toBe(false);
});

const undeclaredActionRefusals: readonly (readonly [string, Parameters<typeof admitWith>[1]])[] = [
  ['an Action the calling module did not declare', { originatorActions: ['commerce.order.commit-order'] }],
  ['any Action when the calling module declares none', { originatorActions: [] }],
];
for (const [label, overrides] of undeclaredActionRefusals) {
  it.effect(`refuses a requester of ${label}`, () =>
    Effect.gen(function* refusedAction() {
      expect(failureCodeOf(yield* Effect.exit(admitWith([recordedSessionRow()], overrides)))).toBe('forbidden');
    }),
  );
}

it.effect('refuses a requester whose user is banned now', () =>
  Effect.gen(function* banned() {
    expect(failureCodeOf(yield* Effect.exit(admitWith([recordedSessionRow()], { subjectUserBanned: true })))).toBe(
      'forbidden',
    );
  }),
);

it.effect('refuses a support impersonation, which has no lifetime to cap its replay by', () =>
  Effect.gen(function* impersonated() {
    const row = recordedSessionRow({
      authContextRef: 'better-auth-session:impersonation-session',
      authMethod: 'support_impersonation',
      impersonatedByPrincipalId: impersonator,
    });
    expect(failureCodeOf(yield* Effect.exit(admit([row])))).toBe('forbidden');
  }),
);

it.effect('admits evidence at the edge of the seven-day window but no older', () =>
  Effect.gen(function* window() {
    const edge = nowSeconds - ORIGINATOR_EVIDENCE_MAX_AGE_DAYS * 24 * 60 * 60;
    yield* admit([recordedSessionRow({ startedAtEpochSeconds: edge })]);
    const tooOld = yield* Effect.exit(admit([recordedSessionRow({ startedAtEpochSeconds: edge - 1 })]));
    expect(failureCodeOf(tooOld)).toBe('forbidden');
  }),
);

const refusals: readonly (readonly [string, readonly RecordedRow[]])[] = [
  ['no recorded invocation for this tenant', []],
  ['an invocation that is not a terminal success', [recordedSessionRow({ status: 'running' })]],
  ['a rejected invocation', [recordedSessionRow({ status: 'rejected' })]],
  ['an invocation with no principal', [recordedSessionRow({ principalId: null })]],
  ['an inactive principal', [recordedSessionRow({ principalStatus: 'disabled' })]],
  ['a revoked binding', [recordedSessionRow({ bindingRevoked: true })]],
  ['a binding that is no longer active', [recordedSessionRow({ bindingStatus: 'disabled' })]],
  [
    'a binding of another principal',
    [recordedSessionRow({ bindingPrincipalId: '40000000-0000-4000-8000-000000000002' })],
  ],
  ['a binding of the wrong subject type', [recordedSessionRow({ bindingSubjectType: 'api_key' })]],
  ['a missing binding', [recordedSessionRow({ authBindingId: null, bindingPrincipalId: null, bindingStatus: null })]],
  ['a system invocation, which carries no requester', [recordedSessionRow({ authMethod: 'system' })]],
  ['an invocation with no recorded authentication method', [recordedSessionRow({ authMethod: null })]],
  ['an invocation older than the window', [recordedSessionRow({ startedAtEpochSeconds: nowSeconds - 8 * 86_400 })]],
  ['a requester recorded as impersonated', [recordedSessionRow({ impersonatedByPrincipalId: impersonator })]],
  ['an invocation recorded in the future', [recordedSessionRow({ startedAtEpochSeconds: nowSeconds + 3600 })]],
  ['an invocation with no recorded time', [recordedSessionRow({ startedAtEpochSeconds: null })]],
];
for (const [label, rows] of refusals) {
  it.effect(`refuses ${label}`, () =>
    Effect.gen(function* refused() {
      expect(failureCodeOf(yield* Effect.exit(admit(rows)))).toBe('forbidden');
    }),
  );
}

it.effect('reports an unreadable Core row as unavailable rather than admitting or forbidding it', () =>
  Effect.gen(function* unreadable() {
    expect(Exit.isFailure(yield* Effect.exit(decodeOriginatorEvidenceRows([{ unexpected: true }])))).toBe(true);
  }),
);

it.effect('decodes a row Core returned into the admission shape without changing it', () =>
  Effect.gen(function* decodes() {
    const rows = yield* decodeOriginatorEvidenceRows([recordedSessionRow({ impersonatedByPrincipalId: null })]);
    expect(rows).toHaveLength(1);
    expect(
      yield* admitInvocationEvidence(rows, {
        nowSeconds,
        originatorActions: [declaredAction],
        subjectUserBanned: false,
        tenantId,
      }),
    ).toMatchObject({ principal: { principalId, tenantId }, workload: false });
  }),
);
