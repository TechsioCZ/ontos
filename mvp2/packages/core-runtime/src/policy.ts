export interface PolicyAllowed {
  readonly ok: true;
  readonly policyKey: string;
  readonly reason: string;
}

export interface PolicyDenied {
  readonly ok: false;
  readonly code: string;
  readonly policyKey: string;
  readonly reason: string;
}

export type PolicyDecision = PolicyAllowed | PolicyDenied;

export type PolicyCheck<TData> = (data: TData) => PolicyDecision;

export const allowPolicy = (input: {
  readonly policyKey: string;
  readonly reason: string;
}): PolicyAllowed => ({
  ok: true,
  policyKey: input.policyKey,
  reason: input.reason,
});

export const denyPolicy = (input: {
  readonly code: string;
  readonly policyKey: string;
  readonly reason: string;
}): PolicyDenied => ({
  code: input.code,
  ok: false,
  policyKey: input.policyKey,
  reason: input.reason,
});

export const rejectStringStartingWithNewPolicy: PolicyCheck<string> = (value) =>
  value.startsWith('New')
    ? denyPolicy({
        code: 'string_starts_with_new',
        policyKey: 'core.string.startsWithNew',
        reason: 'The value cannot start with "New".',
      })
    : allowPolicy({
        policyKey: 'core.string.startsWithNew',
        reason: 'The value does not start with "New".',
      });
