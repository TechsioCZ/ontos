import { Schema } from 'effect';

import { PackageDefinitionSelectionRevisionSchema } from '@app/catalog-selection-contracts/catalog-selection';
import { PackageDefinitionEvidenceRefsSchema, PackageDefinitionReasonSchema } from './package-definition-contract.ts';

export const ActivatePackageDefinitionPayloadSchema = Schema.Struct({
  evidenceRefs: PackageDefinitionEvidenceRefsSchema,
  expectedCurrent: PackageDefinitionSelectionRevisionSchema,
  reason: PackageDefinitionReasonSchema,
});
export type ActivatePackageDefinitionPayload = typeof ActivatePackageDefinitionPayloadSchema.Type;
export { PackageDefinitionMutationResultSchema as ActivatePackageDefinitionResultSchema } from './package-definition-contract.ts';
