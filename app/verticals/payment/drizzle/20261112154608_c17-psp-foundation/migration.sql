CREATE TABLE "payment"."psp_credential_revisions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"credential_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"recorded_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by_action_invocation_id" uuid,
	"revision" integer NOT NULL,
	"secret_ref" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "payment_psp_credentials_number_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","revision"),
	CONSTRAINT "payment_psp_credentials_status_ck" CHECK ("status" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "payment_psp_credentials_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "payment_psp_credentials_secret_ref_ck" CHECK ("secret_ref" ~ '^[A-Za-z0-9._-]{1,120}$'),
	CONSTRAINT "payment_psp_credentials_retirement_ck" CHECK (("status" = 'RETIRED') = ("retired_at" is not null) and ("retired_at" is null) = ("retired_by_action_invocation_id" is null)),
	CONSTRAINT "payment_psp_credentials_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_credential_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_gateway_enablement_revisions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"enablement_id" uuid NOT NULL,
	"enablement_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"environment" text NOT NULL,
	"provider_family" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"return_url" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "payment_psp_enablement_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","enablement_id","revision"),
	CONSTRAINT "payment_psp_enablement_revisions_family_ck" CHECK ("provider_family" in ('GOPAY', 'STRIPE', 'COMGATE')),
	CONSTRAINT "payment_psp_enablement_revisions_environment_ck" CHECK ("environment" in ('SANDBOX', 'LIVE')),
	CONSTRAINT "payment_psp_enablement_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "payment_psp_enablement_revisions_return_url_ck" CHECK ("return_url" is null or ("return_url" ~ '^https://[^[:space:]/?#]+[^[:space:]]*$' and length("return_url") <= 2000)),
	CONSTRAINT "payment_psp_enablement_revisions_configuration_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 200),
	CONSTRAINT "payment_psp_enablement_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_psp_enablement_revisions_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_gateway_enablement_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_gateway_enablements" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"configured_at" timestamp with time zone NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"enablement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"environment" text NOT NULL,
	"provider_family" text NOT NULL,
	"reason" text NOT NULL,
	"return_url" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "payment_psp_enablements_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","enablement_id"),
	CONSTRAINT "payment_psp_enablements_identity_uk" UNIQUE("tenant_id","legal_entity_id","customer_configuration_id","provider_family"),
	CONSTRAINT "payment_psp_enablements_family_ck" CHECK ("provider_family" in ('GOPAY', 'STRIPE', 'COMGATE')),
	CONSTRAINT "payment_psp_enablements_environment_ck" CHECK ("environment" in ('SANDBOX', 'LIVE')),
	CONSTRAINT "payment_psp_enablements_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "payment_psp_enablements_return_url_ck" CHECK ("return_url" is null or ("return_url" ~ '^https://[^[:space:]/?#]+[^[:space:]]*$' and length("return_url") <= 2000)),
	CONSTRAINT "payment_psp_enablements_configuration_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 200),
	CONSTRAINT "payment_psp_enablements_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_psp_enablements_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_gateway_enablements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_provider_account_binding_revisions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"current_credential_revision" integer NOT NULL,
	"notification_url" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "payment_psp_binding_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","revision"),
	CONSTRAINT "payment_psp_binding_revisions_status_ck" CHECK ("status" in ('CURRENT', 'RETIRED_FOR_NEW_INTENTS')),
	CONSTRAINT "payment_psp_binding_revisions_revisions_ck" CHECK ("revision" > 0 and "current_credential_revision" > 0),
	CONSTRAINT "payment_psp_binding_revisions_notification_url_ck" CHECK ("notification_url" is null or ("notification_url" ~ '^https://[^[:space:]/?#]+[^[:space:]]*$' and length("notification_url") <= 2000)),
	CONSTRAINT "payment_psp_binding_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_psp_binding_revisions_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_account_binding_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_provider_account_bindings" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"binding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"configured_at" timestamp with time zone NOT NULL,
	"current_credential_revision" integer NOT NULL,
	"environment" text NOT NULL,
	"merchant_identity" jsonb NOT NULL,
	"notification_url" text NOT NULL,
	"provider_account_ref" text NOT NULL,
	"provider_family" text NOT NULL,
	"reason" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "payment_psp_bindings_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","binding_id"),
	CONSTRAINT "payment_psp_bindings_family_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","provider_family","environment"),
	CONSTRAINT "payment_psp_bindings_account_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","provider_family","environment","provider_account_ref"),
	CONSTRAINT "payment_psp_bindings_ref_uk" UNIQUE("tenant_id","provider_account_ref"),
	CONSTRAINT "payment_psp_bindings_family_ck" CHECK ("provider_family" in ('GOPAY', 'STRIPE', 'COMGATE')),
	CONSTRAINT "payment_psp_bindings_environment_ck" CHECK ("environment" in ('SANDBOX', 'LIVE')),
	CONSTRAINT "payment_psp_bindings_status_ck" CHECK ("status" in ('CURRENT', 'RETIRED_FOR_NEW_INTENTS')),
	CONSTRAINT "payment_psp_bindings_merchant_ck" CHECK (jsonb_typeof("merchant_identity") = 'object' and "merchant_identity"->>'_tag' = "provider_family"),
	CONSTRAINT "payment_psp_bindings_revisions_ck" CHECK ("revision" > 0 and "current_credential_revision" > 0),
	CONSTRAINT "payment_psp_bindings_ref_ck" CHECK ("provider_account_ref" ~ '^pab_[0-9a-f]{32}$'),
	CONSTRAINT "payment_psp_bindings_notification_url_ck" CHECK ("notification_url" is null or ("notification_url" ~ '^https://[^[:space:]/?#]+[^[:space:]]*$' and length("notification_url") <= 2000)),
	CONSTRAINT "payment_psp_bindings_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "payment_psp_bindings_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_account_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_provider_dispatches" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"origin_action_invocation_id" uuid NOT NULL,
	"origin_composition_revision" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"worker_key" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"credential_revision" integer,
	"customer_redirect_url" text,
	"dispatch_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"endpoint_ref" text,
	"environment" text NOT NULL,
	"idempotency_key_hash" text,
	"material_hash" text NOT NULL,
	"not_sent_reason" text,
	"operation_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"order_reference" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"prepared_at" timestamp with time zone,
	"provider_account_ref" text NOT NULL,
	"provider_family" text NOT NULL,
	"provider_payment_ref" text,
	"provider_refund_ref" text,
	"replay_expires_at" timestamp with time zone,
	"replay_starts_at" timestamp with time zone,
	"request_body" bytea,
	"request_hash" text,
	"request_headers" jsonb,
	"responded_at" timestamp with time zone,
	"return_token" text,
	"state" text NOT NULL,
	"target_operation_id" uuid,
	"transition_delivery_id" uuid,
	"transitioned_at" timestamp with time zone,
	CONSTRAINT "payment_psp_dispatches_operation_uk" UNIQUE("tenant_id","legal_entity_id","operation_id"),
	CONSTRAINT "payment_psp_dispatches_order_reference_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","order_reference"),
	CONSTRAINT "payment_psp_dispatches_vocabulary_ck" CHECK ("state" in ('AWAITING_TARGET', 'PREPARED', 'ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN', 'UNSUPPORTED', 'NOT_SENT', 'TARGET_UNRESOLVED') and "operation_kind" in ('COLLECT', 'CANCEL_OR_VOID', 'REFUND') and ("not_sent_reason" is null or "not_sent_reason" in ('WITHHELD_FOR_CANCELLATION', 'TARGET_WITHHELD', 'TARGET_NOT_EFFECTED', 'PREPARE_UNAVAILABLE', 'PRIOR_REFUND_UNRESOLVED'))),
	CONSTRAINT "payment_psp_dispatches_family_ck" CHECK ("provider_family" in ('GOPAY', 'STRIPE', 'COMGATE')),
	CONSTRAINT "payment_psp_dispatches_environment_ck" CHECK ("environment" in ('SANDBOX', 'LIVE')),
	CONSTRAINT "payment_psp_dispatches_target_ck" CHECK (("operation_kind" = 'COLLECT') = ("target_operation_id" is null) and ("target_operation_id" is null or "target_operation_id" <> "operation_id")),
	CONSTRAINT "payment_psp_dispatches_order_reference_ck" CHECK ("order_reference" = replace("operation_id"::text, '-', '')),
	CONSTRAINT "payment_psp_dispatches_not_sent_ck" CHECK (("state" = 'NOT_SENT') = ("not_sent_reason" is not null)),
	CONSTRAINT "payment_psp_dispatches_request_ck" CHECK (("prepared_at" is null) = ("request_hash" is null)
        and ("prepared_at" is null) = ("endpoint_ref" is null)
        and ("prepared_at" is null) = ("credential_revision" is null)
        and ("state" not in ('PREPARED', 'ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN') or "prepared_at" is not null)
        and ("state" not in ('AWAITING_TARGET', 'NOT_SENT', 'UNSUPPORTED', 'TARGET_UNRESOLVED') or "prepared_at" is null)
        and ("idempotency_key_hash" is null or "prepared_at" is not null)
        and ("request_body" is null or ("prepared_at" is not null and octet_length("request_body") <= 65536))
        and ("request_body" is null) = ("request_headers" is null)
        and ("request_headers" is null or jsonb_typeof("request_headers") = 'array')),
	CONSTRAINT "payment_psp_dispatches_replay_ck" CHECK (("replay_starts_at" is null) = ("replay_expires_at" is null)
        and ("replay_starts_at" is null or ("replay_expires_at" > "replay_starts_at"
          and "idempotency_key_hash" is not null and "request_body" is not null))),
	CONSTRAINT "payment_psp_dispatches_return_token_ck" CHECK ("return_token" is null or ("operation_kind" = 'COLLECT' and "return_token" ~ '^[A-Za-z0-9_-]{22}$')),
	CONSTRAINT "payment_psp_dispatches_credential_revision_ck" CHECK ("credential_revision" is null or "credential_revision" > 0),
	CONSTRAINT "payment_psp_dispatches_response_ck" CHECK (("responded_at" is not null) = ("state" in ('ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN'))
        and ("customer_redirect_url" is null or "state" = 'ACKNOWLEDGED')
        and ("transitioned_at" is null) = ("transition_delivery_id" is null)),
	CONSTRAINT "payment_psp_dispatches_hashes_ck" CHECK ("material_hash" ~ '^[a-f0-9]{64}$' and ("request_hash" is null or "request_hash" ~ '^[a-f0-9]{64}$') and ("idempotency_key_hash" is null or "idempotency_key_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "payment_psp_dispatches_redirect_ck" CHECK ("customer_redirect_url" is null or ("customer_redirect_url" ~ '^https://[^[:space:]/?#]+[^[:space:]]*$' and length("customer_redirect_url") <= 2000)),
	CONSTRAINT "payment_psp_dispatches_ref_ck" CHECK ("provider_account_ref" ~ '^pab_[0-9a-f]{32}$'),
	CONSTRAINT "payment_psp_dispatches_endpoint_ck" CHECK ("endpoint_ref" is null or ("endpoint_ref" = btrim("endpoint_ref") and length("endpoint_ref") between 1 and 200)),
	CONSTRAINT "payment_psp_dispatches_payment_ref_ck" CHECK ("provider_payment_ref" is null or ("provider_payment_ref" = btrim("provider_payment_ref") and length("provider_payment_ref") between 1 and 200)),
	CONSTRAINT "payment_psp_dispatches_refund_ref_ck" CHECK ("provider_refund_ref" is null or ("provider_refund_ref" = btrim("provider_refund_ref") and length("provider_refund_ref") between 1 and 200)),
	CONSTRAINT "payment_psp_dispatches_worker_ck" CHECK ("worker_key" = btrim("worker_key") and length("worker_key") between 1 and 200),
	CONSTRAINT "payment_psp_dispatches_composition_ck" CHECK ("origin_composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_dispatches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_provider_evidence" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"origin_action_invocation_id" uuid NOT NULL,
	"origin_composition_revision" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"worker_key" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"discrepancy" jsonb,
	"economic_effect_key" text,
	"environment" text NOT NULL,
	"evidence_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"evidence_origin" text NOT NULL,
	"fact_family" text NOT NULL,
	"fact_kind" text NOT NULL,
	"notification_id" uuid,
	"observation_id" uuid,
	"observed_amount_minor" bigint,
	"observed_currency" text,
	"operation_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_account_ref" text NOT NULL,
	"provider_family" text NOT NULL,
	"provider_occurred_at" timestamp with time zone,
	"provider_refs" jsonb NOT NULL,
	"reason" text,
	"received_at" timestamp with time zone NOT NULL,
	"source_occurrence_id" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"submission_executor_principal_id" uuid,
	"submission_state" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_delivery_id" uuid,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_psp_evidence_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","evidence_id"),
	CONSTRAINT "payment_psp_evidence_occurrence_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","source_occurrence_id","source_revision"),
	CONSTRAINT "payment_psp_evidence_vocabulary_ck" CHECK ("evidence_origin" in ('NOTIFICATION_LOOKUP', 'NOTIFICATION_SIGNED', 'DISPATCH_RESPONSE', 'LOCAL_NOT_SENT', 'RECOVERY_LOOKUP', 'RECOVERY_REPLAY')
        and "submission_state" in ('PENDING_SUBMISSION', 'ACCEPTED', 'DUPLICATE', 'HELD', 'CONFLICT', 'DENIED')
        and "fact_kind" in ('COLLECTION_PENDING', 'COLLECTION_CONFIRMED', 'COLLECTION_NOT_EFFECTED', 'CANCEL_CONFIRMED', 'CANCEL_NOT_EFFECTED', 'REFUND_PENDING', 'REFUND_INDETERMINATE', 'REFUND_CONFIRMED', 'REFUND_NOT_EFFECTED')
        and "fact_family" in ('GATEWAY_OUTCOME', 'REFUND_EXECUTION')),
	CONSTRAINT "payment_psp_evidence_family_ck" CHECK ("provider_family" in ('GOPAY', 'STRIPE', 'COMGATE')),
	CONSTRAINT "payment_psp_evidence_environment_ck" CHECK ("environment" in ('SANDBOX', 'LIVE')),
	CONSTRAINT "payment_psp_evidence_money_ck" CHECK (("observed_amount_minor" is null) = ("observed_currency" is null) and ("observed_amount_minor" is null or ("observed_amount_minor" between 0 and 9007199254740991 and "observed_currency" ~ '^[A-Z]{3}$'))),
	CONSTRAINT "payment_psp_evidence_times_ck" CHECK ("verified_at" >= "received_at"),
	CONSTRAINT "payment_psp_evidence_submission_ck" CHECK (("submission_state" = 'PENDING_SUBMISSION') = ("submitted_at" is null)
        and ("submitted_at" is null) = ("submitted_delivery_id" is null)
        and ("observation_id" is null or "submission_state" in ('ACCEPTED', 'DUPLICATE', 'HELD', 'CONFLICT'))),
	CONSTRAINT "payment_psp_evidence_document_ck" CHECK (jsonb_typeof("provider_refs") = 'array' and ("discrepancy" is null or jsonb_typeof("discrepancy") = 'object')),
	CONSTRAINT "payment_psp_evidence_revision_ck" CHECK ("source_revision" between 0 and 9007199254740991),
	CONSTRAINT "payment_psp_evidence_ref_ck" CHECK ("provider_account_ref" ~ '^pab_[0-9a-f]{32}$'),
	CONSTRAINT "payment_psp_evidence_occurrence_ck" CHECK ("source_occurrence_id" = btrim("source_occurrence_id") and length("source_occurrence_id") between 1 and 200),
	CONSTRAINT "payment_psp_evidence_effect_ck" CHECK ("economic_effect_key" is null or ("economic_effect_key" = btrim("economic_effect_key") and length("economic_effect_key") between 1 and 200)),
	CONSTRAINT "payment_psp_evidence_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") between 1 and 200)),
	CONSTRAINT "payment_psp_evidence_worker_ck" CHECK ("worker_key" = btrim("worker_key") and length("worker_key") between 1 and 200),
	CONSTRAINT "payment_psp_evidence_composition_ck" CHECK ("origin_composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_provider_notifications" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"authenticity" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"claimed_status" text,
	"correlated_operation_id" uuid,
	"delivery_identity" text NOT NULL,
	"environment" text NOT NULL,
	"headers" jsonb NOT NULL,
	"notification_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"processed_at" timestamp with time zone,
	"processed_delivery_id" uuid,
	"provider_account_ref" text NOT NULL,
	"provider_event_at" timestamp with time zone,
	"provider_family" text NOT NULL,
	"provider_occurrence_id" text,
	"provider_refs" jsonb NOT NULL,
	"query" jsonb NOT NULL,
	"raw_body" bytea NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"transport_delivery_ref" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_psp_notifications_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","notification_id"),
	CONSTRAINT "payment_psp_notifications_binding_id_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","notification_id"),
	CONSTRAINT "payment_psp_notifications_delivery_uk" UNIQUE("tenant_id","legal_entity_id","binding_id","delivery_identity"),
	CONSTRAINT "payment_psp_notifications_vocabulary_ck" CHECK ("state" in ('CAPTURED', 'IGNORED', 'HELD_UNCORRELATED', 'SUBMITTED', 'SUBMISSION_HELD', 'SUBMISSION_DENIED') and "authenticity" in ('SIGNATURE_VERIFIED', 'SHARED_SECRET_VERIFIED', 'LOOKUP_REQUIRED')),
	CONSTRAINT "payment_psp_notifications_family_ck" CHECK ("provider_family" in ('GOPAY', 'STRIPE', 'COMGATE')),
	CONSTRAINT "payment_psp_notifications_environment_ck" CHECK ("environment" in ('SANDBOX', 'LIVE')),
	CONSTRAINT "payment_psp_notifications_processing_ck" CHECK (("processed_at" is null) = ("state" in ('CAPTURED', 'IGNORED'))
        and ("processed_at" is null) = ("processed_delivery_id" is null)
        and ("correlated_operation_id" is null or "state" in ('SUBMITTED', 'SUBMISSION_HELD', 'SUBMISSION_DENIED'))),
	CONSTRAINT "payment_psp_notifications_document_ck" CHECK (jsonb_typeof("headers") = 'object' and jsonb_typeof("query") = 'object' and jsonb_typeof("provider_refs") = 'array'
        and octet_length("raw_body") <= 65536),
	CONSTRAINT "payment_psp_notifications_times_ck" CHECK ("verified_at" >= "received_at"),
	CONSTRAINT "payment_psp_notifications_ref_ck" CHECK ("provider_account_ref" ~ '^pab_[0-9a-f]{32}$'),
	CONSTRAINT "payment_psp_notifications_delivery_ck" CHECK ("delivery_identity" = btrim("delivery_identity") and length("delivery_identity") between 1 and 200),
	CONSTRAINT "payment_psp_notifications_transport_ck" CHECK ("transport_delivery_ref" = btrim("transport_delivery_ref") and length("transport_delivery_ref") between 1 and 200),
	CONSTRAINT "payment_psp_notifications_occurrence_ck" CHECK ("provider_occurrence_id" is null or ("provider_occurrence_id" = btrim("provider_occurrence_id") and length("provider_occurrence_id") between 1 and 200)),
	CONSTRAINT "payment_psp_notifications_claimed_status_ck" CHECK ("claimed_status" is null or ("claimed_status" = btrim("claimed_status") and length("claimed_status") between 1 and 200)),
	CONSTRAINT "payment_psp_notifications_composition_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_psp_credentials_active_uk" ON "payment"."psp_credential_revisions" ("tenant_id","legal_entity_id","binding_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_psp_bindings_current_uk" ON "payment"."psp_provider_account_bindings" ("tenant_id","legal_entity_id","provider_family","environment") WHERE "status" = 'CURRENT';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_psp_dispatches_return_token_uk" ON "payment"."psp_provider_dispatches" ("tenant_id","legal_entity_id","return_token") WHERE "return_token" is not null;--> statement-breakpoint
CREATE INDEX "payment_psp_dispatches_target_idx" ON "payment"."psp_provider_dispatches" ("tenant_id","legal_entity_id","target_operation_id");--> statement-breakpoint
CREATE INDEX "payment_psp_dispatches_provider_payment_idx" ON "payment"."psp_provider_dispatches" ("tenant_id","legal_entity_id","binding_id","provider_payment_ref");--> statement-breakpoint
CREATE INDEX "payment_psp_dispatches_state_idx" ON "payment"."psp_provider_dispatches" ("tenant_id","legal_entity_id","state");--> statement-breakpoint
CREATE INDEX "payment_psp_evidence_pending_idx" ON "payment"."psp_provider_evidence" ("tenant_id","legal_entity_id","operation_id","submission_state");--> statement-breakpoint
ALTER TABLE "payment"."psp_credential_revisions" ADD CONSTRAINT "payment_psp_credentials_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_gateway_enablement_revisions" ADD CONSTRAINT "payment_psp_enablement_revisions_current_fk" FOREIGN KEY ("tenant_id","legal_entity_id","enablement_id") REFERENCES "payment"."psp_gateway_enablements"("tenant_id","legal_entity_id","enablement_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_gateway_enablement_revisions" ADD CONSTRAINT "payment_psp_enablement_revisions_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","provider_family","environment") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id","provider_family","environment") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_gateway_enablements" ADD CONSTRAINT "payment_psp_enablements_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","provider_family","environment") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id","provider_family","environment") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_account_binding_revisions" ADD CONSTRAINT "payment_psp_binding_revisions_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_dispatches" ADD CONSTRAINT "payment_psp_dispatches_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_dispatches" ADD CONSTRAINT "payment_psp_dispatches_target_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","target_operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_dispatches" ADD CONSTRAINT "payment_psp_dispatches_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","provider_family","environment","provider_account_ref") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id","provider_family","environment","provider_account_ref") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_dispatches" ADD CONSTRAINT "payment_psp_dispatches_credential_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","credential_revision") REFERENCES "payment"."psp_credential_revisions"("tenant_id","legal_entity_id","binding_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_evidence" ADD CONSTRAINT "payment_psp_evidence_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","payment_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","payment_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_evidence" ADD CONSTRAINT "payment_psp_evidence_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","provider_family","environment","provider_account_ref") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id","provider_family","environment","provider_account_ref") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_evidence" ADD CONSTRAINT "payment_psp_evidence_notification_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","notification_id") REFERENCES "payment"."psp_provider_notifications"("tenant_id","legal_entity_id","binding_id","notification_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_evidence" ADD CONSTRAINT "payment_psp_evidence_observation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","observation_id") REFERENCES "payment"."observations"("tenant_id","legal_entity_id","observation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_notifications" ADD CONSTRAINT "payment_psp_notifications_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","provider_family","environment","provider_account_ref") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id","provider_family","environment","provider_account_ref") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_notifications" ADD CONSTRAINT "payment_psp_notifications_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","correlated_operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "payment_psp_credential_revisions_select" ON "payment"."psp_credential_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_credential_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_credential_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_credential_revisions_insert" ON "payment"."psp_credential_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_credential_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_credential_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_credential_revisions_update" ON "payment"."psp_credential_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_credential_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_credential_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_credential_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_credential_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_credential_revisions_delete" ON "payment"."psp_credential_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_credential_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_credential_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablement_revisions_select" ON "payment"."psp_gateway_enablement_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_gateway_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablement_revisions_insert" ON "payment"."psp_gateway_enablement_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_gateway_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablement_revisions_update" ON "payment"."psp_gateway_enablement_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_gateway_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_gateway_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablement_revisions_delete" ON "payment"."psp_gateway_enablement_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_gateway_enablement_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablement_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablements_select" ON "payment"."psp_gateway_enablements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_gateway_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablements_insert" ON "payment"."psp_gateway_enablements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_gateway_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablements_update" ON "payment"."psp_gateway_enablements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_gateway_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_gateway_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_gateway_enablements_delete" ON "payment"."psp_gateway_enablements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_gateway_enablements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_gateway_enablements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_binding_revisions_select" ON "payment"."psp_provider_account_binding_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_provider_account_binding_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_binding_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_binding_revisions_insert" ON "payment"."psp_provider_account_binding_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_provider_account_binding_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_binding_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_binding_revisions_update" ON "payment"."psp_provider_account_binding_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_provider_account_binding_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_binding_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_provider_account_binding_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_binding_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_binding_revisions_delete" ON "payment"."psp_provider_account_binding_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_provider_account_binding_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_binding_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_bindings_select" ON "payment"."psp_provider_account_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_provider_account_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_bindings_insert" ON "payment"."psp_provider_account_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_provider_account_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_bindings_update" ON "payment"."psp_provider_account_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_provider_account_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_provider_account_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_account_bindings_delete" ON "payment"."psp_provider_account_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_provider_account_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_account_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_dispatches_select" ON "payment"."psp_provider_dispatches" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_provider_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_dispatches_insert" ON "payment"."psp_provider_dispatches" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_provider_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_dispatches_update" ON "payment"."psp_provider_dispatches" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_provider_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_provider_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_dispatches_delete" ON "payment"."psp_provider_dispatches" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_provider_dispatches"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_dispatches"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_evidence_select" ON "payment"."psp_provider_evidence" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_provider_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_evidence_insert" ON "payment"."psp_provider_evidence" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_provider_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_evidence_update" ON "payment"."psp_provider_evidence" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_provider_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_provider_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_evidence_delete" ON "payment"."psp_provider_evidence" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_provider_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_notifications_select" ON "payment"."psp_provider_notifications" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_provider_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_notifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_notifications_insert" ON "payment"."psp_provider_notifications" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_provider_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_notifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_notifications_update" ON "payment"."psp_provider_notifications" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_provider_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_notifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_provider_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_notifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_provider_notifications_delete" ON "payment"."psp_provider_notifications" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_provider_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_provider_notifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);