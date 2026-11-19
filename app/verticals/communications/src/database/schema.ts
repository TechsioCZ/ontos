import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import type { Schema } from 'effect';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** A JSON document a column stores: always written through its owner's Schema codec, never assembled by hand. */
export type StoredJson = typeof Schema.Json.Type;

export const COMMUNICATIONS_SCHEMA_NAME = 'communications';
/**
 * The one Communications schema. Leaf lanes declare governed tables with `communicationsSchema.table.withRLS(...)`
 * and attach `tenantRlsPolicies` or `tenantLegalEntityRlsPolicies` from `@app/core-runtime`.
 */
export const communicationsSchema = pgSchema(COMMUNICATIONS_SCHEMA_NAME);

/** Pre-authentication ingress replay identity; never stores credentials or trusted business scope. */
export const gatewayAssertionRedemptions = communicationsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('communications_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('communications_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

/**
 * Template Type: the stable identity of one transactional template, per message type, channel, language and allowed
 * scope (#1398). It is immutable and carries identity only: every declared placeholder belongs to a Template Revision,
 * because a change in meaning is a new revision. `scope_key` is `tenant` or `legal-entity:<uuid>` so the identity is one
 * plain unique key.
 */
export const templateTypes = communicationsSchema.table.withRLS(
  'template_types',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    channel: text('channel').$type<'email'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    language: text('language').$type<'cs' | 'en'>().notNull(),
    legalEntityId: uuid('legal_entity_id'),
    messageType: text('message_type').notNull(),
    scopeKey: text('scope_key').notNull(),
    scopeKind: text('scope_kind').notNull(),
    templateTypeId: uuid('template_type_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_template_types_tenant_identity_uk').on(table.tenantId, table.templateTypeId),
    // the target of the activation's scope foreign key: an activation can only carry the scope of its own Type
    unique('communications_template_types_scope_identity_uk').on(table.tenantId, table.templateTypeId, table.scopeKey),
    unique('communications_template_types_identity_uk').on(
      table.tenantId,
      table.messageType,
      table.channel,
      table.language,
      table.scopeKey,
    ),
    check('communications_template_types_channel_ck', sql`${table.channel} in ('email')`),
    check('communications_template_types_language_ck', sql`${table.language} in ('cs', 'en')`),
    check(
      'communications_template_types_scope_ck',
      sql`(${table.scopeKind} = 'tenant' and ${table.legalEntityId} is null and ${table.scopeKey} = 'tenant') or (${table.scopeKind} = 'legal-entity' and ${table.legalEntityId} is not null and ${table.scopeKey} = 'legal-entity:' || ${table.legalEntityId}::text)`,
    ),
    ...tenantRlsPolicies('communications_template_types', table.tenantId),
  ],
);

/**
 * Immutable Template Revision: any change in meaning or text is a new revision, never an update. A revision declares its
 * own required and optional placeholders (names only), so activation checks its text against what it itself declares.
 */
export const templateRevisions = communicationsSchema.table.withRLS(
  'template_revisions',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    body: text('body').notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    optionalPlaceholders: jsonb('optional_placeholders').$type<readonly string[]>().notNull(),
    placeholdersUsed: jsonb('placeholders_used').$type<readonly string[]>().notNull(),
    reason: text('reason').notNull(),
    requiredPlaceholders: jsonb('required_placeholders').$type<readonly string[]>().notNull(),
    revisionId: uuid('revision_id').primaryKey(),
    revisionNumber: integer('revision_number').notNull(),
    subject: text('subject').notNull(),
    templateTypeId: uuid('template_type_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_template_revisions_tenant_identity_uk').on(table.tenantId, table.revisionId),
    // the target of the activation's revision foreign key: an activation can only name the Type of its own revision
    unique('communications_template_revisions_type_identity_uk').on(
      table.tenantId,
      table.revisionId,
      table.templateTypeId,
    ),
    unique('communications_template_revisions_number_uk').on(
      table.tenantId,
      table.templateTypeId,
      table.revisionNumber,
    ),
    foreignKey({
      columns: [table.tenantId, table.templateTypeId],
      foreignColumns: [templateTypes.tenantId, templateTypes.templateTypeId],
      name: 'communications_template_revisions_type_fk',
    }).onDelete('restrict'),
    check('communications_template_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check(
      'communications_template_revisions_placeholders_ck',
      sql`jsonb_typeof(${table.requiredPlaceholders}) = 'array' and jsonb_typeof(${table.optionalPlaceholders}) = 'array' and jsonb_typeof(${table.placeholdersUsed}) = 'array'`,
    ),
    ...tenantRlsPolicies('communications_template_revisions', table.tenantId),
  ],
);

