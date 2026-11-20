/**
 * Communications' OWN personal-data inventory (#1410, D21). It is a declaration in code, not a store: it names, per
 * category of data Communications is system of record for, what is actually persisted and where, the originating
 * business event a retention period would start from, and which Privacy facts the category still needs.
 *
 * NOTHING in this file is a legal value. Processing Purpose and Version, Processing Scope, Controller and role,
 * Retention Rule identity and version, business-start confirmation, Legal Hold applicability and the human disposition
 * owner are INPUT GATES (`RequiredInput`): each is ABSENT until the named owner supplies it, and an absent or
 * conflicting one is a recorded CONFIGURATION GAP (pending review). A gap is never RETAIN-forever, never DELETE-done
 * and never a default period. No retention number, legal basis, purpose id or controller is invented anywhere here.
 */

import { DateTime, Schema } from 'effect';

export const COMMUNICATIONS_OWNER_CAPABILITY = 'communications.core';

/** One category of Communications' own data (D21 scope item 1, a to g). */
export const INVENTORY_CATEGORY_IDS = [
  'REQUEST_DECISION_INTENT',
  'ORIGINAL_RECIPIENT_ENDPOINT',
  'TYPE_LANGUAGE_TEMPLATE_REVISION',
  'ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION',
  'TEMPORARY_RENDERED_CONTENT',
  'ATTACHMENT_LINK_REFERENCES',
  'PROVIDER_COPY_WORKING_COPY_PROTECTION',
] as const;
export type InventoryCategoryId = (typeof INVENTORY_CATEGORY_IDS)[number];

/** The party that has to supply a missing input or take over the open obligation. */
export const GATE_OWNERS = [
  'PRIVACY_OWNER',
  'PRODUCT_OWNER',
  'LEGAL',
  'PORTAL_AUTH_OWNER',
  'SOURCE_OWNER',
  'DOCUMENT_OWNER',
  'STEP_22_PROVIDER_OWNER',
  'DEPLOYMENT_OWNER',
] as const;
export type GateOwner = (typeof GATE_OWNERS)[number];

/** The Privacy facts a category cannot be retained, exported or disposed of without. */
export const REQUIRED_INPUT_KEYS = [
  'PROCESSING_PURPOSE_VERSION',
  'PROCESSING_SCOPE',
  'DATA_CATEGORIES',
  'CONTROLLER_AND_ROLE',
  'RETENTION_RULE_IDENTITY_VERSION',
  'BUSINESS_START_EVENT_CONFIRMATION',
  'LEGAL_HOLD_APPLICABILITY',
  'HUMAN_DISPOSITION_OWNER',
] as const;
export type RequiredInputKey = (typeof REQUIRED_INPUT_KEYS)[number];

/** Which owner has to supply which input. Fixed here so the evidence names the owner without inventing a default. */
export const INPUT_OWNER: Readonly<Record<RequiredInputKey, GateOwner>> = Object.freeze({
  BUSINESS_START_EVENT_CONFIRMATION: 'PRIVACY_OWNER',
  CONTROLLER_AND_ROLE: 'PRIVACY_OWNER',
  DATA_CATEGORIES: 'PRIVACY_OWNER',
  HUMAN_DISPOSITION_OWNER: 'PRODUCT_OWNER',
  LEGAL_HOLD_APPLICABILITY: 'LEGAL',
  PROCESSING_PURPOSE_VERSION: 'PRIVACY_OWNER',
  PROCESSING_SCOPE: 'PRIVACY_OWNER',
  RETENTION_RULE_IDENTITY_VERSION: 'PRIVACY_OWNER',
});

export const PersonalDataKindSchema = Schema.Literals([
  'CONTACT_REFERENCE_AND_MASK',
  'PROVIDER_CORRELATION',
  'STAFF_ACTOR_PRINCIPAL',
  'SUBJECT_REFERENCE',
  'TIMING_FACT',
]);
export type PersonalDataKind = typeof PersonalDataKindSchema.Type;

/** Content that, by the product owner's decision (1A, 2A, #1402), is NEVER kept in this category. */
export const ExcludedContentSchema = Schema.Literals([
  'ATTACHMENT_BYTES',
  'AUTH_SECRET_OR_PROOF',
  'FULL_PERSONALIZED_BODY',
  'PROVIDER_PAYLOAD',
  'RAW_ENDPOINT_ADDRESS',
  'RENDERED_CONTENT',
]);
export type ExcludedContent = typeof ExcludedContentSchema.Type;

