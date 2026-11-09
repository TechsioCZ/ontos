CREATE SCHEMA "payment";
--> statement-breakpoint
CREATE TABLE "payment"."economic_effect_attributions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"account_ref" text NOT NULL,
	"attributed_at" timestamp with time zone NOT NULL,
	"attribution_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"economic_effect_key" text NOT NULL,
	"environment" text NOT NULL,
	"fact_kind" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_system" text NOT NULL,
	CONSTRAINT "payment_economic_effect_attributions_effect_uk" UNIQUE("tenant_id","legal_entity_id","source_kind","source_system","account_ref","environment","fact_kind","economic_effect_key"),
	CONSTRAINT "payment_economic_effect_attributions_vocabulary_ck" CHECK ("fact_kind" in ('COLLECTION_PENDING', 'COLLECTION_CONFIRMED', 'COLLECTION_NOT_EFFECTED', 'CANCEL_CONFIRMED', 'CANCEL_NOT_EFFECTED', 'REFUND_PENDING', 'REFUND_CONFIRMED', 'REFUND_NOT_EFFECTED', 'SETTLEMENT_OBSERVED', 'SOURCE_CORRECTION', 'UNRECOGNIZED') and "source_kind" in ('BANK_ACCOUNTING', 'CARRIER', 'LOCAL_POS_OPERATOR', 'PAYMENT_GATEWAY', 'MANUAL_EXTERNAL_REFUND')),
	CONSTRAINT "payment_economic_effect_attributions_system_ck" CHECK ("source_system" = btrim("source_system") and length("source_system") between 1 and 200),
	CONSTRAINT "payment_economic_effect_attributions_account_ck" CHECK ("account_ref" = btrim("account_ref") and length("account_ref") between 1 and 200),
	CONSTRAINT "payment_economic_effect_attributions_environment_ck" CHECK ("environment" = btrim("environment") and length("environment") between 1 and 200),
	CONSTRAINT "payment_economic_effect_attributions_effect_ck" CHECK ("economic_effect_key" = btrim("economic_effect_key") and length("economic_effect_key") between 1 and 200),
	CONSTRAINT "payment_economic_effect_attributions_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."economic_effect_attributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateway_assertion_redemptions_identity_uk" UNIQUE("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "payment"."method_enablement_revisions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"method" text NOT NULL,
	"method_enablement_id" uuid NOT NULL,
	"method_enablement_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "payment_method_enablement_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","method_enablement_id","revision"),
	CONSTRAINT "payment_method_enablement_revisions_method_ck" CHECK ("method" in ('ONLINE_GATEWAY', 'BANK_TRANSFER_ADVANCE', 'CASH_ON_DELIVERY', 'DEFERRED_INVOICE', 'PAY_ON_PICKUP_OR_ON_SITE')),
	CONSTRAINT "payment_method_enablement_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "payment_method_enablement_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_method_enablement_revisions_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."method_enablement_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."method_enablements" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"configured_at" timestamp with time zone NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"method" text NOT NULL,
	"method_enablement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"reason" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "payment_method_enablements_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","method_enablement_id"),
	CONSTRAINT "payment_method_enablements_identity_uk" UNIQUE("tenant_id","legal_entity_id","customer_configuration_id","method"),
	CONSTRAINT "payment_method_enablements_method_ck" CHECK ("method" in ('ONLINE_GATEWAY', 'BANK_TRANSFER_ADVANCE', 'CASH_ON_DELIVERY', 'DEFERRED_INVOICE', 'PAY_ON_PICKUP_OR_ON_SITE')),
	CONSTRAINT "payment_method_enablements_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "payment_method_enablements_configuration_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 200),
	CONSTRAINT "payment_method_enablements_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_method_enablements_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."method_enablements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."observations" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"acceptance_outcome" text NOT NULL,
	"account_ref" text NOT NULL,
	"amount_minor" bigint,
	"capability_correlated" boolean,
	"correction_effect" text,
	"corrects_observation_id" uuid,
	"currency" text,
	"economic_effect_key" text,
	"environment" text NOT NULL,
	"evidence_ref" text,
	"fact_family" text NOT NULL,
	"fact_kind" text NOT NULL,
	"observation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"operation_id" uuid,
	"payment_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"source_authority_id" uuid,
	"source_authority_revision" integer,
	"source_kind" text NOT NULL,
	"source_occurred_at" timestamp with time zone,
	"source_occurrence_id" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_system" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_observations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","observation_id"),
	CONSTRAINT "payment_observations_occurrence_uk" UNIQUE("tenant_id","legal_entity_id","source_kind","source_system","account_ref","environment","source_occurrence_id","source_revision"),
	CONSTRAINT "payment_observations_correction_effect_ck" CHECK (("correction_effect" is not null) = ("fact_kind" = 'SOURCE_CORRECTION' and "acceptance_outcome" = 'ACCEPTED_OBSERVATION') and ("correction_effect" is null or "correction_effect" in ('RECORD_ONLY', 'REDUCE_ESTABLISHED_COLLECTION', 'REOPEN_TO_CONFLICT'))),
	CONSTRAINT "payment_observations_vocabulary_ck" CHECK ("acceptance_outcome" in ('ACCEPTED_OBSERVATION', 'DUPLICATE', 'HELD_UNRESOLVED', 'CONFLICT', 'UNAUTHORIZED_SOURCE', 'UNSUPPORTED_FACT') and "fact_kind" in ('COLLECTION_PENDING', 'COLLECTION_CONFIRMED', 'COLLECTION_NOT_EFFECTED', 'CANCEL_CONFIRMED', 'CANCEL_NOT_EFFECTED', 'REFUND_PENDING', 'REFUND_CONFIRMED', 'REFUND_NOT_EFFECTED', 'SETTLEMENT_OBSERVED', 'SOURCE_CORRECTION', 'UNRECOGNIZED') and "fact_family" in ('BANK_ACCOUNTING_RECEIPT', 'DEFERRED_INVOICE_RECEIPT', 'COD_CUSTOMER_COLLECTION', 'COD_REMITTANCE', 'LOCAL_POS_COLLECTION', 'GATEWAY_OUTCOME', 'REFUND_EXECUTION', 'SETTLEMENT_REMITTANCE') and "source_kind" in ('BANK_ACCOUNTING', 'CARRIER', 'LOCAL_POS_OPERATOR', 'PAYMENT_GATEWAY', 'MANUAL_EXTERNAL_REFUND')),
	CONSTRAINT "payment_observations_money_ck" CHECK (("amount_minor" is null) = ("currency" is null) and ("amount_minor" is null or ("amount_minor" between 0 and 9007199254740991 and "currency" = 'CZK'))),
	CONSTRAINT "payment_observations_capability_ck" CHECK ("capability_correlated" is null or ("payment_id" is not null and "source_kind" in ('CARRIER', 'LOCAL_POS_OPERATOR'))),
	CONSTRAINT "payment_observations_correlation_ck" CHECK (("operation_id" is null or "payment_id" is not null) and ("corrects_observation_id" is null or "corrects_observation_id" <> "observation_id")),
	CONSTRAINT "payment_observations_authority_ck" CHECK (("source_authority_id" is null) = ("source_authority_revision" is null) and ("source_authority_revision" is null or "source_authority_revision" > 0) and ("acceptance_outcome" = 'UNAUTHORIZED_SOURCE' or "source_authority_id" is not null)),
	CONSTRAINT "payment_observations_revision_ck" CHECK ("source_revision" between 0 and 9007199254740991),
	CONSTRAINT "payment_observations_times_ck" CHECK ("verified_at" >= "received_at"),
	CONSTRAINT "payment_observations_system_ck" CHECK ("source_system" = btrim("source_system") and length("source_system") between 1 and 200),
	CONSTRAINT "payment_observations_account_ck" CHECK ("account_ref" = btrim("account_ref") and length("account_ref") between 1 and 200),
	CONSTRAINT "payment_observations_environment_ck" CHECK ("environment" = btrim("environment") and length("environment") between 1 and 200),
	CONSTRAINT "payment_observations_occurrence_ck" CHECK ("source_occurrence_id" = btrim("source_occurrence_id") and length("source_occurrence_id") between 1 and 200),
	CONSTRAINT "payment_observations_refs_ck" CHECK (("economic_effect_key" is null or ("economic_effect_key" = btrim("economic_effect_key") and length("economic_effect_key") between 1 and 200)) and ("evidence_ref" is null or ("evidence_ref" = btrim("evidence_ref") and length("evidence_ref") between 1 and 200))),
	CONSTRAINT "payment_observations_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."operation_outcome_transitions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"cause_id" text,
	"cause_kind" text NOT NULL,
	"from_outcome" text,
	"operation_id" uuid NOT NULL,
	"outcome_revision" integer NOT NULL,
	"payment_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"to_outcome" text NOT NULL,
	"transition_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	CONSTRAINT "payment_outcome_transitions_revision_uk" UNIQUE("tenant_id","legal_entity_id","operation_id","outcome_revision"),
	CONSTRAINT "payment_outcome_transitions_cause_ck" CHECK ("cause_kind" in ('CREATION', 'OBSERVATION', 'RECONCILIATION', 'RECOVERY') and ("cause_kind" = 'CREATION') = ("from_outcome" is null) and ("cause_kind" = 'CREATION') = ("outcome_revision" = 1) and ("cause_id" is null or ("cause_id" = btrim("cause_id") and length("cause_id") between 1 and 200))),
	CONSTRAINT "payment_outcome_transitions_outcome_ck" CHECK ("to_outcome" in ('PENDING', 'EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'INDETERMINATE', 'CONFLICT') and ("from_outcome" is null or ("from_outcome" in ('PENDING', 'EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'INDETERMINATE', 'CONFLICT') and "from_outcome" <> "to_outcome"))),
	CONSTRAINT "payment_outcome_transitions_revision_ck" CHECK ("outcome_revision" > 0),
	CONSTRAINT "payment_outcome_transitions_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."operation_outcome_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."payment_authorizations" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"authorization_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"coverage_revision" integer,
	"currency" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuance_key" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"method_condition_evidence" jsonb,
	"order_commitment_attempt_id" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"payment_term_ref" jsonb NOT NULL,
	"proof_kind" text NOT NULL,
	"purchase_correlation_id" text NOT NULL,
	CONSTRAINT "payment_authorizations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","authorization_id"),
	CONSTRAINT "payment_authorizations_issuance_uk" UNIQUE("tenant_id","legal_entity_id","payment_id","order_commitment_attempt_id","issuance_key"),
	CONSTRAINT "payment_authorizations_proof_ck" CHECK ("proof_kind" in ('PREPAID_COVERAGE', 'METHOD_CONDITION') and ("proof_kind" <> 'PREPAID_COVERAGE' or ("coverage_revision" is not null and "coverage_revision" > 0)) and ("proof_kind" <> 'METHOD_CONDITION' or jsonb_typeof("method_condition_evidence") = 'object')),
	CONSTRAINT "payment_authorizations_amount_ck" CHECK ("amount_minor" between 0 and 9007199254740991 and "currency" = 'CZK'),
	CONSTRAINT "payment_authorizations_method_ck" CHECK ("method" in ('ONLINE_GATEWAY', 'BANK_TRANSFER_ADVANCE', 'CASH_ON_DELIVERY', 'DEFERRED_INVOICE', 'PAY_ON_PICKUP_OR_ON_SITE')),
	CONSTRAINT "payment_authorizations_validity_ck" CHECK ("expires_at" > "issued_at"),
	CONSTRAINT "payment_authorizations_issuance_key_ck" CHECK ("issuance_key" ~ '^[!-~]{1,200}$'),
	CONSTRAINT "payment_authorizations_attempt_ck" CHECK ("order_commitment_attempt_id" = btrim("order_commitment_attempt_id") and length("order_commitment_attempt_id") between 1 and 200),
	CONSTRAINT "payment_authorizations_purchase_ck" CHECK ("purchase_correlation_id" = btrim("purchase_correlation_id") and length("purchase_correlation_id") between 1 and 200),
	CONSTRAINT "payment_authorizations_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."payment_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."payment_operations" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"binding" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"kind" text NOT NULL,
	"material_hash" text NOT NULL,
	"material_request" jsonb NOT NULL,
	"operation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"operation_key" text NOT NULL,
	"outcome" text NOT NULL,
	"outcome_revision" integer NOT NULL,
	"payment_id" uuid NOT NULL,
	"refund_basis" jsonb,
	"refund_basis_kind" text,
	"refund_execution_route" jsonb,
	"target_operation_id" uuid,
	CONSTRAINT "payment_operations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","operation_id"),
	CONSTRAINT "payment_operations_payment_id_uk" UNIQUE("tenant_id","legal_entity_id","payment_id","operation_id"),
	CONSTRAINT "payment_operations_key_uk" UNIQUE("tenant_id","legal_entity_id","payment_id","operation_key"),
	CONSTRAINT "payment_operations_kind_ck" CHECK ("kind" in ('COLLECT', 'CANCEL_OR_VOID', 'REFUND')),
	CONSTRAINT "payment_operations_outcome_ck" CHECK ("outcome" in ('PENDING', 'EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'INDETERMINATE', 'CONFLICT')),
	CONSTRAINT "payment_operations_amount_ck" CHECK ("amount_minor" between 0 and 9007199254740991 and "currency" = 'CZK' and ("kind" = 'CANCEL_OR_VOID' or "amount_minor" > 0)),
	CONSTRAINT "payment_operations_target_ck" CHECK (("kind" = 'COLLECT') = ("target_operation_id" is null) and ("target_operation_id" is null or "target_operation_id" <> "operation_id")),
	CONSTRAINT "payment_operations_refund_basis_ck" CHECK ((("kind" = 'REFUND') = ("refund_basis_kind" is not null)) and (("refund_basis_kind" is null) = ("refund_basis" is null)) and ("refund_basis_kind" is null or ("refund_basis_kind" in ('REFUNDABLE_ITEMS', 'FAILED_COMMITMENT_COMPENSATION') and "refund_basis"->>'_tag' = "refund_basis_kind"))),
	CONSTRAINT "payment_operations_refund_route_ck" CHECK (("kind" = 'REFUND') = ("refund_execution_route" is not null) and ("refund_execution_route" is null or jsonb_typeof("refund_execution_route") = 'object')),
	CONSTRAINT "payment_operations_outcome_revision_ck" CHECK ("outcome_revision" > 0),
	CONSTRAINT "payment_operations_material_hash_ck" CHECK ("material_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payment_operations_key_ck" CHECK ("operation_key" ~ '^[!-~]{1,200}$'),
	CONSTRAINT "payment_operations_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."payment_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."payments" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"aggregate_version" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"coverage_revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"execution_binding" jsonb NOT NULL,
	"intent_key" text NOT NULL,
	"material_hash" text NOT NULL,
	"method" text NOT NULL,
	"payment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"payment_term_ref" jsonb NOT NULL,
	"predecessor_payment_id" uuid,
	"purchase_correlation_id" text NOT NULL,
	"purchasing_context" jsonb NOT NULL,
	"term_semantic_evidence" jsonb NOT NULL,
	CONSTRAINT "payment_payments_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","payment_id"),
	CONSTRAINT "payment_payments_intent_key_uk" UNIQUE("tenant_id","legal_entity_id","intent_key"),
	CONSTRAINT "payment_payments_amount_ck" CHECK ("amount_minor" between 0 and 9007199254740991 and "currency" = 'CZK'),
	CONSTRAINT "payment_payments_method_ck" CHECK ("method" in ('ONLINE_GATEWAY', 'BANK_TRANSFER_ADVANCE', 'CASH_ON_DELIVERY', 'DEFERRED_INVOICE', 'PAY_ON_PICKUP_OR_ON_SITE')),
	CONSTRAINT "payment_payments_revisions_ck" CHECK ("coverage_revision" > 0 and "aggregate_version" > 0),
	CONSTRAINT "payment_payments_predecessor_ck" CHECK ("predecessor_payment_id" is null or "predecessor_payment_id" <> "payment_id"),
	CONSTRAINT "payment_payments_material_hash_ck" CHECK ("material_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payment_payments_binding_ck" CHECK (jsonb_typeof("execution_binding") = 'object' and jsonb_typeof("payment_term_ref") = 'object' and jsonb_typeof("term_semantic_evidence") = 'object'),
	CONSTRAINT "payment_payments_purchase_ck" CHECK ("purchase_correlation_id" = btrim("purchase_correlation_id") and length("purchase_correlation_id") between 1 and 200),
	CONSTRAINT "payment_payments_purchasing_context_ck" CHECK (jsonb_typeof("purchasing_context") = 'object'),
	CONSTRAINT "payment_payments_configuration_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 200),
	CONSTRAINT "payment_payments_intent_key_ck" CHECK ("intent_key" ~ '^[!-~]{1,200}$'),
	CONSTRAINT "payment_payments_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."reconciliation_cases" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"case_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"case_kind" text NOT NULL,
	"closed_at" timestamp with time zone,
	"observation_id" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"operation_id" uuid,
	"payment_id" uuid,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "payment_reconciliation_cases_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","case_id"),
	CONSTRAINT "payment_reconciliation_cases_kind_ck" CHECK ("case_kind" in ('HELD_OBSERVATION', 'OPERATION_CONFLICT', 'AMBIGUOUS_FUNDS', 'UNRESOLVED_OPERATION') and "status" in ('OPEN', 'CLOSED')),
	CONSTRAINT "payment_reconciliation_cases_subject_ck" CHECK (("payment_id" is not null or "observation_id" is not null) and ("operation_id" is null or "payment_id" is not null)),
	CONSTRAINT "payment_reconciliation_cases_status_ck" CHECK (("status" = 'CLOSED') = ("closed_at" is not null) and "revision" > 0),
	CONSTRAINT "payment_reconciliation_cases_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."reconciliation_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."reconciliation_decisions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"case_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"decision_kind" text NOT NULL,
	"evidence_ref" text,
	"operation_id" uuid,
	"reason" text NOT NULL,
	"resulting_outcome" text,
	CONSTRAINT "payment_reconciliation_decisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","decision_id"),
	CONSTRAINT "payment_reconciliation_decisions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "payment_reconciliation_decisions_kind_ck" CHECK ("decision_kind" in ('ATTACH_EVIDENCE', 'CLASSIFY_CONFLICT', 'CLOSE_CASE') and ("resulting_outcome" is null or "resulting_outcome" in ('PENDING', 'EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'INDETERMINATE', 'CONFLICT'))),
	CONSTRAINT "payment_reconciliation_decisions_evidence_ck" CHECK ("evidence_ref" is null or ("evidence_ref" = btrim("evidence_ref") and length("evidence_ref") between 1 and 200)),
	CONSTRAINT "payment_reconciliation_decisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_reconciliation_decisions_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."reconciliation_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."recovery_requests" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"binding_snapshot" jsonb NOT NULL,
	"mode" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recovery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_recovery_requests_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","recovery_id"),
	CONSTRAINT "payment_recovery_requests_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "payment_recovery_requests_mode_ck" CHECK ("mode" in ('PROVIDER_IDEMPOTENT_REPLAY', 'AUTHORITATIVE_LOOKUP', 'AWAIT_QUALIFIED_EVIDENCE', 'GOVERNED_RECONCILIATION')),
	CONSTRAINT "payment_recovery_requests_binding_ck" CHECK (jsonb_typeof("binding_snapshot") = 'object'),
	CONSTRAINT "payment_recovery_requests_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_recovery_requests_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."recovery_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."refund_item_claims" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"active" boolean NOT NULL,
	"amount_minor" bigint NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"claim_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"currency" text NOT NULL,
	"item_ref" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_action_invocation_id" uuid,
	"source_evidence_ref" text NOT NULL,
	CONSTRAINT "payment_refund_item_claims_operation_item_uk" UNIQUE("tenant_id","legal_entity_id","operation_id","item_ref"),
	CONSTRAINT "payment_refund_item_claims_amount_ck" CHECK ("amount_minor" between 1 and 9007199254740991 and "currency" = 'CZK'),
	CONSTRAINT "payment_refund_item_claims_release_ck" CHECK ("active" = ("released_at" is null) and "active" = ("released_by_action_invocation_id" is null)),
	CONSTRAINT "payment_refund_item_claims_item_ck" CHECK ("item_ref" = btrim("item_ref") and length("item_ref") between 1 and 200),
	CONSTRAINT "payment_refund_item_claims_evidence_ck" CHECK ("source_evidence_ref" = btrim("source_evidence_ref") and length("source_evidence_ref") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "payment"."refund_item_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."source_authorities" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"account_ref" text NOT NULL,
	"configured_at" timestamp with time zone NOT NULL,
	"environment" text NOT NULL,
	"fact_family" text NOT NULL,
	"method" text,
	"reason" text NOT NULL,
	"refund_route" boolean NOT NULL,
	"revision" integer NOT NULL,
	"source_authority_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_kind" text NOT NULL,
	"source_system" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "payment_source_authorities_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","source_authority_id"),
	CONSTRAINT "payment_source_authorities_identity_uk" UNIQUE NULLS NOT DISTINCT("tenant_id","legal_entity_id","fact_family","method","source_kind","source_system","account_ref","environment"),
	CONSTRAINT "payment_source_authorities_family_ck" CHECK ("fact_family" in ('BANK_ACCOUNTING_RECEIPT', 'DEFERRED_INVOICE_RECEIPT', 'COD_CUSTOMER_COLLECTION', 'COD_REMITTANCE', 'LOCAL_POS_COLLECTION', 'GATEWAY_OUTCOME', 'REFUND_EXECUTION', 'SETTLEMENT_REMITTANCE')),
	CONSTRAINT "payment_source_authorities_method_ck" CHECK ("method" is null or "method" in ('ONLINE_GATEWAY', 'BANK_TRANSFER_ADVANCE', 'CASH_ON_DELIVERY', 'DEFERRED_INVOICE', 'PAY_ON_PICKUP_OR_ON_SITE')),
	CONSTRAINT "payment_source_authorities_kind_ck" CHECK ("source_kind" in ('BANK_ACCOUNTING', 'CARRIER', 'LOCAL_POS_OPERATOR', 'PAYMENT_GATEWAY', 'MANUAL_EXTERNAL_REFUND')),
	CONSTRAINT "payment_source_authorities_status_ck" CHECK ("status" in ('ACTIVE', 'REVOKED')),
	CONSTRAINT "payment_source_authorities_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "payment_source_authorities_system_ck" CHECK ("source_system" = btrim("source_system") and length("source_system") between 1 and 200),
	CONSTRAINT "payment_source_authorities_account_ck" CHECK ("account_ref" = btrim("account_ref") and length("account_ref") between 1 and 200),
	CONSTRAINT "payment_source_authorities_environment_ck" CHECK ("environment" = btrim("environment") and length("environment") between 1 and 200),
	CONSTRAINT "payment_source_authorities_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_source_authorities_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."source_authorities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."source_authority_revisions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"refund_route" boolean NOT NULL,
	"revision" integer NOT NULL,
	"source_authority_id" uuid NOT NULL,
	"source_authority_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"status" text NOT NULL,
	"submitter_principal_ids" uuid[] NOT NULL,
	CONSTRAINT "payment_source_authority_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","source_authority_id","revision"),
	CONSTRAINT "payment_source_authority_revisions_status_ck" CHECK ("status" in ('ACTIVE', 'REVOKED')),
	CONSTRAINT "payment_source_authority_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "payment_source_authority_revisions_submitters_ck" CHECK (cardinality("submitter_principal_ids") between 1 and 100 and array_ndims("submitter_principal_ids") = 1 and array_position("submitter_principal_ids", null) is null),
	CONSTRAINT "payment_source_authority_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_source_authority_revisions_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."source_authority_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "payment_gateway_assertion_redemptions_expiry_idx" ON "payment"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_observations_payment_idx" ON "payment"."observations" ("tenant_id","legal_entity_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_observations_effect_idx" ON "payment"."observations" ("tenant_id","legal_entity_id","operation_id","economic_effect_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_one_collect_lineage_uk" ON "payment"."payment_operations" ("tenant_id","legal_entity_id","payment_id") WHERE "kind" = 'COLLECT' and "outcome" <> 'NOT_EFFECTED_CONFIRMED';--> statement-breakpoint
