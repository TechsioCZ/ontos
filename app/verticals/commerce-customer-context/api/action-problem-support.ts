interface ProblemFields<Status extends number> {
  readonly detail: string;
  readonly status: Status;
  readonly title: string;
  readonly type: string;
}

type CodedProblemFields<Code extends string, Status extends number> = ProblemFields<Status> & {
  readonly code: Code;
};

type UnavailableProblemFields<Code extends string> = CodedProblemFields<Code, 503> & {
  readonly retryable: true;
};

export type PurchasingApprovalDomainProblemIdentity =
  | {
      readonly code: 'COMMIT_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'LEVEL_ALREADY_COMPLETED' | 'STALE_PROPOSAL_REVISION';
      readonly kind: 'conflict';
    }
  | { readonly code: 'BUYER_PERMISSION_DENIED' | 'PERMISSION_DENIED'; readonly kind: 'forbidden' }
  | {
      readonly code:
        | 'HIERARCHY_AMBIGUOUS'
        | 'HIERARCHY_RANGE_INVALID'
        | 'NO_ELIGIBLE_ROUTE'
        | 'NOT_ROUTE_ELIGIBLE'
        | 'OWNER_CONFIRMATION_EXPIRED'
        | 'POLICY_ROUTE_INVALID'
        | 'PROFILE_INACTIVE'
        | 'PROPOSAL_MATERIAL_CHANGE'
        | 'PROPOSAL_NOT_CURRENT'
        | 'REQUEST_EXPIRED'
        | 'REQUEST_NOT_PENDING'
        | 'REQUEST_SUPERSEDED'
        | 'SELF_APPROVAL_DENIED';
      readonly kind: 'ineligible';
    }
  | { readonly code: 'HIERARCHY_NOT_FOUND'; readonly kind: 'notFound' }
  | {
      readonly code: 'CURRENT_STATE_INDETERMINATE' | 'DEPENDENCY_UNAVAILABLE' | 'EVIDENCE_PERSISTENCE_FAILED';
      readonly kind: 'unavailable';
    };

export type CounterpartyAccessDomainProblemIdentity =
  | { readonly code: 'invitation_revision_conflict'; readonly kind: 'conflict' }
  | {
      readonly code: 'counterparty_scope_mismatch' | 'principal_scope_mismatch';
      readonly kind: 'forbidden';
    }
  | {
      readonly code:
        | 'administrative_scope_exceeded'
        | 'bootstrap_required'
        | 'grantor_not_authorized'
        | 'invitation_claim_proof_consumed'
        | 'invitation_claim_proof_invalid'
        | 'invitation_claimant_mismatch'
        | 'invitation_expired'
        | 'invitation_invalid'
        | 'inviter_authority_denied'
        | 'permission_not_delegable'
        | 'permission_scope_not_allowed'
        | 'principal_not_eligible'
        | 'reason_required';
      readonly kind: 'ineligible';
    }
  | { readonly code: 'invitation_rate_limited'; readonly kind: 'rateLimited' }
  | { readonly code: 'counterparty_access_unavailable'; readonly kind: 'unavailable' };

export const actionProblemStatus = {
  authentication: 401,
  conflict: 409,
  forbidden: 403,
  ineligible: 422,
  internal: 500,
  invalid: 400,
  notFound: 404,
  precondition: 428,
  rateLimited: 429,
  timeout: 504,
  unavailable: 503,
} as const;