/** Where the data physically lives. `NONE` means the owner persists nothing of this kind (and a guard test proves it). */
export const CopyKindSchema = Schema.Literals([
  'EXTERNAL_PROVIDER_COPY',
  'LOCAL_REFERENCE_ONLY',
  'LOCAL_SYSTEM_OF_RECORD',
  'NONE_PERSISTED',
  'PLATFORM_BACKUP',
]);
export type CopyKind = typeof CopyKindSchema.Type;

export interface StoredColumns {
  readonly columns: readonly string[];
  readonly table: string;
}

/** The originating business event of a category. It is an immutable column of an append-only or immutable row. */
export interface BusinessStartEvent {
  readonly column: string;
  readonly event: string;
  readonly table: string;
}

export interface InventoryCategory {
  readonly businessStart: BusinessStartEvent | null;
  readonly copyKind: CopyKind;
  readonly excludedContent: readonly ExcludedContent[];
  readonly id: InventoryCategoryId;
  readonly ownerCapability: typeof COMMUNICATIONS_OWNER_CAPABILITY;
  readonly personalDataKinds: readonly PersonalDataKind[];
  /** Stable Privacy `recordContentScope` key of the category. */
  readonly recordContentScope: string;
  readonly storage: readonly StoredColumns[];
}

const ownerStore = (table: string, ...columns: readonly string[]): StoredColumns => ({ columns, table });

/**
 * The seven categories, from what the owner tables actually persist (the schema contract test proves every table and
 * column named here exists, and that no owner table is left unclassified).
 */
