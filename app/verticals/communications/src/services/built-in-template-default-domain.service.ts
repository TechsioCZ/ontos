import { DateTime, Effect, Option, Schema } from 'effect';
import { BuiltInTemplateDefaultEntrySchema, TemplateLegalEntityIdSchema } from '../../shared/template-revision.ts';
import type {
  BuiltInTemplateDefaultEntry,
  TemplateIdentity,
  TemplateLifecycleState,
  TemplateScope,
} from '../../shared/template-revision.ts';
import { allBuiltInTemplateDefaults } from '../domain/catalog/built-in-template-defaults.ts';
import type { BuiltInTemplateDefault } from '../domain/catalog/built-in-template-defaults.ts';
import {
  PORTAL_AUTH_DEFAULT_COPY_APPROVAL,
  PORTAL_AUTH_DEFAULT_COPY_APPROVED_ON,
} from '../domain/catalog/portal-auth-copy-draft.ts';
import { lifecycleOf } from './template-revision-domain.service.ts';
import type { TemplateRevisionPortContract, TemplateRevisionRecord } from './template-revision-port.service.ts';

/**
 * The review of the built-in default texts (#1398, #1406) a Tenant's authorised user reads before replacing one. The
 * built-in text is in force for an identity the Tenant never took over; the Tenant replaces it through the ordinary
 * prepare and activate Actions, which store an own revision attributed to that user. This module only reads.
 */

interface ReviewedRevision {
  readonly everActivated: boolean;
  readonly lifecycleState: TemplateLifecycleState;
  readonly revision: TemplateRevisionRecord;
}

/** Every revision of a Type with its lifecycle state and whether it was ever activated. */
const reviewRevisions = Effect.fn('BuiltInTemplateDefault.reviewRevisions')(function* reviewRevisions(
  port: TemplateRevisionPortContract,
  templateTypeId: string,
) {
  const revisions = yield* port.revisionsOfType(templateTypeId);
  return yield* Effect.forEach(
    revisions,
    (revision) =>
      Effect.all([port.activationsOfRevision(revision.revisionId), port.findInvalidation(revision.revisionId)], {
        concurrency: 1,
      }).pipe(
        Effect.map(([activations, invalidation]): ReviewedRevision => ({
          everActivated: activations.length > 0,
          lifecycleState: lifecycleOf(activations, Option.isSome(invalidation)),
          revision,
        })),
      ),
    { concurrency: 1 },
  );
});

/**
 * What a new message of the identity uses now, by the same rule as `resolveTemplatePin`: the Tenant's active revision;
 * otherwise the built-in default while the Tenant never activated an own revision; otherwise nothing (fail closed).
 */
const inForceOf = (builtIn: BuiltInTemplateDefault, revisions: readonly ReviewedRevision[], replaced: boolean) => {
  const active = revisions.filter(({ lifecycleState }) => lifecycleState === 'active');
  const [only] = active;
  if (active.length > 1) {
    return { reason: 'template_active_revision_ambiguous', source: 'NONE' } as const;
  }
  if (only !== undefined) {
    return {
      contentDigest: only.revision.contentDigest,
      revisionId: only.revision.revisionId,
      revisionNumber: only.revision.revisionNumber,
      source: 'TENANT_REVISION',
    } as const;
  }
  return replaced
    ? ({ reason: 'template_no_active_revision', source: 'NONE' } as const)
    : ({ contentDigest: builtIn.contentDigest, source: 'BUILT_IN_DEFAULT', version: builtIn.version } as const);
};

const decodeEntry = Schema.decodeUnknownEffect(BuiltInTemplateDefaultEntrySchema);

const reviewEntry = Effect.fn('BuiltInTemplateDefault.reviewEntry')(function* reviewEntry(
  port: TemplateRevisionPortContract,
  builtIn: BuiltInTemplateDefault,
  scope: TemplateScope,
) {
  const identity: TemplateIdentity = {
    channel: 'email',
    language: builtIn.language,
    messageType: builtIn.messageType,
    scope,
  };
  const type = yield* port.findType(identity);
  const revisions = Option.isNone(type) ? [] : yield* reviewRevisions(port, type.value.templateTypeId);
  const replaced = revisions.some(({ everActivated }) => everActivated);
  const entry: BuiltInTemplateDefaultEntry = yield* decodeEntry({
    builtInDefault: {
      approval: PORTAL_AUTH_DEFAULT_COPY_APPROVAL,
      approvedOn: PORTAL_AUTH_DEFAULT_COPY_APPROVED_ON,
      body: builtIn.body,
      contentDigest: builtIn.contentDigest,
      optionalPlaceholders: builtIn.optionalPlaceholders,
      requiredPlaceholders: builtIn.requiredPlaceholders,
      state: replaced ? 'BUILT_IN_DEFAULT_REPLACED' : 'BUILT_IN_DEFAULT_IN_USE',
      subject: builtIn.subject,
      version: builtIn.version,
    },
    identity,
    inForce: inForceOf(builtIn, revisions, replaced),
    revisions: revisions.map(({ lifecycleState, revision }) => ({
      body: revision.body,
      contentDigest: revision.contentDigest,
      createdAt: DateTime.formatIso(revision.createdAt),
      isBuiltInDefaultText: revision.contentDigest === builtIn.contentDigest,
      lifecycleState,
      optionalPlaceholders: revision.optionalPlaceholders,
      requiredPlaceholders: revision.requiredPlaceholders,
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      subject: revision.subject,
    })),
  }).pipe(Effect.orDie);
  return entry;
});

/**
 * The read-only review of every built-in default of one exact Template scope: per message type and language the text
 * in force, the built-in default with its exact text, placeholders, version and digest, and the Tenant's own revisions
 * of exactly that identity. Czech comes first in each message type.
 */
export const reviewBuiltInTemplateDefaults = Effect.fn('BuiltInTemplateDefault.review')(function* review(
  port: TemplateRevisionPortContract,
  scope: TemplateScope,
) {
  return yield* Effect.forEach(allBuiltInTemplateDefaults(), (builtIn) => reviewEntry(port, builtIn, scope), {
    concurrency: 1,
  });
});

/** The Template scope a call of this operation may see: the trusted Legal Entity, or the Tenant itself. */
export const operatingTemplateScope = (legalEntityId: string | null | undefined): TemplateScope =>
  legalEntityId === null || legalEntityId === undefined
    ? { kind: 'tenant' }
    : { kind: 'legal-entity', legalEntityId: TemplateLegalEntityIdSchema.make(legalEntityId) };
