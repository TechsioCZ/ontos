import { Effect, Schema } from 'effect';

import { AddSavedAddressPayloadSchema } from '../actions/add-saved-address.ts';
import { UpdateSavedAddressPayloadSchema } from '../actions/update-saved-address.ts';
import { RemoveSavedAddressPayloadSchema } from '../actions/remove-saved-address.ts';

import { CreateCustomerGroupPayloadSchema } from '../actions/create-customer-group.ts';
import { UpdateCustomerGroupPayloadSchema } from '../actions/update-customer-group.ts';
import { EnsureRetailCustomerProfilePayloadSchema } from '../actions/ensure-retail-customer-profile.ts';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../actions/create-counterparty-purchasing-profile.ts';
import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '../actions/apply-customer-group-membership-source.ts';
import { ChangeOrganizationCustomerProfileIcoPayloadSchema } from './organization-profile-ico.ts';
import { ChangeCustomerProfileIcoPayloadSchema } from '../actions/change-customer-profile-ico.ts';
import { AssignCustomerPriceGroupPayloadSchema } from '../actions/assign-customer-price-group.ts';
import { AssignCounterpartyPriceGroupPayloadSchema } from '../actions/assign-counterparty-price-group.ts';

const OWNER = 'commerce.customer-context' as const;
type NativeTarget = Readonly<{
  targetModuleKey?: typeof OWNER;
  targetResourceId?: string;
  targetResourceType?: string;
}>;

/** Projects the published payload codec and actual native Action target before transport.
 * It grants no permission and is not proof that the Action committed. Scope-wide Actions
 * declare no accessTarget; business references in their payload do not create one. */
const requestIdentity = <Decoded, Encoded, ActionKey extends string>(
  schema: Schema.Codec<Decoded, Encoded>,
  payload: Schema.Json | Encoded,
  actionKey: ActionKey,
  target: (decoded: Decoded) => NativeTarget,
) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(payload).pipe(
    Effect.flatMap((decoded) =>
      Schema.encodeEffect(schema)(decoded).pipe(
        Effect.map((normalizedPayload) => ({
          actionKey,
          normalizedPayload,
          owningModuleKey: OWNER,
          schemaVersion: '1' as const,
          target: target(decoded),
        })),
      ),
    ),
  );

export const createCustomerGroupRequestIdentity = (
  payload: Schema.Json | typeof CreateCustomerGroupPayloadSchema.Encoded,
) =>
  requestIdentity(
    CreateCustomerGroupPayloadSchema,
    payload,
    'commerce.customer-context.create-customer-group',
    () => ({}),
  );

export const updateCustomerGroupRequestIdentity = (
  payload: Schema.Json | typeof UpdateCustomerGroupPayloadSchema.Encoded,
) =>
  requestIdentity(
    UpdateCustomerGroupPayloadSchema,
    payload,
    'commerce.customer-context.update-customer-group',
    () => ({}),
  );

export const ensureRetailCustomerProfileRequestIdentity = (
  payload: Schema.Json | typeof EnsureRetailCustomerProfilePayloadSchema.Encoded,
) =>
  requestIdentity(
    EnsureRetailCustomerProfilePayloadSchema,
    payload,
    'commerce.customer-context.ensure-retail-customer-profile',
    () => ({}),
  );

export const createCounterpartyPurchasingProfileRequestIdentity = (
  payload: Schema.Json | typeof CreateCounterpartyPurchasingProfilePayloadSchema.Encoded,
) =>
  requestIdentity(
    CreateCounterpartyPurchasingProfilePayloadSchema,
    payload,
    'commerce.customer-context.create-counterparty-purchasing-profile',
    () => ({}),
  );

export const applyCustomerGroupMembershipSourceRequestIdentity = (
  payload: Schema.Json | typeof ApplyCustomerGroupMembershipSourcePayloadSchema.Encoded,
) =>
  requestIdentity(
    ApplyCustomerGroupMembershipSourcePayloadSchema,
    payload,
    'commerce.customer-context.apply-customer-group-membership-source',
    () => ({}),
  );

export const changeCustomerProfileIcoRequestIdentity = (
  payload: Schema.Json | typeof ChangeCustomerProfileIcoPayloadSchema.Encoded,
) =>
  requestIdentity(
    ChangeCustomerProfileIcoPayloadSchema,
    payload,
    'commerce.customer-context.change-customer-profile-ico',
    (decoded) => ({
      targetModuleKey: OWNER,
      targetResourceId: decoded.profileRef.resourceId,
      targetResourceType: 'commerce.customer-context.customer-profile-ico.change',
    }),
  );

export const assignCustomerPriceGroupRequestIdentity = (
  payload: Schema.Json | typeof AssignCustomerPriceGroupPayloadSchema.Encoded,
) =>
  requestIdentity(
    AssignCustomerPriceGroupPayloadSchema,
    payload,
    'commerce.customer-context.assign-customer-price-group',
    () => ({}),
  );

export const assignCounterpartyPriceGroupRequestIdentity = (
  payload: Schema.Json | typeof AssignCounterpartyPriceGroupPayloadSchema.Encoded,
) =>
  requestIdentity(
    AssignCounterpartyPriceGroupPayloadSchema,
    payload,
    'commerce.customer-context.assign-counterparty-price-group',
    () => ({}),
  );

export const addSavedAddressRequestIdentity = (payload: Schema.Json | typeof AddSavedAddressPayloadSchema.Encoded) =>
  requestIdentity(AddSavedAddressPayloadSchema, payload, 'commerce.customer-context.add-saved-address', () => ({}));

export const updateSavedAddressRequestIdentity = (
  payload: Schema.Json | typeof UpdateSavedAddressPayloadSchema.Encoded,
) =>
  requestIdentity(
    UpdateSavedAddressPayloadSchema,
    payload,
    'commerce.customer-context.update-saved-address',
    () => ({}),
  );

export const removeSavedAddressRequestIdentity = (
  payload: Schema.Json | typeof RemoveSavedAddressPayloadSchema.Encoded,
) =>
  requestIdentity(
    RemoveSavedAddressPayloadSchema,
    payload,
    'commerce.customer-context.remove-saved-address',
    () => ({}),
  );

export const changeOrganizationCustomerProfileIcoRequestIdentity = (
  payload: Schema.Json | typeof ChangeOrganizationCustomerProfileIcoPayloadSchema.Encoded,
) =>
  requestIdentity(
    ChangeOrganizationCustomerProfileIcoPayloadSchema,
    payload,
    'commerce.customer-context.change-organization-customer-profile-ico',
    (decoded) => ({
      targetModuleKey: OWNER,
      targetResourceId: decoded.profileRef.resourceId,
      targetResourceType: 'commerce.customer-context.organization-customer-profile-ico.change',
    }),
  );