export const purchasingApprovalRejectedProblemByCode = {
  BUYER_PERMISSION_DENIED: { code: 'BUYER_PERMISSION_DENIED', kind: 'forbidden' },
  COMMIT_CONFLICT: { code: 'COMMIT_CONFLICT', kind: 'conflict' },
  CURRENT_STATE_INDETERMINATE: { code: 'CURRENT_STATE_INDETERMINATE', kind: 'unavailable' },
  DEPENDENCY_UNAVAILABLE: { code: 'DEPENDENCY_UNAVAILABLE', kind: 'unavailable' },
  EVIDENCE_PERSISTENCE_FAILED: { code: 'EVIDENCE_PERSISTENCE_FAILED', kind: 'unavailable' },
  HIERARCHY_AMBIGUOUS: { code: 'HIERARCHY_AMBIGUOUS', kind: 'ineligible' },
  HIERARCHY_NOT_FOUND: { code: 'HIERARCHY_NOT_FOUND', kind: 'notFound' },
  HIERARCHY_RANGE_INVALID: { code: 'HIERARCHY_RANGE_INVALID', kind: 'ineligible' },
  IDEMPOTENCY_CONFLICT: { code: 'IDEMPOTENCY_CONFLICT', kind: 'conflict' },
  LEVEL_ALREADY_COMPLETED: { code: 'LEVEL_ALREADY_COMPLETED', kind: 'conflict' },
  NO_ELIGIBLE_ROUTE: { code: 'NO_ELIGIBLE_ROUTE', kind: 'ineligible' },
  NOT_ROUTE_ELIGIBLE: { code: 'NOT_ROUTE_ELIGIBLE', kind: 'ineligible' },
  OWNER_CONFIRMATION_EXPIRED: { code: 'OWNER_CONFIRMATION_EXPIRED', kind: 'ineligible' },
  PERMISSION_DENIED: { code: 'PERMISSION_DENIED', kind: 'forbidden' },
  POLICY_ROUTE_INVALID: { code: 'POLICY_ROUTE_INVALID', kind: 'ineligible' },
  PROFILE_INACTIVE: { code: 'PROFILE_INACTIVE', kind: 'ineligible' },
  PROPOSAL_MATERIAL_CHANGE: { code: 'PROPOSAL_MATERIAL_CHANGE', kind: 'ineligible' },
  PROPOSAL_NOT_CURRENT: { code: 'PROPOSAL_NOT_CURRENT', kind: 'ineligible' },
  REQUEST_EXPIRED: { code: 'REQUEST_EXPIRED', kind: 'ineligible' },
  REQUEST_NOT_PENDING: { code: 'REQUEST_NOT_PENDING', kind: 'ineligible' },
  REQUEST_SUPERSEDED: { code: 'REQUEST_SUPERSEDED', kind: 'ineligible' },
  SELF_APPROVAL_DENIED: { code: 'SELF_APPROVAL_DENIED', kind: 'ineligible' },
  STALE_PROPOSAL_REVISION: { code: 'STALE_PROPOSAL_REVISION', kind: 'conflict' },
} as const satisfies Record<string, PurchasingApprovalDomainProblemIdentity>;

export const counterpartyAccessContractViolationProblemByCode = {
  administrative_scope_exceeded: { code: 'administrative_scope_exceeded', kind: 'ineligible' },
  bootstrap_required: { code: 'bootstrap_required', kind: 'ineligible' },
  counterparty_scope_mismatch: { code: 'counterparty_scope_mismatch', kind: 'forbidden' },
  grantor_not_authorized: { code: 'grantor_not_authorized', kind: 'ineligible' },
  invitation_claim_proof_consumed: { code: 'invitation_claim_proof_consumed', kind: 'ineligible' },
  invitation_claim_proof_invalid: { code: 'invitation_claim_proof_invalid', kind: 'ineligible' },
  invitation_claimant_mismatch: { code: 'invitation_claimant_mismatch', kind: 'ineligible' },
  invitation_expired: { code: 'invitation_expired', kind: 'ineligible' },
  invitation_invalid: { code: 'invitation_invalid', kind: 'ineligible' },
  invitation_rate_limited: { code: 'invitation_rate_limited', kind: 'rateLimited' },
  invitation_revision_conflict: { code: 'invitation_revision_conflict', kind: 'conflict' },
  inviter_authority_denied: { code: 'inviter_authority_denied', kind: 'ineligible' },
  permission_not_delegable: { code: 'permission_not_delegable', kind: 'ineligible' },
  permission_scope_not_allowed: { code: 'permission_scope_not_allowed', kind: 'ineligible' },
  principal_not_eligible: { code: 'principal_not_eligible', kind: 'ineligible' },
  principal_scope_mismatch: { code: 'principal_scope_mismatch', kind: 'forbidden' },
  reason_required: { code: 'reason_required', kind: 'ineligible' },
} as const satisfies Record<string, CounterpartyAccessDomainProblemIdentity>;

