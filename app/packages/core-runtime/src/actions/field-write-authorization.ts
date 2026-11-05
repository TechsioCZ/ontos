import { Effect, Option, Schema } from 'effect';

import type { AccessDeclaration, AccessFieldGroup } from '../authorization/access-declaration.ts';
import type {
  AccessAmount,
  AccessDecision,
  AccessRecordTarget,
  ParentReadRequirement,
} from '../access/decision/contract.ts';
import { withOptional } from '../access/decision/optional.ts';
import { capabilityPolicyOf } from '../access/enforcement/capability.ts';
import type { AccessDecisionService } from '../access/enforcement/contract.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ActionPermissionDenied } from './errors.ts';

const asJson = Schema.decodeUnknownOption(Schema.Json);
const asJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));
const isJsonObject = Schema.is(Schema.JsonObject);

/** The rows of a JSON array, or none for any other JSON value. */
const jsonElementsOf = (value: Schema.Json): readonly Schema.Json[] => Option.getOrUndefined(asJsonArray(value)) ?? [];

/**
 * Whether a request's decoded payload actually names one governed field path (O58, O74).
 *
 * The path addresses the payload root and an array applies it to each element, exactly as a read's
 * result projection addresses its result: one declared `lines.purchasePrice` path governs the same
 * field of a single object and of every row of an array. Only a path the payload really writes is
 * governed — a field the caller left out of the request asks for no authority over it.
 */
const payloadNamesPath = (value: Schema.Json, segments: readonly string[]): boolean => {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return true;
  }
  if (isJsonObject(value)) {
    const child = asJson(value[head]);
    return Option.isSome(child) && (tail.length === 0 || payloadNamesPath(child.value, tail));
  }
  return jsonElementsOf(value).some((element) => payloadNamesPath(element, segments));
};

/** The declared paths of `group` this payload writes, in declaration order. */
export const writtenFieldPaths = <Payload>(
  group: AccessFieldGroup,
  payload: Payload,
): readonly (readonly string[])[] => {
  const decoded = asJson(payload);
  const written: (readonly string[])[] = [];
  for (const field of group.fields) {
    const segments = field.split('.');
    // A payload that is not JSON data cannot be shown to write no governed field, so every declared
    // path counts: the refusal is fail-closed, never a skip.
    if (Option.isNone(decoded) || payloadNamesPath(decoded.value, segments)) {
      written.push(segments);
    }
  }
  return written;
};

/**
 * The outcome of the `field_write` groups of one Action (O58, O74): `allowed`, a refusal to hand to
 * the caller, or an unreadable authority that is retryable and never an allow.
 */
export interface FieldWriteAuthorization {
  /** Present exactly when a governed field the caller may not write is part of this payload. */
  readonly failure?: ActionPermissionDenied;
  readonly outcome: 'allowed' | 'denied' | 'unavailable';
}

export interface FieldWriteAuthorizationInput<Payload> {
  /** The seam as the Action runtime holds it: one question per group, parent read included. */
  readonly accessDecision: Pick<AccessDecisionService, 'decide'>;
  /**
   * The governed amount the Action's own decision was evaluated against (O18), carried into the
   * parent read so an amount-capped Action grant is held to the same amount; absent when the Action
   * derives none.
   */
  readonly amount?: AccessAmount;
  /** The Action's own decoded declaration; its capability is the parent read of every group. */
  readonly declaration: AccessDeclaration;
  readonly groups: readonly AccessFieldGroup[];
  readonly legalEntityScope: LegalEntityScope;
  readonly now: Date;
  /** The payload the entrypoint already decoded and validated; never a request body re-read here. */
  readonly payload: Payload;
  readonly scope: OperationalScope;
  /** The record-scoped Action's own target; absent on a scope-wide Action (O74). */
  readonly target?: AccessRecordTarget;
}

const NO_FIELD_WRITE_GROUPS: readonly AccessFieldGroup[] = Object.freeze([]);

const approvedOrDenied = (outcome: AccessDecision['outcome']): 'allowed' | 'denied' | 'unavailable' => {
  if (outcome === 'UNAVAILABLE') {
    return 'unavailable';
  }
  return outcome === 'ALLOWED' ? 'allowed' : 'denied';
};

const refusalOf = <Payload>(
  denied: readonly { readonly decision: AccessDecision; readonly group: AccessFieldGroup }[],
  payload: Payload,
): ActionPermissionDenied | undefined => {
  const written = denied.flatMap(({ decision, group }) => {
    const paths = writtenFieldPaths(group, payload);
    return paths.length === 0 ? [] : [{ decision, paths }];
  });
  if (written.length === 0) {
    // Every governed field this caller may not write is absent from this payload, so nothing to
    // refuse: the Action's other fields stay writable (O74).
    return undefined;
  }
  const reasons = [...new Set(written.flatMap(({ decision }) => decision.reasons.map(({ code }) => code)))];
  const fields = written.flatMap(({ paths }) => paths.map((segments) => segments.join('.')));
  return written.some(({ decision }) => decision.outcome === 'NEEDS_APPROVAL')
    ? new ActionPermissionDenied({
        code: 'action_approval_required',
        reason: `This Action needs an approved mandate to write ${fields.join(', ')}`,
        reasons,
      })
    : new ActionPermissionDenied({
        code: 'action_permission_denied',
        reason: `The principal is not permitted to write ${fields.join(', ')}`,
        reasons,
      });
};

/**
 * The `field_write` groups of one Action, decided beside the Action's own capability (O58, O74).
 *
 * Field access rides the parent read it belongs to: on a record-scoped Action that is the Action's
 * own capability with the record it acts on, and on a scope-wide Action it is the same capability
 * decided scope-wide in this same scope, with no record to name. The engine evaluates each group and
 * its parent read in one snapshot; only a capability the caller really writes is refused, so an
 * Action that governs one sensitive field keeps every other field writable for the same caller.
 */
export const authorizeDeclaredFieldWrites = <Payload>(
  input: FieldWriteAuthorizationInput<Payload>,
): Effect.Effect<FieldWriteAuthorization> => {
  const groups = input.groups.length === 0 ? NO_FIELD_WRITE_GROUPS : input.groups;
  if (groups.length === 0) {
    return Effect.succeed({ outcome: 'allowed' });
  }
  const parentRead: ParentReadRequirement = withOptional(
    withOptional({ capability: capabilityPolicyOf(input.declaration) }, 'amount', input.amount),
    'target',
    input.target,
  );
  return Effect.forEach(
    groups,
    (group) =>
      input.accessDecision.decide(
        withOptional(
          {
            carrier: { accessDeclaration: group },
            legalEntityScope: input.legalEntityScope,
            now: input.now,
            parentRead,
            scope: input.scope,
          },
          'target',
          input.target,
        ),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((decisions): FieldWriteAuthorization => {
      if (decisions.some((decision) => approvedOrDenied(decision.outcome) === 'unavailable')) {
        // An unreadable field decision is retryable, never a silent allow (O48b).
        return { outcome: 'unavailable' };
      }
      const denied = decisions.flatMap((decision, index) => {
        const group = groups[index];
        return group === undefined || approvedOrDenied(decision.outcome) !== 'denied' ? [] : [{ decision, group }];
      });
      if (denied.length === 0) {
        return { outcome: 'allowed' };
      }
      const failure = refusalOf(denied, input.payload);
      return failure === undefined ? { outcome: 'allowed' } : { failure, outcome: 'denied' };
    }),
  );
};