CREATE INDEX "payment_operations_target_idx" ON "payment"."payment_operations" ("tenant_id","legal_entity_id","target_operation_id");--> statement-breakpoint
CREATE INDEX "payment_payments_purchase_idx" ON "payment"."payments" ("tenant_id","legal_entity_id","purchase_correlation_id");--> statement-breakpoint
CREATE INDEX "payment_reconciliation_cases_open_idx" ON "payment"."reconciliation_cases" ("tenant_id","legal_entity_id","status","payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refund_item_claims_active_item_uk" ON "payment"."refund_item_claims" ("tenant_id","legal_entity_id","payment_id","item_ref") WHERE "active";--> statement-breakpoint
ALTER TABLE "payment"."economic_effect_attributions" ADD CONSTRAINT "payment_economic_effect_attributions_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."method_enablement_revisions" ADD CONSTRAINT "payment_method_enablement_revisions_current_fk" FOREIGN KEY ("tenant_id","legal_entity_id","method_enablement_id") REFERENCES "payment"."method_enablements"("tenant_id","legal_entity_id","method_enablement_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."observations" ADD CONSTRAINT "payment_observations_authority_fk" FOREIGN KEY ("tenant_id","legal_entity_id","source_authority_id") REFERENCES "payment"."source_authorities"("tenant_id","legal_entity_id","source_authority_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."observations" ADD CONSTRAINT "payment_observations_payment_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id") REFERENCES "payment"."payments"("tenant_id","legal_entity_id","payment_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."observations" ADD CONSTRAINT "payment_observations_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."observations" ADD CONSTRAINT "payment_observations_corrects_fk" FOREIGN KEY ("tenant_id","legal_entity_id","corrects_observation_id") REFERENCES "payment"."observations"("tenant_id","legal_entity_id","observation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."operation_outcome_transitions" ADD CONSTRAINT "payment_outcome_transitions_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."payment_authorizations" ADD CONSTRAINT "payment_authorizations_payment_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id") REFERENCES "payment"."payments"("tenant_id","legal_entity_id","payment_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."payment_operations" ADD CONSTRAINT "payment_operations_payment_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id") REFERENCES "payment"."payments"("tenant_id","legal_entity_id","payment_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."payment_operations" ADD CONSTRAINT "payment_operations_target_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","target_operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."payments" ADD CONSTRAINT "payment_payments_predecessor_fk" FOREIGN KEY ("tenant_id","legal_entity_id","predecessor_payment_id") REFERENCES "payment"."payments"("tenant_id","legal_entity_id","payment_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_payment_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id") REFERENCES "payment"."payments"("tenant_id","legal_entity_id","payment_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_observation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","observation_id") REFERENCES "payment"."observations"("tenant_id","legal_entity_id","observation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."reconciliation_decisions" ADD CONSTRAINT "payment_reconciliation_decisions_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","case_id") REFERENCES "payment"."reconciliation_cases"("tenant_id","legal_entity_id","case_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."recovery_requests" ADD CONSTRAINT "payment_recovery_requests_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."refund_item_claims" ADD CONSTRAINT "payment_refund_item_claims_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."source_authority_revisions" ADD CONSTRAINT "payment_source_authority_revisions_current_fk" FOREIGN KEY ("tenant_id","legal_entity_id","source_authority_id") REFERENCES "payment"."source_authorities"("tenant_id","legal_entity_id","source_authority_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "payment_economic_effect_attributions_select" ON "payment"."economic_effect_attributions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."economic_effect_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."economic_effect_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_economic_effect_attributions_insert" ON "payment"."economic_effect_attributions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."economic_effect_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."economic_effect_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_economic_effect_attributions_update" ON "payment"."economic_effect_attributions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."economic_effect_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."economic_effect_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."economic_effect_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."economic_effect_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_economic_effect_attributions_delete" ON "payment"."economic_effect_attributions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."economic_effect_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."economic_effect_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablement_revisions_select" ON "payment"."method_enablement_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."method_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablement_revisions_insert" ON "payment"."method_enablement_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."method_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablement_revisions_update" ON "payment"."method_enablement_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."method_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."method_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablement_revisions_delete" ON "payment"."method_enablement_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."method_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablements_select" ON "payment"."method_enablements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."method_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablements_insert" ON "payment"."method_enablements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."method_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablements_update" ON "payment"."method_enablements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."method_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."method_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_method_enablements_delete" ON "payment"."method_enablements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."method_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."method_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_observations_select" ON "payment"."observations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_observations_insert" ON "payment"."observations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_observations_update" ON "payment"."observations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_observations_delete" ON "payment"."observations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."observations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."observations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_outcome_transitions_select" ON "payment"."operation_outcome_transitions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."operation_outcome_transitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."operation_outcome_transitions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_outcome_transitions_insert" ON "payment"."operation_outcome_transitions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."operation_outcome_transitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."operation_outcome_transitions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_outcome_transitions_update" ON "payment"."operation_outcome_transitions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."operation_outcome_transitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."operation_outcome_transitions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."operation_outcome_transitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."operation_outcome_transitions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_outcome_transitions_delete" ON "payment"."operation_outcome_transitions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."operation_outcome_transitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."operation_outcome_transitions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_authorizations_select" ON "payment"."payment_authorizations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."payment_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_authorizations_insert" ON "payment"."payment_authorizations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."payment_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_authorizations_update" ON "payment"."payment_authorizations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."payment_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."payment_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_authorizations_delete" ON "payment"."payment_authorizations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."payment_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_operations_select" ON "payment"."payment_operations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."payment_operations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_operations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_operations_insert" ON "payment"."payment_operations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."payment_operations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_operations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_operations_update" ON "payment"."payment_operations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."payment_operations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_operations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."payment_operations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_operations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_operations_delete" ON "payment"."payment_operations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."payment_operations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payment_operations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_payments_select" ON "payment"."payments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."payments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_payments_insert" ON "payment"."payments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."payments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_payments_update" ON "payment"."payments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."payments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."payments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_payments_delete" ON "payment"."payments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."payments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."payments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_cases_select" ON "payment"."reconciliation_cases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_cases_insert" ON "payment"."reconciliation_cases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_cases_update" ON "payment"."reconciliation_cases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_cases_delete" ON "payment"."reconciliation_cases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_decisions_select" ON "payment"."reconciliation_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."reconciliation_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_decisions_insert" ON "payment"."reconciliation_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."reconciliation_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_decisions_update" ON "payment"."reconciliation_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."reconciliation_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."reconciliation_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_reconciliation_decisions_delete" ON "payment"."reconciliation_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."reconciliation_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."reconciliation_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_recovery_requests_select" ON "payment"."recovery_requests" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."recovery_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."recovery_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_recovery_requests_insert" ON "payment"."recovery_requests" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."recovery_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."recovery_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_recovery_requests_update" ON "payment"."recovery_requests" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."recovery_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."recovery_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."recovery_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."recovery_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_recovery_requests_delete" ON "payment"."recovery_requests" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."recovery_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."recovery_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_refund_item_claims_select" ON "payment"."refund_item_claims" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."refund_item_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."refund_item_claims"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_refund_item_claims_insert" ON "payment"."refund_item_claims" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."refund_item_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."refund_item_claims"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_refund_item_claims_update" ON "payment"."refund_item_claims" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."refund_item_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."refund_item_claims"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."refund_item_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."refund_item_claims"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_refund_item_claims_delete" ON "payment"."refund_item_claims" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."refund_item_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."refund_item_claims"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authorities_select" ON "payment"."source_authorities" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authorities_insert" ON "payment"."source_authorities" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authorities_update" ON "payment"."source_authorities" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authorities_delete" ON "payment"."source_authorities" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authority_revisions_select" ON "payment"."source_authority_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."source_authority_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authority_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authority_revisions_insert" ON "payment"."source_authority_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."source_authority_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authority_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authority_revisions_update" ON "payment"."source_authority_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."source_authority_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authority_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."source_authority_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authority_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_source_authority_revisions_delete" ON "payment"."source_authority_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."source_authority_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."source_authority_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);