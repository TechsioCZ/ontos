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
import { approvedMessageTypes } from '../domain/catalog/approved-registry.ts';
import type { TemplateContract } from '../domain/catalog/template-contract.ts';
import { templateContractOf } from '../domain/catalog/template-contract.ts';
import type { TransactionalMessageType } from '../domain/catalog/message-type.ts';
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

/** The text and the placeholder declarations a revision's digest covers: a changed declaration is a different revision. */
interface DigestedContent {
  readonly body: string;
  readonly optionalPlaceholders: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
}

/**
 * Meaning fingerprint of one revision: its subject, body and the placeholder names it declares as required and as
 * optional. It identifies the revision without storing or exposing the text again. The declarations are part of it
 * because two revisions of the same words that declare different required values are not the same message.
 */
export const templateContentDigest = Effect.fn('TemplateRevision.contentDigest')(function* contentDigest(
  content: DigestedContent,
) {
  const crypto = yield* Crypto.Crypto;
  // each field is length-prefixed and a placeholder name never holds a comma, so no two contents share one encoding
  const canonical = [
    content.subject,
    content.body,
    uniqueSorted(content.requiredPlaceholders).join(','),
    uniqueSorted(content.optionalPlaceholders).join(','),
  ]
    .map((field) => `${field.length}:${field}`)
    .join('');
  const digest = yield* crypto.digest('SHA-256', new TextEncoder().encode(canonical)).pipe(Effect.orDie);
  return Hex.encode(digest);
});

/**
 * The approved Transactional Message Types as far as templates are concerned: the contract a revision of one message
 * type key must fit. A key that is not approved has no contract, so no revision of it can be prepared or activated.
 */
export interface ApprovedTemplateTypes {
  readonly contractOf: (messageType: string) => Option.Option<TemplateContract>;
}

const approvedTemplateTypesOf = (
  types: readonly Pick<TransactionalMessageType, 'placeholderContract' | 'typeId'>[],
): ApprovedTemplateTypes => ({
  contractOf: (messageType) =>
    Option.fromNullishOr(types.find(({ typeId }) => typeId === messageType)).pipe(Option.map(templateContractOf)),
});

/** The production set: exactly the approved catalog, the same list the decision layer is built from. */
export const approvedTemplateTypes: ApprovedTemplateTypes = approvedTemplateTypesOf(approvedMessageTypes);