/**
 * One row per activation period of a revision: who, what, when, for which scope and why. Only the closing columns are
 * ever updated, and only once: a database trigger refuses any update of a closed row, so closed history is append-only.
 * The partial unique index keeps at most one open activation per Template Type, and the composite foreign keys tie the
 * activation's Type and scope to its revision's Type.
 */
export const templateActivations = communicationsSchema.table.withRLS(
  'template_activations',
  {
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
    activatedByPrincipalId: uuid('activated_by_principal_id').notNull(),
    activationId: uuid('activation_id').primaryKey(),
    activationInvocationId: uuid('activation_invocation_id').notNull(),
    activationReason: text('activation_reason').notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByPrincipalId: uuid('ended_by_principal_id'),
    endedKind: text('ended_kind').$type<'replaced' | 'deactivated' | 'invalidated-unsafe'>(),
    endInvocationId: uuid('end_invocation_id'),
    endReason: text('end_reason'),
    legalEntityId: uuid('legal_entity_id'),
    revisionId: uuid('revision_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    templateTypeId: uuid('template_type_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.revisionId, table.templateTypeId],
      foreignColumns: [templateRevisions.tenantId, templateRevisions.revisionId, templateRevisions.templateTypeId],
      name: 'communications_template_activations_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.templateTypeId, table.scopeKey],
      foreignColumns: [templateTypes.tenantId, templateTypes.templateTypeId, templateTypes.scopeKey],
      name: 'communications_template_activations_type_fk',
    }).onDelete('restrict'),
    check(
      'communications_template_activations_scope_ck',
      sql`(${table.scopeKey} = 'tenant' and ${table.legalEntityId} is null) or (${table.legalEntityId} is not null and ${table.scopeKey} = 'legal-entity:' || ${table.legalEntityId}::text)`,
    ),
    uniqueIndex('communications_template_activations_open_uk')
      .on(table.tenantId, table.templateTypeId)
      .where(sql`${table.endedAt} is null`),
    index('communications_template_activations_revision_idx').on(table.tenantId, table.revisionId),
    check(
      'communications_template_activations_end_ck',
      sql`(${table.endedAt} is null and ${table.endedKind} is null and ${table.endedByPrincipalId} is null and ${table.endReason} is null and ${table.endInvocationId} is null) or (${table.endedAt} is not null and ${table.endedAt} >= ${table.activatedAt} and ${table.endedKind} in ('replaced', 'deactivated', 'invalidated-unsafe') and ${table.endedByPrincipalId} is not null and ${table.endReason} is not null and ${table.endInvocationId} is not null)`,
    ),
    ...tenantRlsPolicies('communications_template_activations', table.tenantId),
  ],
);

/** Append-only unsafe marker: a Current security gate for a revision, never a mutation of an earlier decision. */
export const templateRevisionInvalidations = communicationsSchema.table.withRLS(
  'template_revision_invalidations',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }).notNull(),
    invalidatedByPrincipalId: uuid('invalidated_by_principal_id').notNull(),
    invalidationId: uuid('invalidation_id').primaryKey(),
    reason: text('reason').notNull(),
    revisionId: uuid('revision_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_template_revision_invalidations_revision_uk').on(table.tenantId, table.revisionId),
    foreignKey({
      columns: [table.tenantId, table.revisionId],
      foreignColumns: [templateRevisions.tenantId, templateRevisions.revisionId],
      name: 'communications_template_revision_invalidations_revision_fk',
    }).onDelete('restrict'),
    ...tenantRlsPolicies('communications_template_revision_invalidations', table.tenantId),
  ],
);

