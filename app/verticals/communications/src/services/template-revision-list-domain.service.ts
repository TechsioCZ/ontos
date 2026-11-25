import { DateTime, Effect, Option, Schema } from 'effect';
import {
  TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE,
  TemplateRevisionListPageSchema,
} from '../../shared/template-revision-read.ts';
import type { TemplateRevisionListPage, TemplateRevisionListRequest } from '../../shared/template-revision-read.ts';
import type { TemplateScope } from '../../shared/template-revision.ts';
import { activationAudit, lifecycleOf } from './template-revision-domain.service.ts';
import type { TemplateRevisionPortContract, TemplateRevisionWithType } from './template-revision-port.service.ts';

/**
 * The Tenant administrator's list of Template Revisions (#1398 D.2, T-04, AC-01, AC-02). It reads the same activation facts
 * as the per-message `templateUse` audit (`describeTemplateUse`: `activationsOfRevision`, `findInvalidation`, `lifecycleOf`,
 * `activationAudit`) and the revision's identity, digest and declared placeholder names, and it never reads or returns the
 * subject or the body. This module only reads.
 */

const decodePage = Schema.decodeUnknownEffect(TemplateRevisionListPageSchema);
const iso = (at: DateTime.Utc) => DateTime.formatIso(at);

/** The audit of one revision: its identity, state and the whole activation trace, from the owner's own facts. */
const itemOf = Effect.fn('TemplateRevisionList.item')(function* item(
  port: TemplateRevisionPortContract,
  { revision, type }: TemplateRevisionWithType,
) {
  const [activations, invalidation] = yield* Effect.all(
    [port.activationsOfRevision(revision.revisionId), port.findInvalidation(revision.revisionId)],
    { concurrency: 1 },
  );
  return {
    activations: activations.map(activationAudit),
    contentDigest: revision.contentDigest,
    createdAt: iso(revision.createdAt),
    createdByPrincipalId: revision.createdByPrincipalId,
    identity: type.identity,
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
    optionalPlaceholders: revision.optionalPlaceholders,
    preparedReason: revision.reason,
    requiredPlaceholders: revision.requiredPlaceholders,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    templateTypeId: revision.templateTypeId,
  };
});

/**
 * One page of the revisions of ONE exact scope (the trusted Legal Entity, or the Tenant itself): ordered by message type,
 * then language, then the newest revision first. One row more than the limit is read to know whether a next page exists.
 */
export const listTemplateRevisions = Effect.fn('TemplateRevisionList.list')(function* list(
  port: TemplateRevisionPortContract,
  scope: TemplateScope,
  input: TemplateRevisionListRequest,
) {
  const limit = input.limit ?? TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE;
  const rows = yield* port.revisionsOfScope({
    after: input.cursor,
    language: input.language,
    limit: limit + 1,
    messageType: input.messageType,
    scope,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const items = yield* Effect.forEach(page, (row) => itemOf(port, row), { concurrency: 1 });
  const nextCursor =
    rows.length > limit && last !== undefined
      ? {
          language: last.type.identity.language,
          messageType: last.type.identity.messageType,
          revisionNumber: last.revision.revisionNumber,
        }
      : undefined;
  const decoded: TemplateRevisionListPage = yield* decodePage(
    nextCursor === undefined ? { items } : { items, nextCursor },
  ).pipe(Effect.orDie);
  return decoded;
});
