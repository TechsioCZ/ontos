// Blessed shape (audit "Existing patterns to preserve": "Outbox payloads already use
// `Schema.Json`, registered payload Schemas, and Drizzle JSONB correctly"), written the way this
// repo already writes Struct fields: the fields object is hoisted to a module-scope `const` and
// then handed to `Schema.Struct`. Real precedents, all generated or hand-written today:
//   verticals/contacts/shared/apis/customer-list.ts:8   `BoundedListInputFields` (Codesmith-generated)
//   verticals/contacts/shared/apis/customer-detail.ts:69 `customerBusinessFields`
//   packages/core-runtime/src/auth/principal-administration-reads.ts:21 `paginationInput`
//   apps/shell-super-app/shared/api.ts:464               `safeTenantIdentityFields`
// The rule's own documentation says a Struct field is "Never reported", but the `ObjectExpression`
// handler only skips properties syntactically inside a `Schema.*` call, so hoisting the identical
// fields object out of the `Schema.Struct(...)` argument turns the blessed shape into a violation.
import { Schema } from 'effect';

export const OutboxMessageFields = {
  payloadJson: Schema.Json,
  topic: Schema.String,
} as const;

export const OutboxMessageSchema = Schema.Struct(OutboxMessageFields);
