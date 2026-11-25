import { Schema } from 'effect';

import {
  AuditActivationSchema,
  TemplateIdentitySchema,
  TemplateLanguageSchema,
  TemplateLifecycleStateSchema,
  TemplateMessageTypeSchema,
  TemplatePlaceholderNameSchema,
  TemplatePrincipalIdSchema,
  TemplateRevisionIdSchema,
  TemplateScopeSchema,
  TemplateTypeIdSchema,
} from './template-revision.ts';

/**
 * Published, schema-only answer to "which Template Revisions does this Tenant have, which one is active per Template Type,
 * language and scope, and what is the activation history" (#1398 D.2, T-04, AC-01, AC-02, T-07). It is a typed allow-list
 * of identity, digest, declared placeholder NAMES and the who/what/when/scope/why trace: the subject and the body of a
 * revision have no field to travel in, so reading this list never reads the wording. The wording stays with the
 * Actions that prepared it and the seed-content review.
 */

/**
 * The one technical page cap of the list, defined once. It bounds one response and the work of one Read; it is not a
 * business number. A larger `limit` is refused at decoding instead of being silently clamped.
 */
export const TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE = 50;

/**
 * The position after the last returned revision. The list is ordered by message type, then language, then the newest
 * revision first; the caller only echoes the cursor back and the scope is never taken from it.
 */
export const TemplateRevisionListCursorSchema = Schema.Struct({
  language: TemplateLanguageSchema,
  messageType: TemplateMessageTypeSchema,
  revisionNumber: Schema.Int,
});
export type TemplateRevisionListCursor = typeof TemplateRevisionListCursorSchema.Type;

/** The request names no Tenant and no scope: the trusted operation scope is the only way to choose them. */
export const TemplateRevisionListRequestFieldsSchema = Schema.Struct({
  cursor: Schema.optionalKey(TemplateRevisionListCursorSchema),
  language: Schema.optionalKey(TemplateLanguageSchema),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE),
    ),
  ),
  messageType: Schema.optionalKey(TemplateMessageTypeSchema),
});
export type TemplateRevisionListRequest = typeof TemplateRevisionListRequestFieldsSchema.Type;

/**
 * One Template Revision with its lifecycle state in the domain's own vocabulary: `draft` (prepared, never activated),
 * `active`, `retired` (activated once, no longer) and `invalidated-unsafe`; and its whole activation history.
 */
export const TemplateRevisionListItemSchema = Schema.Struct({
  activations: Schema.Array(AuditActivationSchema),
  contentDigest: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  createdByPrincipalId: TemplatePrincipalIdSchema,
  identity: TemplateIdentitySchema,
  invalidation: Schema.optionalKey(
    Schema.Struct({
      invalidatedAt: Schema.DateTimeUtcFromString,
      invalidatedByPrincipalId: TemplatePrincipalIdSchema,
      reason: Schema.String,
    }),
  ),
  lifecycleState: TemplateLifecycleStateSchema,
  /** The placeholder names this revision itself declared; names only, never a value. */
  optionalPlaceholders: Schema.Array(TemplatePlaceholderNameSchema),
  /** Why the administrator prepared this revision. */
  preparedReason: Schema.String,
  requiredPlaceholders: Schema.Array(TemplatePlaceholderNameSchema),
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Int,
  templateTypeId: TemplateTypeIdSchema,
});

export const TemplateRevisionListPageSchema = Schema.Struct({
  items: Schema.Array(TemplateRevisionListItemSchema),
  /** Present exactly when more revisions exist after this page. */
  nextCursor: Schema.optionalKey(TemplateRevisionListCursorSchema),
});
export type TemplateRevisionListPage = typeof TemplateRevisionListPageSchema.Type;

export const TemplateRevisionListResultSchema = Schema.Struct({
  ...TemplateRevisionListPageSchema.fields,
  /** The exact scope this page answers: the trusted Legal Entity, or the Tenant itself. */
  scope: TemplateScopeSchema,
});
