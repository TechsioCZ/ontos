import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context, Schema } from 'effect';
import type { Effect, Option } from 'effect';

import { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../../shared/domain/psp-configuration.ts';
import { GatewayEnvironmentSchema, ProviderNotificationStateSchema } from '../../../shared/domain/psp-vocabulary.ts';
import type { ProviderNotificationState } from '../../../shared/domain/psp-vocabulary.ts';
import { VerifiedNotificationTriggerSchema } from './notification-envelope.ts';
import type { GatewayLedgerUnavailableError } from './psp-errors.ts';

/**
 * Worker-side access to captured provider notifications (#1157). Capture is an Action; processing
 * columns are changed only through scoped routines.
 */

export const ProviderNotificationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ProviderNotificationId'),
);
export type ProviderNotificationId = typeof ProviderNotificationIdSchema.Type;

export const StoredProviderNotificationSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  correlatedOperationId: Schema.Option(PaymentOperationIdSchema),
  environment: GatewayEnvironmentSchema,
  notificationId: ProviderNotificationIdSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  receivedAt: Schema.DateTimeUtc,
  state: ProviderNotificationStateSchema,
  trigger: VerifiedNotificationTriggerSchema,
});
export type StoredProviderNotification = typeof StoredProviderNotificationSchema.Type;

export interface ReadProviderNotificationInput {
  readonly notificationId: ProviderNotificationId;
  readonly scope: OutboxWorkerLegalEntityScope;
}

export interface TransitionProviderNotificationInput {
  readonly correlatedOperationId: Option.Option<typeof PaymentOperationIdSchema.Type>;
  readonly notificationId: ProviderNotificationId;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly to: ProviderNotificationState;
  readonly workerContext: OutboxWorkerHandlerContext;
}

export interface ProviderNotificationStoreContract {
  readonly read: (
    input: ReadProviderNotificationInput,
  ) => Effect.Effect<Option.Option<StoredProviderNotification>, GatewayLedgerUnavailableError>;
  /** Idempotent for the same target state and correlation; an illegal transition fails. */
  readonly transition: (
    input: TransitionProviderNotificationInput,
  ) => Effect.Effect<StoredProviderNotification, GatewayLedgerUnavailableError>;
}

export class ProviderNotificationStore extends Context.Service<
  ProviderNotificationStore,
  ProviderNotificationStoreContract
>()('@app/payment/integrations/psp/notification-store/ProviderNotificationStore') {}
