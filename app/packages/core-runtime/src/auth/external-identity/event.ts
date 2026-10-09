import {
  ReservePrincipalBindingCoreIdentityPrincipalBindingReservedV1OutboxPayloadSchema,
  ReservePrincipalBindingCoreIdentityPrincipalBindingReservedV1OutboxTopic,
} from '../../modules/actions/reserve-principal-binding-core-identity-principal-binding-reserved-v1.outbox-message.ts';
import {
  ActivatePrincipalBindingCoreIdentityPrincipalBindingActivatedV1OutboxPayloadSchema,
  ActivatePrincipalBindingCoreIdentityPrincipalBindingActivatedV1OutboxTopic,
} from '../../modules/actions/activate-principal-binding-core-identity-principal-binding-activated-v1.outbox-message.ts';
import {
  ChangePrincipalBindingStatusCoreIdentityPrincipalBindingStatusChangedV1OutboxPayloadSchema,
  ChangePrincipalBindingStatusCoreIdentityPrincipalBindingStatusChangedV1OutboxTopic,
} from '../../modules/actions/change-principal-binding-status-core-identity-principal-binding-status-changed-v1.outbox-message.ts';

/**
 * The lifecycle event map is derived from the generated outbox contracts. A
 * domain event and its outbox message deliberately share the same neutral
 * payload shape so the transaction cannot publish a provider-specific shadow
 * event.
 */
export const PRINCIPAL_BINDING_RESERVED_EVENT_TYPE =
  ReservePrincipalBindingCoreIdentityPrincipalBindingReservedV1OutboxTopic;
export const PRINCIPAL_BINDING_ACTIVATED_EVENT_TYPE =
  ActivatePrincipalBindingCoreIdentityPrincipalBindingActivatedV1OutboxTopic;
export const PRINCIPAL_BINDING_STATUS_CHANGED_EVENT_TYPE =
  ChangePrincipalBindingStatusCoreIdentityPrincipalBindingStatusChangedV1OutboxTopic;

export const principalBindingLifecycleDomainEvents = Object.freeze({
  [PRINCIPAL_BINDING_ACTIVATED_EVENT_TYPE]:
    ActivatePrincipalBindingCoreIdentityPrincipalBindingActivatedV1OutboxPayloadSchema,
  [PRINCIPAL_BINDING_RESERVED_EVENT_TYPE]:
    ReservePrincipalBindingCoreIdentityPrincipalBindingReservedV1OutboxPayloadSchema,
  [PRINCIPAL_BINDING_STATUS_CHANGED_EVENT_TYPE]:
    ChangePrincipalBindingStatusCoreIdentityPrincipalBindingStatusChangedV1OutboxPayloadSchema,
});