const categoriesById = {
  ATTACHMENT_LINK_REFERENCES: {
    // No attachment or link reference column exists today. The per-type link or attachment policy (2A) and its document
    // owner are an input gate; a column added later must be declared here first (the guard test proves it).
    businessStart: null,
    copyKind: 'NONE_PERSISTED',
    excludedContent: ['ATTACHMENT_BYTES', 'AUTH_SECRET_OR_PROOF'],
    ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
    personalDataKinds: [],
    recordContentScope: 'communications.attachment-link-references',
    storage: [],
  },
  ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION: {
    businessStart: { column: 'prepared_at', event: 'DELIVERY_ATTEMPT_PREPARED', table: 'delivery_attempts' },
    copyKind: 'LOCAL_SYSTEM_OF_RECORD',
    excludedContent: ['PROVIDER_PAYLOAD', 'RAW_ENDPOINT_ADDRESS', 'FULL_PERSONALIZED_BODY'],
    ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
    personalDataKinds: ['SUBJECT_REFERENCE', 'TIMING_FACT'],
    recordContentScope: 'communications.attempts-provider-observations-suppression',
    storage: [
      ownerStore('delivery_attempts', 'attempt_id', 'intent_id', 'state', 'evidence', 'prepared_at', 'finished_at'),
      ownerStore('intent_handoff_stops', 'intent_id', 'reasons', 'recorded_at'),
      ownerStore(
        'provider_observations',
        'observation_id',
        'intent_id',
        'attempt_id',
        'kind',
        'evidence',
        'recorded_at',
        'observed_at',
      ),
      ownerStore(
        'provider_observation_conflicts',
        'conflict_id',
        'content_fingerprint',
        'intent_id',
        'attempt_id',
        'observation_id',
        'kind',
        'recorded_at',
      ),
      ownerStore(
        'attempt_retry_links',
        'attempt_id',
        'previous_attempt_id',
        'basis_kind',
        'basis_observation_id',
        'intent_id',
        'reason_code',
        'linked_at',
      ),
      ownerStore('intent_resend_links', 'original_intent_id', 'resend_intent_id', 'reason_code', 'linked_at'),
    ],
  },
  ORIGINAL_RECIPIENT_ENDPOINT: {
    businessStart: { column: 'created_at', event: 'MESSAGE_INTENT_PINNED', table: 'message_intents' },
    copyKind: 'LOCAL_REFERENCE_ONLY',
    excludedContent: ['RAW_ENDPOINT_ADDRESS', 'AUTH_SECRET_OR_PROOF'],
    ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
    personalDataKinds: ['CONTACT_REFERENCE_AND_MASK', 'SUBJECT_REFERENCE'],
    recordContentScope: 'communications.original-recipient-endpoint',
    // references, evidence and an owner mask only: the pinned address is never stored
    storage: [ownerStore('message_intents', 'original_binding', 'endpoint_pin', 'handoff_pin')],
  },
  PROVIDER_COPY_WORKING_COPY_PROTECTION: {
    businessStart: { column: 'recorded_at', event: 'PROVIDER_OBSERVATION_RECORDED', table: 'provider_observations' },
    copyKind: 'EXTERNAL_PROVIDER_COPY',
    excludedContent: ['PROVIDER_PAYLOAD', 'FULL_PERSONALIZED_BODY'],
    ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
    personalDataKinds: ['PROVIDER_CORRELATION', 'TIMING_FACT'],
    recordContentScope: 'communications.provider-copy-working-copy-protection',
    // only the correlation of a copy a provider holds; the copy itself is the provider's, and backups are the platform's
    storage: [
      ownerStore('provider_observations', 'provider_key', 'provider_ref', 'observation_key'),
      ownerStore('provider_observation_conflicts', 'provider_key', 'observation_key', 'observed_at'),
    ],
  },
  REQUEST_DECISION_INTENT: {
    businessStart: { column: 'received_at', event: 'COMMUNICATION_REQUEST_RECEIVED', table: 'communication_requests' },
    copyKind: 'LOCAL_SYSTEM_OF_RECORD',
    excludedContent: ['FULL_PERSONALIZED_BODY', 'RAW_ENDPOINT_ADDRESS', 'AUTH_SECRET_OR_PROOF'],
    ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
    personalDataKinds: ['SUBJECT_REFERENCE', 'TIMING_FACT'],
    recordContentScope: 'communications.request-decision-intent',
    storage: [
      ownerStore(
        'communication_requests',
        'request_id',
        'identity_key',
        'source_module',
        'purpose',
        'payload',
        'received_at',
        // the source's occurrence identity, the trusted scope (Legal Entity, profile, Counterparty, Storefront references)
        // and the hash of the material meaning (which covers the recipients) all identify the subject's event indirectly
        'occurrence_id',
        'scope_key',
        'fingerprint',
      ),
      ownerStore('communication_request_conflicts', 'conflict_id', 'request_id', 'fingerprint', 'detected_at'),
      ownerStore(
        'communication_decisions',
        'decision_id',
        'request_id',
        'outcome',
        'type_id',
        'decided_at',
        // slots that could not be resolved name the recipient roles that stayed open
        'unresolved_slots',
      ),
      ownerStore(
        'message_intents',
        'intent_id',
        'request_id',
        'recipient_module',
        'recipient_type',
        'recipient_id',
        'recipient_role',
        'status',
        'purpose',
        'created_at',
        // the catalog candidate identity and slot are keyed per recipient; the Privacy scope pinned for the message names
        // the subject locator it was decided under
        'intent_key',
        'slot_key',
        'processing_scope',
      ),
    ],
  },
  TEMPORARY_RENDERED_CONTENT: {
    // The product owner decided (1A, #1402) that NO rendered or personalized content is persisted. The category exists so
    // that the decision is explicit and a guard test fails if a column for it ever appears.
    businessStart: null,
    copyKind: 'NONE_PERSISTED',
    excludedContent: ['FULL_PERSONALIZED_BODY', 'RENDERED_CONTENT', 'AUTH_SECRET_OR_PROOF'],
    ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
    personalDataKinds: [],
    recordContentScope: 'communications.temporary-rendered-content',
    storage: [],
  },
  TYPE_LANGUAGE_TEMPLATE_REVISION: {
    businessStart: { column: 'created_at', event: 'MESSAGE_INTENT_PINNED', table: 'message_intents' },
    copyKind: 'LOCAL_SYSTEM_OF_RECORD',
    excludedContent: ['FULL_PERSONALIZED_BODY', 'RENDERED_CONTENT'],
    ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
    personalDataKinds: ['STAFF_ACTOR_PRINCIPAL', 'TIMING_FACT'],
    recordContentScope: 'communications.type-language-template-revision',
    storage: [
      ownerStore(
        'message_intents',
        'type_id',
        'type_revision',
        'language',
        'language_decision',
        'template_revision_id',
        'template_revision_number',
        'tenant_mode',
        'policy_ref',
      ),
      ownerStore('template_types', 'template_type_id', 'created_by_principal_id', 'created_at'),
      // `reason` columns are free text written by a staff actor: they may name a person, so they are staff-attributed data
      ownerStore('template_revisions', 'revision_id', 'created_by_principal_id', 'created_at', 'reason'),
      ownerStore(
        'template_activations',
        'activation_id',
        'activated_by_principal_id',
        'ended_by_principal_id',
        'activated_at',
        'ended_at',
        'activation_reason',
        'end_reason',
      ),
      ownerStore(
        'template_revision_invalidations',
        'invalidation_id',
        'invalidated_by_principal_id',
        'invalidated_at',
        'reason',
      ),
      ownerStore('tenant_language_mode_versions', 'policy_version_id', 'set_by_principal_id', 'set_at'),
    ],
  },
} as const satisfies Record<InventoryCategoryId, Omit<InventoryCategory, 'id'>>;

