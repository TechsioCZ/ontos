import { DateTime, Effect, Option, Order, Schema } from 'effect';
import { BuiltInTemplateDefaultEntrySchema, TemplateLegalEntityIdSchema } from '../../shared/template-revision.ts';
import type {
  BuiltInTemplateDefaultBlock,
  ConfirmBuiltInTemplateDefaultPayloadSchema,
  BuiltInTemplateDefaultEntry,
  TemplateIdentity,
  TemplateLifecycleState,
  TemplateScope,
} from '../../shared/template-revision.ts';
import { TemplateDefaultConfirmationRefused } from '../../shared/template-revision-errors.ts';
import {
  PORTAL_AUTH_COPY_DRAFT_APPROVAL,
  PORTAL_AUTH_COPY_DRAFT_VERSION,
  portalAuthCopyDraft,
} from '../domain/catalog/portal-auth-copy-draft.ts';
import type { PortalAuthCopyEntry } from '../domain/catalog/portal-auth-copy-draft.ts';
import {
  activateRevision,
  assertOperatingScope,
  lifecycleOf,
  prepareRevision,
  templateContentDigest,
} from './template-revision-domain.service.ts';
import type { TemplateActor } from './template-revision-domain.service.ts';
import type {
  TemplateActivationRecord,
  TemplateRevisionPortContract,
  TemplateRevisionRecord,
} from './template-revision-port.service.ts';

/**
 * Built-in default texts (#1398, #1406): the product owner approved the Portal Auth wording as the default TEXT, and a
 * Tenant's authorised user confirms it per exact Template identity. Confirming stores it through the ordinary prepare
 * path and activates it through the ordinary activate path, in the one transaction of that user's own Action. Nothing
 * here runs on its own: without that Action call no default is stored, and Communications keeps sending nothing.
 */

/** The text a confirmation stores, declared exactly as the prepare path stores it. */
interface BuiltInDefaultText {
  readonly body: string;
  readonly contentDigest: string;
  readonly optionalPlaceholders: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
}

const builtInDefaultText = Effect.fn('BuiltInTemplateDefault.text')(function* text(copy: PortalAuthCopyEntry) {
  const declared: BuiltInDefaultText = {
    body: copy.body,
    contentDigest: yield* templateContentDigest(copy.subject, copy.body),
    optionalPlaceholders: [],
    requiredPlaceholders: [copy.ownerRenderedSlot],
    subject: copy.subject,
  };
  return declared;
});

const sameNames = (left: readonly string[], right: readonly string[]) => {
  const sortedRight = right.toSorted(Order.String);
  return (
    left.length === right.length && left.toSorted(Order.String).every((name, index) => name === sortedRight[index])
  );
};

/** Whether a stored revision carries exactly the built-in default text and placeholder declaration. */
const carriesBuiltInDefault = (revision: TemplateRevisionRecord, text: BuiltInDefaultText) =>
  revision.contentDigest === text.contentDigest &&
  sameNames(revision.requiredPlaceholders, text.requiredPlaceholders) &&
  sameNames(revision.optionalPlaceholders, text.optionalPlaceholders);

interface ReviewedRevision {
  readonly isBuiltInDefaultText: boolean;
  readonly lifecycleState: TemplateLifecycleState;
  /** The revision's open activation; present exactly when it is the active revision. */
  readonly openActivation: TemplateActivationRecord | undefined;
  readonly revision: TemplateRevisionRecord;
}

/** Every revision of a Type with its lifecycle state and whether it is the built-in default text. */
const reviewRevisions = Effect.fn('BuiltInTemplateDefault.reviewRevisions')(function* reviewRevisions(
  port: TemplateRevisionPortContract,
  templateTypeId: string,
  text: BuiltInDefaultText,
) {
  const revisions = yield* port.revisionsOfType(templateTypeId);
  return yield* Effect.forEach(
    revisions,
    (revision) =>
      Effect.all([port.activationsOfRevision(revision.revisionId), port.findInvalidation(revision.revisionId)], {
        concurrency: 1,
      }).pipe(
        Effect.map(([activations, invalidation]): ReviewedRevision => ({
          isBuiltInDefaultText: carriesBuiltInDefault(revision, text),
          lifecycleState: lifecycleOf(activations, Option.isSome(invalidation)),
          openActivation: activations.find((activation) => Option.isNone(activation.ending)),
          revision,
        })),
      ),
    { concurrency: 1 },
  );
});

