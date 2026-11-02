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