export const communicationsOwnDataInventory: readonly InventoryCategory[] = Object.freeze(
  INVENTORY_CATEGORY_IDS.map((id) => ({ id, ...categoriesById[id] })),
);

/** One category by id; total, because the declaration is keyed by every id. */
export const inventoryCategory = (id: InventoryCategoryId): InventoryCategory => ({ id, ...categoriesById[id] });

/**
 * Tables that hold no personal data of a Data Subject or a staff actor, with the reason. Every owner table is either in
 * a category above or here, so a table added by a later lane cannot silently stay out of the inventory.
 */
export const TABLES_WITHOUT_PERSONAL_DATA: Readonly<Record<string, string>> = Object.freeze({
  gateway_assertion_redemptions: 'REPLAY_IDENTITY_ONLY_NO_SUBJECT_OR_ACTOR',
});

/**
 * The owner scope part of a category IS its Privacy `recordContentScope`: the Processing Activity declares those keys per
 * data category, so Privacy asks for exactly the parts the activity says Communications holds, and an activity that leaves
 * a category out can never be answered as complete.
 */
export const scopePartRef = (id: InventoryCategoryId): string => inventoryCategory(id).recordContentScope;
export const scopePartRefs: readonly string[] = INVENTORY_CATEGORY_IDS.map(scopePartRef);

const categoryByScopeRef = new Map(INVENTORY_CATEGORY_IDS.map((id) => [scopePartRef(id), id] as const));
export const categoryOfScopeRef = (scopeRef: string): InventoryCategoryId | undefined =>
  categoryByScopeRef.get(scopeRef);

/* ------------------------------------------------------------------------------------------------ */
/* Input gates                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/** A reference to an approved Retention Rule, exactly as Privacy publishes it. Supplied, never defaulted. */
export interface SuppliedRetentionRule {
  readonly applicabilityDecisionRef: string;
  /**
   * The rule version applies to records whose ORIGINAL business start is at or after this instant (ISO). A new rule
   * version therefore never reaches back: an earlier record keeps the version that applied at its own start (PRIV-COM-15).
   * Absent means the version applies from the beginning.
   */
  readonly applicableStartFrom?: DateTime.Utc;
  readonly ruleRef: string;
  readonly ruleVersion: number;
}

/** What Privacy (and the owners named in `INPUT_OWNER`) supply for one category. Every field is a reference. */
export interface SuppliedCategoryPrivacyReference {
  readonly businessStartConfirmationRef?: string;
  readonly controllerRef?: string;
  readonly controllerRole?: 'CONTROLLER' | 'JOINT_CONTROLLER' | 'PROCESSOR';
  readonly dataCategoryRefs?: readonly string[];
  readonly humanDispositionOwnerRef?: string;
  /** A Legal Hold applicability decision, or an explicit statement that none applies, both by reference. */
  readonly legalHoldApplicabilityRef?: string;
  readonly processingScopeRef?: string;
  readonly purposeRef?: string;
  readonly purposeVersion?: number;
  readonly retentionRules?: readonly SuppliedRetentionRule[];
}