/**
 * Whether Czech is active for the same message type and scope. English is confirmable only then: under the platform
 * language mode B an English message is sent only when Czech exists, so a confirmed English text never stands alone.
 * The confirm Action holds the Czech Type's shared lock, so no Czech change can commit while it decides.
 */
const czechActiveFor = Effect.fn('BuiltInTemplateDefault.czechActive')(function* czechActive(
  port: TemplateRevisionPortContract,
  identity: TemplateIdentity,
  lock: boolean,
) {
  if (identity.language === 'cs') {
    return true;
  }
  const czech = yield* port.findType({ ...identity, language: 'cs' });
  if (Option.isNone(czech)) {
    return false;
  }
  if (lock) {
    yield* port.lockTypeShared(czech.value.templateTypeId);
  }
  return (yield* port.openActivations(czech.value.templateTypeId)).length > 0;
});

type Assessment =
  | { readonly code: BuiltInTemplateDefaultBlock; readonly kind: 'blocked' }
  | { readonly kind: 'confirmable' }
  | {
      readonly activation: TemplateActivationRecord;
      readonly kind: 'confirmed';
      readonly revision: TemplateRevisionRecord;
    };

/**
 * The one rule both the Read shows and the Action enforces. A Tenant's own active revision is never replaced; a text the
 * Tenant invalidated as unsafe is never confirmed again; English waits for Czech.
 */
export const assessBuiltInDefault = (input: {
  readonly czechActive: boolean;
  readonly language: TemplateIdentity['language'];
  readonly revisions: readonly ReviewedRevision[];
}): Assessment => {
  const active = input.revisions.find(({ openActivation }) => openActivation !== undefined);
  if (active?.openActivation !== undefined) {
    return active.isBuiltInDefaultText
      ? { activation: active.openActivation, kind: 'confirmed', revision: active.revision }
      : { code: 'template_tenant_revision_active', kind: 'blocked' };
  }
  if (input.revisions.some((found) => found.isBuiltInDefaultText && found.lifecycleState === 'invalidated-unsafe')) {
    return { code: 'template_built_in_default_invalidated', kind: 'blocked' };
  }
  if (input.language === 'en' && !input.czechActive) {
    return { code: 'template_built_in_default_requires_czech', kind: 'blocked' };
  }
  return { kind: 'confirmable' };
};

const identityOf = (copy: PortalAuthCopyEntry, scope: TemplateScope): TemplateIdentity => ({
  channel: 'email',
  language: copy.language,
  messageType: copy.messageType,
  scope,
});

const decodeEntry = Schema.decodeUnknownEffect(BuiltInTemplateDefaultEntrySchema);

const reviewEntry = Effect.fn('BuiltInTemplateDefault.reviewEntry')(function* reviewEntry(
  port: TemplateRevisionPortContract,
  copy: PortalAuthCopyEntry,
  scope: TemplateScope,
) {
  const identity = identityOf(copy, scope);
  const [text, type] = yield* Effect.all([builtInDefaultText(copy), port.findType(identity)], { concurrency: 1 });
  const revisions = Option.isNone(type) ? [] : yield* reviewRevisions(port, type.value.templateTypeId, text);
  const czechActive = yield* czechActiveFor(port, identity, false);
  const assessment = assessBuiltInDefault({ czechActive, language: copy.language, revisions });
  const reviewed = {
    builtInDefault: {
      ...text,
      approval: PORTAL_AUTH_COPY_DRAFT_APPROVAL,
      state: assessment.kind === 'confirmed' ? 'BUILT_IN_DEFAULT_CONFIRMED' : 'BUILT_IN_DEFAULT_NOT_CONFIRMED',
      version: PORTAL_AUTH_COPY_DRAFT_VERSION,
    },
    identity,
    revisions: revisions.map(({ isBuiltInDefaultText, lifecycleState, revision }) => ({
      body: revision.body,
      contentDigest: revision.contentDigest,
      createdAt: DateTime.formatIso(revision.createdAt),
      isBuiltInDefaultText,
      lifecycleState,
      optionalPlaceholders: revision.optionalPlaceholders,
      requiredPlaceholders: revision.requiredPlaceholders,
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      subject: revision.subject,
    })),
  };
  const entry: BuiltInTemplateDefaultEntry = yield* decodeEntry(
    assessment.kind === 'blocked' ? { ...reviewed, confirmationBlockedBy: assessment.code } : reviewed,
  ).pipe(Effect.orDie);
  return entry;
});

