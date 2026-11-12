import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PaymentCustomerConfigurationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type { GatewayProviderAccountRef } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../../shared/domain/psp-vocabulary.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';
import type { GatewayExecutionTarget } from './psp-request.ts';

/**
 * Resolves the exact Provider Account Binding named by a C16 operation binding or a notification
 * route (#1155). Retired bindings resolve for their historical operations; the Current binding is
 * never substituted. Unknown refs, environment mismatches, a binding of another family, unreadable
 * routines and credential gaps are UNAVAILABLE for the query's family (never a defect).
 *
 * Credential rule (#1158): every resolution returns the binding's current ACTIVE credential revision.
 * A rotation authenticates the same account, so replay, lookup and notification processing after a
 * rotation use the new revision of the same binding. A dispatch's recorded `credentialRevision` is
 * audit only and never selects a credential. The capture Action resolves through
 * `GatewayCaptureBindingReader` (capture-binding-resolver.ts) under the same rules.
 */

export interface GatewayExecutionTargetQuery {
  /** Present for COLLECT (enablement return URL); absent for cancel, refund and recovery. */
  readonly customerConfigurationId: Option.Option<typeof PaymentCustomerConfigurationIdSchema.Type>;
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  /** Family of the C16 operation binding; a resolved binding of another family is UNAVAILABLE. */
  readonly providerFamily: typeof PaymentGatewayProviderFamilySchema.Type;
  /** Core-verified worker scope; tenant and legal entity never come from the message payload. */
  readonly scope: OutboxWorkerLegalEntityScope;
}

export interface GatewayNotificationTargetQuery {
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  /** Family of the stored notification's route. */
  readonly providerFamily: typeof PaymentGatewayProviderFamilySchema.Type;
  readonly scope: OutboxWorkerLegalEntityScope;
}

/** Worker side: implemented over the scoped routines by L-CONFIG-BINDING. */
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
