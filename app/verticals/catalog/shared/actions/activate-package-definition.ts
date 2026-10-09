import { Schema } from 'effect';

import { PackageDefinitionSelectionRevisionSchema } from '../domain/catalog-selection-evidence.ts';
import { PackageDefinitionEvidenceRefsSchema, PackageDefinitionReasonSchema } from './package-definition-contract.ts';

export const ActivatePackageDefinitionPayloadSchema = Schema.Struct({
  evidenceRefs: PackageDefinitionEvidenceRefsSchema,
  expectedCurrent: PackageDefinitionSelectionRevisionSchema,
  reason: PackageDefinitionReasonSchema,
});
export type ActivatePackageDefinitionPayload = typeof ActivatePackageDefinitionPayloadSchema.Type;
export { PackageDefinitionMutationResultSchema as ActivatePackageDefinitionResultSchema } from './package-definition-contract.ts';