export type SuppliedPrivacyReferences = Readonly<
  Partial<Record<InventoryCategoryId, SuppliedCategoryPrivacyReference>>
>;

/** No category has a supplied Privacy reference today: every input is an open gate. */
export const noSuppliedPrivacyReferences: SuppliedPrivacyReferences = Object.freeze({});

export interface MissingInput {
  readonly input: RequiredInputKey;
  readonly owner: GateOwner;
}

/**
 * Closed outcome of one category's configuration. There is deliberately no state that means "retain forever", "delete
 * done" or "default period": a category without a complete approved reference is pending review.
 */
export type CategoryConfiguration =
  | { readonly gaps: readonly MissingInput[]; readonly state: 'CONFIGURATION_GAP' }
  | { readonly conflictingRuleRefs: readonly string[]; readonly state: 'CONFLICTING_CONFIGURATION' }
  | { readonly rule: SuppliedRetentionRule; readonly state: 'CONFIGURED' }
  | { readonly reason: 'NO_PERSONAL_DATA_PERSISTED'; readonly state: 'NOT_APPLICABLE' };

const present = (value: string | undefined): boolean => value !== undefined && value.trim().length > 0;

const missingInputsOf = (supplied: SuppliedCategoryPrivacyReference | undefined): readonly MissingInput[] => {
  const provided = {
    BUSINESS_START_EVENT_CONFIRMATION: present(supplied?.businessStartConfirmationRef),
    CONTROLLER_AND_ROLE: present(supplied?.controllerRef) && supplied?.controllerRole !== undefined,
    DATA_CATEGORIES: (supplied?.dataCategoryRefs?.length ?? 0) > 0,
    HUMAN_DISPOSITION_OWNER: present(supplied?.humanDispositionOwnerRef),
    LEGAL_HOLD_APPLICABILITY: present(supplied?.legalHoldApplicabilityRef),
    PROCESSING_PURPOSE_VERSION: present(supplied?.purposeRef) && (supplied?.purposeVersion ?? 0) >= 1,
    PROCESSING_SCOPE: present(supplied?.processingScopeRef),
    RETENTION_RULE_IDENTITY_VERSION: (supplied?.retentionRules?.length ?? 0) > 0,
  } satisfies Record<RequiredInputKey, boolean>;
  const missing: MissingInput[] = [];
  for (const input of REQUIRED_INPUT_KEYS) {
    if (!provided[input]) {
      missing.push({ input, owner: INPUT_OWNER[input] });
    }
  }
  return missing;
};

const ruleKey = ({ ruleRef, ruleVersion }: SuppliedRetentionRule): string => `${ruleRef}@${ruleVersion}`;

/** The instant a rule version starts applying; a version without one applies from the beginning of time. */
const startOf = (rule: SuppliedRetentionRule): number =>
  rule.applicableStartFrom === undefined ? Number.NEGATIVE_INFINITY : DateTime.toEpochMillis(rule.applicableStartFrom);

/** The rules that start applying at the same instant: more than one distinct identity or version is a conflict. */
const conflictingRuleKeys = (rules: readonly SuppliedRetentionRule[]): readonly string[] => {
  const byStart = new Map<number, Set<string>>();
  for (const rule of rules) {
    byStart.set(startOf(rule), (byStart.get(startOf(rule)) ?? new Set<string>()).add(ruleKey(rule)));
  }
  const conflicting: string[] = [];
  for (const keys of byStart.values()) {
    if (keys.size > 1) {
      conflicting.push(...keys);
    }
  }
  return conflicting;
};

/**
 * The one rule version that applied to a record with the given ORIGINAL business start: the latest version whose
 * `applicableStartFrom` is not after that start. A later version never applies to an earlier record, and a start before
 * every version has no rule (a gap), never a default.
 */
export const ruleApplicableAt = (
  rules: readonly SuppliedRetentionRule[],
  businessStartAt: DateTime.Utc,
): SuppliedRetentionRule | undefined =>
  rules
    .filter((rule) => startOf(rule) <= DateTime.toEpochMillis(businessStartAt))
    .toSorted((left, right) => startOf(right) - startOf(left))[0];

