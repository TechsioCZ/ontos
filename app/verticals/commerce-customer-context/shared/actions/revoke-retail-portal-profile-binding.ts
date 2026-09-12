import { RetailPortalBindingResultSchema } from './bind-retail-portal-profile.ts';
import { RetailPortalProfileBindingMutationPayloadSchema } from './retail-portal-profile-binding-mutation.ts';

export const RevokeRetailPortalProfileBindingPayloadSchema = RetailPortalProfileBindingMutationPayloadSchema;
export type RevokeRetailPortalProfileBindingPayload = typeof RevokeRetailPortalProfileBindingPayloadSchema.Type;

export const RevokeRetailPortalProfileBindingResultSchema = RetailPortalBindingResultSchema;
export type RevokeRetailPortalProfileBindingResult = typeof RevokeRetailPortalProfileBindingResultSchema.Type;
