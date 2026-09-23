import { Schema } from 'effect';

import { PackageDefinitionSelectionRevisionSchema } from '../domain/catalog-selection-evidence.ts';
import {
  PackageDefinitionContentInputSchema,
  PackageDefinitionEvidenceRefsSchema,
  PackageDefinitionReasonSchema,
  PackageDefinitionChangeKindSchema,
} from './package-definition-contract.ts';

export const RevisePackageDefinitionPayloadSchema = Schema.Struct({
  changeKind: PackageDefinitionChangeKindSchema,
  content: PackageDefinitionContentInputSchema,
  evidenceRefs: PackageDefinitionEvidenceRefsSchema,
  expectedCurrent: PackageDefinitionSelectionRevisionSchema,
  priorErrorExplanation: Schema.optionalKey(PackageDefinitionReasonSchema),
  reason: PackageDefinitionReasonSchema,
});
export type RevisePackageDefinitionPayload = typeof RevisePackageDefinitionPayloadSchema.Type;
export { PackageDefinitionMutationResultSchema as RevisePackageDefinitionResultSchema } from './package-definition-contract.ts';