/**
 * Append-only history of one Tenant's own language mode choice (#1399, L-13): one row per change, never updated or
 * removed. The effective mode is the highest `version_number`; a Tenant without a row has made no own choice, and the
 * platform default (B) applies. A decision pins the version it used, so a later change rewrites no earlier decision.
 */
export const tenantLanguageModeVersions = communicationsSchema.table.withRLS(
  'tenant_language_mode_versions',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    mode: text('mode').$type<'A' | 'B'>().notNull(),
    policyVersionId: uuid('policy_version_id').primaryKey(),
    setAt: timestamp('set_at', { withTimezone: true }).defaultNow().notNull(),
    setByPrincipalId: uuid('set_by_principal_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    versionNumber: integer('version_number').notNull(),
  },
  (table) => [
    unique('communications_language_mode_versions_number_uk').on(table.tenantId, table.versionNumber),
    check('communications_language_mode_versions_mode_ck', sql`${table.mode} in ('A', 'B')`),
    check('communications_language_mode_versions_number_ck', sql`${table.versionNumber} > 0`),
    ...tenantRlsPolicies('communications_language_mode_versions', table.tenantId),
  ],
);

/**
 * Communication Request (#1401): the durable identity of one committed source request. `identity_key` is the business
 * identity (source owner x Tenant/scope x purpose x occurrence/revision, I-02) and the ONLY dedupe key: the Action
 * invocation id is attribution, never identity. `fingerprint` is the hash of the material meaning, so the same identity
 * with another meaning is a conflict instead of an update. `payload` is the request exactly as the source sent it
 * (references and revisions, never an address or a secret) and is what the pre-handoff worker re-checks against.
 */
export const communicationRequests = communicationsSchema.table.withRLS(
  'communication_requests',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    identityKey: text('identity_key').notNull(),
    occurrenceId: text('occurrence_id').notNull(),
    occurrenceRevision: integer('occurrence_revision').notNull(),
    payload: jsonb('payload').$type<StoredJson>().notNull(),
    purpose: text('purpose').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    requestId: uuid('request_id').primaryKey(),
    scopeKey: text('scope_key').notNull(),
    sourceModule: text('source_module').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_requests_tenant_identity_uk').on(table.tenantId, table.requestId),
    unique('communications_requests_identity_key_uk').on(table.tenantId, table.identityKey),
    check('communications_requests_revision_ck', sql`${table.occurrenceRevision} > 0`),
    ...tenantRlsPolicies('communication_requests', table.tenantId),
  ],
);

/** A request that arrived again under an existing identity with another material meaning. Append-only; nothing else changes. */
export const communicationRequestConflicts = communicationsSchema.table.withRLS(
  'communication_request_conflicts',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    conflictId: uuid('conflict_id').primaryKey(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    requestId: uuid('request_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_request_conflicts_fingerprint_uk').on(table.tenantId, table.requestId, table.fingerprint),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [communicationRequests.tenantId, communicationRequests.requestId],
      name: 'communications_request_conflicts_request_fk',
    }).onDelete('restrict'),
    ...tenantRlsPolicies('communication_request_conflicts', table.tenantId),
  ],
);

/**
 * Communication Decision: exactly one per request. It records the approved type revision and the Tenant language
 * mode the decision used, so a later catalog revision or mode change reinterprets nothing (I-05, AC-10). `outcome` is
 * `NO_MESSAGE` (the catalog, the source or an approved rule decided that no concrete message exists) or
 * `MESSAGE_INTENTS` (one or more concrete candidates, each with its own status).
 */
