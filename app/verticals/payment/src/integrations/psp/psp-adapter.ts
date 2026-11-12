import { Context } from 'effect';
import type { Effect } from 'effect';

import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type { GatewayCapabilityRow } from './capability-matrix.ts';
import type { RawProviderNotification, VerifiedNotificationTrigger } from './notification-envelope.ts';
import type {
  GatewayNotificationRejectedError,
  GatewayProviderOutcomeUnknownError,
  GatewayProviderResponseInvalidError,
  GatewayProviderUnavailableError,
  GatewayProviderUnsupportedError,
} from './psp-errors.ts';
import type {
  GatewayCancelRequest,
  GatewayCollectRequest,
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayLookupRequest,
  GatewayRefundRequest,
} from './psp-request.ts';
import type { PreparedProviderRequest, ProviderDispatchResponse, ProviderFindingResult } from './psp-result.ts';

/**
 * Provider-neutral adapter contract implemented once per gateway family (#1154). Preparation is
 * pure and happens before the dispatch ledger commits; `send` makes exactly one provider attempt.
 */

type PrepareFailure = GatewayProviderUnavailableError | GatewayProviderUnsupportedError;
type SendFailure = GatewayProviderOutcomeUnknownError | GatewayProviderUnavailableError;

export interface GatewayProviderAdapter {
  readonly capabilities: GatewayCapabilityRow;
  readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
  /**
   * Bounded-retry read through the target's binding. May return several findings (e.g. a
   * collection plus its refunds). A miss or "not found" is INDETERMINATE, never NOT_EFFECTED.
   */
  readonly lookup: (
    target: GatewayExecutionTarget,
    request: GatewayLookupRequest,
  ) => Effect.Effect<
    readonly ProviderFindingResult[],
    GatewayProviderResponseInvalidError | GatewayProviderUnavailableError
  >;
  readonly prepareCancel: (
    target: GatewayExecutionTarget,
    request: GatewayCancelRequest,
  ) => Effect.Effect<PreparedProviderRequest, PrepareFailure>;
  readonly prepareCollect: (
    target: GatewayExecutionTarget,
    request: GatewayCollectRequest,
  ) => Effect.Effect<PreparedProviderRequest, PrepareFailure>;
  readonly prepareRefund: (
    target: GatewayExecutionTarget,
    request: GatewayRefundRequest,
  ) => Effect.Effect<PreparedProviderRequest, PrepareFailure>;
  /** Re-sends the exact persisted bytes and key inside the replay window. Stripe only; others are Unsupported. */
  readonly replay: (
    target: GatewayExecutionTarget,
    prepared: PreparedProviderRequest,
    expected: GatewayExpectedEffect,
  ) => Effect.Effect<ProviderDispatchResponse, GatewayProviderUnsupportedError | SendFailure>;
  /** One provider attempt; never retried here. */
  readonly send: (
    target: GatewayExecutionTarget,
    prepared: PreparedProviderRequest,
    expected: GatewayExpectedEffect,
  ) => Effect.Effect<ProviderDispatchResponse, SendFailure>;
  /** Authenticates a raw notification for the binding it was addressed to; `verifiedAt` comes from the Effect clock. */
  readonly verifyNotification: (
    target: GatewayExecutionTarget,
    notification: RawProviderNotification,
  ) => Effect.Effect<VerifiedNotificationTrigger, GatewayNotificationRejectedError | GatewayProviderUnavailableError>;
}

export interface GatewayProviderAdaptersContract {
  /** The adapter of exactly this family; there is no cross-family fallback. */
  readonly forFamily: (
    family: typeof PaymentGatewayProviderFamilySchema.Type,
  ) => Effect.Effect<GatewayProviderAdapter, GatewayProviderUnavailableError>;
}

export class GatewayProviderAdapters extends Context.Service<
  GatewayProviderAdapters,
  GatewayProviderAdaptersContract
>()('@app/payment/integrations/psp/psp-adapter/GatewayProviderAdapters') {}
