import type { CoreReadonlyDbExecutor } from './db/types.ts';
import type { OperationContext } from './operation-context.ts';

export interface PolicyAllowed {
  readonly ok: true;
  readonly policyKey: string;
  readonly reason: string;
}

export interface PolicyDenied<TDeniedState = unknown> {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly policyKey: string;
  readonly reason: string;
  readonly state: TDeniedState;
}

export type PolicyDecision<TDeniedState = unknown> = PolicyAllowed | PolicyDenied<TDeniedState>;

export interface PolicyExecutionInput<TInput> {
  readonly data: TInput;
  readonly db: CoreReadonlyDbExecutor;
  readonly operation: OperationContext<TInput>;
}

export type PolicyCheck<TInput, TDeniedState = unknown> = (
  input: PolicyExecutionInput<TInput>,
) => PolicyDecision<TDeniedState> | Promise<PolicyDecision<TDeniedState>>;

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
  readonly message: string;
  readonly policyKey: string;
  readonly reason: string;
  readonly state: unknown;
}): PolicyDenied => ({
  code: input.code,
  message: input.message,
  ok: false,
  policyKey: input.policyKey,
  reason: input.reason,
  state: input.state,
});
