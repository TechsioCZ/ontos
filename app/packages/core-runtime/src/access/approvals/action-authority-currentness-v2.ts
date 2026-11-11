import { Effect, Match, Option } from 'effect';

import { ActionPermissionCheckError, ActionPermissionDenied } from '../../actions/errors.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AuthorityCell, DecisionAuthorityPort } from '../decision/authority.ts';
import type { AccessDecisionRequest } from '../decision/contract.ts';
import { decideAccessMany } from '../decision/engine.ts';
import type { DecisionBatchGroup, DecisionCheckPort } from '../decision/engine.ts';
import { capabilityPolicyOf, gateScopeOf } from '../enforcement/capability.ts';
import { seamUnavailable } from '../enforcement/decisions.ts';
import { withOptional } from '../decision/optional.ts';
import { sameHolder } from '../model.ts';
import { conjoinActionTargetDecisions } from '../../actions/target-set.ts';
import { actionAuthorityQuestionsV2, bindActionAuthorityV2 } from './action-authority-v2.ts';
import type { ActionAuthorityProofV2 } from './action-authority-v2.ts';
import type { ActionCommandV2 } from './action-command-v2.ts';

type BoundQuestion = Effect.Success<ReturnType<typeof actionAuthorityQuestionsV2>>[number];

const unavailable = (reason: string) =>
  new ActionPermissionCheckError({ code: 'action_permission_check_failed', reason });
const lost = (reason: string) => new ActionPermissionDenied({ code: 'action_permission_denied', reason });

/**
 * Restrict the ordinary intent port to the exact saved grant/assignment pairs of ONE question.
 * A different live grant cannot rescue a revoked bound witness. No selector, amount, membership,
 * role-binding or engine rule is reimplemented here; the canonical planner decides those facts.
 */
const boundAuthority = (
  authority: DecisionAuthorityPort,
  bound: BoundQuestion,
  proof: ActionAuthorityProofV2,
  requiredWitnesses: BoundQuestion['saved']['witnesses'],
): DecisionAuthorityPort => {
  const holder = { _tag: 'Principal', principalId: proof.principalId } as const;
  // The unrestricted batch read is dropped, so every cell set the engine sees passes the bound filter below.
  const { readCellsMany: _unrestricted, ...restricted } = authority;
  return {
    ...restricted,
    readCells: (query) =>
      authority.readCells(query).pipe(
        Effect.map((cells) => {
          if (query.scopeId !== proof.scopeId || query.mode !== bound.saved.mode || !sameHolder(query.holder, holder)) {
            return [];
          }
          const required = requiredWitnesses.filter((witness) => witness.capabilityKey === query.capabilityKey);
          const selected: AuthorityCell[] = [];
          for (const witness of required) {
            const cell = cells.find(
              (candidate) =>
                candidate.assignmentIncarnationId === witness.assignmentIncarnationId &&
                candidate.grantIncarnationId === witness.grantIncarnationId &&
                candidate.capabilityKey === witness.capabilityKey &&
                candidate.mode === bound.saved.mode &&
                sameHolder(candidate.holder, holder),
            );
            if (cell === undefined) {
              return [];
            }
            selected.push(cell);
          }
          return selected;
        }),
      ),
    readScope: (query) =>
      authority.readScope(query).pipe(
        Effect.map(
          Option.filter((scope) => {
            const sameContext = Match.value(scope.scope).pipe(
              Match.tags({
                LegalEntity: ({ legalEntityId }) => legalEntityId === query.legalEntityId,
                TenantContext: () => query.legalEntityId === undefined,
              }),
              Match.exhaustive,
            );
            return scope.scopeId === proof.scopeId && scope.tenantId === query.tenantId && sameContext;
          }),
        ),
      ),
  };
};

const requiredPathsOf = ({ question, saved }: BoundQuestion): readonly BoundQuestion['saved']['witnesses'][] => {
  const primary = saved.witnesses.filter(
    (witness) => String(witness.capabilityKey) === String(question.declaration.key),
  );
  if (question.parent === undefined) {
    return primary.map((witness) => [witness]);
  }
  const parents = saved.witnesses.filter((witness) => String(witness.capabilityKey) === String(question.parent?.key));
  // Check each retained authority path independently. An alternative live witness must not conceal
  // a lost/expired/amount-capped path the durable proof explicitly bound.
  return primary.flatMap((witness) => parents.map((parent) => [witness, parent]));
};

