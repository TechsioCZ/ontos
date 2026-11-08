import { Effect } from 'effect';

import type { AccessDecision, AccessRecordTarget } from '../access/decision/contract.ts';
import type { GateInput } from '../access/enforcement/contract.ts';
import { capabilityPolicyOf } from '../access/enforcement/capability.ts';
import { withOptional } from '../access/decision/optional.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ActionPermissionCheckError, ActionPermissionDenied } from './errors.ts';
import { getActionGoverningRead } from './governing-read.ts';
import type { ActionGoverningReadDeclaration } from './governing-read.ts';
import { conjoinActionTargetDecisions } from './target-set.ts';

/** The original registered Read's record and field restrictions, independently in RUN. */
export const decideActionGoverningReads = Effect.fn('ActionRuntime.decideGoverningReads')(
  function* decideActionGoverningReads(input: {
    readonly decide: (input: GateInput) => Effect.Effect<AccessDecision>;
    readonly now: Date;
    readonly reference: ActionGoverningReadDeclaration | undefined;
    readonly scope: OperationalScope;
    readonly targets: readonly AccessRecordTarget[];
  }) {
    const read = getActionGoverningRead(input.reference);
    if (read === undefined) {
      return [];
    }
    const { descriptor } = read;
    const declaration = descriptor.accessDeclaration;
    if (declaration === undefined || input.targets.length === 0) {
      return yield* new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: 'The registered governing Read requires the complete owned Action target set',
      });
    }
    const perTarget = yield* Effect.forEach(
      input.targets,
      Effect.fn('ActionRuntime.decideGoverningRecord')(function* decideGoverningRecord(target) {
        const base = {
          legalEntityScope: descriptor.legalEntityScope,
          mode: 'run' as const,
          now: input.now,
          scope: input.scope,
          target,
        };
        const record = yield* input.decide({ ...base, carrier: descriptor });
        const fields = yield* Effect.forEach(
          descriptor.accessFieldGroups ?? [],
          (group) =>
            input.decide({
              ...base,
              carrier: withOptional({ accessDeclaration: group }, 'accessActor', descriptor.accessActor),
              parentRead: { capability: capabilityPolicyOf(declaration), target },
            }),
          { concurrency: 1 },
        );
        return [record, ...fields];
      }),
      { concurrency: 1 },
    );
    return perTarget.flat();
  },
);

/** No missing read or field answer is an implied grant; all decisions remain independent. */
export const requireAllowedGoverningReads = (
  decisions: readonly AccessDecision[],
): Effect.Effect<void, ActionPermissionCheckError | ActionPermissionDenied> => {
  const [first, ...rest] = decisions;
  if (first === undefined) {
    return Effect.void;
  }
  const decision = conjoinActionTargetDecisions([first, ...rest]);
  if (decision.outcome === 'UNAVAILABLE') {
    return Effect.fail(
      new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: 'A required governing record or field read could not be checked',
      }),
    );
  }
  return decision.outcome === 'ALLOWED'
    ? Effect.void
    : Effect.fail(
        new ActionPermissionDenied({
          code: 'action_permission_denied',
          reason: 'The Action requires independent governing record and field-read authority',
          reasons: decision.reasons.map(({ code }) => code),
        }),
      );
};
