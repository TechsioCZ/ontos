import { Schema } from 'effect';

import { PackageDefinitionRefSchema } from '../resources/package-definition.ts';
import {
  PackageDefinitionContentInputSchema,
  PackageDefinitionEvidenceRefsSchema,
  PackageDefinitionReasonSchema,
} from './package-definition-contract.ts';

export const CreatePackageDefinitionPayloadSchema = Schema.Struct({
  content: PackageDefinitionContentInputSchema,
  definitionRef: PackageDefinitionRefSchema,
  evidenceRefs: PackageDefinitionEvidenceRefsSchema,
  reason: PackageDefinitionReasonSchema,
});
export type CreatePackageDefinitionPayload = typeof CreatePackageDefinitionPayloadSchema.Type;
export { PackageDefinitionMutationResultSchema as CreatePackageDefinitionResultSchema } from './package-definition-contract.ts';
