import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { AgentProfileSetupInputSchema } from './agent-profile-setup.mts';
import { DemoSeedError } from './seed-client.mts';

export const AgentPolicyEvidenceSchema = Schema.Struct({
  expected: Schema.Array(Schema.String),
  input: AgentProfileSetupInputSchema,
  missing: Schema.Array(Schema.String),
  profileMatches: Schema.Boolean,
  unexpected: Schema.Array(Schema.String),
});
export const AgentPolicyInspectionSchema = Schema.Struct({ policies: Schema.Array(AgentPolicyEvidenceSchema) });
export type AgentPolicyEvidence = typeof AgentPolicyEvidenceSchema.Type;

/** User-reviewed stage residue, not company membership defaults. Never infer a company from a duplicate name. */
const unscopedStageResidue = new Set(['24c3628e-d340-46d1-a87b-5d8f98d0fa87', '301134e3-1bb2-4430-a865-01599ef12df8']);

export const isReviewedUnscopedAgent = (principalId: string): boolean => unscopedStageResidue.has(principalId);

export const reviewedUnscopedAgentExclusion = (input: {
  readonly companyMembershipCount: number;
  readonly declaredSeedSlotPresent: boolean;
  readonly directAuthorityCount: number;
  readonly displayName: string;
  readonly principalId: string;
  readonly scopedRoleMembershipCount: number;
  readonly sourceDeclaresPrincipal: boolean;
}): string | undefined =>
  isReviewedUnscopedAgent(input.principalId) &&
  input.displayName === 'Asistent provozu' &&
  input.companyMembershipCount === 0 &&
  input.scopedRoleMembershipCount === 0 &&
  input.directAuthorityCount === 0 &&
  !input.sourceDeclaresPrincipal &&
  input.declaredSeedSlotPresent
    ? 'Excluded unchanged: no source-declared assignment for this principal; the single Nájempark operations-assistant seed slot is already occupied by an audited company agent.'
    : undefined;

/** Never authorize a tuple not emitted by the shared native source builder, or a destructive replacement. */
export const validateDeclaredAgentRepair = (evidence: AgentPolicyEvidence) =>
  Effect.gen(function* validateDeclaredOnly() {
    if (
      evidence.input.operation !== 'configure-agent' ||
      !evidence.profileMatches ||
      evidence.unexpected.length > 0 ||
      new Set(evidence.expected).size !== evidence.expected.length ||
      new Set(evidence.missing).size !== evidence.missing.length ||
      evidence.missing.some((tuple) => !evidence.expected.includes(tuple))
    ) {
      return yield* new DemoSeedError({
        reason: 'Undeclared, destructive, duplicate or profile-changing agent policy plan; no reconciliation allowed',
      });
    }
    return yield* Effect.void;
  });

export const agentPolicyFingerprint = <S extends Schema.Top>(schema: S, value: S['Type']) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.map((text) => createHash('sha256').update(text).digest('hex')),
  );
