import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { Order, Schema, SchemaGetter } from 'effect';

import { SourceProvisioningLocationsSchema, SourceProvisioningPolicySchema } from '../domain/source-provisioning.ts';
import type { SourceProvisioningLocation } from '../domain/source-provisioning.ts';
import { SourceProvisioningPolicyRejected } from '../domain/source-provisioning-policy-rejected.ts';
import { SourceProvisioningUnavailable } from '../domain/source-provisioning-unavailable.ts';
import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const canonicalUuid = Schema.String.check(Schema.isUUID(), Schema.isPattern(/^[0-9a-f-]+$/u));
const canonicalLocations = SchemaGetter.transform((locations: readonly SourceProvisioningLocation[]) =>
  locations.toSorted((left, right) => Order.String(left.locationKey, right.locationKey)),
);

/**
 * The one provisioning policy of the selected external Inventory Backend of a Customer Configuration. The issuer
 * and the instant the provisioned correlations hold from are taken from that backend configuration.
 */
export const DefineSourceProvisioningPolicyPayloadSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  externalScope: boundedText,
  locations: SourceProvisioningLocationsSchema.pipe(
    Schema.decode({ decode: canonicalLocations, encode: canonicalLocations }),
  ),
  namespace: boundedText,
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter(({ locations, ownerConfigurationRef, unitRef }) =>
    [ownerConfigurationRef, unitRef, ...locations.map(({ stockLocationRef }) => stockLocationRef)].every(
      ({ resourceId, tenantId }) => Schema.is(canonicalUuid)(resourceId) && Schema.is(canonicalUuid)(tenantId),
    )
      ? undefined
      : 'Source provisioning policy native identifiers must be canonical lowercase UUIDs',
  ),
);
export type DefineSourceProvisioningPolicyPayload = typeof DefineSourceProvisioningPolicyPayloadSchema.Type;

export const DefineSourceProvisioningPolicyResultSchema = Schema.Struct({
  outcome: Schema.Literals(['DEFINED', 'EXACT_REPLAY']),
  policy: SourceProvisioningPolicySchema,
});
export type DefineSourceProvisioningPolicyResult = typeof DefineSourceProvisioningPolicyResultSchema.Type;

export const DefineSourceProvisioningPolicyErrorSchema = Schema.Union([
  SourceProvisioningPolicyRejected,
  SourceProvisioningUnavailable,
]);
export type DefineSourceProvisioningPolicyError = typeof DefineSourceProvisioningPolicyErrorSchema.Type;