export const communicationDecisions = communicationsSchema.table.withRLS(
  'communication_decisions',
  {
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    decisionId: uuid('decision_id').primaryKey(),
    languagePolicy: jsonb('language_policy').$type<StoredJson | null>(),
    noMessageReason: text('no_message_reason'),
    outcome: text('outcome').$type<'MESSAGE_INTENTS' | 'NO_MESSAGE'>().notNull(),
    requestId: uuid('request_id').notNull(),
    requiredness: text('requiredness').$type<'OPTIONAL' | 'REQUIRED' | null>(),
    ruleKey: text('rule_key'),
    tenantId: uuid('tenant_id').notNull(),
    typeId: text('type_id'),
    typeRevision: integer('type_revision'),
    unresolvedSlots: jsonb('unresolved_slots').$type<StoredJson>().notNull(),
  },
  (table) => [
    unique('communications_decisions_tenant_identity_uk').on(table.tenantId, table.decisionId),
    unique('communications_decisions_request_uk').on(table.tenantId, table.requestId),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [communicationRequests.tenantId, communicationRequests.requestId],
      name: 'communications_decisions_request_fk',
    }).onDelete('restrict'),
    check('communications_decisions_outcome_ck', sql`${table.outcome} in ('MESSAGE_INTENTS', 'NO_MESSAGE')`),
    check(
      'communications_decisions_shape_ck',
      sql`(${table.outcome} = 'NO_MESSAGE' and ${table.noMessageReason} is not null) or (${table.outcome} = 'MESSAGE_INTENTS' and ${table.noMessageReason} is null and ${table.typeId} is not null and ${table.typeRevision} is not null)`,
    ),
    ...tenantRlsPolicies('communication_decisions', table.tenantId),
  ],
);

/**
 * Message Intent: one concrete message to one original recipient, with everything it was decided under pinned. The row
 * is immutable. The pins are: the original recipient binding (references and evidence, never an address), the
 * endpoint pin (channel, contact reference and revision, owner mask; never the address), the Privacy scope, the
 * actual language, the exact template revision and the Tenant mode with its policy version. `intent_key` is the
 * catalog candidate identity. A repeated or parallel decision lands on this same row.
 */
export const messageIntents = communicationsSchema.table.withRLS(
  'message_intents',
  {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    decisionId: uuid('decision_id').notNull(),
    endpointPin: jsonb('endpoint_pin').$type<StoredJson | null>(),
    handoffPin: jsonb('handoff_pin').$type<StoredJson>().notNull(),
    intentId: uuid('intent_id').primaryKey(),
    intentKey: text('intent_key').notNull(),
    language: text('language').$type<'cs' | 'en' | null>(),
    languageDecision: jsonb('language_decision').$type<StoredJson | null>(),
    originalBinding: jsonb('original_binding').$type<StoredJson>().notNull(),
    policyRef: jsonb('policy_ref').$type<StoredJson | null>(),
    processingScope: jsonb('processing_scope').$type<StoredJson | null>(),
    purpose: text('purpose').notNull(),
    reason: text('reason'),
    recipientId: text('recipient_id').notNull(),
    recipientModule: text('recipient_module').notNull(),
    recipientRole: text('recipient_role').notNull(),
    recipientType: text('recipient_type').notNull(),
    requestId: uuid('request_id').notNull(),
    slotKey: text('slot_key').notNull(),
    status: text('status').$type<'NOT_SENT' | 'PENDING_HANDOFF' | 'SUPPRESSED'>().notNull(),
    templateRevisionId: uuid('template_revision_id'),
    templateRevisionNumber: integer('template_revision_number'),
    tenantId: uuid('tenant_id').notNull(),
    tenantMode: text('tenant_mode').$type<'A' | 'B' | null>(),
    typeId: text('type_id').notNull(),
    typeRevision: integer('type_revision').notNull(),
  },
  (table) => [
    unique('communications_intents_tenant_identity_uk').on(table.tenantId, table.intentId),
    unique('communications_intents_key_uk').on(table.tenantId, table.intentKey),
    foreignKey({
      columns: [table.tenantId, table.decisionId],
      foreignColumns: [communicationDecisions.tenantId, communicationDecisions.decisionId],
      name: 'communications_intents_decision_fk',
    }).onDelete('restrict'),
    index('communications_intents_request_idx').on(table.tenantId, table.requestId),
    check('communications_intents_status_ck', sql`${table.status} in ('NOT_SENT', 'PENDING_HANDOFF', 'SUPPRESSED')`),
    // a pending intent has everything the last stoppable handoff re-checks: endpoint, Privacy scope, language and revision
    check(
      'communications_intents_pending_pins_ck',
      sql`${table.status} <> 'PENDING_HANDOFF' or (${table.endpointPin} is not null and ${table.processingScope} is not null and ${table.languageDecision} is not null and ${table.language} is not null and ${table.templateRevisionId} is not null and ${table.templateRevisionNumber} is not null and ${table.tenantMode} is not null and ${table.policyRef} is not null)`,
    ),
    check('communications_intents_reason_ck', sql`${table.status} = 'PENDING_HANDOFF' or ${table.reason} is not null`),
    ...tenantRlsPolicies('message_intents', table.tenantId),
  ],
);

