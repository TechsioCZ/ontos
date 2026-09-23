import { Schema } from 'effect';

import { PackageDefinitionSelectionRevisionSchema } from '../domain/catalog-selection-evidence.ts';
import { PackageDefinitionEvidenceRefsSchema, PackageDefinitionReasonSchema } from './package-definition-contract.ts';

export const RetirePackageDefinitionPayloadSchema = Schema.Struct({
  evidenceRefs: PackageDefinitionEvidenceRefsSchema,
  expectedCurrent: PackageDefinitionSelectionRevisionSchema,
  reason: PackageDefinitionReasonSchema,
});
export type RetirePackageDefinitionPayload = typeof RetirePackageDefinitionPayloadSchema.Type;
export { PackageDefinitionMutationResultSchema as RetirePackageDefinitionResultSchema } from './package-definition-contract.ts';
