import { PackageOptionTransitionPayloadSchema } from './package-option-contract.ts';

export const RetirePackageOptionPayloadSchema = PackageOptionTransitionPayloadSchema;
export type RetirePackageOptionPayload = typeof RetirePackageOptionPayloadSchema.Type;
export { PackageOptionTransitionResultSchema as RetirePackageOptionResultSchema } from './package-option-contract.ts';
