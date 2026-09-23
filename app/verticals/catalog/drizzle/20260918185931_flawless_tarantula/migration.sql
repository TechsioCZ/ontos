CREATE TABLE "catalog"."catalog_accepted_source_assertions" (
	"tenant_id" uuid,
	"assertion_id" uuid,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"fact_key" text NOT NULL,
	"issuer_system_id" text NOT NULL,
	"source_issuer_kind" text NOT NULL,
	"source_issuer_id" text NOT NULL,
	"source_record_namespace" text NOT NULL,
	"source_record_id" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"evidenced_at" timestamp with time zone NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"value" jsonb NOT NULL,
	"value_fingerprint" text NOT NULL,
	"target_resolution_source" text NOT NULL,
	"correlation_ref" text,
	"deterministic_rule_id" text,
	"correlation_capture_status" text NOT NULL,
	"authority_issuer_system_id" text NOT NULL,
	"authority_target_kind" text NOT NULL,
	"authority_fact_key" text NOT NULL,
	"authority_status" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_source_assertions_pk" PRIMARY KEY("tenant_id","assertion_id"),
	CONSTRAINT "catalog_source_assertions_source_revision_uk" UNIQUE("tenant_id","target_kind","target_id","fact_key","source_issuer_kind","source_issuer_id","source_record_namespace","source_record_id","source_revision"),
	CONSTRAINT "catalog_source_assertions_invocation_uk" UNIQUE("tenant_id","action_invocation_id","assertion_id"),
	CONSTRAINT "catalog_source_assertions_target_kind_ck" CHECK ("target_kind" in ('PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION')),
	CONSTRAINT "catalog_source_assertions_source_kind_ck" CHECK ("source_issuer_kind" in ('EXTERNAL_BUSINESS_SYSTEM', 'EXTERNAL_EVIDENCE_PROVIDER')),
	CONSTRAINT "catalog_source_assertions_revision_ck" CHECK ("source_revision" >= 0),
	CONSTRAINT "catalog_source_assertions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "catalog_source_assertions_fingerprint_ck" CHECK ("value_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_source_assertions_issuer_ck" CHECK ("issuer_system_id" = "source_issuer_id" and "authority_issuer_system_id" = "issuer_system_id"),
	CONSTRAINT "catalog_source_assertions_authority_ck" CHECK ("authority_status" = 'VERIFIED' and "authority_target_kind" = "target_kind" and "authority_fact_key" = "fact_key"),
	CONSTRAINT "catalog_source_assertions_resolution_ck" CHECK (("target_resolution_source" = 'OWNER_CORRELATION' and "correlation_ref" is not null and "deterministic_rule_id" is null and "correlation_capture_status" = 'ALREADY_OWNER_CONFIRMED') or ("target_resolution_source" = 'PRE_APPROVED_RULE' and "correlation_ref" is null and "deterministic_rule_id" is not null and "correlation_capture_status" = 'CONFIRMED_BEFORE_ACCEPTANCE')),
	CONSTRAINT "catalog_source_assertions_fact_key_ck" CHECK (length(btrim("fact_key")) between 1 and 200),
	CONSTRAINT "catalog_source_assertions_value_size_ck" CHECK (octet_length("value"::text) between 1 and 65536)
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_accepted_source_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."catalog_local_override_heads" (
	"tenant_id" uuid,
	"target_kind" text,
	"target_id" uuid,
	"fact_key" text,
	"latest_revision" bigint NOT NULL,
	"active_revision" bigint,
	"lifecycle" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_local_override_heads_pk" PRIMARY KEY("tenant_id","target_kind","target_id","fact_key"),
	CONSTRAINT "catalog_local_override_heads_target_kind_ck" CHECK ("target_kind" in ('PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION')),
	CONSTRAINT "catalog_local_override_heads_revision_ck" CHECK ("latest_revision" > 0 and ("active_revision" is null or "active_revision" = "latest_revision")),
	CONSTRAINT "catalog_local_override_heads_lifecycle_ck" CHECK (("lifecycle" = 'ACTIVE' and "active_revision" = "latest_revision") or ("lifecycle" = 'RELEASED' and "active_revision" is null))
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_local_override_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."catalog_local_override_revisions" (
	"tenant_id" uuid,
	"target_kind" text,
	"target_id" uuid,
	"fact_key" text,
	"revision" bigint,
	"lifecycle" text NOT NULL,
	"value" jsonb NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_local_override_revisions_pk" PRIMARY KEY("tenant_id","target_kind","target_id","fact_key","revision"),
	CONSTRAINT "catalog_local_override_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_local_override_revisions_target_kind_ck" CHECK ("target_kind" in ('PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION')),
	CONSTRAINT "catalog_local_override_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_local_override_revisions_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'RELEASED')),
	CONSTRAINT "catalog_local_override_revisions_reason_ck" CHECK (length(btrim("reason")) between 1 and 1000),
	CONSTRAINT "catalog_local_override_revisions_evidence_ck" CHECK (length(btrim("evidence_ref")) between 1 and 1000),
	CONSTRAINT "catalog_local_override_revisions_value_size_ck" CHECK (octet_length("value"::text) between 1 and 65536)
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_local_override_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "catalog_source_assertions_scope_idx" ON "catalog"."catalog_accepted_source_assertions" ("tenant_id","target_kind","target_id","fact_key");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_local_override_heads_one_active_uk" ON "catalog"."catalog_local_override_heads" ("tenant_id","target_kind","target_id","fact_key") WHERE "active_revision" is not null;--> statement-breakpoint
CREATE POLICY "catalog_source_assertions_tenant_select" ON "catalog"."catalog_accepted_source_assertions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_accepted_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_source_assertions_tenant_insert" ON "catalog"."catalog_accepted_source_assertions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_accepted_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_source_assertions_tenant_update" ON "catalog"."catalog_accepted_source_assertions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_accepted_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_accepted_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_source_assertions_tenant_delete" ON "catalog"."catalog_accepted_source_assertions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_accepted_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_heads_tenant_select" ON "catalog"."catalog_local_override_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_local_override_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_heads_tenant_insert" ON "catalog"."catalog_local_override_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_local_override_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_heads_tenant_update" ON "catalog"."catalog_local_override_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_local_override_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_local_override_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_heads_tenant_delete" ON "catalog"."catalog_local_override_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_local_override_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_revisions_tenant_select" ON "catalog"."catalog_local_override_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_local_override_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_revisions_tenant_insert" ON "catalog"."catalog_local_override_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_local_override_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_revisions_tenant_update" ON "catalog"."catalog_local_override_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_local_override_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_local_override_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_local_override_revisions_tenant_delete" ON "catalog"."catalog_local_override_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_local_override_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_accepted_source_assertions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_local_override_heads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_local_override_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_accepted_source_assertions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."catalog_accepted_source_assertions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_local_override_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."catalog_local_override_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "catalog"."protect_local_override_head_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.fact_key IS DISTINCT FROM OLD.fact_key THEN
    RAISE EXCEPTION 'catalog local override head identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_local_override_heads_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."catalog_local_override_heads"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_local_override_head_identity"();