/**
 * The read-only review of every built-in default of one exact Template scope: per message type and language the
 * Tenant's own revisions of exactly that identity, and the built-in default as a marked candidate with its exact text,
 * placeholders and content digest. Czech comes first in each message type.
 */
export const reviewBuiltInTemplateDefaults = Effect.fn('BuiltInTemplateDefault.review')(function* review(
  port: TemplateRevisionPortContract,
  scope: TemplateScope,
) {
  return yield* Effect.forEach(portalAuthCopyDraft, (copy) => reviewEntry(port, copy, scope), { concurrency: 1 });
});

/** The Template scope a call of this operation may see or change: the trusted Legal Entity, or the Tenant itself. */
export const operatingTemplateScope = (legalEntityId: string | null | undefined): TemplateScope =>
  legalEntityId === null || legalEntityId === undefined
    ? { kind: 'tenant' }
    : { kind: 'legal-entity', legalEntityId: TemplateLegalEntityIdSchema.make(legalEntityId) };

const refuse = (code: (typeof TemplateDefaultConfirmationRefused.Type)['code'], reason: string) =>
  Effect.fail(new TemplateDefaultConfirmationRefused({ code, reason }));

export type ConfirmBuiltInDefaultInput = typeof ConfirmBuiltInTemplateDefaultPayloadSchema.Type;

const BLOCK_REASONS = {
  template_built_in_default_invalidated: 'This text was invalidated as unsafe in this scope',
  template_built_in_default_requires_czech: 'English is confirmable only while Czech is active in this scope',
  template_tenant_revision_active: 'The Tenant already has an active revision of this message type and language',
} as const satisfies Record<BuiltInTemplateDefaultBlock, string>;

/**
 * Confirms one built-in default for one exact identity, as the acting user and with their reason. It stores the text
 * through the prepare path and activates it through the activate path, so validation, digest and the activation rules
 * are the very same. Confirming the text that already is active changes nothing; any other active revision of the
 * Tenant is never replaced.
 */
export const confirmBuiltInTemplateDefault = Effect.fn('BuiltInTemplateDefault.confirm')(function* confirm(
  port: TemplateRevisionPortContract,
  input: ConfirmBuiltInDefaultInput,
  actor: TemplateActor,
) {
  const copy = portalAuthCopyDraft.find(
    (found) => found.messageType === input.messageType && found.language === input.language,
  );
  if (copy === undefined) {
    return yield* refuse(
      'template_built_in_default_unknown',
      'No built-in default text exists for this message type and language',
    );
  }
  yield* assertOperatingScope(input.scope, actor.legalEntityId);
  const text = yield* builtInDefaultText(copy);
  if (input.contentDigest !== text.contentDigest) {
    return yield* refuse(
      'template_built_in_default_digest_mismatch',
      'The reviewed content digest is not the digest of the built-in default text',
    );
  }
  const identity = identityOf(copy, input.scope);
  const czechActive = yield* czechActiveFor(port, identity, true);
  // Creates the identity-only Type on first use and holds its exclusive lock: every writer of the Type waits here.
  const type = yield* port.ensureType({
    actionInvocationId: actor.actionInvocationId,
    at: yield* port.clockNow,
    identity,
    principalId: actor.principalId,
  });
  const assessment = assessBuiltInDefault({
    czechActive,
    language: copy.language,
    revisions: yield* reviewRevisions(port, type.templateTypeId, text),
  });
  if (assessment.kind === 'confirmed') {
    return { activation: assessment.activation, alreadyConfirmed: true, revision: assessment.revision };
  }
  if (assessment.kind === 'blocked') {
    return yield* refuse(assessment.code, BLOCK_REASONS[assessment.code]);
  }
  const { revision } = yield* prepareRevision(
    port,
    {
      ...identity,
      body: text.body,
      optionalPlaceholders: text.optionalPlaceholders,
      reason: input.reason,
      requiredPlaceholders: text.requiredPlaceholders,
      subject: text.subject,
    },
    actor,
  );
  const { activation } = yield* activateRevision(
    port,
    { reason: input.reason, revisionId: revision.revisionId },
    actor,
  );
  return { activation, alreadyConfirmed: false, revision };
});
