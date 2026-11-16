import { Context, Duration, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { shellGatewayBaseUrlConfig } from '@app/shared-contracts/shell-gateway-url';
import { HttpApi, HttpApiClient } from 'effect/http-api';

import {
  PaymentReconciliationGroup,
  PaymentReconciliationIdempotencyKeySchema,
} from '../../../shared/payment-gateway-relay.ts';
import type { PaymentReconciliationRecoveryPayload } from '../../../shared/payment-gateway-relay.ts';
import type { GatewayReconciliationDueRow } from '../../persistence/gateway-reconciliation-due.ts';
import type { ReconciliationApiKey } from './reconciliation-credentials.ts';

/**
 * The reconciliation driver's only effect (#1158, phase 2 D-P5): one A10 `request-payment-operation-recovery`
 * request for one listed debt row, through the Shell's route-scoped `paymentReconciliation` relay with the
 * Tenant's integration API key. The driver never calls a provider and never names a recovery mode; A10 picks
 * it from the operation's original binding and the actual time, and a recovery delivery looks up before it
 * would ever replay the exact stored request.
 *
 * The key and the payload depend only on the listed row, so two drivers that read the same row send the same
 * request: Core idempotency commits it once. `round` counts committed recovery requests, so a new key exists
 * only after an A10 committed. A lost answer is UNAVAILABLE and is never resent within the tick; the next tick
 * either sees the committed round (and its backoff) or sends the identical request again.
 */

/** Why a row was not requested. Only `forbidden` and `module_state` cool the whole Tenant down. */
export const GatewayReconciliationSkipReasonSchema = Schema.Literals([
  'already_resolved',
  'drain',
  'forbidden',
  'hash_conflict',
  'held',
  'module_state',
]);
export type GatewayReconciliationSkipReason = typeof GatewayReconciliationSkipReasonSchema.Type;

export const GatewayReconciliationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('REQUESTED', {}),
  Schema.TaggedStruct('SKIPPED', { reason: GatewayReconciliationSkipReasonSchema }),
  Schema.TaggedStruct('UNAVAILABLE', {}),
]);
export type GatewayReconciliationOutcome = typeof GatewayReconciliationOutcomeSchema.Type;

export const GATEWAY_RECONCILIATION_REQUESTED: GatewayReconciliationOutcome = Object.freeze({ _tag: 'REQUESTED' });
export const GATEWAY_RECONCILIATION_UNAVAILABLE: GatewayReconciliationOutcome = Object.freeze({ _tag: 'UNAVAILABLE' });
export const gatewayReconciliationSkipped = (
  reason: GatewayReconciliationSkipReason,
): GatewayReconciliationOutcome => ({
  _tag: 'SKIPPED',
  reason,
});

/** The caller idempotency key of `row`'s current round. */
export const gatewayReconciliationIdempotencyKey = (row: Pick<GatewayReconciliationDueRow, 'operationId' | 'round'>) =>
  `payment.gateway-reconciliation:${row.operationId}:r${row.round}`;

/** The A10 payload of `row`: the original operation and the listed trigger, never a mode. */
export const gatewayReconciliationPayload = (
  row: GatewayReconciliationDueRow,
): PaymentReconciliationRecoveryPayload => ({
  operationId: row.operationId,
  paymentId: row.paymentId,
  reason: `Gateway reconciliation round ${row.round}`,
  trigger: row.recommendedTrigger,
});

export interface GatewayReconciliationInvokerContract {
  /** Never fails: every answer, transport failure and timeout is an outcome. */
  readonly request: (
    row: GatewayReconciliationDueRow,
    apiKey: ReconciliationApiKey,
  ) => Effect.Effect<GatewayReconciliationOutcome>;
}

export class GatewayReconciliationInvoker extends Context.Service<
  GatewayReconciliationInvoker,
  GatewayReconciliationInvokerContract
>()('@app/payment/integrations/psp/gateway-reconciliation-invoker/GatewayReconciliationInvoker') {}

const PaymentReconciliationDriverApi = HttpApi.make('paymentReconciliationDriver').add(PaymentReconciliationGroup);

/** One exchange, including the body read; a slower answer is UNAVAILABLE for this tick. */
const REQUEST_TIMEOUT = Duration.seconds(30);

const skipped = (reason: GatewayReconciliationSkipReason) => Effect.succeed(gatewayReconciliationSkipped(reason));
const unavailable = Effect.succeed(GATEWAY_RECONCILIATION_UNAVAILABLE);

/** A10's conflict code: another driver's commit of this round, a resolved operation, or a refusal a person owns. */
const outcomeOfConflict = (code: string) =>
  Match.value(code).pipe(
    Match.when('payment_recovery_operation_already_resolved', () => skipped('already_resolved')),
    // Another driver committed this round (same key) or committed it with a newer trigger (same key, other hash).
    Match.whenOr('action_request_hash_conflict', 'action_already_committed', () => skipped('hash_conflict')),
    Match.orElse(() => skipped('held')),
  );

/**
 * Live invoker over the Shell relay. The relay paths are absolute host paths below
 * `/api/payment/v1`, so only the origin of `ONTOS_SHELL_GATEWAY_BASE_URL` is used: the Shell refuses a relay
 * path that arrives under its BFF mount. The URL is read per request, so a missing value makes the driver
 * UNAVAILABLE without stopping the worker host.
 */
export const GatewayReconciliationInvokerLive = Layer.effect(
  GatewayReconciliationInvoker,
  Effect.gen(function* makeGatewayReconciliationInvoker() {
    const httpClient = yield* HttpClient.HttpClient;
    const request = Effect.fn('GatewayReconciliationInvoker.request')(function* requestRecovery(
      row: GatewayReconciliationDueRow,
      apiKey: ReconciliationApiKey,
    ) {
      // The one Shell address rule of every client that presents a key: HTTPS, or plain HTTP to loopback only.
      const base = yield* shellGatewayBaseUrlConfig;
      const idempotencyKey = yield* Schema.decodeEffect(PaymentReconciliationIdempotencyKeySchema)(
        gatewayReconciliationIdempotencyKey(row),
      );
      const client = yield* HttpApiClient.group(PaymentReconciliationDriverApi, {
        baseUrl: base.origin,
        group: 'paymentReconciliation',
        httpClient,
      });
      return yield* client.requestRecovery({
        headers: {
          'idempotency-key': idempotencyKey,
          'x-api-key': Redacted.value(apiKey),
        },
        params: { routeKey: row.routeKey },
        payload: gatewayReconciliationPayload(row),
      });
    });
    return GatewayReconciliationInvoker.of({
      request: (row, apiKey) =>
        request(row, apiKey).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.as(GATEWAY_RECONCILIATION_REQUESTED),
          // Shell relay answers: 401 (key refused), 403 (forbidden, module state, or an approval that would park
          // a proposal) and 404 (unknown route for this key's Tenant) are Tenant-level refusals; 422 is a refusal
          // a person owns; 503, a timeout and every transport or decoding failure are retried in a later tick.
          Effect.catchTags(
            {
              PaymentReconciliationAuthenticationProblem: () => skipped('forbidden'),
              PaymentReconciliationConflictProblem: ({ code }) => outcomeOfConflict(code),
              PaymentReconciliationForbiddenProblem: () => skipped('forbidden'),
              PaymentReconciliationIneligibleProblem: () => skipped('held'),
              PaymentReconciliationNotFoundProblem: () => skipped('forbidden'),
            },
            () => unavailable,
          ),
        ),
    });
  }),
);
