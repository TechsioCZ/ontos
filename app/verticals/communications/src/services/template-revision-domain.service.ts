import type { OperationalScope } from '@app/core-runtime';
import { Array as EffectArray, Crypto, DateTime, Effect, Option, Order, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { TemplatePinSchema, TemplateUseAuditSchema, templateScopeKey } from '../../shared/template-revision.ts';
import type {
  TemplateIdentity,
  TemplateLifecycleState,
  TemplatePin,
  TemplateScope,
  TemplateUseAudit,
} from '../../shared/template-revision.ts';
import {
  TemplatePinBlocked,
  TemplateRefused,
  TemplateResolutionFailed,
  TemplateRevisionNotFound,
} from '../../shared/template-revision-errors.ts';
import type {
  TemplateActivationRecord,
  TemplateRevisionPortContract,
  TemplateRevisionRecord,
  TemplateTypeRecord,
} from './template-revision-port.service.ts';

/** Who is acting and in which operating scope; the governed Action supplies it from its trusted operational scope. */
export interface TemplateActor {
  readonly actionInvocationId: string;
  /** The Legal Entity the operation is trusted to run in, if any. */
  readonly legalEntityId: string | null;
  readonly principalId: string;
}

export const templateActorOf = (context: {
  readonly actionInvocationId: string;
  readonly scope: OperationalScope;
}): TemplateActor => ({
  actionInvocationId: context.actionInvocationId,
  legalEntityId: context.scope.legalEntityId ?? null,
  principalId: context.scope.principalId,
});

const slot = /\{\{\s*(?<name>[a-z][a-z0-9_]*)\s*\}\}/gu;
const uniqueSorted = (names: readonly string[]) => EffectArray.dedupe(names).toSorted(Order.String);
const sameNames = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((name, index) => name === right[index]);
const iso = (at: DateTime.Utc) => DateTime.formatIso(at);

/** The placeholder names of a text, and whether it carries any brace that is not a well-formed placeholder. */
export const extractPlaceholders = (text: string) => {
  const names = [...text.matchAll(slot)].map((match) => match.groups?.['name'] ?? '');
  const malformed = /\{\{|\}\}/u.test(text.replaceAll(slot, ''));
  return { malformed, names };
};

const refuse = (code: (typeof TemplateRefused.Type)['code'], reason: string, placeholders?: readonly string[]) =>
  Effect.fail(new TemplateRefused(placeholders === undefined ? { code, reason } : { code, placeholders, reason }));

/** Meaning fingerprint of one revision text: identifies it without storing or exposing the text again. */
export const templateContentDigest = Effect.fn('TemplateRevision.contentDigest')(function* contentDigest(
  subject: string,
  body: string,
) {
  const crypto = yield* Crypto.Crypto;
  const bytes = new TextEncoder().encode(`${subject.length}:${subject}${body}`);
  const digest = yield* crypto.digest('SHA-256', bytes).pipe(Effect.orDie);
  return Hex.encode(digest);
});

/**
 * An Action of one scope may only change a Template of exactly that scope: a tenant-wide Template needs a tenant-wide
 * operation, a Legal Entity Template needs that Legal Entity as the trusted operating scope.
 */
export const assertOperatingScope = (scope: TemplateScope, legalEntityId: string | null) =>
  (scope.kind === 'tenant' ? legalEntityId === null : legalEntityId === scope.legalEntityId)
    ? Effect.void
    : refuse('template_scope_mismatch', 'The Template scope is not the trusted operating scope of this operation');

/** What activation requires of a revision and its Type: required data present, nothing undeclared. */
export const assessActivatable = Effect.fn('TemplateRevision.assessActivatable')(function* assess(
  type: TemplateTypeRecord,
  revision: TemplateRevisionRecord,
) {
  const subject = extractPlaceholders(revision.subject);
  const body = extractPlaceholders(revision.body);
  if (subject.malformed || body.malformed) {
    return yield* refuse('template_content_malformed', 'The revision text carries a malformed placeholder');
  }
  const used = new Set([...subject.names, ...body.names]);
  const missing = type.requiredPlaceholders.filter((name) => !used.has(name));
  if (missing.length > 0) {
    return yield* refuse(
      'template_placeholder_missing',
      'The revision lacks a placeholder its Template Type requires',
      missing,
    );
  }
  const declared = new Set([...type.requiredPlaceholders, ...type.optionalPlaceholders]);
  const undeclared = uniqueSorted([...used].filter((name) => !declared.has(name)));
  if (undeclared.length > 0) {
    return yield* refuse(
      'template_placeholder_undeclared',
      'The revision uses a placeholder its Template Type does not declare',
      undeclared,
    );
  }
  return uniqueSorted([...used]);
});

export interface PrepareRevisionInput extends TemplateIdentity {
  readonly body: string;
  readonly optionalPlaceholders: readonly string[];
  readonly reason: string;
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
}

/** Stores a new immutable draft revision, creating its Template Type on first use. The draft is not usable yet. */
export const prepareRevision = Effect.fn('TemplateRevision.prepare')(function* prepareRevision(
  port: TemplateRevisionPortContract,
  input: PrepareRevisionInput,
  actor: TemplateActor,
) {
  yield* assertOperatingScope(input.scope, actor.legalEntityId);
  const subject = extractPlaceholders(input.subject);
  const body = extractPlaceholders(input.body);
  const required = uniqueSorted(input.requiredPlaceholders);
  const optional = uniqueSorted(input.optionalPlaceholders);
  const requiredNames = new Set(required);
  if (
    subject.malformed ||
    body.malformed ||
    required.length !== input.requiredPlaceholders.length ||
    optional.length !== input.optionalPlaceholders.length ||
    optional.some((name) => requiredNames.has(name))
  ) {
    return yield* refuse(
      'template_content_malformed',
      'The text or the declared placeholders are malformed or repeat a name',
    );
  }
  const type = yield* port.ensureType({
    actionInvocationId: actor.actionInvocationId,
    at: yield* port.operationAt,
    identity: { channel: input.channel, language: input.language, messageType: input.messageType, scope: input.scope },
    optionalPlaceholders: optional,
    principalId: actor.principalId,
    requiredPlaceholders: required,
  });
  if (!sameNames(type.requiredPlaceholders, required) || !sameNames(type.optionalPlaceholders, optional)) {
    return yield* refuse(
      'template_type_declaration_conflict',
      'The Template Type already exists with other declared placeholders; a new meaning needs a new identity',
    );
  }
  const revision = yield* port.appendRevision({
    actionInvocationId: actor.actionInvocationId,
    at: yield* port.operationAt,
    body: input.body,
    contentDigest: yield* templateContentDigest(input.subject, input.body),
    placeholdersUsed: uniqueSorted([...subject.names, ...body.names]),
    principalId: actor.principalId,
    reason: input.reason,
    subject: input.subject,
    templateTypeId: type.templateTypeId,
  });
  return { revision, type };
});

const loadRevisionAndType = Effect.fn('TemplateRevision.loadRevisionAndType')(function* load(
  port: TemplateRevisionPortContract,
  revisionId: string,
  actor: TemplateActor,
) {
  const revision = yield* port.loadRevision(revisionId);
  if (Option.isNone(revision)) {
    return yield* new TemplateRevisionNotFound({
      code: 'template_revision_not_found',
      reason: 'The Template Revision is unavailable in this scope',
    });
  }
  // Locking the Type serializes every activation, deactivation and invalidation of its revisions.
  const type = yield* port.lockType(revision.value.templateTypeId);
  if (Option.isNone(type)) {
    return yield* new TemplateRevisionNotFound({
      code: 'template_revision_not_found',
      reason: 'The Template Type is unavailable in this scope',
    });
  }
  yield* assertOperatingScope(type.value.identity.scope, actor.legalEntityId);
  return { revision: revision.value, type: type.value };
});

const openActivationOf = (open: readonly TemplateActivationRecord[], revisionId: string) =>
  open.find((activation) => activation.revisionId === revisionId);

/**
 * One authorized administrator approves and activates a complete revision for its exact Type; the revision it
 * replaces, if any, is closed in the same transaction so a Type never has two open activations.
 */
export const activateRevision = Effect.fn('TemplateRevision.activate')(function* activateRevision(
  port: TemplateRevisionPortContract,
  input: { readonly reason: string; readonly revisionId: string },
  actor: TemplateActor,
) {
  const { revision, type } = yield* loadRevisionAndType(port, input.revisionId, actor);
  if (Option.isSome(yield* port.findInvalidation(revision.revisionId))) {
    return yield* refuse('template_revision_invalidated', 'An unsafe-invalidated revision can never be activated');
  }
  yield* assessActivatable(type, revision);
  const open = yield* port.openActivations(type.templateTypeId);
  if (openActivationOf(open, revision.revisionId) !== undefined) {
    return yield* refuse('template_revision_already_active', 'The revision is already the active revision');
  }
  const at = yield* port.operationAt;
  const [replaced] = open;
  yield* Effect.forEach(
    open,
    (activation) =>
      port.closeActivation(activation.activationId, {
        actionInvocationId: actor.actionInvocationId,
        endedAt: at,
        endedByPrincipalId: actor.principalId,
        endedKind: 'replaced',
        endReason: `Replaced by revision ${revision.revisionNumber}`,
      }),
    { concurrency: 1, discard: true },
  );
  const activation = yield* port.appendActivation({
    actionInvocationId: actor.actionInvocationId,
    activatedAt: at,
    activatedByPrincipalId: actor.principalId,
    activationReason: input.reason,
    legalEntityId: type.identity.scope.kind === 'tenant' ? null : type.identity.scope.legalEntityId,
    revisionId: revision.revisionId,
    scopeKey: templateScopeKey(type.identity.scope),
    templateTypeId: type.templateTypeId,
  });
  return { activation, replaced, revision };
});

/** Ends the active period of a revision without replacing it: later messages of the Type then fail explicitly. */
export const deactivateRevision = Effect.fn('TemplateRevision.deactivate')(function* deactivateRevision(
  port: TemplateRevisionPortContract,
  input: { readonly reason: string; readonly revisionId: string },
  actor: TemplateActor,
) {
  const { revision, type } = yield* loadRevisionAndType(port, input.revisionId, actor);
  const open = openActivationOf(yield* port.openActivations(type.templateTypeId), revision.revisionId);
  if (open === undefined) {
    return yield* refuse('template_revision_not_active', 'The revision is not the active revision');
  }
  const endedAt = yield* port.operationAt;
  yield* port.closeActivation(open.activationId, {
    actionInvocationId: actor.actionInvocationId,
    endedAt,
    endedByPrincipalId: actor.principalId,
    endedKind: 'deactivated',
    endReason: input.reason,
  });
  return { activation: open, endedAt, revision };
});

/**
 * Marks a revision unsafe. This is a Current gate: it ends any active period and blocks every later stoppable handoff
 * of a pinned message, and it rewrites no earlier decision and never picks a newer revision.
 */
export const invalidateRevisionAsUnsafe = Effect.fn('TemplateRevision.invalidate')(function* invalidateRevision(
  port: TemplateRevisionPortContract,
  input: { readonly reason: string; readonly revisionId: string },
  actor: TemplateActor,
) {
  const { revision, type } = yield* loadRevisionAndType(port, input.revisionId, actor);
  if (Option.isSome(yield* port.findInvalidation(revision.revisionId))) {
    return yield* refuse('template_revision_already_invalidated', 'The revision is already invalidated as unsafe');
  }
  const invalidatedAt = yield* port.operationAt;
  yield* port.appendInvalidation({
    actionInvocationId: actor.actionInvocationId,
    invalidatedAt,
    invalidatedByPrincipalId: actor.principalId,
    reason: input.reason,
    revisionId: revision.revisionId,
  });
  const endedActivation = openActivationOf(yield* port.openActivations(type.templateTypeId), revision.revisionId);
  if (endedActivation !== undefined) {
    yield* port.closeActivation(endedActivation.activationId, {
      actionInvocationId: actor.actionInvocationId,
      endedAt: invalidatedAt,
      endedByPrincipalId: actor.principalId,
      endedKind: 'invalidated-unsafe',
      endReason: input.reason,
    });
  }
  return { endedActivation, invalidatedAt, revision };
});

/**
 * Pin contract, step one: resolve the unambiguous revision active at the decision time for exactly one Template
 * identity. No active revision, or more than one, is an explicit failure: never a guess, never another scope,
 * language or brand. The Message Intent lane stores the returned pin at the first approved creation of an intent.
 */
export const resolveTemplatePin = Effect.fn('TemplateRevision.resolvePin')(function* resolveTemplatePin(
  port: TemplateRevisionPortContract,
  identity: TemplateIdentity,
  decisionTime?: DateTime.Utc,
) {
  const at = decisionTime ?? (yield* port.operationAt);
  const type = yield* port.findType(identity);
  if (Option.isNone(type)) {
    return yield* new TemplateResolutionFailed({
      code: 'template_no_active_revision',
      reason: 'No Template Type exists for this exact message type, channel, language and scope',
    });
  }
  const active = yield* port.activationsAt(type.value.templateTypeId, at);
  if (active.length > 1) {
    return yield* new TemplateResolutionFailed({
      code: 'template_active_revision_ambiguous',
      reason: 'More than one revision is active for this exact Template identity',
    });
  }
  const [only] = active;
  const [revision, invalidation] =
    only === undefined
      ? [Option.none(), Option.none()]
      : yield* Effect.all([port.loadRevision(only.revisionId), port.findInvalidation(only.revisionId)], {
          concurrency: 1,
        });
  if (Option.isNone(revision) || Option.isSome(invalidation)) {
    return yield* new TemplateResolutionFailed({
      code: 'template_no_active_revision',
      reason: 'No usable approved active revision exists for this exact Template identity',
    });
  }
  return yield* Schema.decodeUnknownEffect(TemplatePinSchema)({
    ...type.value.identity,
    decisionTime: iso(at),
    revisionId: revision.value.revisionId,
    revisionNumber: revision.value.revisionNumber,
    templateTypeId: type.value.templateTypeId,
  }).pipe(Effect.orDie);
});

/**
 * Pin contract, step two: the Current gate before every stoppable handoff, retry included. A retry reuses its stored
 * pin and never resolves again. The gate returns the very same pin or blocks; it never offers another revision.
 */
export const verifyTemplatePinForHandoff = Effect.fn('TemplateRevision.verifyPin')(function* verifyPin(
  port: TemplateRevisionPortContract,
  pin: TemplatePin,
) {
  const revision = yield* port.loadRevision(pin.revisionId);
  if (
    Option.isNone(revision) ||
    revision.value.templateTypeId !== pin.templateTypeId ||
    revision.value.revisionNumber !== pin.revisionNumber
  ) {
    return yield* new TemplatePinBlocked({
      code: 'pinned_template_revision_unavailable',
      reason: 'The pinned Template Revision is no longer available; reconcile the intent, nothing is upgraded silently',
      revisionId: pin.revisionId,
    });
  }
  if (Option.isSome(yield* port.findInvalidation(pin.revisionId))) {
    return yield* new TemplatePinBlocked({
      code: 'pinned_template_revision_invalidated_unsafe',
      reason: 'The pinned Template Revision was invalidated as unsafe; no further stoppable handoff is allowed',
      revisionId: pin.revisionId,
    });
  }
  return pin;
});

const activationAudit = (activation: TemplateActivationRecord) => {
  const base = {
    activatedAt: iso(activation.activatedAt),
    activatedByPrincipalId: activation.activatedByPrincipalId,
    activationId: activation.activationId,
    activationReason: activation.activationReason,
    scopeKey: activation.scopeKey,
  };
  return Option.match(activation.ending, {
    onNone: () => base,
    onSome: (ending) => ({
      ...base,
      endedAt: iso(ending.endedAt),
      endedByPrincipalId: ending.endedByPrincipalId,
      endedKind: ending.endedKind,
      endReason: ending.endReason,
    }),
  });
};

const lifecycleOf = (
  activations: readonly TemplateActivationRecord[],
  invalidated: boolean,
): TemplateLifecycleState => {
  if (invalidated) {
    return 'invalidated-unsafe';
  }
  if (activations.some((activation) => Option.isNone(activation.ending))) {
    return 'active';
  }
  return activations.length === 0 ? 'draft' : 'retired';
};

const coversDecision = (activation: TemplateActivationRecord, decisionTime: DateTime.Utc) =>
  DateTime.isLessThanOrEqualTo(activation.activatedAt, decisionTime) &&
  Option.match(activation.ending, {
    onNone: () => true,
    onSome: (ending) => DateTime.isGreaterThan(ending.endedAt, decisionTime),
  });

/**
 * The safe audit answer for one pin: which revision, language and scope a message used and the who/what/when/why of
 * its approval. It reads identity and digests only, never the text, so it can hold no OTP, token or proof.
 */
export const describeTemplateUse = Effect.fn('TemplateRevision.describeUse')(function* describeUse(
  port: TemplateRevisionPortContract,
  pin: TemplatePin,
) {
  const [revision, type, activations, invalidation] = yield* Effect.all(
    [
      port.loadRevision(pin.revisionId),
      port.loadType(pin.templateTypeId),
      port.activationsOfRevision(pin.revisionId),
      port.findInvalidation(pin.revisionId),
    ],
    { concurrency: 1 },
  );
  if (Option.isNone(revision) || Option.isNone(type) || revision.value.templateTypeId !== pin.templateTypeId) {
    return yield* new TemplateRevisionNotFound({
      code: 'template_revision_not_found',
      reason: 'The pinned Template Revision is unavailable in this scope',
    });
  }
  const audit: TemplateUseAudit = yield* Schema.decodeUnknownEffect(TemplateUseAuditSchema)({
    activations: activations.map(activationAudit),
    activeAtDecisionTime: activations.some((activation) => coversDecision(activation, pin.decisionTime)),
    contentDigest: revision.value.contentDigest,
    decisionTime: iso(pin.decisionTime),
    identity: type.value.identity,
    ...Option.match(invalidation, {
      onNone: () => ({}),
      onSome: (found) => ({
        invalidation: {
          invalidatedAt: iso(found.invalidatedAt),
          invalidatedByPrincipalId: found.invalidatedByPrincipalId,
          reason: found.reason,
        },
      }),
    }),
    lifecycleState: lifecycleOf(activations, Option.isSome(invalidation)),
    revisionId: pin.revisionId,
    revisionNumber: revision.value.revisionNumber,
    templateTypeId: pin.templateTypeId,
  }).pipe(Effect.orDie);
  return audit;
});