const approvedContractOf = (catalog: ApprovedTemplateTypes, messageType: string) =>
  Option.match(catalog.contractOf(messageType), {
    onNone: () =>
      refuse('template_content_malformed', 'The message type is not an approved Transactional Message Type'),
    onSome: Effect.succeed,
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
 * revision itself requires present and nothing undeclared by it, and then its fit with the approved message type
 * (#1398 D.3, #1399 L-08): it may use and declare only placeholders the type allows, it must carry every placeholder the
 * type requires (the Auth secret slot among them), and a secret-bearing slot never stands in the subject.
 */
const assessActivatable = Effect.fn('TemplateRevision.assessActivatable')(function* assess(
  revision: TemplateRevisionRecord,
  contract: TemplateContract,
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
  const allowed = new Map(contract.placeholders.map((placeholder) => [placeholder.name, placeholder] as const));
  const outsideType = uniqueSorted([...declared, ...used].filter((name) => !allowed.has(name)));
  if (outsideType.length > 0) {
    return yield* refuse(
      'template_placeholder_undeclared',
      'The revision uses or declares a placeholder its message type does not allow',
      outsideType,
    );
  }
  const secretInSubject = uniqueSorted(subject.names.filter((name) => allowed.get(name)?.kind === 'owner-rendered'));
  if (secretInSubject.length > 0) {
    return yield* refuse(
      'template_content_malformed',
      'A secret-bearing placeholder may not stand in the subject',
      secretInSubject,
    );
  }
  const required = new Set(revision.requiredPlaceholders);
  const lacking = contract.placeholders
    .flatMap(({ name, required: must }) => (must && !(required.has(name) && used.has(name)) ? [name] : []))
    .toSorted(Order.String);
  if (lacking.length > 0) {
    return yield* refuse(
      'template_required_placeholder_omitted',
      'The revision lacks a placeholder its message type requires',
      lacking,
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
  catalog: ApprovedTemplateTypes = approvedTemplateTypes,
) {
  yield* assertOperatingScope(input.scope, actor.legalEntityId);
  yield* approvedContractOf(catalog, input.messageType);
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
    contentDigest: yield* templateContentDigest({
      body: input.body,
      optionalPlaceholders: optional,
      requiredPlaceholders: required,
      subject: input.subject,
    }),
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
  catalog: ApprovedTemplateTypes,
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
  const contract = yield* approvedContractOf(catalog, type.value.identity.messageType);
  return { contract, revision: revision.value, type: type.value };
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
  catalog: ApprovedTemplateTypes = approvedTemplateTypes,
) {
  const { contract, revision, type } = yield* loadRevisionAndType(port, input.revisionId, actor, catalog);
  if (Option.isSome(yield* port.findInvalidation(revision.revisionId))) {
    return yield* refuse('template_revision_invalidated', 'An unsafe-invalidated revision can never be activated');
  }
  yield* assessActivatable(revision, contract);
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
  catalog: ApprovedTemplateTypes = approvedTemplateTypes,
) {
  const { revision, type } = yield* loadRevisionAndType(port, input.revisionId, actor, catalog);
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
  catalog: ApprovedTemplateTypes = approvedTemplateTypes,
) {
  const { revision, type } = yield* loadRevisionAndType(port, input.revisionId, actor, catalog);
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

const decodePin = Schema.decodeUnknownEffect(TemplatePinSchema);

const NO_USABLE_ACTIVE_REVISION = 'No usable approved active revision exists for this exact Template identity';

const noActiveRevision = (reason: string) =>
  new TemplateResolutionFailed({ code: 'template_no_active_revision', reason });

/**
 * Pin contract, step one for exactly one Template identity: the unambiguous revision an authorised administrator
 * prepared AND activated, in force at the decision time. There is no other source (#1398 PO 1A, R-D1): no type, no
 * activation, an ended, invalidated or ambiguous revision is an explicit failure, never a guess and never a built-in,
 * shared, foreign-scope, foreign-language or foreign-brand text.
 */
const resolveExactPin = Effect.fn('TemplateRevision.resolveExactPin')(function* resolveExactPin(
  port: TemplateReadPortContract,
  identity: TemplateIdentity,
  decisionTime?: DateTime.Utc,
) {
  const type = yield* port.findType(identity);
  if (Option.isNone(type)) {
    return yield* noActiveRevision('No Template Type exists for this exact message type, channel, language and scope');
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
  if (only === undefined) {
    return yield* noActiveRevision(NO_USABLE_ACTIVE_REVISION);
  }
  const [revision, invalidation] = yield* Effect.all(
    [port.loadRevision(only.revisionId), port.findInvalidation(only.revisionId)],
    { concurrency: 1 },
  );
  if (Option.isNone(revision) || Option.isSome(invalidation)) {
    return yield* noActiveRevision(NO_USABLE_ACTIVE_REVISION);
  }
  return yield* decodePin({
    ...type.value.identity,
    contentDigest: revision.value.contentDigest,
    decisionTime: iso(at),
    revisionId: revision.value.revisionId,
    revisionNumber: revision.value.revisionNumber,
    source: 'TENANT_REVISION',
    templateTypeId: type.value.templateTypeId,
  }).pipe(Effect.orDie);
});

/**
 * Pin contract, step one with the Tenant-to-Legal-Entity rule (R-D7). A request in a Legal Entity first looks for a
 * revision of that exact Legal Entity. Only when the Legal Entity NEVER took the identity over (no Type, or a Type none of
 * whose revisions was ever activated) does it use the Tenant-wide approved revision of the same message type, channel and
 * language; the returned pin then carries the Tenant scope it was taken from, so the history shows which scope served the
 * message. A Legal Entity that activated an own revision owns the identity: its ended, invalidated or ambiguous own
 * revision fails closed and never falls back. The Message Intent lane stores the returned pin at the first approved
 * creation of an intent.
 */
export const resolveTemplatePin = Effect.fn('TemplateRevision.resolvePin')(function* resolveTemplatePin(
  port: TemplateReadPortContract,
  identity: TemplateIdentity,
  decisionTime?: DateTime.Utc,
) {
  if (identity.scope.kind === 'tenant') {
    return yield* resolveExactPin(port, identity, decisionTime);
  }
  const own = yield* port.findType(identity);
  const takenOver = Option.isSome(own) && Option.isSome(yield* port.latestActivityAt(own.value.templateTypeId));
  return yield* resolveExactPin(port, takenOver ? identity : { ...identity, scope: { kind: 'tenant' } }, decisionTime);
});

/** The exact subject, body and declared placeholders of the revision a pin names. */
export const pinnedTemplateText = (port: Pick<TemplateReadPortContract, 'loadRevision'>, pin: TemplatePin) =>
  port.loadRevision(pin.revisionId);

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

export const lifecycleOf = (
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
    source: 'TENANT_REVISION',
    templateTypeId: pin.templateTypeId,
  }).pipe(Effect.orDie);
  return audit;
});
