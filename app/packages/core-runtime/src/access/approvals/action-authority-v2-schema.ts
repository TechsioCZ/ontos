import { Schema } from 'effect';

import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  GrantIncarnationIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RecordKeySchema,
} from '../ids.ts';

/** These purposes never reinterpret the historical execution/RUN witness contract. */
export const ACTION_AUTHORITY_PURPOSE_MODES_V2 = {
  approve_write: 'approve',
  governing_read: 'run',
  request_write: 'propose',
} as const;

const WitnessSchema = Schema.Struct({
  assignmentIncarnationId: AssignmentIncarnationIdSchema,
  capabilityKey: CapabilityKeySchema,
  grantIncarnationId: GrantIncarnationIdSchema,
});
export const ActionAuthorityQuestionV2Schema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  mode: Schema.Literals(['approve', 'propose', 'run']),
  purpose: Schema.Literals(['approve_write', 'governing_read', 'request_write']),
  questionHash: CommandDigestSchema,
  target: Schema.optionalKey(Schema.Struct({ moduleKey: ModuleKeySchema, recordKey: RecordKeySchema })),
  witnesses: Schema.NonEmptyArray(WitnessSchema),
});
const ProofFields = Schema.Struct({
  admissionDeadline: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(-8_640_000_000_000_000),
      Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
    ),
  ),
  commandDigest: CommandDigestSchema,
  format: Schema.Literal('core.action-authority/2'),
  phase: Schema.Literals(['approver', 'requester']),
  principalId: PrincipalIdSchema,
  questions: Schema.NonEmptyArray(ActionAuthorityQuestionV2Schema),
  scopeId: AccessScopeIdSchema,
  targetSetHash: CommandDigestSchema,
});
export type ActionAuthorityProofV2 = typeof ProofFields.Type;

const witnessSlot = (witness: typeof WitnessSchema.Type) =>
  `${witness.assignmentIncarnationId} ${witness.grantIncarnationId} ${witness.capabilityKey}`;

const proofIssue = (proof: ActionAuthorityProofV2): string | undefined => {
  if (new Set(proof.questions.map((question) => question.questionHash)).size !== proof.questions.length) {
    return 'A forward authority proof contains each exact question once';
  }
  for (const question of proof.questions) {
    if (
      question.mode !== ACTION_AUTHORITY_PURPOSE_MODES_V2[question.purpose] ||
      (proof.phase === 'requester') !== (question.purpose === 'request_write') ||
      new Set(question.witnesses.map(witnessSlot)).size !== question.witnesses.length
    ) {
      return 'Each forward question retains its own phase, purpose, mode and unique witnesses';
    }
  }
  return undefined;
};

/** Schema-only dependency, so persisted lifecycle records do not import the Action runtime. */
export const ActionAuthorityProofV2Schema = ProofFields.check(Schema.makeFilter(proofIssue));
