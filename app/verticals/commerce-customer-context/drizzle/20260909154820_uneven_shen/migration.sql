CREATE TABLE "commerce_customer_context"."approval_decisions" (
	"approval_decision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"decision_resource_id" text NOT NULL,
	"request_resource_id" text NOT NULL,
	"proposal_revision_resource_id" text NOT NULL,
	"decision" text NOT NULL,
	"level_order" integer NOT NULL,
	"request_revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"decision_snapshot" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_approval_decisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","approval_decision_id"),
	CONSTRAINT "ccc_approval_decisions_resource_uk" UNIQUE("tenant_id","legal_entity_id","decision_resource_id"),
	CONSTRAINT "ccc_approval_decisions_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_approval_decisions_kind_ck" CHECK ("decision" in ('APPROVE', 'RETURN', 'REJECT')),
	CONSTRAINT "ccc_approval_decisions_level_ck" CHECK ("level_order" > 0 and "request_revision" > 0),
	CONSTRAINT "ccc_approval_decisions_snapshot_ck" CHECK (jsonb_typeof("decision_snapshot") = 'object'),
	CONSTRAINT "ccc_approval_decisions_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0)),
	CONSTRAINT "ccc_approval_decisions_resource_ck" CHECK ("decision_resource_id" = btrim("decision_resource_id") and length("decision_resource_id") > 0),
	CONSTRAINT "ccc_approval_decisions_request_ck" CHECK ("request_resource_id" = btrim("request_resource_id") and length("request_resource_id") > 0),
	CONSTRAINT "ccc_approval_decisions_proposal_ck" CHECK ("proposal_revision_resource_id" = btrim("proposal_revision_resource_id") and length("proposal_revision_resource_id") > 0),
	CONSTRAINT "ccc_approval_decisions_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."approval_hierarchies" (
	"approval_hierarchy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"hierarchy_resource_id" text NOT NULL,
	"revision" integer NOT NULL,
	"counterparty_resource_ref" text NOT NULL,
	"storefront_id" text,
	"minimum_amount" numeric(38,9) NOT NULL,
	"minimum_currency_code" text NOT NULL,
	"maximum_amount" numeric(38,9),
	"maximum_currency_code" text,
	"hierarchy_snapshot" jsonb NOT NULL,
	"self_approval_policy" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"owner_principal_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_approval_hierarchies_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","approval_hierarchy_id"),
	CONSTRAINT "ccc_approval_hierarchies_resource_revision_uk" UNIQUE("tenant_id","legal_entity_id","hierarchy_resource_id","revision"),
	CONSTRAINT "ccc_approval_hierarchies_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_approval_hierarchies_snapshot_ck" CHECK (jsonb_typeof("hierarchy_snapshot") = 'object'),
	CONSTRAINT "ccc_approval_hierarchies_self_policy_ck" CHECK ("self_approval_policy" in ('DENY', 'ALLOW')),
	CONSTRAINT "ccc_approval_hierarchies_currency_ck" CHECK ("minimum_currency_code" ~ '^[A-Z]{3}$' and ("maximum_currency_code" is null or "maximum_currency_code" ~ '^[A-Z]{3}$')),
	CONSTRAINT "ccc_approval_hierarchies_range_ck" CHECK ("maximum_amount" is null or ("maximum_currency_code" = "minimum_currency_code" and "maximum_amount" >= "minimum_amount")),
	CONSTRAINT "ccc_approval_hierarchies_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_approval_hierarchies_resource_ck" CHECK ("hierarchy_resource_id" = btrim("hierarchy_resource_id") and length("hierarchy_resource_id") > 0),
	CONSTRAINT "ccc_approval_hierarchies_counterparty_ref_ck" CHECK ("counterparty_resource_ref" = btrim("counterparty_resource_ref") and length("counterparty_resource_ref") > 0),
	CONSTRAINT "ccc_approval_hierarchies_storefront_ck" CHECK ("storefront_id" is null or ("storefront_id" = btrim("storefront_id") and length("storefront_id") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_hierarchies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_hierarchies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."approval_revalidations" (
	"approval_revalidation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"revalidation_resource_id" text NOT NULL,
	"request_resource_id" text NOT NULL,
	"proposal_revision_resource_id" text NOT NULL,
	"status" text NOT NULL,
	"proposal_hash" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_approval_revalidations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","approval_revalidation_id"),
	CONSTRAINT "ccc_approval_revalidations_resource_uk" UNIQUE("tenant_id","legal_entity_id","revalidation_resource_id"),
	CONSTRAINT "ccc_approval_revalidations_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_approval_revalidations_status_ck" CHECK ("status" in ('APPROVAL_VALID', 'ALREADY_CONSUMED', 'INVALID')),
	CONSTRAINT "ccc_approval_revalidations_hash_ck" CHECK ("proposal_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ccc_approval_revalidations_evidence_ck" CHECK (jsonb_typeof("evidence") = 'object'),
	CONSTRAINT "ccc_approval_revalidations_period_ck" CHECK ("valid_until" > "checked_at"),
	CONSTRAINT "ccc_approval_revalidations_resource_ck" CHECK ("revalidation_resource_id" = btrim("revalidation_resource_id") and length("revalidation_resource_id") > 0),
	CONSTRAINT "ccc_approval_revalidations_request_ck" CHECK ("request_resource_id" = btrim("request_resource_id") and length("request_resource_id") > 0),
	CONSTRAINT "ccc_approval_revalidations_proposal_ck" CHECK ("proposal_revision_resource_id" = btrim("proposal_revision_resource_id") and length("proposal_revision_resource_id") > 0),
	CONSTRAINT "ccc_approval_revalidations_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_revalidations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_revalidations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."approval_routes" (
	"approval_route_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"route_resource_id" text NOT NULL,
	"request_resource_id" text NOT NULL,
	"proposal_revision_resource_id" text NOT NULL,
	"hierarchy_resource_id" text NOT NULL,
	"hierarchy_revision" integer NOT NULL,
	"route_snapshot" jsonb NOT NULL,
	"current_level_order" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"reroute_reason" text,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_approval_routes_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","approval_route_id"),
	CONSTRAINT "ccc_approval_routes_resource_uk" UNIQUE("tenant_id","legal_entity_id","route_resource_id"),
	CONSTRAINT "ccc_approval_routes_snapshot_ck" CHECK (jsonb_typeof("route_snapshot") = 'object'),
	CONSTRAINT "ccc_approval_routes_level_ck" CHECK ("hierarchy_revision" > 0 and "current_level_order" > 0),
	CONSTRAINT "ccc_approval_routes_status_ck" CHECK ("status" in ('PENDING', 'APPROVED', 'REROUTE_REQUIRED', 'SUPERSEDED')),
	CONSTRAINT "ccc_approval_routes_resource_ck" CHECK ("route_resource_id" = btrim("route_resource_id") and length("route_resource_id") > 0),
	CONSTRAINT "ccc_approval_routes_request_ck" CHECK ("request_resource_id" = btrim("request_resource_id") and length("request_resource_id") > 0),
	CONSTRAINT "ccc_approval_routes_proposal_ck" CHECK ("proposal_revision_resource_id" = btrim("proposal_revision_resource_id") and length("proposal_revision_resource_id") > 0),
	CONSTRAINT "ccc_approval_routes_hierarchy_ck" CHECK ("hierarchy_resource_id" = btrim("hierarchy_resource_id") and length("hierarchy_resource_id") > 0),
	CONSTRAINT "ccc_approval_routes_reason_ck" CHECK ("reroute_reason" is null or ("reroute_reason" = btrim("reroute_reason") and length("reroute_reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."approval_routes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."purchase_approval_requests" (
	"purchase_approval_request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"request_resource_id" text NOT NULL,
	"proposal_revision_resource_id" text NOT NULL,
	"route_resource_id" text NOT NULL,
	"request_revision" integer DEFAULT 1 NOT NULL,
	"request_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"last_decision_resource_id" text,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_approval_requests_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","purchase_approval_request_id"),
	CONSTRAINT "ccc_approval_requests_resource_uk" UNIQUE("tenant_id","legal_entity_id","request_resource_id"),
	CONSTRAINT "ccc_approval_requests_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_approval_requests_revision_ck" CHECK ("request_revision" > 0),
	CONSTRAINT "ccc_approval_requests_snapshot_ck" CHECK (jsonb_typeof("request_snapshot") = 'object'),
	CONSTRAINT "ccc_approval_requests_status_ck" CHECK ("status" in ('PENDING', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED', 'CONSUMED')),
	CONSTRAINT "ccc_approval_requests_consumed_ck" CHECK (("status" = 'CONSUMED' and "consumed_at" is not null) or ("status" <> 'CONSUMED' and "consumed_at" is null)),
	CONSTRAINT "ccc_approval_requests_resource_ck" CHECK ("request_resource_id" = btrim("request_resource_id") and length("request_resource_id") > 0),
	CONSTRAINT "ccc_approval_requests_proposal_ck" CHECK ("proposal_revision_resource_id" = btrim("proposal_revision_resource_id") and length("proposal_revision_resource_id") > 0),
	CONSTRAINT "ccc_approval_requests_route_ck" CHECK ("route_resource_id" = btrim("route_resource_id") and length("route_resource_id") > 0),
	CONSTRAINT "ccc_approval_requests_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_approval_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."purchase_proposal_revisions" (
	"purchase_proposal_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"proposal_revision_resource_id" text NOT NULL,
	"revision" integer NOT NULL,
	"proposal_sequence" integer NOT NULL,
	"buyer_principal_id" uuid NOT NULL,
	"counterparty_resource_ref" text NOT NULL,
	"profile_resource_ref" text NOT NULL,
	"storefront_id" text NOT NULL,
	"proposal_snapshot" jsonb NOT NULL,
	"source_revision_vector" jsonb NOT NULL,
	"canonicalization_version" text NOT NULL,
	"canonical_hash" text NOT NULL,
	"state" text DEFAULT 'CURRENT' NOT NULL,
	"approval_evaluation" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_purchase_proposals_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","purchase_proposal_revision_id"),
	CONSTRAINT "ccc_purchase_proposals_resource_revision_uk" UNIQUE("tenant_id","legal_entity_id","proposal_revision_resource_id","revision"),
	CONSTRAINT "ccc_purchase_proposals_hash_uk" UNIQUE("tenant_id","legal_entity_id","proposal_revision_resource_id","canonical_hash"),
	CONSTRAINT "ccc_purchase_proposals_revision_ck" CHECK ("revision" > 0 and "proposal_sequence" > 0),
	CONSTRAINT "ccc_purchase_proposals_snapshot_ck" CHECK (jsonb_typeof("proposal_snapshot") = 'object' and jsonb_typeof("source_revision_vector") = 'array'),
	CONSTRAINT "ccc_purchase_proposals_hash_ck" CHECK ("canonical_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ccc_purchase_proposals_state_ck" CHECK ("state" in ('CURRENT', 'SUPERSEDED', 'CONSUMED', 'CANCELLED')),
	CONSTRAINT "ccc_purchase_proposals_approval_ck" CHECK ("approval_evaluation" in ('APPROVAL_REQUIRED', 'WITHIN_LIMIT')),
	CONSTRAINT "ccc_purchase_proposals_resource_ck" CHECK ("proposal_revision_resource_id" = btrim("proposal_revision_resource_id") and length("proposal_revision_resource_id") > 0),
	CONSTRAINT "ccc_purchase_proposals_counterparty_ref_ck" CHECK ("counterparty_resource_ref" = btrim("counterparty_resource_ref") and length("counterparty_resource_ref") > 0),
	CONSTRAINT "ccc_purchase_proposals_profile_ref_ck" CHECK ("profile_resource_ref" = btrim("profile_resource_ref") and length("profile_resource_ref") > 0),
	CONSTRAINT "ccc_purchase_proposals_storefront_ck" CHECK ("storefront_id" = btrim("storefront_id") and length("storefront_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_proposal_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_proposal_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ccc_approval_decisions_scope_select" ON "commerce_customer_context"."approval_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."approval_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_decisions_scope_insert" ON "commerce_customer_context"."approval_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."approval_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_decisions_scope_update" ON "commerce_customer_context"."approval_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."approval_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_decisions_scope_delete" ON "commerce_customer_context"."approval_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."approval_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_decisions_scope_owner_routine" ON "commerce_customer_context"."approval_decisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."approval_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_hierarchies_scope_select" ON "commerce_customer_context"."approval_hierarchies" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."approval_hierarchies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_hierarchies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_hierarchies_scope_insert" ON "commerce_customer_context"."approval_hierarchies" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."approval_hierarchies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_hierarchies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_hierarchies_scope_update" ON "commerce_customer_context"."approval_hierarchies" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."approval_hierarchies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_hierarchies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_hierarchies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_hierarchies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_hierarchies_scope_delete" ON "commerce_customer_context"."approval_hierarchies" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."approval_hierarchies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_hierarchies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_hierarchies_scope_owner_routine" ON "commerce_customer_context"."approval_hierarchies" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."approval_hierarchies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_hierarchies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_hierarchies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_hierarchies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_revalidations_scope_select" ON "commerce_customer_context"."approval_revalidations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."approval_revalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_revalidations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_revalidations_scope_insert" ON "commerce_customer_context"."approval_revalidations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."approval_revalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_revalidations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_revalidations_scope_update" ON "commerce_customer_context"."approval_revalidations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."approval_revalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_revalidations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_revalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_revalidations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_revalidations_scope_delete" ON "commerce_customer_context"."approval_revalidations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."approval_revalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_revalidations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_revalidations_scope_owner_routine" ON "commerce_customer_context"."approval_revalidations" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."approval_revalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_revalidations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_revalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_revalidations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_routes_scope_select" ON "commerce_customer_context"."approval_routes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."approval_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_routes_scope_insert" ON "commerce_customer_context"."approval_routes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."approval_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_routes_scope_update" ON "commerce_customer_context"."approval_routes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."approval_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_routes_scope_delete" ON "commerce_customer_context"."approval_routes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."approval_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_routes_scope_owner_routine" ON "commerce_customer_context"."approval_routes" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."approval_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."approval_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."approval_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_requests_scope_select" ON "commerce_customer_context"."purchase_approval_requests" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."purchase_approval_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_approval_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_requests_scope_insert" ON "commerce_customer_context"."purchase_approval_requests" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."purchase_approval_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_approval_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_requests_scope_update" ON "commerce_customer_context"."purchase_approval_requests" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_approval_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_approval_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_approval_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_approval_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_requests_scope_delete" ON "commerce_customer_context"."purchase_approval_requests" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_approval_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_approval_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_approval_requests_scope_owner_routine" ON "commerce_customer_context"."purchase_approval_requests" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."purchase_approval_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_approval_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_approval_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_approval_requests"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_proposals_scope_select" ON "commerce_customer_context"."purchase_proposal_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."purchase_proposal_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_proposals_scope_insert" ON "commerce_customer_context"."purchase_proposal_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."purchase_proposal_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_proposals_scope_update" ON "commerce_customer_context"."purchase_proposal_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_proposal_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_proposal_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_proposals_scope_delete" ON "commerce_customer_context"."purchase_proposal_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_proposal_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_proposals_scope_owner_routine" ON "commerce_customer_context"."purchase_proposal_revisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."purchase_proposal_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_proposal_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