export const makeAuthenticationProblem =
  <Output>(make: (input: ProblemFields<401>) => Output): (() => Output) =>
  () =>
    make({
      detail: 'A valid audience-scoped Bearer assertion is required.',
      status: actionProblemStatus.authentication,
      title: 'Authentication required',
      type: 'https://ontos.dev/problems/operation-authentication-required',
    });

export const makeConflictProblem =
  <Code extends string, Output>(make: (input: CodedProblemFields<Code, 409>) => Output): ((code: Code) => Output) =>
  (code) =>
    make({
      code,
      detail: 'The Action conflicts with current state.',
      status: actionProblemStatus.conflict,
      title: 'Action conflict',
      type: 'https://ontos.dev/problems/action-conflict',
    });

export const makeForbiddenProblem =
  <Code extends string, Output>(make: (input: CodedProblemFields<Code, 403>) => Output): ((code: Code) => Output) =>
  (code) =>
    make({
      code,
      detail: 'The principal is not permitted to perform this Action.',
      status: actionProblemStatus.forbidden,
      title: 'Action forbidden',
      type: 'https://ontos.dev/problems/action-forbidden',
    });

export const makeIneligibleProblem =
  <Code extends string, Output>(make: (input: CodedProblemFields<Code, 422>) => Output): ((code: Code) => Output) =>
  (code) =>
    make({
      code,
      detail: 'The request is not eligible for this Action.',
      status: actionProblemStatus.ineligible,
      title: 'Action ineligible',
      type: 'https://ontos.dev/problems/action-ineligible',
    });

export const makeInternalProblem =
  <Output>(make: (input: ProblemFields<500>) => Output): (() => Output) =>
  () =>
    make({
      detail: 'The Action could not be completed.',
      status: actionProblemStatus.internal,
      title: 'Action failed',
      type: 'https://ontos.dev/problems/action-failed',
    });

export const makeInvalidProblem =
  <Output>(make: (input: ProblemFields<400>) => Output, actionSlug: string): (() => Output) =>
  () =>
    make({
      detail: `The ${actionSlug} Action request is invalid.`,
      status: actionProblemStatus.invalid,
      title: 'Invalid Action request',
      type: 'https://ontos.dev/problems/action-invalid',
    });

export const makeNotFoundProblem =
  <Code extends string, Output>(make: (input: CodedProblemFields<Code, 404>) => Output): ((code: Code) => Output) =>
  (code) =>
    make({
      code,
      detail: 'The requested resource was not found.',
      status: actionProblemStatus.notFound,
      title: 'Resource not found',
      type: 'https://ontos.dev/problems/action-resource-not-found',
    });

export const makePreconditionProblem =
  <Output>(make: (input: ProblemFields<428>) => Output): (() => Output) =>
  () =>
    make({
      detail: 'An Idempotency-Key header is required.',
      status: actionProblemStatus.precondition,
      title: 'Idempotency key required',
      type: 'https://ontos.dev/problems/idempotency-key-required',
    });

export const makeRateLimitedProblem =
  <Code extends string, Output>(make: (input: CodedProblemFields<Code, 429>) => Output): ((code: Code) => Output) =>
  (code) =>
    make({
      code,
      detail: 'The Action rate limit has been exceeded.',
      status: actionProblemStatus.rateLimited,
      title: 'Action rate limited',
      type: 'https://ontos.dev/problems/action-rate-limited',
    });

export const makeUnavailableProblem =
  <Code extends string, Output>(make: (input: UnavailableProblemFields<Code>) => Output): ((code: Code) => Output) =>
  (code) =>
    make({
      code,
      detail: 'The Action capability is temporarily unavailable.',
      retryable: true,
      status: actionProblemStatus.unavailable,
      title: 'Action unavailable',
      type: 'https://ontos.dev/problems/action-unavailable',
    });
