import { Effect, Option, Result, Schema } from 'effect';

import { ActionPermissionCheckError, ActionPermissionDenied } from '../../actions/errors.ts';
import { computeCanonicalValueHash } from '../../actions/repository.ts';
import type { AccessDecision } from '../decision/contract.ts';
import { CapabilityKeySchema } from '../ids.ts';
import type { PrincipalId } from '../ids.ts';
import { sameHolder } from '../model.ts';
import { withOptional } from '../decision/optional.ts';
import { actionCommandQuestionsV2, freezeActionCommandV2 } from './action-command-v2.ts';
import type { ActionCommandQuestionV2, ActionCommandV2 } from './action-command-v2.ts';

import {
  ACTION_AUTHORITY_PURPOSE_MODES_V2,
  ActionAuthorityProofV2Schema,
  ActionAuthorityQuestionV2Schema,
} from './action-authority-v2-schema.ts';
import type { ActionAuthorityProofV2 } from './action-authority-v2-schema.ts';

export { ACTION_AUTHORITY_PURPOSE_MODES_V2, ActionAuthorityProofV2Schema } from './action-authority-v2-schema.ts';
export type { ActionAuthorityProofV2 } from './action-authority-v2-schema.ts';

type QuestionProof = typeof ActionAuthorityQuestionV2Schema.Type;
const witnessSlot = (witness: QuestionProof['witnesses'][number]) =>
  `${witness.assignmentIncarnationId} ${witness.grantIncarnationId} ${witness.capabilityKey}`;

const unavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(new ActionPermissionCheckError({ code: 'action_permission_check_failed', reason }), 'cause', {
    enumerable: false,
    value: cause,
  });

const denied = (reason: string) => new ActionPermissionDenied({ code: 'action_permission_denied', reason });

const expectedQuestions = (command: ActionCommandV2, phase: ActionAuthorityProofV2['phase']) =>
  actionCommandQuestionsV2(command).filter((question) => phase === 'approver' || question.role === 'write');

const purposeOf = (
  phase: ActionAuthorityProofV2['phase'],
  question: ActionCommandQuestionV2,
): QuestionProof['purpose'] => {
  if (phase === 'requester') {
    return 'request_write';
  }
  return question.role === 'write' ? 'approve_write' : 'governing_read';
};

/** Strict forward JSON only. No legacy witness purpose, scalar payload, or missing question is inferred. */
export const decodeActionAuthorityProofV2 = <Value>(value: Value) =>
  Schema.decodeUnknownEffect(ActionAuthorityProofV2Schema, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError((cause) => unavailable('The complete forward Action authority proof is malformed', cause)),
  );

const capabilityKeysOf = (question: ActionCommandQuestionV2) => ({
  parent: question.parent === undefined ? undefined : CapabilityKeySchema.make(question.parent.key),
  primary: CapabilityKeySchema.make(question.declaration.key),
});

const coversQuestion = (witnesses: QuestionProof['witnesses'], question: ActionCommandQuestionV2): boolean => {
  const { parent, primary } = capabilityKeysOf(question);
  return (
    witnesses.every((witness) => witness.capabilityKey === primary || witness.capabilityKey === parent) &&
    witnesses.some((witness) => witness.capabilityKey === primary) &&
    (parent === undefined || witnesses.some((witness) => witness.capabilityKey === parent))
  );
};

const witnessesOf = (
  decision: AccessDecision,
  question: ActionCommandQuestionV2,
  mode: QuestionProof['mode'],
  principalId: PrincipalId,
) => {
  const keys = capabilityKeysOf(question);
  const allowedCapabilities = new Set([keys.primary, keys.parent]);
  const holder = { _tag: 'Principal', principalId } as const;
  if (
    decision.evidence.length === 0 ||
    decision.evidence.some(
      ({ witness }) =>
        witness.mode !== mode ||
        !allowedCapabilities.has(witness.capabilityKey) ||
        !sameHolder(witness.holderId, holder),
    )
  ) {
    return Result.fail(unavailable('Every forward question needs the exact acting person, capability and mode'));
  }
  const witnesses = decision.evidence.map(({ witness }) => ({
    assignmentIncarnationId: witness.assignmentIncarnationId,
    capabilityKey: witness.capabilityKey,
    grantIncarnationId: witness.grantIncarnationId,
  }));
  if (
    !witnesses.some((witness) => witness.capabilityKey === keys.primary) ||
    (keys.parent !== undefined && !witnesses.some((witness) => witness.capabilityKey === keys.parent))
  ) {
    return Result.fail(unavailable('A forward field proof must retain both the field and its actual parent'));
  }
  return Result.succeed([...new Map(witnesses.map((witness) => [witnessSlot(witness), witness])).values()]);
};

/**
 * Bind actual canonical gate answers in canonical question order. The gate has already decided
 * each question; this function cannot turn a missing, mixed, unavailable or witnessless answer into
 * authority. Its JSON is suitable for append-only storage, not an owner-supplied admission boolean.
 */