/**
 * Configuration state of one category. Two different approved rules (identity or version) that start applying at the
 * same instant are a CONFLICT, not a choice: the owner decides which applies. A new rule VERSION that applies from a later
 * start never rewrites an earlier applicability, so it is not a conflict.
 */
export const assessCategoryConfiguration = (
  category: InventoryCategory,
  supplied?: SuppliedCategoryPrivacyReference,
): CategoryConfiguration => {
  if (category.copyKind === 'NONE_PERSISTED') {
    return { reason: 'NO_PERSONAL_DATA_PERSISTED', state: 'NOT_APPLICABLE' };
  }
  const rules = supplied?.retentionRules ?? [];
  const conflicts = conflictingRuleKeys(rules);
  if (conflicts.length > 0) {
    return { conflictingRuleRefs: [...new Set(conflicts)].toSorted(), state: 'CONFLICTING_CONFIGURATION' };
  }
  const gaps = missingInputsOf(supplied);
  const [rule] = rules.toSorted((left, right) => startOf(left) - startOf(right));
  if (gaps.length > 0 || rule === undefined) {
    return { gaps, state: 'CONFIGURATION_GAP' };
  }
  return { rule, state: 'CONFIGURED' };
};

/* ------------------------------------------------------------------------------------------------ */
/* Auth message types (verify-email, reset, OTP)                                                    */
/* ------------------------------------------------------------------------------------------------ */

/**
 * #1410 (comment, J): "a complete approved set of values for all three Auth types is not evidenced; the evidence must
 * name which owner supplies each missing input or takes over the open obligation". These records ARE that evidence. The
 * Auth types are not in the approved catalog yet (it approves no type; d21-12 activates them), so each one names its
 * owners for the inputs that are not Communications' to invent. Secrets and proofs stay with Portal Auth and #326.
 */
export const AUTH_MESSAGE_KINDS = ['VERIFY_EMAIL', 'RESET_PASSWORD', 'ONE_TIME_PASSWORD'] as const;
export type AuthMessageKind = (typeof AUTH_MESSAGE_KINDS)[number];

export interface AuthTypeEvidence {
  readonly kind: AuthMessageKind;
  /** The catalog type id is the Portal Auth owner's to approve (d21-12); none is invented here. */
  readonly missingInputs: readonly (MissingInput & { readonly note: string })[];
  readonly secretOwner: 'PORTAL_AUTH_OWNER';
}

const authInputs = (kind: AuthMessageKind): AuthTypeEvidence['missingInputs'] => [
  ...REQUIRED_INPUT_KEYS.map((input) => ({
    input,
    note: `${kind}: ${input} is not evidenced for this Auth type`,
    owner: INPUT_OWNER[input],
  })),
  {
    input: 'PROCESSING_PURPOSE_VERSION',
    note: `${kind}: the approved catalog type id and the pre-verification subject binding path`,
    owner: 'PORTAL_AUTH_OWNER',
  },
];

export const authTypeEvidence: readonly AuthTypeEvidence[] = Object.freeze(
  AUTH_MESSAGE_KINDS.map((kind): AuthTypeEvidence => ({
    kind,
    missingInputs: authInputs(kind),
    secretOwner: 'PORTAL_AUTH_OWNER',
  })),
);

/**
 * Why a column that no category lists holds no personal data. Every column of every owner table is either stored by a
 * category above or named here with one of these reasons, so a column added later (or one that was never classified) cannot
 * pass unnoticed. A column that may carry a subject reference, a staff actor, free text a person wrote or a time of their
 * event is NOT technical: it belongs to a category.
 */
export const TECHNICAL_COLUMN_REASONS = {
  ACTION_INVOCATION_CORRELATION:
    'Opaque id of the Action invocation that wrote the row: correlation only, no subject or actor.',
  APPROVED_TEMPLATE_TEXT:
    'Approved template text with placeholders (1A): never personalized content, written once per revision.',
  CLOSED_VOCABULARY_CODE:
    'A value of a closed owner vocabulary (a code, a mode, a state flag): no free text, no subject.',
  OPAQUE_ROW_LINK:
    'Opaque identity or foreign-key link between owner rows (the linked row carries the data and is classified).',
  ORDERING_OR_COUNTER: 'A counter or ordering number of the owner: no subject or actor.',
  ORGANIZATION_SCOPE_REFERENCE:
    'Reference to the organizational scope (Legal Entity or scope key) of a template: not a Data Subject.',
  TEMPLATE_TYPE_IDENTITY:
    'Identity of a Template Type (message type, channel, language): configuration, not personal data.',
  TENANT_PARTITION_KEY: 'The Tenant partition key of every owner row.',
} as const;
export type TechnicalColumnReason = keyof typeof TECHNICAL_COLUMN_REASONS;

