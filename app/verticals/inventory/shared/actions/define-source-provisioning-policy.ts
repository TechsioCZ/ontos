import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { Schema } from 'effect';

import { SourceProvisioningLocationsSchema, SourceProvisioningPolicySchema } from '../domain/source-provisioning.ts';
import { SourceProvisioningPolicyRejected } from '../domain/source-provisioning-policy-rejected.ts';
import { SourceProvisioningUnavailable } from '../domain/source-provisioning-unavailable.ts';
import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

/**
 * The one provisioning policy of the selected external Inventory Backend of a Customer Configuration. The issuer
 * and the instant the provisioned correlations hold from are taken from that backend configuration.
 */
export const DefineSourceProvisioningPolicyPayloadSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  externalScope: boundedText,
  locations: SourceProvisioningLocationsSchema,
  namespace: boundedText,
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  unitRef: ProductUnitRefSchema,
});
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
