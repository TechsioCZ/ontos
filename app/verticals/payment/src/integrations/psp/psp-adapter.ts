import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type { GatewayCapabilityRow } from './capability-matrix.ts';
import type { RawProviderNotification, VerifiedNotificationTrigger } from './notification-envelope.ts';
import type { GatewayOrderReference } from './psp-correlation.ts';
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
  ProviderObjectRef,
} from './psp-request.ts';
import type {
  PreparedProviderRequest,
  ProviderDispatchResponse,
  ProviderFindingResult,
  ProviderReplayRequest,
} from './psp-result.ts';

/**
 * Provider-neutral adapter contract implemented once per gateway family (#1154). Preparation is
 * pure and happens before the dispatch ledger commits; `send` makes exactly one provider attempt.
 *
 * Findings vs failures: a finding states what the provider proved about an operation. A capability
 * the family lacks is always `GatewayProviderUnsupported` and an unreachable provider, credential or
 * binding is always `GatewayProviderUnavailable`; neither is ever expressed as a finding.
 */

type PrepareFailure = GatewayProviderUnavailableError | GatewayProviderUnsupportedError;
type SendFailure = GatewayProviderOutcomeUnknownError | GatewayProviderUnavailableError;

export interface GatewayProviderAdapter {
  readonly capabilities: GatewayCapabilityRow;
  readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
  /**
   * Bounded-retry read through the target's binding. Returns at most one finding per operation named
   * by `request.expected` (the operation itself, plus the collection target of a CANCEL_OR_VOID) and
   * never a finding for any other provider object. A miss or "not found" is INDETERMINATE, never
   * NOT_EFFECTED. ORDER_REFERENCE on a family without an order-reference lookup is Unsupported.
   */
  readonly lookup: (
    target: GatewayExecutionTarget,
    request: GatewayLookupRequest,
  ) => Effect.Effect<
    readonly ProviderFindingResult[],
    GatewayProviderResponseInvalidError | GatewayProviderUnavailableError | GatewayProviderUnsupportedError
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
  /**
   * Retrieves one provider object through the target's binding and returns the OntOS order reference it
   * states, only when the object belongs to that binding's merchant and environment (GoPay `order_number` of
   * the binding GoID; Comgate `refId` of the binding merchant's status answer; Stripe
   * `metadata.ontos_order_reference` read with the binding's key in its mode). A candidate for correlation,
   * never evidence: the caller still proves it with `lookup`. A miss or a foreign object is `None`.
   */
  readonly readOrderReference: (
    target: GatewayExecutionTarget,
    ref: ProviderObjectRef,
  ) => Effect.Effect<
    Option.Option<GatewayOrderReference>,
    GatewayProviderResponseInvalidError | GatewayProviderUnavailableError | GatewayProviderUnsupportedError
  >;
  /**
   * Re-sends the exact persisted bytes, headers and key of `ProviderReplayRequest` (built by
   * `replayRequestOf` from the ledger record). Stripe only; other families are Unsupported. Reading the
   * Effect Clock immediately before the single mutate, it fails Unsupported with reason
   * `replay_window_expired` unless `window.startsAt <= now < window.expiresAt`, and caps the mutate
   * timeout at `window.expiresAt`.
   */
  readonly replay: (
    target: GatewayExecutionTarget,
    request: ProviderReplayRequest,
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