export const bindActionAuthorityV2 = Effect.fn('ActionAuthority.bindV2')(function* bindActionAuthorityV2(input: {
  readonly command: ActionCommandV2;
  readonly decisions: readonly AccessDecision[];
  readonly now: Date;
  readonly phase: ActionAuthorityProofV2['phase'];
  readonly principalId: PrincipalId;
}) {
  const { command, decisions, now, phase, principalId } = input;
  const digest = freezeActionCommandV2(command);
  if (Result.isFailure(digest)) {
    return yield* unavailable('A forward authority proof requires the complete canonical command');
  }
  const questions = expectedQuestions(command, phase);
  if (questions.length !== decisions.length) {
    return yield* unavailable('Every forward command question needs its own gate answer');
  }
  if (decisions.some((decision) => decision.outcome === 'UNAVAILABLE')) {
    return yield* unavailable('An authority question was unavailable');
  }
  if (decisions.some((decision) => decision.outcome !== 'ALLOWED')) {
    return yield* denied('Every target, field and governing read must authorize in its actual effective mode');
  }
  const scopes = new Set(decisions.flatMap((decision) => decision.evidence.map(({ witness }) => witness.scopeId)));
  const [scopeId] = scopes;
  if (scopes.size !== 1 || scopeId === undefined) {
    return yield* unavailable('Every forward command question must prove the same exact access scope');
  }
  const deadlines = decisions.flatMap((decision) =>
    decision.admissionDeadline === undefined ? [] : [decision.admissionDeadline.getTime()],
  );
  const admissionDeadline = deadlines.length === 0 ? undefined : Math.min(...deadlines);
  if (
    admissionDeadline !== undefined &&
    (!Number.isSafeInteger(admissionDeadline) || now.getTime() >= admissionDeadline)
  ) {
    return yield* denied('A forward authority proof has expired');
  }
  const proofs = yield* Effect.forEach(
    questions,
    Effect.fn('ActionAuthority.bindQuestionV2')(function* bindQuestion(question, index) {
      const decision = decisions[index];
      if (decision === undefined) {
        return yield* unavailable('A forward question has no gate answer');
      }
      const purpose = purposeOf(phase, question);
      const mode = ACTION_AUTHORITY_PURPOSE_MODES_V2[purpose];
      const witnesses = yield* Effect.fromResult(witnessesOf(decision, question, mode, principalId));
      return yield* Schema.decodeUnknownEffect(ActionAuthorityQuestionV2Schema)(
        withOptional(
          {
            capabilityKey: question.declaration.key,
            mode,
            purpose,
            questionHash: question.questionHash,
            witnesses,
          },
          'target',
          question.target,
        ),
      ).pipe(Effect.mapError((cause) => unavailable('The exact forward question could not be retained', cause)));
    }),
    { concurrency: 1 },
  );
  const candidate = {
    commandDigest: digest.success,
    format: 'core.action-authority/2',
    phase,
    principalId,
    questions: proofs,
    scopeId,
    targetSetHash: command.targetSetHash,
  };
  return yield* decodeActionAuthorityProofV2(
    admissionDeadline === undefined ? candidate : { ...candidate, admissionDeadline },
  );
});

/**
 * Rebind a stored proof to the immutable command before inspecting its live incarnations.
 * Hash equality alone is insufficient: purpose, phase, full question coverage and parent evidence
 * are checked independently. This supplies no currentness verdict and never replaces the gate.
 */
export const actionAuthorityQuestionsV2 = Effect.fn('ActionAuthority.questionsV2')(function* actionAuthorityQuestionsV2<
  Value,
>(
  command: ActionCommandV2,
  value: Value,
  expectation: {
    readonly phase: ActionAuthorityProofV2['phase'];
    readonly principalId: PrincipalId;
    readonly scopeId: string;
  },
) {
  const proof = yield* decodeActionAuthorityProofV2(value);
  const digest = freezeActionCommandV2(command);
  if (
    Result.isFailure(digest) ||
    proof.commandDigest !== digest.success ||
    proof.targetSetHash !== command.targetSetHash ||
    proof.phase !== expectation.phase ||
    proof.principalId !== expectation.principalId ||
    proof.scopeId !== expectation.scopeId
  ) {
    return yield* unavailable('The stored authority does not belong to this exact command, person, phase and scope');
  }
  const questions = expectedQuestions(command, proof.phase);
  if (proof.questions.length !== questions.length) {
    return yield* unavailable('The stored authority does not cover every command question');
  }
  return yield* Effect.forEach(
    questions,
    Effect.fn('ActionAuthority.boundQuestionV2')(function* boundQuestion(question, index) {
      const saved = Option.fromUndefinedOr(proof.questions[index]);
      if (
        Option.isNone(saved) ||
        saved.value.questionHash !== question.questionHash ||
        saved.value.capabilityKey !== capabilityKeysOf(question).primary ||
        computeCanonicalValueHash(saved.value.target) !== computeCanonicalValueHash(question.target) ||
        saved.value.purpose !== purposeOf(proof.phase, question) ||
        !coversQuestion(saved.value.witnesses, question)
      ) {
        return yield* unavailable('The stored authority omitted, copied or changed an exact command question');
      }
      return Object.freeze({ question, saved: saved.value });
    }),
    { concurrency: 1 },
  );
});

/** Canonical whole-proof identity for immutable storage and exact retry/currentness comparisons. */
export const actionAuthorityDigestV2 = (proof: ActionAuthorityProofV2): string => computeCanonicalValueHash(proof);
