import { RetailPortalBindingResultSchema } from './bind-retail-portal-profile.ts';
import { RetailPortalProfileBindingMutationPayloadSchema } from './retail-portal-profile-binding-mutation.ts';

export const RecoverRetailPortalProfileBindingPayloadSchema = RetailPortalProfileBindingMutationPayloadSchema;
export type RecoverRetailPortalProfileBindingPayload = typeof RecoverRetailPortalProfileBindingPayloadSchema.Type;

export const RecoverRetailPortalProfileBindingResultSchema = RetailPortalBindingResultSchema;
export type RecoverRetailPortalProfileBindingResult = typeof RecoverRetailPortalProfileBindingResultSchema.Type;