/**
 * Delivery Attempt: the fourth identity. In this lane an attempt is only PREPARED by the pre-handoff worker BEFORE the
 * handoff call and finished with the provider evidence after it, so a crash between the two leaves a PREPARED attempt
 * that no later processing may resend without reconciliation (I-09). Written only by the worker's scoped routines;
 * the runtime role can read it. A finished attempt is immutable.
 *
 * `NOT_ATTEMPTED` is NOT a provider outcome: no adapter exists in the deployment, so provably nothing was submitted. It
 * is kept apart from `UNAVAILABLE` (a real provider that could not be used, which does NOT prove it did not accept),
 * and it is the only finished state after which a NEXT attempt number may begin: enabling the owner ports before the
 * Messaging Adapter exists (step 22) therefore never burns the intent's only attempt.
 */
export const deliveryAttempts = communicationsSchema.table.withRLS(
  'delivery_attempts',
  {
    attemptId: uuid('attempt_id').primaryKey(),
    attemptNumber: integer('attempt_number').notNull(),
    evidence: jsonb('evidence').$type<StoredJson | null>(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    intentId: uuid('intent_id').notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull(),
    state: text('state')
      .$type<'ACCEPTED' | 'INDETERMINATE' | 'NOT_ATTEMPTED' | 'PREPARED' | 'REJECTED' | 'UNAVAILABLE'>()
      .notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_attempts_number_uk').on(table.tenantId, table.intentId, table.attemptNumber),
    // the target of every history foreign key: an observation or a retry link names an attempt AND the intent it belongs to
    unique('communications_attempts_intent_identity_uk').on(table.tenantId, table.intentId, table.attemptId),
    foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [messageIntents.tenantId, messageIntents.intentId],
      name: 'communications_attempts_intent_fk',
    }).onDelete('restrict'),
    check('communications_attempts_number_ck', sql`${table.attemptNumber} > 0`),
    check(
      'communications_attempts_state_ck',
      sql`${table.state} in ('ACCEPTED', 'INDETERMINATE', 'NOT_ATTEMPTED', 'PREPARED', 'REJECTED', 'UNAVAILABLE')`,
    ),
    ...tenantRlsPolicies('delivery_attempts', table.tenantId),
  ],
);

/**
 * The recorded stop of one intent at its last stoppable handoff, per EVALUATION: every distinct reason, the proven
 * ones first. A stop is a fact, not a verdict on the message forever: recovery after a stop is a later plan (#1403, d21-10).
 *
 * Recoverable by design, without a rewrite: the row is keyed by (intent, `evaluation_seq`), not by the intent alone.
 * This lane records evaluation 1 only, and its worker still treats any stop as final. `proven` (derived from the
 * reasons, never written) separates a PROVEN stop (at least one reason is a proven prohibition: Privacy NOT_ALLOWED,
 * recipient not eligible, source stale, template pin blocked) from an UNPROVEN one (every reason is only the inability to
 * establish a fact: source authority, Privacy or recipient owner outage). d21-10 may supersede an unproven stop ONLY by
 * appending a NEW Current evaluation (`evaluation_seq` + 1); it never edits or removes a row, and a proven stop is never
 * superseded by a retry. The rows stay append-only, so history shows every evaluation that was made.
 */
