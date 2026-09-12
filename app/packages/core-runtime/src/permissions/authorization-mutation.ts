import { Context, Schema } from 'effect';
import type { Effect } from 'effect';
import type { BusinessAccessTarget } from './context-access.ts';
import type { BusinessPermissionCode } from './business-permission.ts';
import type { PrincipalRef } from './principal-ref.ts';

export const AUTHORIZATION_MUTATION_STATES = [
  'PENDING_GRANT',
  'ACTIVE',
  'PENDING_REVOKE',
  'REVOKED',
  'RECONCILIATION_REQUIRED',
] as const;
export const AuthorizationMutationStateSchema = Schema.Literals(AUTHORIZATION_MUTATION_STATES);
export type AuthorizationMutationState = typeof AuthorizationMutationStateSchema.Type;

export const AUTHORIZATION_MUTATION_TRANSITIONS = Object.freeze({
  ACTIVE: Object.freeze(['PENDING_REVOKE', 'RECONCILIATION_REQUIRED']),
  PENDING_GRANT: Object.freeze(['ACTIVE', 'RECONCILIATION_REQUIRED']),
  PENDING_REVOKE: Object.freeze(['REVOKED', 'RECONCILIATION_REQUIRED']),
  RECONCILIATION_REQUIRED: Object.freeze(['ACTIVE', 'PENDING_GRANT', 'PENDING_REVOKE', 'REVOKED']),
  REVOKED: Object.freeze(['PENDING_GRANT', 'RECONCILIATION_REQUIRED']),
} satisfies Readonly<Record<AuthorizationMutationState, readonly AuthorizationMutationState[]>>);

export const canTransitionAuthorizationMutation = (
  from: AuthorizationMutationState,
  to: AuthorizationMutationState,
): boolean => from === to || AUTHORIZATION_MUTATION_TRANSITIONS[from].some((candidate) => candidate === to);

export interface AuthorizationMutationJournalEntry {
  readonly attemptCount: number;
  readonly businessTarget: BusinessAccessTarget;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- This is persisted journal evidence, not ambient request-context threading.
  readonly correlationId: string;
  readonly lastFailureCode?: string;
  readonly mutationId: string;
  readonly operation: 'grant' | 'revoke';
  readonly permission: BusinessPermissionCode;
  readonly principal: PrincipalRef;
  readonly state: AuthorizationMutationState;
}

export interface AuthorizationMutationJournalService {
  readonly begin: (
    entry: Omit<AuthorizationMutationJournalEntry, 'attemptCount' | 'state'>,
  ) => Effect.Effect<AuthorizationMutationJournalEntry>;
  readonly transition: (input: {
    readonly failureCode?: string;
    readonly mutationId: string;
    readonly to: AuthorizationMutationState;
  }) => Effect.Effect<AuthorizationMutationJournalEntry>;
}

export class AuthorizationMutationJournal extends Context.Service<
  AuthorizationMutationJournal,
  AuthorizationMutationJournalService
>()('@app/core-runtime/permissions/authorization-mutation/AuthorizationMutationJournal') {}
