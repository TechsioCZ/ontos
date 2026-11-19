import { Context } from 'effect';
import type { Crypto, Effect, Option } from 'effect';

import type { CommunicationDecisionUnavailable as CommunicationDecisionUnavailableClass } from '../../shared/communication-intake-errors.ts';
import type {
  CommunicationDecisionIdSchema,
  CommunicationDecisionView,
  CommunicationRequestIdSchema,
} from '../../shared/communication-intake.ts';
import type { DecisionPlan } from '../domain/intake/plan.ts';

type CommunicationDecisionUnavailable = InstanceType<typeof CommunicationDecisionUnavailableClass>;

/** The stored first outcome of one request identity: exactly what a duplicate gets back. */
export interface StoredCommunicationDecision {
  readonly decision: CommunicationDecisionView;
  readonly decisionId: typeof CommunicationDecisionIdSchema.Type;
  readonly fingerprint: string;
  readonly requestId: typeof CommunicationRequestIdSchema.Type;
  readonly requiredness: 'OPTIONAL' | 'REQUIRED' | undefined;
}

/**
 * The owner-local port to the request, decision and intent store, generated as this owner's Action service. Every
 * program takes it as an argument: the Action's scoped transaction exists only per invocation, and the Tenant is the
 * one the Core scope installed, never a value a caller can name.
 */
export interface CommunicationIntakePortContract {
  /** The stored decision of an identity; none is a proven absence, not an unreadable store. */
  readonly findDecision: (
    identityKey: string,
  ) => Effect.Effect<Option.Option<StoredCommunicationDecision>, CommunicationDecisionUnavailable>;
  /** Writes request, decision and intents together, in this transaction, and returns the stored decision. */
  readonly insertDecision: (input: {
    readonly actionInvocationId: string;
    readonly fingerprint: string;
    readonly identityKey: string;
    readonly plan: DecisionPlan;
    readonly scopeKey: string;
  }) => Effect.Effect<StoredCommunicationDecision, CommunicationDecisionUnavailable>;
  /** Serializes every decision about one request identity for the rest of the transaction. */
  readonly lockIdentity: (identityKey: string) => Effect.Effect<void, CommunicationDecisionUnavailable>;
  /** Records that an identity arrived again with another meaning; idempotent for the same conflicting fingerprint. */
  readonly recordConflict: (input: {
    readonly actionInvocationId: string;
    readonly fingerprint: string;
    readonly requestId: typeof CommunicationRequestIdSchema.Type;
  }) => Effect.Effect<void, CommunicationDecisionUnavailable, Crypto.Crypto>;
}

/** The Context tag of the port, for a later lane that composes its own Layer over a scoped transaction. */
export class CommunicationIntakePort extends Context.Service<
  CommunicationIntakePort,
  CommunicationIntakePortContract
>()('@app/communications/services/communication-intake-port.service/CommunicationIntakePort') {}
