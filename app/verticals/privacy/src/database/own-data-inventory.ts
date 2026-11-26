/**
 * Privacy's OWN personal-data inventory (#1406). It is a declaration in code, not a store: per category of data Privacy is
 * system of record for, it names what is persisted and where, the candidate originating event a retention period would
 * start from, and the retention inputs that are still open.
 *
 * NOTHING in this file is a legal value. Retention is an explicit CONFIGURATION GAP pending the Privacy owner: no period,
 * legal basis, purpose, controller or disposition owner is chosen here, and a gap is never RETAIN-forever, never
 * DELETE-done and never a default period.
 */
import { Schema } from 'effect';

import type { PRIVACY_TABLE_INVENTORY } from './schema.ts';

type PrivacyTable = (typeof PRIVACY_TABLE_INVENTORY)[number];

export const PRIVACY_OWN_DATA_CATEGORY_IDS = ['PRE_VERIFICATION_SUBJECT_BINDING'] as const;
type PrivacyOwnDataCategoryId = (typeof PRIVACY_OWN_DATA_CATEGORY_IDS)[number];

/** The facts a category cannot be retained or disposed of without. Each one is supplied by its owner, never defaulted. */
export const RETENTION_INPUT_KEYS = [
  'PROCESSING_PURPOSE_VERSION',
  'PROCESSING_SCOPE',
  'DATA_CATEGORIES',
  'CONTROLLER_AND_ROLE',
  'RETENTION_RULE_IDENTITY_VERSION',
  'BUSINESS_START_EVENT_CONFIRMATION',
  'LEGAL_HOLD_APPLICABILITY',
  'HUMAN_DISPOSITION_OWNER',
] as const;
type RetentionInputKey = (typeof RETENTION_INPUT_KEYS)[number];

const PersonalDataKindSchema = Schema.Literals(['STAFF_ACTOR_PRINCIPAL', 'SUBJECT_REFERENCE', 'TIMING_FACT']);
type PersonalDataKind = typeof PersonalDataKindSchema.Type;

/** Content that is never kept in the category: no field for it exists anywhere in its contract or table. */
const ExcludedContentSchema = Schema.Literals(['AUTH_SECRET_OR_PROOF', 'ENDPOINT_ADDRESS']);
type ExcludedContent = typeof ExcludedContentSchema.Type;

interface StoredColumns {
  readonly columns: readonly string[];
  readonly table: PrivacyTable;
}

/** The column whose row creation is the candidate start of retention. Confirming it is itself an open input. */
interface BusinessStartCandidate {
  readonly column: string;
  readonly event: string;
  readonly table: PrivacyTable;
}

/** The only state a category has today: no approved retention reference exists, so every input is pending its owner. */
interface RetentionConfigurationGap {
  readonly owner: 'PRIVACY_OWNER';
  readonly pendingInputs: readonly RetentionInputKey[];
  readonly state: 'CONFIGURATION_GAP';
}

interface PrivacyOwnDataCategory {
  readonly businessStartCandidate: BusinessStartCandidate;
  readonly excludedContent: readonly ExcludedContent[];
  readonly id: PrivacyOwnDataCategoryId;
  readonly personalDataKinds: readonly PersonalDataKind[];
  /** Stable Privacy `recordContentScope` key of the category. */
  readonly recordContentScope: string;
  readonly retention: RetentionConfigurationGap;
  readonly storage: readonly StoredColumns[];
}

const pendingPrivacyOwner: RetentionConfigurationGap = Object.freeze({
  owner: 'PRIVACY_OWNER',
  pendingInputs: RETENTION_INPUT_KEYS,
  state: 'CONFIGURATION_GAP',
});

const categoriesById = {
  PRE_VERIFICATION_SUBJECT_BINDING: {
    // A source owner bound the subject before it verified the person's address (#1406 D.8). The binding id is the Privacy
    // subject identity, the source key and record name the source owner's own account reference, and a withdrawal names
    // the staff principal who decided it. No address, token, link or code has a field anywhere.
    businessStartCandidate: {
      column: 'recorded_at',
      event: 'PRE_VERIFICATION_SUBJECT_BOUND',
      table: 'pre_verification_bindings',
    },
    excludedContent: ['ENDPOINT_ADDRESS', 'AUTH_SECRET_OR_PROOF'],
    personalDataKinds: ['SUBJECT_REFERENCE', 'STAFF_ACTOR_PRINCIPAL', 'TIMING_FACT'],
    recordContentScope: 'privacy.pre-verification-subject-binding',
    retention: pendingPrivacyOwner,
    storage: [
      {
        columns: ['binding_id', 'source_subject_key', 'binding_record', 'recorded_at', 'updated_at'],
        table: 'pre_verification_bindings',
      },
    ],
  },
} as const satisfies Record<PrivacyOwnDataCategoryId, Omit<PrivacyOwnDataCategory, 'id'>>;

