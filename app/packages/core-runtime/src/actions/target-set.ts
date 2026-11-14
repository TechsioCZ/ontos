import { Effect, Option, Schema } from 'effect';

import type { AccessTarget } from '../authorization/access-declaration.ts';
import type { AccessDecision, AccessRecordTarget } from '../access/decision/contract.ts';
import { earliestDeadline } from '../access/decision/contract.ts';
import { ModuleKeySchema, RecordKeySchema } from '../access/ids.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ActionPermissionCheckError } from './errors.ts';
import { computeCanonicalValueHash } from './repository.ts';

/**
 * The complete, nonempty set of records changed by this decoded command, in the trusted scope.
 * The owner must derive every record, not a sample, page, caller-supplied authority or fallback.
 * Record existence and owner snapshot currentness remain the owner's transactional responsibility.
 */
export type ActionAccessTargetsResolver<Payload> = (
  payload: Payload,
  scope: OperationalScope,
) => readonly AccessTarget[];

export interface ActionTargetSet {
  readonly hash: string;
  readonly targets: readonly [AccessRecordTarget, ...AccessRecordTarget[]];
}

/**
 * Invocation-local admission facts, supplied only after every target and applicable field group
 * passed Core's gate. Not a durable mandate, transferable permit or substitute for Core's writer
 * fence or the owner's CAS. The request hash binds the original payload and this exact target set.
 */
export interface ActionTargetSetAdmission {
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly decision: AccessDecision;
  readonly fieldDecisions: readonly AccessDecision[];
  readonly governingReadDecisions?: readonly AccessDecision[];
  readonly mode: 'approve' | 'run';
  readonly requestHash: string;
  /** Per-record answers retain structural as well as grant authority without merging selectors. */
  readonly targetDecisions: readonly AccessDecision[];
  readonly targetSet: ActionTargetSet;
}

const TargetSetSchema = Schema.NonEmptyArray(Schema.Struct({ moduleKey: ModuleKeySchema, recordKey: RecordKeySchema }));
const decodeTargets = Schema.decodeUnknownOption(TargetSetSchema, { onExcessProperty: 'error' });

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ActionPermissionCheckError({
      code: 'action_permission_check_failed',
      reason: 'The complete owned Action target set could not be resolved safely',
    }),
    'cause',
    { enumerable: false, value: cause },
  );

export const resolveActionTargetSet = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  owningModuleKey: string,
  resolver: ActionAccessTargetsResolver<Payload>,
): Effect.Effect<ActionTargetSet, ActionPermissionCheckError> =>
  Effect.try({ catch: unavailable, try: () => resolver(payload, scope) }).pipe(
    Effect.flatMap((resolved) => {
      const decoded = decodeTargets(resolved);
      if (
        Option.isNone(decoded) ||
        scope.legalEntityId === undefined ||
        decoded.value.some((target) => target.moduleKey !== owningModuleKey)
      ) {
        return Effect.fail(unavailable());
      }
      const targets = decoded.value.toSorted((left, right) =>
        left.recordKey < right.recordKey ? -1 : Number(left.recordKey > right.recordKey),
      );
      const [first, ...rest] = targets;
      if (first === undefined || rest.some((target, index) => target.recordKey === targets[index]?.recordKey)) {
        return Effect.fail(unavailable());
      }
      const exact: readonly [AccessRecordTarget, ...AccessRecordTarget[]] = Object.freeze([
        Object.freeze(first),
        ...rest.map((target) => Object.freeze(target)),
      ]);
      return Effect.succeed(
        Object.freeze({
          hash: computeCanonicalValueHash({
            legalEntityId: scope.legalEntityId,
            targets: exact,
            tenantId: scope.tenantId,
          }),
          targets: exact,
        }),
      );
    }),
  );

/** Conjunction, never a union of record selectors or an allow from one successful record. */
export const conjoinActionTargetDecisions = (
  decisions: readonly [AccessDecision, ...AccessDecision[]],
): AccessDecision => {
  const [first] = decisions;
  const outcomes = ['UNAVAILABLE', 'DENIED', 'NEEDS_APPROVAL', 'ALLOWED'] as const;
  const outcome =
    outcomes.find((candidate) => decisions.some((decision) => decision.outcome === candidate)) ?? 'UNAVAILABLE';
  const admissionDeadline = earliestDeadline(decisions.map((decision) => decision.admissionDeadline));
  const [reason, ...otherReasons] = decisions.flatMap((entry) => (entry.outcome === outcome ? entry.reasons : []));
  const decision: AccessDecision = {
    evidence: decisions.flatMap((entry) => entry.evidence),
    outcome,
    reasons: [reason ?? first.reasons[0], ...otherReasons],
    // Selectors describe independent record checks. Flattening them would invent a wider authority.
    selectors: [],
  };
  return Object.freeze(admissionDeadline === undefined ? decision : { ...decision, admissionDeadline });
};