export const intentHandoffStops = communicationsSchema.table.withRLS(
  'intent_handoff_stops',
  {
    evaluationSeq: integer('evaluation_seq').default(1).notNull(),
    intentId: uuid('intent_id').notNull(),
    proven: boolean('proven')
      .generatedAlwaysAs(sql`jsonb_path_exists("reasons", '$[*] ? (@.proven == true)')`)
      .notNull(),
    reasons: jsonb('reasons').$type<StoredJson>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_handoff_stops_evaluation_uk').on(table.tenantId, table.intentId, table.evaluationSeq),
    check('communications_handoff_stops_evaluation_ck', sql`${table.evaluationSeq} > 0`),
    foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [messageIntents.tenantId, messageIntents.intentId],
      name: 'communications_handoff_stops_intent_fk',
    }).onDelete('restrict'),
    ...tenantRlsPolicies('intent_handoff_stops', table.tenantId),
  ],
);

/** A safe opaque identity text: no address, URL, token separator, markup or whitespace can be stored in it. */
const SAFE_IDENTITY_PATTERN = sql.raw("'^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'");
/** A closed, upper-case reason code of a link: a vocabulary of the lane that writes it, never free text. */
const REASON_CODE_PATTERN = sql.raw("'^[A-Z][A-Z0-9_]{0,79}$'");

/**
 * Provider Observation (#1402): one later, external fact about ONE delivery attempt, as step 22 reports or reconciles it.
 * It is the only place where truth that arrives AFTER the attempt's own answer is kept, and it is append-only: a later
 * observation never edits an earlier one and never edits the attempt. The attempt row keeps the submission answer
 * (accepted, rejected, unavailable, indeterminate); an observation can prove acceptance or non-acceptance after an unknown
 * answer, a delivery, or a failure after acceptance, each as its own row with its own time.
 *
 * The identity of an observation is (Tenant, attempt, provider, provider observation key): a repeated callback is the SAME row,
 * never a second effect. `observed_at` is the provider's own claim; `recorded_at` and `recorded_seq` are this owner's, so the
 * timeline order is explicit: (`observed_at`, `recorded_seq`). Written only by the scoped routine `ingest_provider_observation`,
 * which verifies the Tenant, intent and attempt binding and the provider identity; the runtime role can only read it.
 *
 * `evidence` is a closed, minimal document (kind, basis, failure class): never a provider payload, a recipient address,
 * markup or a secret. The key columns are pattern-checked so they cannot hold an address or a URL either.
 */
