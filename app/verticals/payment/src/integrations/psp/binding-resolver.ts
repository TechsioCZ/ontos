import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PaymentCustomerConfigurationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import type { GatewayProviderAccountRef } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../../shared/domain/psp-vocabulary.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';
import type { GatewayExecutionTarget } from './psp-request.ts';

/**
 * Resolves the exact Provider Account Binding named by a C16 operation binding or a notification
 * route (#1155). Retired bindings resolve for their historical operations; the Current binding is
 * never substituted. Unknown refs, environment mismatches and credential gaps are UNAVAILABLE.
 */

export interface GatewayExecutionTargetQuery {
  /**
   * The credential revision recorded on an existing dispatch (replay, lookup, notification of an
   * in-flight operation). `None` selects the binding's current revision for a first dispatch.
   */
  readonly credentialRevision: Option.Option<number>;
  /** Present for COLLECT (enablement return URL); absent for cancel, refund and recovery. */
  readonly customerConfigurationId: Option.Option<typeof PaymentCustomerConfigurationIdSchema.Type>;
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  /** Core-verified worker scope; tenant and legal entity never come from the message payload. */
  readonly scope: OutboxWorkerLegalEntityScope;
}

export interface GatewayNotificationTargetQuery {
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly scope: OutboxWorkerLegalEntityScope;
}

export interface GatewayBindingResolverContract {
  readonly resolveExecutionTarget: (
    query: GatewayExecutionTargetQuery,
  ) => Effect.Effect<GatewayExecutionTarget, GatewayProviderUnavailableError>;
  /** `returnUrl` is always `None` here. */
  readonly resolveForNotification: (
    query: GatewayNotificationTargetQuery,
  ) => Effect.Effect<GatewayExecutionTarget, GatewayProviderUnavailableError>;
}

export class GatewayBindingResolver extends Context.Service<GatewayBindingResolver, GatewayBindingResolverContract>()(
  '@app/payment/integrations/psp/binding-resolver/GatewayBindingResolver',
) {}