const requestOf = ({ question, saved }: BoundQuestion, command: ActionCommandV2): AccessDecisionRequest => {
  const amount = question.role === 'write' ? command.amount : undefined;
  const parentRead =
    question.parent === undefined
      ? undefined
      : withOptional(
          withOptional({ capability: capabilityPolicyOf(question.parent) }, 'target', question.target),
          'amount',
          amount,
        );
  return withOptional(
    withOptional(
      withOptional(
        { capability: capabilityPolicyOf(question.declaration), mode: saved.mode },
        'target',
        question.target,
      ),
      'amount',
      amount,
    ),
    'parentRead',
    parentRead,
  );
};

/**
 * Revalidate a durable full-question proof with Core's actual planner and check port. A caller
 * supplies current persisted intent and either the remote check OUTSIDE SQL or exact prepared
 * engine replay INSIDE its revision fence. This function opens no transaction or pool lease.
 *
 * Requester PROPOSE and approver APPROVE remain distinct. Governing Read/field-read RUN checks
 * are never substituted by write approval, and no historical execution/RUN purpose is parsed.
 */
export const recheckActionAuthorityV2 = Effect.fn('ActionAuthority.recheckBoundV2')(
  function* recheckActionAuthorityV2(input: {
    readonly authority: DecisionAuthorityPort;
    readonly check: DecisionCheckPort;
    readonly command: ActionCommandV2;
    readonly expectation: Parameters<typeof actionAuthorityQuestionsV2>[2];
    readonly now: Date;
    readonly proof: ActionAuthorityProofV2;
    readonly scope: OperationalScope;
  }) {
    const { authority, check, command, expectation, now, proof, scope } = input;
    if (scope.tenantId !== command.scope.tenantId || scope.legalEntityId !== command.scope.legalEntityId) {
      return yield* unavailable('A bound Action proof cannot be inspected in another tenant or company');
    }
    const questions = yield* actionAuthorityQuestionsV2(command, proof, expectation);
    if (proof.admissionDeadline !== undefined && now.getTime() >= proof.admissionDeadline) {
      return yield* lost('A bound Action authority deadline has passed');
    }
    const actorScope = gateScopeOf(command.legalEntityScope, scope);
    const actor = withOptional(
      { actor: { _tag: 'Principal' as const, principalId: proof.principalId }, tenantId: command.scope.tenantId },
      'legalEntityId',
      command.declaration.kind === 'admin' ? undefined : actorScope.legalEntityId,
    );
    const groupsByQuestion: readonly (readonly DecisionBatchGroup[])[] = questions.map((bound) =>
      requiredPathsOf(bound).map((path) => ({
        authority: boundAuthority(authority, bound, proof, path),
        inputs: [{ actor, now, request: requestOf(bound, command) }],
      })),
    );
    const answers = yield* decideAccessMany(check, groupsByQuestion.flat());
    let offset = 0;
    const decisions = groupsByQuestion.map((groups) => {
      const [firstAnswer, ...restAnswers] = answers.slice(offset, offset + groups.length).flat();
      offset += groups.length;
      return firstAnswer === undefined
        ? seamUnavailable('unavailable.intent')
        : conjoinActionTargetDecisions([firstAnswer, ...restAnswers]);
    });
    const current = yield* bindActionAuthorityV2({
      command,
      decisions,
      now,
      phase: proof.phase,
      principalId: proof.principalId,
    });
    const deadlines = [proof.admissionDeadline, current.admissionDeadline].filter((deadline) => deadline !== undefined);
    // Currentness never rewrites the saved question/witness identities or extends a saved deadline.
    // A tighter live deadline still bounds this attempt without mutating the historical proof.
    return deadlines.length === 0 ? proof : { ...proof, admissionDeadline: Math.min(...deadlines) };
  },
);
