CREATE SCHEMA "core";
--> statement-breakpoint
CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TABLE "core"."action_invocations" (
	"action_invocation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"principal_id" uuid NOT NULL,
	"auth_binding_id" uuid,
	"auth_context_ref" text,
	"impersonated_by_principal_id" uuid,
	"auth_method" text NOT NULL,
	"trace_id" text,
	"correlation_id" text,
	"action_key" text NOT NULL,
	"idempotency_key" text,
	"target_module_key" text,
	"target_resource_type" text,
	"target_resource_id" text,
	"status" text NOT NULL,
	"request_hash" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "core_action_invocations_auth_method_ck" CHECK ("core"."action_invocations"."auth_method" in ('session', 'api_key', 'system', 'support_impersonation')),
	CONSTRAINT "core_action_invocations_status_ck" CHECK ("core"."action_invocations"."status" in ('received', 'rejected', 'running', 'succeeded', 'failed', 'replayed'))
);
--> statement-breakpoint
CREATE TABLE "core"."audit_events" (
	"audit_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"action_invocation_id" uuid,
	"principal_id" uuid,
	"auth_binding_id" uuid,
	"auth_context_ref" text,
	"impersonated_by_principal_id" uuid,
	"auth_method" text NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"outcome_stage" text NOT NULL,
	"outcome_code" text NOT NULL,
	"audit_profile" text NOT NULL,
	"target_module_key" text,
	"target_resource_type" text,
	"target_resource_id" text,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_audit_events_outcome_ck" CHECK ("core"."audit_events"."outcome" in ('allowed', 'denied', 'succeeded', 'failed')),
	CONSTRAINT "core_audit_events_stage_ck" CHECK ("core"."audit_events"."outcome_stage" in ('system', 'authn', 'authz', 'policy', 'validation', 'execution')),
	CONSTRAINT "core_audit_events_profile_ck" CHECK ("core"."audit_events"."audit_profile" in ('standard', 'sensitive', 'minimal'))
);
--> statement-breakpoint
CREATE TABLE "core"."data_access_events" (
	"data_access_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"action_invocation_id" uuid,
	"principal_id" uuid NOT NULL,
	"auth_binding_id" uuid,
	"auth_context_ref" text,
	"impersonated_by_principal_id" uuid,
	"auth_method" text NOT NULL,
	"access_kind" text NOT NULL,
	"serving_module_key" text NOT NULL,
	"target_module_key" text,
	"target_resource_type" text,
	"target_resource_id" text,
	"query_hash" text NOT NULL,
	"result_count" integer NOT NULL,
	"result_fingerprint_schema" text,
	"result_fingerprint_hash" text,
	"evidence_policy_key" text NOT NULL,
	"evidence_capture_mode" text NOT NULL,
	"evidence_payload_json" jsonb,
	"redaction_profile" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_data_access_events_access_kind_ck" CHECK ("core"."data_access_events"."access_kind" in ('read', 'list', 'search', 'export', 'download')),
	CONSTRAINT "core_data_access_events_capture_mode_ck" CHECK ("core"."data_access_events"."evidence_capture_mode" in ('metadata_only', 'hash_only', 'redacted_payload', 'stored_artifact')),
	CONSTRAINT "core_data_access_events_redaction_ck" CHECK (("core"."data_access_events"."evidence_capture_mode" = 'redacted_payload' and "core"."data_access_events"."redaction_profile" is not null and "core"."data_access_events"."evidence_payload_json" is not null) or ("core"."data_access_events"."evidence_capture_mode" <> 'redacted_payload' and "core"."data_access_events"."redaction_profile" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."domain_events" (
	"domain_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"action_invocation_id" uuid,
	"producer_module_key" text NOT NULL,
	"event_type" text NOT NULL,
	"subject_module_key" text NOT NULL,
	"subject_resource_type" text NOT NULL,
	"subject_resource_id" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tenant_sequence_no" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."evidence_references" (
	"evidence_reference_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"media_asset_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"action_invocation_id" uuid,
	"audit_event_id" uuid,
	"data_access_event_id" uuid,
	"domain_event_id" uuid,
	"evidence_kind" text NOT NULL,
	"subject_module_key" text,
	"subject_resource_type" text,
	"subject_resource_id" text,
	"evidence_policy_key" text NOT NULL,
	"retention_policy_key" text NOT NULL,
	"artifact_content_sha256" text NOT NULL,
	"storage_lock_scope" text NOT NULL,
	"storage_lock_mode" text NOT NULL,
	"storage_legal_hold" boolean DEFAULT false NOT NULL,
	"storage_retain_until" timestamp with time zone,
	"storage_lock_status" text NOT NULL,
	"storage_lock_verified_at" timestamp with time zone,
	"storage_lock_evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retain_until" timestamp with time zone,
	"legal_hold_until" timestamp with time zone,
	"disposition_status" text NOT NULL,
	"data_classification" text NOT NULL,
	"schema_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "core_evidence_references_source_kind_ck" CHECK ("core"."evidence_references"."source_kind" in ('action', 'audit', 'data_access', 'domain_event')),
	CONSTRAINT "core_evidence_references_source_one_ck" CHECK (num_nonnulls("core"."evidence_references"."action_invocation_id", "core"."evidence_references"."audit_event_id", "core"."evidence_references"."data_access_event_id", "core"."evidence_references"."domain_event_id") = 1),
	CONSTRAINT "core_evidence_references_subject_all_ck" CHECK (num_nonnulls("core"."evidence_references"."subject_module_key", "core"."evidence_references"."subject_resource_type", "core"."evidence_references"."subject_resource_id") in (0, 3)),
	CONSTRAINT "core_evidence_references_disposition_ck" CHECK ("core"."evidence_references"."disposition_status" in ('active', 'expired', 'deleted', 'legal_hold')),
	CONSTRAINT "core_evidence_references_classification_ck" CHECK ("core"."evidence_references"."data_classification" in ('internal', 'confidential', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "core"."legal_entities" (
	"legal_entity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"registration_country" text NOT NULL,
	"registration_number" text NOT NULL,
	"vat_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_legal_entities_status_ck" CHECK ("core"."legal_entities"."status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "core"."media_assets" (
	"media_asset_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"ingested_by_principal_id" uuid,
	"ingestion_source" text NOT NULL,
	"external_source_ref" text,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_object_version_ref" text,
	"original_filename" text,
	"display_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_sha256" text,
	"sealed_at" timestamp with time zone,
	"processing_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_media_assets_ingestion_source_ck" CHECK ("core"."media_assets"."ingestion_source" in ('user', 'integration', 'import', 'system')),
	CONSTRAINT "core_media_assets_processing_status_ck" CHECK ("core"."media_assets"."processing_status" in ('uploaded', 'scanning', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "core"."media_links" (
	"media_link_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"linked_by_principal_id" uuid,
	"action_invocation_id" uuid,
	"link_source" text NOT NULL,
	"target_module_key" text NOT NULL,
	"target_resource_type" text NOT NULL,
	"target_resource_id" text NOT NULL,
	"link_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "core_media_links_source_ck" CHECK ("core"."media_links"."link_source" in ('user', 'integration', 'import', 'system'))
);
--> statement-breakpoint
CREATE TABLE "core"."outbox_attempts" (
	"outbox_attempt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_delivery_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "core"."outbox_deliveries" (
	"outbox_delivery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_message_id" uuid NOT NULL,
	"worker_key" text NOT NULL,
	"consumer_module_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_outbox_deliveries_status_ck" CHECK ("core"."outbox_deliveries"."status" in ('pending', 'processing', 'done', 'dead')),
	CONSTRAINT "core_outbox_deliveries_attempts_count_ck" CHECK ("core"."outbox_deliveries"."attempts_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."outbox_messages" (
	"outbox_message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain_event_id" uuid NOT NULL,
	"producer_module_key" text NOT NULL,
	"topic" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."principal_auth_bindings" (
	"principal_auth_binding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject_type" text NOT NULL,
	"provider_subject_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "core_auth_bindings_provider_ck" CHECK ("core"."principal_auth_bindings"."provider" in ('better_auth')),
	CONSTRAINT "core_auth_bindings_subject_type_ck" CHECK ("core"."principal_auth_bindings"."subject_type" in ('user', 'api_key')),
	CONSTRAINT "core_auth_bindings_status_ck" CHECK ("core"."principal_auth_bindings"."status" in ('active', 'revoked', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "core"."principals" (
	"principal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "core_principals_kind_ck" CHECK ("core"."principals"."kind" in ('human', 'service', 'integration', 'agent', 'system')),
	CONSTRAINT "core_principals_status_ck" CHECK ("core"."principals"."status" in ('active', 'disabled', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "core"."search_index_entries" (
	"search_index_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"source_module_key" text NOT NULL,
	"source_resource_type" text NOT NULL,
	"source_resource_id" text NOT NULL,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	"facets_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."tenant_module_state_changes" (
	"module_state_change_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"previous_state" text,
	"new_state" text NOT NULL,
	"changed_by_principal_id" uuid,
	"action_invocation_id" uuid,
	"change_source" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_module_state_changes_source_ck" CHECK ("core"."tenant_module_state_changes"."change_source" in ('user', 'support', 'system')),
	CONSTRAINT "core_module_state_changes_new_state_ck" CHECK ("core"."tenant_module_state_changes"."new_state" in ('inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "core"."tenant_module_states" (
	"tenant_module_state_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"state" text NOT NULL,
	"last_change_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_module_states_state_ck" CHECK ("core"."tenant_module_states"."state" in ('inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "core"."tenants" (
	"tenant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"default_locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_tenants_status_ck" CHECK ("core"."tenants"."status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "core"."worker_checkpoints" (
	"tenant_id" uuid NOT NULL,
	"consumer_name" text NOT NULL,
	"stream_key" text NOT NULL,
	"last_tenant_sequence_no" bigint,
	"last_processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_worker_checkpoints_pk" PRIMARY KEY("tenant_id","consumer_name","stream_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."action_invocations" ADD CONSTRAINT "action_invocations_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."action_invocations" ADD CONSTRAINT "action_invocations_legal_entity_id_legal_entities_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("legal_entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."action_invocations" ADD CONSTRAINT "action_invocations_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."action_invocations" ADD CONSTRAINT "action_invocations_auth_binding_id_principal_auth_bindings_principal_auth_binding_id_fk" FOREIGN KEY ("auth_binding_id") REFERENCES "core"."principal_auth_bindings"("principal_auth_binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."action_invocations" ADD CONSTRAINT "action_invocations_impersonated_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("impersonated_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "audit_events_legal_entity_id_legal_entities_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("legal_entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "audit_events_action_invocation_id_action_invocations_action_invocation_id_fk" FOREIGN KEY ("action_invocation_id") REFERENCES "core"."action_invocations"("action_invocation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "audit_events_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "audit_events_auth_binding_id_principal_auth_bindings_principal_auth_binding_id_fk" FOREIGN KEY ("auth_binding_id") REFERENCES "core"."principal_auth_bindings"("principal_auth_binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "audit_events_impersonated_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("impersonated_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "data_access_events_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "data_access_events_legal_entity_id_legal_entities_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("legal_entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "data_access_events_action_invocation_id_action_invocations_action_invocation_id_fk" FOREIGN KEY ("action_invocation_id") REFERENCES "core"."action_invocations"("action_invocation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "data_access_events_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "data_access_events_auth_binding_id_principal_auth_bindings_principal_auth_binding_id_fk" FOREIGN KEY ("auth_binding_id") REFERENCES "core"."principal_auth_bindings"("principal_auth_binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "data_access_events_impersonated_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("impersonated_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."domain_events" ADD CONSTRAINT "domain_events_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."domain_events" ADD CONSTRAINT "domain_events_legal_entity_id_legal_entities_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("legal_entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."domain_events" ADD CONSTRAINT "domain_events_action_invocation_id_action_invocations_action_invocation_id_fk" FOREIGN KEY ("action_invocation_id") REFERENCES "core"."action_invocations"("action_invocation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."evidence_references" ADD CONSTRAINT "evidence_references_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."evidence_references" ADD CONSTRAINT "evidence_references_legal_entity_id_legal_entities_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("legal_entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."evidence_references" ADD CONSTRAINT "evidence_references_media_asset_id_media_assets_media_asset_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "core"."media_assets"("media_asset_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."evidence_references" ADD CONSTRAINT "evidence_references_action_invocation_id_action_invocations_action_invocation_id_fk" FOREIGN KEY ("action_invocation_id") REFERENCES "core"."action_invocations"("action_invocation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."evidence_references" ADD CONSTRAINT "evidence_references_audit_event_id_audit_events_audit_event_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "core"."audit_events"("audit_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."evidence_references" ADD CONSTRAINT "evidence_references_data_access_event_id_data_access_events_data_access_event_id_fk" FOREIGN KEY ("data_access_event_id") REFERENCES "core"."data_access_events"("data_access_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."evidence_references" ADD CONSTRAINT "evidence_references_domain_event_id_domain_events_domain_event_id_fk" FOREIGN KEY ("domain_event_id") REFERENCES "core"."domain_events"("domain_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."media_assets" ADD CONSTRAINT "media_assets_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."media_assets" ADD CONSTRAINT "media_assets_legal_entity_id_legal_entities_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("legal_entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."media_assets" ADD CONSTRAINT "media_assets_ingested_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("ingested_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."media_links" ADD CONSTRAINT "media_links_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."media_links" ADD CONSTRAINT "media_links_media_asset_id_media_assets_media_asset_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "core"."media_assets"("media_asset_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."media_links" ADD CONSTRAINT "media_links_linked_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("linked_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."media_links" ADD CONSTRAINT "media_links_action_invocation_id_action_invocations_action_invocation_id_fk" FOREIGN KEY ("action_invocation_id") REFERENCES "core"."action_invocations"("action_invocation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."outbox_attempts" ADD CONSTRAINT "outbox_attempts_outbox_delivery_id_outbox_deliveries_outbox_delivery_id_fk" FOREIGN KEY ("outbox_delivery_id") REFERENCES "core"."outbox_deliveries"("outbox_delivery_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_outbox_message_id_outbox_messages_outbox_message_id_fk" FOREIGN KEY ("outbox_message_id") REFERENCES "core"."outbox_messages"("outbox_message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" ADD CONSTRAINT "outbox_messages_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" ADD CONSTRAINT "outbox_messages_domain_event_id_domain_events_domain_event_id_fk" FOREIGN KEY ("domain_event_id") REFERENCES "core"."domain_events"("domain_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "principal_auth_bindings_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "principal_auth_bindings_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."principals" ADD CONSTRAINT "principals_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."search_index_entries" ADD CONSTRAINT "search_index_entries_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."search_index_entries" ADD CONSTRAINT "search_index_entries_legal_entity_id_legal_entities_legal_entity_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "core"."legal_entities"("legal_entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."tenant_module_state_changes" ADD CONSTRAINT "tenant_module_state_changes_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."tenant_module_state_changes" ADD CONSTRAINT "tenant_module_state_changes_changed_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("changed_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."tenant_module_state_changes" ADD CONSTRAINT "tenant_module_state_changes_action_invocation_id_action_invocations_action_invocation_id_fk" FOREIGN KEY ("action_invocation_id") REFERENCES "core"."action_invocations"("action_invocation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."tenant_module_states" ADD CONSTRAINT "tenant_module_states_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."worker_checkpoints" ADD CONSTRAINT "worker_checkpoints_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_action_invocations_idempotency_uk" ON "core"."action_invocations" USING btree ("tenant_id","action_key","principal_id","idempotency_key") WHERE "core"."action_invocations"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "core_action_invocations_tenant_started_idx" ON "core"."action_invocations" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "core_action_invocations_target_idx" ON "core"."action_invocations" USING btree ("tenant_id","target_module_key","target_resource_type","target_resource_id");--> statement-breakpoint
CREATE INDEX "core_audit_events_tenant_occurred_idx" ON "core"."audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "core_audit_events_action_idx" ON "core"."audit_events" USING btree ("action_invocation_id");--> statement-breakpoint
CREATE INDEX "core_data_access_events_tenant_occurred_idx" ON "core"."data_access_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_domain_events_tenant_sequence_uk" ON "core"."domain_events" USING btree ("tenant_id","tenant_sequence_no");--> statement-breakpoint
CREATE INDEX "core_domain_events_subject_idx" ON "core"."domain_events" USING btree ("tenant_id","subject_module_key","subject_resource_type","subject_resource_id");--> statement-breakpoint
CREATE INDEX "core_evidence_references_subject_idx" ON "core"."evidence_references" USING btree ("tenant_id","subject_module_key","subject_resource_type","subject_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_legal_entities_registration_uk" ON "core"."legal_entities" USING btree ("tenant_id","registration_country","registration_number");--> statement-breakpoint
CREATE INDEX "core_legal_entities_tenant_idx" ON "core"."legal_entities" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_media_assets_storage_uk" ON "core"."media_assets" USING btree ("storage_provider","storage_key","storage_object_version_ref");--> statement-breakpoint
CREATE INDEX "core_media_assets_tenant_idx" ON "core"."media_assets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "core_media_links_target_idx" ON "core"."media_links" USING btree ("tenant_id","target_module_key","target_resource_type","target_resource_id");--> statement-breakpoint
CREATE INDEX "core_outbox_attempts_delivery_started_idx" ON "core"."outbox_attempts" USING btree ("outbox_delivery_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_outbox_deliveries_message_worker_uk" ON "core"."outbox_deliveries" USING btree ("outbox_message_id","worker_key");--> statement-breakpoint
CREATE INDEX "core_outbox_deliveries_pending_idx" ON "core"."outbox_deliveries" USING btree ("available_at") WHERE "core"."outbox_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "core_outbox_deliveries_message_idx" ON "core"."outbox_deliveries" USING btree ("outbox_message_id");--> statement-breakpoint
CREATE INDEX "core_outbox_deliveries_worker_status_idx" ON "core"."outbox_deliveries" USING btree ("worker_key","status");--> statement-breakpoint
CREATE INDEX "core_outbox_messages_unmatched_idx" ON "core"."outbox_messages" USING btree ("created_at") WHERE "core"."outbox_messages"."matched_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "core_auth_bindings_subject_uk" ON "core"."principal_auth_bindings" USING btree ("tenant_id","provider","subject_type","provider_subject_id");--> statement-breakpoint
CREATE INDEX "core_auth_bindings_principal_idx" ON "core"."principal_auth_bindings" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "core_principals_tenant_kind_idx" ON "core"."principals" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "core_search_index_entries_source_uk" ON "core"."search_index_entries" USING btree ("tenant_id","source_module_key","source_resource_type","source_resource_id");--> statement-breakpoint
CREATE INDEX "core_module_state_changes_tenant_module_idx" ON "core"."tenant_module_state_changes" USING btree ("tenant_id","module_key","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_module_states_tenant_module_uk" ON "core"."tenant_module_states" USING btree ("tenant_id","module_key");--> statement-breakpoint
CREATE UNIQUE INDEX "core_tenants_slug_uk" ON "core"."tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");