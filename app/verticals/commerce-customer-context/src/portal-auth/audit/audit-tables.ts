import { index, pgSchema, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The audit trail lives in the Commerce realm's own schema. The handle is declared here rather than
 * imported from the Better Auth table module so the dependency runs one way: the provider table
 * module owns the adapter inventory and names this table in it, and this module names no other.
 */
const commercePortalAuthAuditSchema = pgSchema('commerce_auth');

/**
 * Commerce-owned authentication audit evidence. It lives beside the realm it describes, not in
 * Core: these are provider/session facts, and a refused sign-in has no tenant to attribute.
 * The column list is the containment boundary — there is no column a secret could occupy.
 */
export const portalAuthAuditEvent = commercePortalAuthAuditSchema.table(
  'portal_auth_audit_event',
  {
    auditEventId: uuid('audit_event_id').defaultRandom().primaryKey(),
    /**
     * Ties a pre-mutation intent row to the completion row for the same attempt — a recovery
     * ledger token digest, or the keyed digest of a sign-in attempt's client key. A digest only:
     * no token, address or credential can occupy this column.
     */
    correlationDigest: text('correlation_digest'),
    eventType: text('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    operation: text('operation'),
    outcome: text('outcome').notNull(),
    /** The provider's opaque subject id; never an address, a display name or a token. */
    providerSubjectId: text('provider_subject_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    schemaVersion: smallint('schema_version').notNull(),
    /** The published opaque session reference, which is already the caller-visible identifier. */
    sessionRef: text('session_ref'),
    /** HMAC digest of the attempted address under the deployment secret; never the address. */
    subjectDigest: text('subject_digest'),
  },
  (table) => [
    index('commerce_auth_audit_event_occurred_at_idx').on(table.occurredAt),
    index('commerce_auth_audit_event_type_occurred_at_idx').on(table.eventType, table.occurredAt),
    index('commerce_auth_audit_event_subject_digest_idx').on(table.subjectDigest),
    index('commerce_auth_audit_event_provider_subject_id_idx').on(table.providerSubjectId),
    index('commerce_auth_audit_event_correlation_digest_idx').on(table.correlationDigest),
  ],
);
