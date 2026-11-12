import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type { GatewayProviderAccountRef } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../../shared/domain/psp-vocabulary.ts';
import type { PaymentOwnerScope } from '../../ports/owner-evidence-unavailable.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';
import type { GatewayExecutionTarget } from './psp-request.ts';

export interface GatewayCaptureTargetQuery {
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  /** The notification route's family; a binding of another family is `None` (BINDING_UNKNOWN). */
  readonly providerFamily: typeof PaymentGatewayProviderFamilySchema.Type;
  /** The capture Action's verified Tenant and Selling Legal Entity; never taken from webhook fields. */
  readonly scope: PaymentOwnerScope;
}

/**
 * Action side, for `capture-provider-notification` only: the same binding, environment, historical and
 * credential rules as `resolveForNotification`, read over the Action's own scoped transaction. Implemented
 * by L-CONFIG-BINDING; there is no second resolution path.
 */
export interface GatewayCaptureBindingResolverContract {
  /**
   * `None` when no binding of this family with this ref exists in this scope and environment (capture result
   * REJECTED `BINDING_UNKNOWN`); UNAVAILABLE when the binding cannot be read or used now. `returnUrl` is `None`.
   */
  readonly resolveForCapture: (
    query: GatewayCaptureTargetQuery,
  ) => Effect.Effect<Option.Option<GatewayExecutionTarget>, GatewayProviderUnavailableError>;
}

export class GatewayCaptureBindingResolver extends Context.Service<
  GatewayCaptureBindingResolver,
  GatewayCaptureBindingResolverContract
>()('@app/payment/integrations/psp/capture-binding-resolver/GatewayCaptureBindingResolver') {}