const TENANT = { tenant_id: 'TENANT_PARTITION_KEY' } as const;
const INVOCATION = { action_invocation_id: 'ACTION_INVOCATION_CORRELATION' } as const;

export const TECHNICAL_COLUMNS: Readonly<Record<string, Readonly<Record<string, TechnicalColumnReason>>>> =
  Object.freeze({
    attempt_retry_links: { ...TENANT },
    communication_decisions: {
      ...TENANT,
      language_policy: 'CLOSED_VOCABULARY_CODE',
      no_message_reason: 'CLOSED_VOCABULARY_CODE',
      requiredness: 'CLOSED_VOCABULARY_CODE',
      rule_key: 'CLOSED_VOCABULARY_CODE',
      type_revision: 'ORDERING_OR_COUNTER',
    },
    communication_request_conflicts: { ...TENANT, ...INVOCATION },
    communication_requests: { ...TENANT, ...INVOCATION, occurrence_revision: 'ORDERING_OR_COUNTER' },
    delivery_attempts: { ...TENANT, attempt_number: 'ORDERING_OR_COUNTER' },
    intent_handoff_stops: { ...TENANT, evaluation_seq: 'ORDERING_OR_COUNTER', proven: 'CLOSED_VOCABULARY_CODE' },
    intent_resend_links: { ...TENANT },
    message_intents: { ...TENANT, decision_id: 'OPAQUE_ROW_LINK', reason: 'CLOSED_VOCABULARY_CODE' },
    provider_observation_conflicts: { ...TENANT, recorded_seq: 'ORDERING_OR_COUNTER' },
    provider_observations: { ...TENANT, recorded_seq: 'ORDERING_OR_COUNTER' },
    template_activations: {
      ...TENANT,
      activation_invocation_id: 'ACTION_INVOCATION_CORRELATION',
      end_invocation_id: 'ACTION_INVOCATION_CORRELATION',
      ended_kind: 'CLOSED_VOCABULARY_CODE',
      legal_entity_id: 'ORGANIZATION_SCOPE_REFERENCE',
      revision_id: 'OPAQUE_ROW_LINK',
      scope_key: 'ORGANIZATION_SCOPE_REFERENCE',
      template_type_id: 'OPAQUE_ROW_LINK',
    },
    template_revision_invalidations: { ...TENANT, ...INVOCATION, revision_id: 'OPAQUE_ROW_LINK' },
    template_revisions: {
      ...TENANT,
      ...INVOCATION,
      body: 'APPROVED_TEMPLATE_TEXT',
      content_digest: 'APPROVED_TEMPLATE_TEXT',
      optional_placeholders: 'APPROVED_TEMPLATE_TEXT',
      placeholders_used: 'APPROVED_TEMPLATE_TEXT',
      required_placeholders: 'APPROVED_TEMPLATE_TEXT',
      revision_number: 'ORDERING_OR_COUNTER',
      subject: 'APPROVED_TEMPLATE_TEXT',
      template_type_id: 'OPAQUE_ROW_LINK',
    },
    template_types: {
      ...TENANT,
      ...INVOCATION,
      channel: 'TEMPLATE_TYPE_IDENTITY',
      language: 'TEMPLATE_TYPE_IDENTITY',
      legal_entity_id: 'ORGANIZATION_SCOPE_REFERENCE',
      message_type: 'TEMPLATE_TYPE_IDENTITY',
      scope_key: 'ORGANIZATION_SCOPE_REFERENCE',
      scope_kind: 'ORGANIZATION_SCOPE_REFERENCE',
    },
    tenant_language_mode_versions: {
      ...TENANT,
      ...INVOCATION,
      mode: 'CLOSED_VOCABULARY_CODE',
      version_number: 'ORDERING_OR_COUNTER',
    },
  });