export const privacyOwnDataInventory: readonly PrivacyOwnDataCategory[] = Object.freeze(
  PRIVACY_OWN_DATA_CATEGORY_IDS.map((id) => ({ id, ...categoriesById[id] })),
);

/** Why a column no category stores holds no personal data. */
export const TECHNICAL_COLUMN_REASONS = {
  CLOSED_VOCABULARY_CODE: 'A value of a closed Privacy vocabulary: no free text, no subject.',
  ORDERING_OR_COUNTER: 'A revision counter of the row: no subject or actor.',
  ORGANIZATION_SCOPE_REFERENCE: 'The Legal Entity the row is scoped to: an organization, not a Data Subject.',
  TENANT_PARTITION_KEY: 'The Tenant partition key of the row.',
} as const;
type TechnicalColumnReason = keyof typeof TECHNICAL_COLUMN_REASONS;

/** Every column of an inventoried table is stored by a category or named here, so a later column cannot pass unseen. */
export const TECHNICAL_COLUMNS: Readonly<
  Partial<Record<PrivacyTable, Readonly<Record<string, TechnicalColumnReason>>>>
> = Object.freeze({
  pre_verification_bindings: {
    legal_entity_id: 'ORGANIZATION_SCOPE_REFERENCE',
    revision: 'ORDERING_OR_COUNTER',
    status: 'CLOSED_VOCABULARY_CODE',
    tenant_id: 'TENANT_PARTITION_KEY',
  },
});

/**
 * Privacy tables that existed before this inventory and are NOT inventoried yet: an open inventory gap pending the Privacy
 * owner, never a statement that they hold no personal data. The list is closed: a table added later is inventoried above.
 */
export const TABLES_PREDATING_OWN_DATA_INVENTORY: readonly PrivacyTable[] = Object.freeze([
  'anti_resurrection_protections',
  'applicability_decisions',
  'applicability_policies',
  'consent_decisions',
  'consent_scope_bindings',
  'demo_source_processing_policies',
  'disposition_decisions',
  'dsr_cases',
  'dsr_deadlines',
  'dsr_delivery_access',
  'dsr_delivery_evidence',
  'dsr_owner_tasks',
  'dsr_resolver_assignments',
  'dsr_responses',
  'dsr_substantive_decisions',
  'dsr_verifications',
  'eligibility_evidence',
  'external_obligations',
  'gateway_assertion_redemptions',
  'legal_basis_assignments',
  'legal_holds',
  'notice_acknowledgements',
  'notice_provisions',
  'notice_versions',
  'owner_contributions',
  'owner_execution_outcomes',
  'privacy_measure_dispatches',
  'privacy_representations',
  'privacy_subjects',
  'processing_activities',
  'processing_activity_lifecycle_events',
  'processing_interventions',
  'processing_purposes',
  'purpose_versions',
  'responsibility_assignments',
  'retention_evaluation_work',
  'retention_exceptions',
  'retention_rules',
  'temporary_dsr_exports',
]);

/** The fields of the binding record (`binding_record`) and the personal data each one carries, if any. */
export const PRE_VERIFICATION_BINDING_RECORD_FIELDS: Readonly<
  Record<string, PersonalDataKind | TechnicalColumnReason>
> = Object.freeze({
  bindingRef: 'SUBJECT_REFERENCE',
  boundAt: 'TIMING_FACT',
  legalEntityId: 'ORGANIZATION_SCOPE_REFERENCE',
  revision: 'ORDERING_OR_COUNTER',
  source: 'SUBJECT_REFERENCE',
  status: 'CLOSED_VOCABULARY_CODE',
  tenantId: 'TENANT_PARTITION_KEY',
  updatedAt: 'TIMING_FACT',
  validUntil: 'TIMING_FACT',
  // the staff principal who withdrew the binding, the evidence reference of that decision and when it happened
  withdrawal: 'STAFF_ACTOR_PRINCIPAL',
});
