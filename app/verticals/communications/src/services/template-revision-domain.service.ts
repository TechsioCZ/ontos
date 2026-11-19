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
  TemplateReadPortContract,
  TemplateRevisionPortContract,
  TemplateRevisionRecord,
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
const lineBreak = /[\r\n]/u;
const uniqueSorted = (names: readonly string[]) => EffectArray.dedupe(names).toSorted(Order.String);
const iso = (at: DateTime.Utc) => DateTime.formatIso(at);

/** The placeholder names of a text, and whether it carries any brace that is not a well-formed placeholder. */
export const extractPlaceholders = (text: string) => {
  const names = [...text.matchAll(slot)].map((match) => match.groups?.['name'] ?? '');
  const malformed = /\{\{|\}\}/u.test(text.replaceAll(slot, ''));
  return { malformed, names };
};

const refuse = (code: (typeof TemplateRefused.Type)['code'], reason: string, placeholders?: readonly string[]) =>
  Effect.fail(new TemplateRefused(placeholders === undefined ? { code, reason } : { code, placeholders, reason }));

/**
 * Business time of a write to one Type: the database wall clock, never earlier than the latest instant an activation of
 * that Type started or ended. The clamp keeps `ended_at >= activated_at` and the activation timeline monotonic even
 * if the clock of a second writer lags the one that wrote last.
 */
export const clampBusinessTime = (clock: DateTime.Utc, latest: Option.Option<DateTime.Utc>) =>
  Option.match(latest, { onNone: () => clock, onSome: (floor) => DateTime.max(clock, floor) });

/**
 * Takes business time. It is only meaningful after the Type lock is held, because every activation another writer
 * committed before releasing that lock is then visible and bounds this writer's time from below.
 */
const businessTimeOf = Effect.fn('TemplateRevision.businessTime')(function* businessTime(
  port: TemplateReadPortContract,
  templateTypeId: string,
) {
  const [clock, latest] = yield* Effect.all([port.clockNow, port.latestActivityAt(templateTypeId)], {
    concurrency: 1,
  });
  return clampBusinessTime(clock, latest);
});

/** Meaning fingerprint of one revision text: identifies it without storing or exposing the text again. */
const templateContentDigest = Effect.fn('TemplateRevision.contentDigest')(function* contentDigest(
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
const assertOperatingScope = (scope: TemplateScope, legalEntityId: string | null) =>
  (scope.kind === 'tenant' ? legalEntityId === null : legalEntityId === scope.legalEntityId)
    ? Effect.void
    : refuse('template_scope_mismatch', 'The Template scope is not the trusted operating scope of this operation');

/**
 * What activation requires of a revision: a single-line subject, well-formed placeholders, every placeholder the
 * revision itself requires present and nothing undeclared by it. The Type carries no declaration to fall back on.
 */
const assessActivatable = Effect.fn('TemplateRevision.assessActivatable')(function* assess(
  revision: TemplateRevisionRecord,
) {
  const subject = extractPlaceholders(revision.subject);
  const body = extractPlaceholders(revision.body);
  if (lineBreak.test(revision.subject)) {
    return yield* refuse('template_content_malformed', 'The subject must be one line without a line break');
  }
  if (subject.malformed || body.malformed) {
    return yield* refuse('template_content_malformed', 'The revision text carries a malformed placeholder');
  }
  const used = new Set([...subject.names, ...body.names]);
  const missing = revision.requiredPlaceholders.filter((name) => !used.has(name));
  if (missing.length > 0) {
    return yield* refuse(
      'template_required_placeholder_omitted',
      'The revision lacks a placeholder it declares as required',
      missing,
    );
  }
  const declared = new Set([...revision.requiredPlaceholders, ...revision.optionalPlaceholders]);
  const undeclared = uniqueSorted([...used].filter((name) => !declared.has(name)));
  if (undeclared.length > 0) {
    return yield* refuse(
      'template_placeholder_undeclared',
      'The revision uses a placeholder it does not declare',
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

/**
 * Stores a new immutable draft revision with its own declared placeholders, creating its identity-only Template Type on
 * first use. The draft is not usable yet.
 */
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
    lineBreak.test(input.subject) ||
    subject.malformed ||
    body.malformed ||
    required.length !== input.requiredPlaceholders.length ||
    optional.length !== input.optionalPlaceholders.length ||
    optional.some((name) => requiredNames.has(name))
  ) {
    return yield* refuse(
      'template_content_malformed',
      'The subject, the text or the declared placeholders are malformed or repeat a name',
    );
  }
  const type = yield* port.ensureType({
    actionInvocationId: actor.actionInvocationId,
    at: yield* port.clockNow,
    identity: { channel: input.channel, language: input.language, messageType: input.messageType, scope: input.scope },
    principalId: actor.principalId,
  });
  const revision = yield* port.appendRevision({
    actionInvocationId: actor.actionInvocationId,
    at: yield* port.clockNow,
    body: input.body,
    contentDigest: yield* templateContentDigest(input.subject, input.body),
    optionalPlaceholders: optional,
    placeholdersUsed: uniqueSorted([...subject.names, ...body.names]),
    principalId: actor.principalId,
    reason: input.reason,
    requiredPlaceholders: required,
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
  yield* assessActivatable(revision);
  const open = yield* port.openActivations(type.templateTypeId);
  if (openActivationOf(open, revision.revisionId) !== undefined) {
    return yield* refuse('template_revision_already_active', 'The revision is already the active revision');
  }
  // The Type lock is held here, so the time taken now cannot predate any activation another writer committed.
  const at = yield* businessTimeOf(port, type.templateTypeId);
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
  const endedAt = yield* businessTimeOf(port, type.templateTypeId);
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
  const invalidatedAt = yield* businessTimeOf(port, type.templateTypeId);
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
  port: TemplateReadPortContract,
  identity: TemplateIdentity,
  decisionTime?: DateTime.Utc,
) {
  const type = yield* port.findType(identity);
  if (Option.isNone(type)) {
    return yield* new TemplateResolutionFailed({
      code: 'template_no_active_revision',
      reason: 'No Template Type exists for this exact message type, channel, language and scope',
    });
  }
  // A decision time taken from the clock is taken under the shared Type lock, so no activation can later commit with a
  // start at or before it: the pin's decision time stays consistent with the end of the revision it pins.
  const at =
    decisionTime ??
    (yield* port
      .lockTypeShared(type.value.templateTypeId)
      .pipe(Effect.andThen(businessTimeOf(port, type.value.templateTypeId))));
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
  port: TemplateReadPortContract,
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
  const type = yield* port.loadType(pin.templateTypeId);
  if (
    Option.isNone(type) ||
    type.value.identity.messageType !== pin.messageType ||
    type.value.identity.channel !== pin.channel ||
    type.value.identity.language !== pin.language ||
    templateScopeKey(type.value.identity.scope) !== templateScopeKey(pin.scope)
  ) {
    return yield* new TemplatePinBlocked({
      code: 'pinned_template_identity_mismatch',
      reason: 'The pin names an identity other than the Template Type of its revision; nothing is handed off',
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
    optionalPlaceholders: revision.value.optionalPlaceholders,
    requiredPlaceholders: revision.value.requiredPlaceholders,
    revisionId: pin.revisionId,
    revisionNumber: revision.value.revisionNumber,
    templateTypeId: pin.templateTypeId,
  }).pipe(Effect.orDie);
  return audit;
});
