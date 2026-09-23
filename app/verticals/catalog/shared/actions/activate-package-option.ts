import { PackageOptionTransitionPayloadSchema } from './package-option-contract.ts';

export const ActivatePackageOptionPayloadSchema = PackageOptionTransitionPayloadSchema;
export type ActivatePackageOptionPayload = typeof ActivatePackageOptionPayloadSchema.Type;
export { PackageOptionTransitionResultSchema as ActivatePackageOptionResultSchema } from './package-option-contract.ts';