export const providerObservations = communicationsSchema.table.withRLS(
  'provider_observations',
  {
    attemptId: uuid('attempt_id').notNull(),
    evidence: jsonb('evidence').$type<StoredJson>().notNull(),
    intentId: uuid('intent_id').notNull(),
    kind: text('kind')
      .$type<'ACCEPTANCE_PROVEN' | 'DELIVERY_FAILED' | 'DELIVERY_PROVEN' | 'NON_ACCEPTANCE_PROVEN'>()
      .notNull(),
    observationId: uuid('observation_id').primaryKey(),
    observationKey: text('observation_key').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    providerKey: text('provider_key').notNull(),
    providerRef: text('provider_ref'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    recordedSeq: bigint('recorded_seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_observations_tenant_identity_uk').on(table.tenantId, table.observationId),
    unique('communications_observations_provider_identity_uk').on(
      table.tenantId,
      table.attemptId,
      table.providerKey,
      table.observationKey,
    ),
    unique('communications_observations_seq_uk').on(table.recordedSeq),
    foreignKey({
      columns: [table.tenantId, table.intentId, table.attemptId],
      foreignColumns: [deliveryAttempts.tenantId, deliveryAttempts.intentId, deliveryAttempts.attemptId],
      name: 'communications_observations_attempt_fk',
    }).onDelete('restrict'),
    index('communications_observations_intent_idx').on(table.tenantId, table.intentId),
    check(
      'communications_observations_kind_ck',
      sql`${table.kind} in ('ACCEPTANCE_PROVEN', 'DELIVERY_FAILED', 'DELIVERY_PROVEN', 'NON_ACCEPTANCE_PROVEN')`,
    ),
    check(
      'communications_observations_keys_ck',
      sql`${table.observationKey} ~ ${SAFE_IDENTITY_PATTERN} and ${table.providerKey} ~ ${SAFE_IDENTITY_PATTERN} and (${table.providerRef} is null or ${table.providerRef} ~ ${SAFE_IDENTITY_PATTERN})`,
    ),
    // the evidence is closed: only these keys, the kind it states is the row's kind, and the basis fits the kind
    check(
      'communications_observations_evidence_ck',
      sql`jsonb_typeof(${table.evidence}) = 'object' and (${table.evidence} - array['basis', 'failureClass', 'kind']) = '{}'::jsonb and ${table.evidence} ->> 'kind' = ${table.kind} and (${table.evidence} ->> 'basis') in ('PROVIDER_EVENT', 'RECONCILIATION') and ((${table.kind} = 'DELIVERY_FAILED') = ((${table.evidence} ->> 'failureClass') is not null)) and (${table.kind} <> 'DELIVERY_FAILED' or (${table.evidence} ->> 'failureClass') in ('BOUNCED_PERMANENT', 'BOUNCED_TRANSIENT', 'DROPPED_BY_PROVIDER'))`,
    ),
    // a delivery claim and a failure after acceptance need a provider event; a proven non-acceptance needs a reconciliation
    check(
      'communications_observations_basis_ck',
      sql`(${table.kind} not in ('DELIVERY_PROVEN', 'DELIVERY_FAILED') or (${table.evidence} ->> 'basis') = 'PROVIDER_EVENT') and (${table.kind} <> 'NON_ACCEPTANCE_PROVEN' or (${table.evidence} ->> 'basis') = 'RECONCILIATION')`,
    ),
    ...tenantRlsPolicies('provider_observations', table.tenantId),
  ],
);

/**
 * Technical Retry link (#1402, H-09): a LATER attempt of the SAME intent follows an earlier one. An attempt carries no
 * recipient, language or template column, so a retry cannot change any pin: they live on the immutable intent. The link
 * records only why the earlier attempt no longer blocks the next (`basis_kind`) and a safe reason code. A retry after an
 * unknown effect names the observation that proved non-acceptance (`basis_observation_id`); nothing else may.
 *
 * Structure only: whether a retry is allowed is the recovery lane's (d21-10, #1403). Written only by the scoped routine
 * `worker_link_retry_attempt`, which checks the intent, the order and that the earlier attempt is finished.
 */
export const attemptRetryLinks = communicationsSchema.table.withRLS(
  'attempt_retry_links',
  {
    attemptId: uuid('attempt_id').primaryKey(),
    basisKind: text('basis_kind').$type<'PRIOR_NOT_ATTEMPTED' | 'RECONCILED_NON_ACCEPTANCE'>().notNull(),
    basisObservationId: uuid('basis_observation_id'),
    intentId: uuid('intent_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull(),
    previousAttemptId: uuid('previous_attempt_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.intentId, table.attemptId],
      foreignColumns: [deliveryAttempts.tenantId, deliveryAttempts.intentId, deliveryAttempts.attemptId],
      name: 'communications_retry_links_attempt_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.intentId, table.previousAttemptId],
      foreignColumns: [deliveryAttempts.tenantId, deliveryAttempts.intentId, deliveryAttempts.attemptId],
      name: 'communications_retry_links_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.basisObservationId],
      foreignColumns: [providerObservations.tenantId, providerObservations.observationId],
      name: 'communications_retry_links_basis_fk',
    }).onDelete('restrict'),
    index('communications_retry_links_previous_idx').on(table.tenantId, table.previousAttemptId),
    check('communications_retry_links_distinct_ck', sql`${table.attemptId} <> ${table.previousAttemptId}`),
    check('communications_retry_links_reason_ck', sql`${table.reasonCode} ~ ${REASON_CODE_PATTERN}`),
    check(
      'communications_retry_links_basis_ck',
      sql`(${table.basisKind} = 'PRIOR_NOT_ATTEMPTED' and ${table.basisObservationId} is null) or (${table.basisKind} = 'RECONCILED_NON_ACCEPTANCE' and ${table.basisObservationId} is not null)`,
    ),
    ...tenantRlsPolicies('attempt_retry_links', table.tenantId),
  ],
);

/**
 * Explicit Resend link (#1402, H-09): a NEW Message Intent, decided by a NEW Communication Request of the source owner,
 * linked to the original intent with a safe reason code. The row is readable both ways: `resend_intent_id` is unique, so a
 * resend names exactly one original, and an index on `original_intent_id` lists every resend of an original. Never an
 * implicit "resend succeeded": the resend has its own attempts and observations.
 *
 * Structure only (d21-10 decides when a resend is approved). A trigger refuses a resend inside the original's own request,
 * an intent that is its own ancestor, and any update or delete.
 */
export const intentResendLinks = communicationsSchema.table.withRLS(
  'intent_resend_links',
  {
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull(),
    originalIntentId: uuid('original_intent_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    resendIntentId: uuid('resend_intent_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('communications_resend_links_resend_uk').on(table.tenantId, table.resendIntentId),
    foreignKey({
      columns: [table.tenantId, table.originalIntentId],
      foreignColumns: [messageIntents.tenantId, messageIntents.intentId],
      name: 'communications_resend_links_original_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.resendIntentId],
      foreignColumns: [messageIntents.tenantId, messageIntents.intentId],
      name: 'communications_resend_links_resend_fk',
    }).onDelete('restrict'),
    index('communications_resend_links_original_idx').on(table.tenantId, table.originalIntentId),
    check('communications_resend_links_distinct_ck', sql`${table.originalIntentId} <> ${table.resendIntentId}`),
    check('communications_resend_links_reason_ck', sql`${table.reasonCode} ~ ${REASON_CODE_PATTERN}`),
    ...tenantRlsPolicies('intent_resend_links', table.tenantId),
  ],
);

/** Every owner table, so the verifier and the schema contract test reach each one through its typed reference. */
export const COMMUNICATIONS_TABLES = [
  gatewayAssertionRedemptions,
  templateTypes,
  templateRevisions,
  templateActivations,
  templateRevisionInvalidations,
  tenantLanguageModeVersions,
  communicationRequests,
  communicationRequestConflicts,
  communicationDecisions,
  messageIntents,
  deliveryAttempts,
  intentHandoffStops,
  providerObservations,
  attemptRetryLinks,
  intentResendLinks,
] as const;

export const COMMUNICATIONS_TABLE_INVENTORY = [
  'gateway_assertion_redemptions',
  'template_types',
  'template_revisions',
  'template_activations',
  'template_revision_invalidations',
  'tenant_language_mode_versions',
  'communication_requests',
  'communication_request_conflicts',
  'communication_decisions',
  'message_intents',
  'delivery_attempts',
  'intent_handoff_stops',
  'provider_observations',
  'attempt_retry_links',
  'intent_resend_links',
] as const;

/** Relational Queries v2 entry point for this owner. */
export const communicationsRelations = defineRelations({
  attemptRetryLinks,
  communicationDecisions,
  communicationRequestConflicts,
  communicationRequests,
  deliveryAttempts,
  gatewayAssertionRedemptions,
  intentHandoffStops,
  intentResendLinks,
  messageIntents,
  providerObservations,
  templateActivations,
  templateRevisionInvalidations,
  templateRevisions,
  templateTypes,
  tenantLanguageModeVersions,
});
