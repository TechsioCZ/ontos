import { Effect } from 'effect';

import { ActionPermissionCheckError } from '../../actions/errors.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { AccessEnforcementPorts, BoundAccessGate, PreparedAccessDecision } from '../../operations/access-gate.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { sameAuthorityRevision } from '../enforcement/currentness.ts';
import { prepareEngineEvidence } from '../enforcement/prepared-check.ts';
import { PrincipalIdSchema } from '../ids.ts';
import { recheckActionAuthorityV2 } from './action-authority-currentness-v2.ts';
import { actionAuthorityQuestionsV2, bindActionAuthorityV2 } from './action-authority-v2.ts';
import type { ActionAuthorityProofV2 } from './action-authority-v2.ts';
import { actionCommandGateQuestionV2, actionCommandQuestionsV2 } from './action-command-v2.ts';
import type { ActionCommandV2 } from './action-command-v2.ts';

const unavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(new ActionPermissionCheckError({ code: 'action_permission_check_failed', reason }), 'cause', {
    enumerable: false,
    value: cause,
  });
const STORED_CURRENTNESS_UNAVAILABLE = 'Stored Action authority currentness is unavailable';

/**
 * Prepare every actual command question outside the owner transaction. The writer uses the
 * canonical gate's existing persisted-revision/current-intent fence and exact engine replay for
 * EACH question. There is no ALLOWED cache, scalar target substitution or Action RUN recheck.
 */
export const prepareActionAuthorityV2 = Effect.fn('ActionAuthority.prepareV2')(
  function* prepareActionAuthorityV2(input: {
    readonly command: ActionCommandV2;
    readonly gate: BoundAccessGate;
    readonly now: Date;
    readonly phase: ActionAuthorityProofV2['phase'];
    readonly scope: OperationalScope;
  }) {
    const { command, gate, now, phase, scope } = input;
    const { prepare } = gate;
    if (prepare === undefined) {
      return yield* unavailable('A forward Action requires canonical prepared authority with persisted currentness');
    }
    const principalId = PrincipalIdSchema.make(scope.principalId);
    const questions = actionCommandQuestionsV2(command).filter(
      (question) => phase === 'approver' || question.role === 'write',
    );
    const prepared: readonly PreparedAccessDecision[] = yield* Effect.forEach(
      questions,
      Effect.fn('ActionAuthority.prepareQuestionV2')(function* prepareQuestion(question) {
        const questionInput = yield* actionCommandGateQuestionV2(command, question, phase, scope, now);
        return yield* prepare(questionInput).pipe(
          Effect.mapError((cause) => unavailable('An exact forward authority question could not be prepared', cause)),
        );
      }),
      { concurrency: 1 },
    );
    const proof = yield* bindActionAuthorityV2({
      command,
      decisions: prepared.map(({ decision }) => decision),
      now,
      phase,
      principalId,
    });
    const expectation = Object.freeze({ phase, principalId, scopeId: proof.scopeId });
    return Object.freeze({
      proof,
      recheck: Effect.fn('ActionAuthority.recheckV2')(function* recheckPreparedActionAuthorityV2(
        currentTime: Date,
        transaction: CoreTransaction,
      ) {
        if (
          scope.principalId !== principalId ||
          scope.tenantId !== command.scope.tenantId ||
          scope.legalEntityId !== command.scope.legalEntityId
        ) {
          return yield* unavailable('The prepared Action person or tenant/company scope changed before writer entry');
        }
        yield* actionAuthorityQuestionsV2(command, proof, expectation);
        const decisions = yield* Effect.forEach(
          prepared,
          (question) =>
            question
              .recheck(currentTime, transaction)
              .pipe(Effect.mapError((cause) => unavailable('Prepared Action authority is no longer current', cause))),
          { concurrency: 1 },
        );
        return yield* bindActionAuthorityV2({ command, decisions, now: currentTime, phase, principalId });
      }),
    });
  },
);

/**
 * A stored proof is not a new admission. Recheck every saved authority path before taking an owner
 * lease, then retain the exact engine questions behind a persisted revision fence. In particular,
 * preparing a fresh gate decision would let a replacement grant conceal a lost bound incarnation.
 */
export const prepareBoundActionAuthorityV2 = Effect.fn('ActionAuthority.prepareBoundV2')(
  function* prepareBoundActionAuthorityV2(input: {
    readonly command: ActionCommandV2;
    readonly expectation: Parameters<typeof actionAuthorityQuestionsV2>[2];
    readonly now: Date;
    readonly ports: AccessEnforcementPorts;
    readonly proof: ActionAuthorityProofV2;
    readonly scope: OperationalScope;
  }) {
    const { command, expectation, now, ports, proof, scope } = input;
    const { currentness } = ports;
    const joinIntent = ports.intent.joined;
    if (currentness === undefined || joinIntent === undefined) {
      return yield* unavailable('A stored Action proof requires persisted currentness and transaction-joined intent');
    }
    // Refuse malformed/copied documents before any authority transport or database acquisition.
    yield* actionAuthorityQuestionsV2(command, proof, expectation);
    const administrative = command.declaration.kind === 'admin';
    const before = yield* currentness
      .read(scope, command.legalEntityScope, administrative)
      .pipe(Effect.mapError((cause) => unavailable(STORED_CURRENTNESS_UNAVAILABLE, cause)));
    const evidence = prepareEngineEvidence(ports.check);
    const question = { command, expectation, now, proof, scope };
    const preparedProof = yield* recheckActionAuthorityV2({
      ...question,
      authority: ports.intent.authorityFor(scope),
      check: evidence.capture,
    });
    const after = yield* currentness
      .read(scope, command.legalEntityScope, administrative)
      .pipe(Effect.mapError((cause) => unavailable(STORED_CURRENTNESS_UNAVAILABLE, cause)));
    if (!sameAuthorityRevision(before, after)) {
      return yield* unavailable('Persisted authority changed while the stored Action proof was being prepared');
    }
    evidence.seal();
    return Object.freeze({
      proof: preparedProof,
      recheck: Effect.fn('ActionAuthority.recheckPreparedBoundV2')(function* recheckPreparedBoundActionAuthority(
        currentTime: Date,
        transaction: CoreTransaction,
      ) {
        const current = yield* currentness
          .read(scope, command.legalEntityScope, administrative, transaction)
          .pipe(Effect.mapError((cause) => unavailable(STORED_CURRENTNESS_UNAVAILABLE, cause)));
        if (!sameAuthorityRevision(before, current)) {
          return yield* unavailable('The stored Action proof preparation is no longer current');
        }
        return yield* recheckActionAuthorityV2({
          ...question,
          authority: joinIntent(transaction).authorityFor(scope),
          check: evidence.replay,
          now: currentTime,
        });
      }),
    });
  },
);
