import { Schema } from 'effect';

import { SymmyEffectIdSchema } from './identity.ts';

const AdmissionInvocationIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmySourceAdmissionInvocationId')),
);
const ProjectionVersionSchema = Schema.toEncoded(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isPattern(/^[a-z][a-z0-9.-]+$/u)).pipe(
    Schema.brand('SymmySourceSemanticProjectionVersion'),
  ),
);
const InputDigestSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

/** Locator and checksum only. Actual signed admission, retained intent and current guards must agree. */
export const SymmySourceOrganizationWitnessSchema = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  originalAdmissionInvocationId: AdmissionInvocationIdSchema,
  semanticInputDigest: InputDigestSchema,
  semanticProjectionVersion: ProjectionVersionSchema,
});
export type SymmySourceOrganizationWitness = typeof SymmySourceOrganizationWitnessSchema.Type;

/** Current native input checksum; this is separate from immutable source classification evidence. */
export const SymmySourceOrganizationMaterializationWitnessSchema = Schema.Struct({
  inputDigest: InputDigestSchema,
  projectionVersion: ProjectionVersionSchema,
});
export type SymmySourceOrganizationMaterializationWitness =
  typeof SymmySourceOrganizationMaterializationWitnessSchema.Type;
