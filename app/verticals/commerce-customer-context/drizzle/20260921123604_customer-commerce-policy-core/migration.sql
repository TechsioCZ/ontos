CREATE TABLE "commerce_customer_context"."commerce_quantity_rule_assignments" (
	"quantity_rule_assignment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"profile_kind" text NOT NULL,
	"profile_resource_id" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_quantity_rule_assignments_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","quantity_rule_assignment_id"),
	CONSTRAINT "ccc_quantity_rule_assignments_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_quantity_rule_assignments_profile_ck" CHECK ("profile_kind" in ('RETAIL', 'COUNTERPARTY')),
	CONSTRAINT "ccc_quantity_rule_assignments_lifecycle_ck" CHECK ("lifecycle" in ('SCHEDULED', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "ccc_quantity_rule_assignments_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_quantity_rule_assignments_profile_resource_ck" CHECK ("profile_resource_id" = btrim("profile_resource_id") and length("profile_resource_id") > 0),
	CONSTRAINT "ccc_quantity_rule_assignments_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0),
	CONSTRAINT "ccc_quantity_rule_assignments_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" (
	"policy_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"channel_id" text,
	"commerce_market_id" text,
	"storefront_id" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"selector_kind" text NOT NULL,
	"selector_resource_module_id" text,
	"selector_resource_type" text,
	"selector_resource_id" text,
	"selector_tenant_id" uuid,
	"rule_kind" text NOT NULL,
	"quantity_basis_module_id" text NOT NULL,
	"quantity_basis_resource_type" text NOT NULL,
	"quantity_basis_resource_id" text NOT NULL,
	"quantity_basis_tenant_id" uuid NOT NULL,
	"quantity_basis_owner_revision" text NOT NULL,
	"quantity_unit_module_id" text NOT NULL,
	"quantity_unit_resource_type" text NOT NULL,
	"quantity_unit_resource_id" text NOT NULL,
	"quantity_unit_tenant_id" uuid NOT NULL,
	"restriction_kind" text NOT NULL,
	"minimum" text,
	"maximum" text,
	"multiple" text,
	CONSTRAINT "ccc_quantity_rule_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","policy_revision_id"),
	CONSTRAINT "ccc_quantity_rule_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_quantity_rule_scope_ck" CHECK (("scope_kind" = 'SELLER' and "channel_id" is null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is null) or ("scope_kind" = 'STOREFRONT_MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is not null) or ("scope_kind" = 'STOREFRONT_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is not null)),
	CONSTRAINT "ccc_quantity_rule_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_quantity_rule_lifecycle_ck" CHECK ("lifecycle" in ('SCHEDULED', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "ccc_quantity_rule_channel_ck" CHECK ("channel_id" is null or ("channel_id" = btrim("channel_id") and length("channel_id") > 0)),
	CONSTRAINT "ccc_quantity_rule_market_ck" CHECK ("commerce_market_id" is null or ("commerce_market_id" = btrim("commerce_market_id") and length("commerce_market_id") > 0)),
	CONSTRAINT "ccc_quantity_rule_storefront_ck" CHECK ("storefront_id" is null or ("storefront_id" = btrim("storefront_id") and length("storefront_id") > 0)),
	CONSTRAINT "ccc_quantity_rule_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0),
	CONSTRAINT "ccc_quantity_rule_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0),
	CONSTRAINT "ccc_quantity_rule_field_scope_ck" CHECK ("scope_kind" in ('CHANNEL_SELLER', 'MARKET_CHANNEL_SELLER', 'STOREFRONT_MARKET_CHANNEL_SELLER')),
	CONSTRAINT "ccc_quantity_rule_selector_ck" CHECK (("selector_kind" = 'ALL' and "selector_resource_module_id" is null and "selector_resource_type" is null and "selector_resource_id" is null and "selector_tenant_id" is null) or ("selector_kind" = 'PRODUCT' and "selector_resource_module_id" = 'commerce.catalog' and "selector_resource_type" = 'commerce.catalog.product' and "selector_resource_id" is not null and "selector_tenant_id" = "tenant_id") or ("selector_kind" = 'VARIANT' and "selector_resource_module_id" = 'commerce.catalog' and "selector_resource_type" = 'commerce.catalog.variant' and "selector_resource_id" is not null and "selector_tenant_id" = "tenant_id") or ("selector_kind" = 'PACKAGE_OPTION' and "selector_resource_module_id" = 'commerce.catalog' and "selector_resource_type" = 'commerce.catalog.package-option' and "selector_resource_id" is not null and "selector_tenant_id" = "tenant_id")),
	CONSTRAINT "ccc_quantity_rule_kind_ck" CHECK ("rule_kind" in ('REPLACEABLE_ENVELOPE', 'NON_RELAXABLE_CONSTRAINT')),
	CONSTRAINT "ccc_quantity_rule_basis_ck" CHECK ("quantity_basis_module_id" = 'commerce.catalog' and "quantity_basis_resource_type" = 'commerce.catalog.quantity-basis' and "quantity_basis_tenant_id" = "tenant_id" and "quantity_unit_module_id" = 'commerce.catalog' and "quantity_unit_resource_type" = 'commerce.catalog.quantity-unit' and "quantity_unit_tenant_id" = "tenant_id"),
	CONSTRAINT "ccc_quantity_rule_restriction_ck" CHECK (("restriction_kind" = 'NO_COMMERCIAL_QUANTITY_RESTRICTION' and "minimum" is null and "maximum" is null and "multiple" is null) or ("restriction_kind" = 'BOUNDED' and ("minimum" is null or (length("minimum") <= 80 and "minimum" ~ '^(?:[1-9][0-9]*(?:[.][0-9]+)?|0[.]0*[1-9][0-9]*)$')) and ("maximum" is null or (length("maximum") <= 80 and "maximum" ~ '^(?:[1-9][0-9]*(?:[.][0-9]+)?|0[.]0*[1-9][0-9]*)$')) and ("multiple" is null or (length("multiple") <= 80 and "multiple" ~ '^(?:[1-9][0-9]*(?:[.][0-9]+)?|0[.]0*[1-9][0-9]*)$')) and ("minimum" is not null or "maximum" is not null or "multiple" is not null) and ("minimum" is null or "maximum" is null or "maximum"::numeric >= "minimum"::numeric))),
	CONSTRAINT "ccc_quantity_rule_selector_resource_ck" CHECK ("selector_resource_id" is null or ("selector_resource_id" = btrim("selector_resource_id") and length("selector_resource_id") > 0)),
	CONSTRAINT "ccc_quantity_rule_basis_resource_ck" CHECK ("quantity_basis_resource_id" = btrim("quantity_basis_resource_id") and length("quantity_basis_resource_id") > 0),
	CONSTRAINT "ccc_quantity_rule_basis_revision_ck" CHECK ("quantity_basis_owner_revision" = btrim("quantity_basis_owner_revision") and length("quantity_basis_owner_revision") > 0),
	CONSTRAINT "ccc_quantity_rule_unit_resource_ck" CHECK ("quantity_unit_resource_id" = btrim("quantity_unit_resource_id") and length("quantity_unit_resource_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_commerce_policy_completeness_generations" (
	"customer_commerce_policy_completeness_generation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"field_family" text NOT NULL,
	"generation" bigint NOT NULL,
	"predicate_ref" text NOT NULL,
	"owner_revision" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"next_applicability_boundary" timestamp with time zone,
	"state_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ccc_policy_generations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_commerce_policy_completeness_generation_id"),
	CONSTRAINT "ccc_policy_generations_family_uk" UNIQUE("tenant_id","legal_entity_id","field_family"),
	CONSTRAINT "ccc_policy_generations_family_ck" CHECK ("field_family" in ('MARKET_BOOTSTRAP', 'PURCHASE_CURRENCY', 'PAYMENT_TERM', 'COMMERCE_QUANTITY_RULE', 'COMMERCE_QUANTITY_ASSIGNMENT')),
	CONSTRAINT "ccc_policy_generations_generation_ck" CHECK ("generation" > 0),
	CONSTRAINT "ccc_policy_generations_owner_revision_ck" CHECK ("owner_revision" = "field_family" || ':' || "generation"::text),
	CONSTRAINT "ccc_policy_generations_predicate_family_ck" CHECK (("field_family" = 'MARKET_BOOTSTRAP' and "predicate_ref" = 'commerce.customer-context.policy.market_bootstrap.current') or ("field_family" = 'PURCHASE_CURRENCY' and "predicate_ref" = 'commerce.customer-context.policy.purchase_currency.current') or ("field_family" = 'PAYMENT_TERM' and "predicate_ref" = 'commerce.customer-context.policy.payment_term.current') or ("field_family" = 'COMMERCE_QUANTITY_RULE' and "predicate_ref" = 'commerce.customer-context.policy.commerce_quantity_rule.current') or ("field_family" = 'COMMERCE_QUANTITY_ASSIGNMENT' and "predicate_ref" = 'commerce.customer-context.policy.commerce_quantity_assignment.current')),
	CONSTRAINT "ccc_policy_generations_boundary_ck" CHECK ("next_applicability_boundary" is null or "next_applicability_boundary" > "observed_at"),
	CONSTRAINT "ccc_policy_generations_metadata_ck" CHECK (jsonb_typeof("state_metadata") = 'object'),
	CONSTRAINT "ccc_policy_generations_predicate_ck" CHECK ("predicate_ref" = btrim("predicate_ref") and length("predicate_ref") > 0),
	CONSTRAINT "ccc_policy_generations_revision_ck" CHECK ("owner_revision" = btrim("owner_revision") and length("owner_revision") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_commerce_policy_completeness_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."market_bootstrap_policy_revisions" (
	"policy_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"channel_id" text,
	"commerce_market_id" text,
	"storefront_id" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"default_channel_id" text NOT NULL,
	"default_commerce_market_id" text NOT NULL,
	"default_selling_legal_entity_id" uuid NOT NULL,
	CONSTRAINT "ccc_market_bootstrap_policy_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","policy_revision_id"),
	CONSTRAINT "ccc_market_bootstrap_policy_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_market_bootstrap_policy_scope_ck" CHECK (("scope_kind" = 'SELLER' and "channel_id" is null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is null) or ("scope_kind" = 'STOREFRONT_MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is not null) or ("scope_kind" = 'STOREFRONT_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is not null)),
	CONSTRAINT "ccc_market_bootstrap_policy_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_market_bootstrap_policy_lifecycle_ck" CHECK ("lifecycle" in ('SCHEDULED', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "ccc_market_bootstrap_policy_channel_ck" CHECK ("channel_id" is null or ("channel_id" = btrim("channel_id") and length("channel_id") > 0)),
	CONSTRAINT "ccc_market_bootstrap_policy_market_ck" CHECK ("commerce_market_id" is null or ("commerce_market_id" = btrim("commerce_market_id") and length("commerce_market_id") > 0)),
	CONSTRAINT "ccc_market_bootstrap_policy_storefront_ck" CHECK ("storefront_id" is null or ("storefront_id" = btrim("storefront_id") and length("storefront_id") > 0)),
	CONSTRAINT "ccc_market_bootstrap_policy_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0),
	CONSTRAINT "ccc_market_bootstrap_policy_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0),
	CONSTRAINT "ccc_market_bootstrap_policy_selector_ck" CHECK ("scope_kind" in ('SELLER', 'CHANNEL_SELLER', 'STOREFRONT_CHANNEL_SELLER') and "commerce_market_id" is null),
	CONSTRAINT "ccc_market_bootstrap_policy_default_market_ck" CHECK ("default_commerce_market_id" = btrim("default_commerce_market_id") and length("default_commerce_market_id") > 0),
	CONSTRAINT "ccc_market_bootstrap_policy_default_channel_ck" CHECK ("default_channel_id" = btrim("default_channel_id") and length("default_channel_id") > 0),
	CONSTRAINT "ccc_market_bootstrap_policy_default_seller_ck" CHECK ("default_selling_legal_entity_id" = "legal_entity_id"),
	CONSTRAINT "ccc_market_bootstrap_policy_default_scope_ck" CHECK (("scope_kind" = 'SELLER') or ("scope_kind" in ('CHANNEL_SELLER', 'STOREFRONT_CHANNEL_SELLER') and "default_channel_id" = "channel_id"))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."payment_term_policy_revisions" (
	"policy_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"channel_id" text,
	"commerce_market_id" text,
	"storefront_id" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_kind" text NOT NULL,
	"payment_term_resource_id" text,
	"enabled" boolean,
	CONSTRAINT "ccc_payment_term_policy_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","policy_revision_id"),
	CONSTRAINT "ccc_payment_term_policy_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_payment_term_policy_scope_ck" CHECK (("scope_kind" = 'SELLER' and "channel_id" is null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is null) or ("scope_kind" = 'STOREFRONT_MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is not null) or ("scope_kind" = 'STOREFRONT_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is not null)),
	CONSTRAINT "ccc_payment_term_policy_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_payment_term_policy_lifecycle_ck" CHECK ("lifecycle" in ('SCHEDULED', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "ccc_payment_term_policy_channel_ck" CHECK ("channel_id" is null or ("channel_id" = btrim("channel_id") and length("channel_id") > 0)),
	CONSTRAINT "ccc_payment_term_policy_market_ck" CHECK ("commerce_market_id" is null or ("commerce_market_id" = btrim("commerce_market_id") and length("commerce_market_id") > 0)),
	CONSTRAINT "ccc_payment_term_policy_storefront_ck" CHECK ("storefront_id" is null or ("storefront_id" = btrim("storefront_id") and length("storefront_id") > 0)),
	CONSTRAINT "ccc_payment_term_policy_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0),
	CONSTRAINT "ccc_payment_term_policy_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0),
	CONSTRAINT "ccc_payment_term_policy_field_scope_ck" CHECK ("scope_kind" in ('SELLER', 'CHANNEL_SELLER', 'MARKET_CHANNEL_SELLER', 'STOREFRONT_MARKET_CHANNEL_SELLER')),
	CONSTRAINT "ccc_payment_term_policy_value_ck" CHECK (("rule_kind" in ('APPLICABLE_PAYMENT_TERM_CONSTRAINT', 'FALLBACK_PAYMENT_TERM') and "payment_term_resource_id" is not null and "enabled" is null) or ("rule_kind" = 'EXPLICIT_PAYMENT_TERM_CHOICE_POLICY' and "payment_term_resource_id" is null and "enabled" is not null)),
	CONSTRAINT "ccc_payment_term_policy_resource_ck" CHECK ("payment_term_resource_id" is null or ("payment_term_resource_id" = btrim("payment_term_resource_id") and length("payment_term_resource_id") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."payment_term_policy_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."purchase_currency_policy_revisions" (
	"policy_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"channel_id" text,
	"commerce_market_id" text,
	"storefront_id" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_kind" text NOT NULL,
	"currency_code" text,
	CONSTRAINT "ccc_purchase_currency_policy_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","policy_revision_id"),
	CONSTRAINT "ccc_purchase_currency_policy_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_purchase_currency_policy_scope_ck" CHECK (("scope_kind" = 'SELLER' and "channel_id" is null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is null) or ("scope_kind" = 'MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is null) or ("scope_kind" = 'STOREFRONT_MARKET_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is not null and "storefront_id" is not null) or ("scope_kind" = 'STOREFRONT_CHANNEL_SELLER' and "channel_id" is not null and "commerce_market_id" is null and "storefront_id" is not null)),
	CONSTRAINT "ccc_purchase_currency_policy_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_purchase_currency_policy_lifecycle_ck" CHECK ("lifecycle" in ('SCHEDULED', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "ccc_purchase_currency_policy_channel_ck" CHECK ("channel_id" is null or ("channel_id" = btrim("channel_id") and length("channel_id") > 0)),
	CONSTRAINT "ccc_purchase_currency_policy_market_ck" CHECK ("commerce_market_id" is null or ("commerce_market_id" = btrim("commerce_market_id") and length("commerce_market_id") > 0)),
	CONSTRAINT "ccc_purchase_currency_policy_storefront_ck" CHECK ("storefront_id" is null or ("storefront_id" = btrim("storefront_id") and length("storefront_id") > 0)),
	CONSTRAINT "ccc_purchase_currency_policy_idempotency_ck" CHECK ("idempotency_key" = btrim("idempotency_key") and length("idempotency_key") > 0),
	CONSTRAINT "ccc_purchase_currency_policy_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0),
	CONSTRAINT "ccc_purchase_currency_policy_field_scope_ck" CHECK ("scope_kind" in ('SELLER', 'CHANNEL_SELLER', 'MARKET_CHANNEL_SELLER', 'STOREFRONT_MARKET_CHANNEL_SELLER')),
	CONSTRAINT "ccc_purchase_currency_policy_value_ck" CHECK ("rule_kind" in ('ALLOWED_CURRENCY_CONSTRAINT', 'DEFAULT_CURRENCY') and "currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_currency_policy_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_assignments" ADD CONSTRAINT "ccc_quantity_rule_assignments_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","policy_revision_id") REFERENCES "commerce_customer_context"."commerce_quantity_rule_revisions"("tenant_id","legal_entity_id","policy_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_assignments_rls_select" ON "commerce_customer_context"."commerce_quantity_rule_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."commerce_quantity_rule_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_assignments_rls_insert" ON "commerce_customer_context"."commerce_quantity_rule_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."commerce_quantity_rule_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_assignments_rls_update" ON "commerce_customer_context"."commerce_quantity_rule_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."commerce_quantity_rule_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."commerce_quantity_rule_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_assignments_rls_delete" ON "commerce_customer_context"."commerce_quantity_rule_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."commerce_quantity_rule_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_assignments_rls_owner_routine" ON "commerce_customer_context"."commerce_quantity_rule_assignments" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."commerce_quantity_rule_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."commerce_quantity_rule_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_rls_select" ON "commerce_customer_context"."commerce_quantity_rule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."commerce_quantity_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_rls_insert" ON "commerce_customer_context"."commerce_quantity_rule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."commerce_quantity_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_rls_update" ON "commerce_customer_context"."commerce_quantity_rule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."commerce_quantity_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."commerce_quantity_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_rls_delete" ON "commerce_customer_context"."commerce_quantity_rule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."commerce_quantity_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_quantity_rule_rls_owner_routine" ON "commerce_customer_context"."commerce_quantity_rule_revisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."commerce_quantity_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."commerce_quantity_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."commerce_quantity_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_policy_generations_rls_select" ON "commerce_customer_context"."customer_commerce_policy_completeness_generations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_commerce_policy_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_commerce_policy_completeness_generations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_policy_generations_rls_insert" ON "commerce_customer_context"."customer_commerce_policy_completeness_generations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_commerce_policy_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_commerce_policy_completeness_generations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_policy_generations_rls_update" ON "commerce_customer_context"."customer_commerce_policy_completeness_generations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_commerce_policy_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_commerce_policy_completeness_generations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_commerce_policy_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_commerce_policy_completeness_generations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_policy_generations_rls_delete" ON "commerce_customer_context"."customer_commerce_policy_completeness_generations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_commerce_policy_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_commerce_policy_completeness_generations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_policy_generations_rls_owner_routine" ON "commerce_customer_context"."customer_commerce_policy_completeness_generations" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_commerce_policy_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_commerce_policy_completeness_generations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_commerce_policy_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_commerce_policy_completeness_generations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_policy_rls_select" ON "commerce_customer_context"."market_bootstrap_policy_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_bootstrap_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_policy_rls_insert" ON "commerce_customer_context"."market_bootstrap_policy_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_bootstrap_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_policy_rls_update" ON "commerce_customer_context"."market_bootstrap_policy_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_bootstrap_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_bootstrap_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_policy_rls_delete" ON "commerce_customer_context"."market_bootstrap_policy_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_bootstrap_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_policy_rls_owner_routine" ON "commerce_customer_context"."market_bootstrap_policy_revisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."market_bootstrap_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_bootstrap_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_bootstrap_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_policy_rls_select" ON "commerce_customer_context"."payment_term_policy_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."payment_term_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_policy_rls_insert" ON "commerce_customer_context"."payment_term_policy_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."payment_term_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_policy_rls_update" ON "commerce_customer_context"."payment_term_policy_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."payment_term_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."payment_term_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_policy_rls_delete" ON "commerce_customer_context"."payment_term_policy_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."payment_term_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_term_policy_rls_owner_routine" ON "commerce_customer_context"."payment_term_policy_revisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."payment_term_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."payment_term_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."payment_term_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_currency_policy_rls_select" ON "commerce_customer_context"."purchase_currency_policy_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."purchase_currency_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_currency_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_currency_policy_rls_insert" ON "commerce_customer_context"."purchase_currency_policy_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."purchase_currency_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_currency_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_currency_policy_rls_update" ON "commerce_customer_context"."purchase_currency_policy_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_currency_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_currency_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_currency_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_currency_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_currency_policy_rls_delete" ON "commerce_customer_context"."purchase_currency_policy_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_currency_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_currency_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_purchase_currency_policy_rls_owner_routine" ON "commerce_customer_context"."purchase_currency_policy_revisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."purchase_currency_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_currency_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_currency_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_currency_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."market_bootstrap_policy_candidate_generations" (
	"tenant_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"predicate_ref" text NOT NULL,
	"owner_revision" text NOT NULL,
	"declared_scope_ref" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"next_applicability_boundary" timestamp with time zone,
	CONSTRAINT "ccc_market_bootstrap_candidate_generations_owner_uk" UNIQUE("tenant_id","selling_legal_entity_id"),
	CONSTRAINT "ccc_market_bootstrap_candidate_generations_generation_ck" CHECK ("generation" > 0),
	CONSTRAINT "ccc_market_bootstrap_candidate_generations_owner_revision_ck" CHECK ("owner_revision" = 'MARKET_BOOTSTRAP:' || "tenant_id"::text || ':' || "selling_legal_entity_id"::text || ':' || "generation"::text),
	CONSTRAINT "ccc_market_bootstrap_candidate_generations_predicate_ck" CHECK ("predicate_ref" = 'commerce.customer-context.policy.market_bootstrap.current:' || "tenant_id"::text || ':' || "selling_legal_entity_id"::text),
	CONSTRAINT "ccc_market_bootstrap_candidate_generations_scope_ck" CHECK ("declared_scope_ref" = 'commerce.customer-context.policy.market_bootstrap.all:' || "tenant_id"::text || ':' || "selling_legal_entity_id"::text),
	CONSTRAINT "ccc_market_bootstrap_candidate_generations_boundary_ck" CHECK ("next_applicability_boundary" is null or "next_applicability_boundary" > "observed_at")
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_candidate_generations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" (
	"policy_revision_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"channel_id" text,
	"storefront_id" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"default_channel_id" text NOT NULL,
	"default_commerce_market_id" text NOT NULL,
	CONSTRAINT "ccc_market_bootstrap_candidates_scope_id_uk" UNIQUE("tenant_id","selling_legal_entity_id","policy_revision_id"),
	CONSTRAINT "ccc_market_bootstrap_candidates_scope_ck" CHECK (("scope_kind" = 'SELLER' and "channel_id" is null and "storefront_id" is null) or ("scope_kind" = 'CHANNEL_SELLER' and "channel_id" is not null and "storefront_id" is null) or ("scope_kind" = 'STOREFRONT_CHANNEL_SELLER' and "channel_id" is not null and "storefront_id" is not null)),
	CONSTRAINT "ccc_market_bootstrap_candidates_lifecycle_ck" CHECK ("lifecycle" in ('SCHEDULED', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "ccc_market_bootstrap_candidates_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_market_bootstrap_candidates_activation_ck" CHECK (("activated_at" is null or ("activated_at" >= "effective_from" and ("effective_to" is null or "activated_at" < "effective_to"))) and ("retired_at" is null or ("activated_at" is not null and "retired_at" >= "activated_at" and ("effective_to" is null or "retired_at" <= "effective_to")))),
	CONSTRAINT "ccc_market_bootstrap_candidates_channel_ck" CHECK ("channel_id" is null or ("channel_id" = btrim("channel_id") and length("channel_id") > 0)),
	CONSTRAINT "ccc_market_bootstrap_candidates_storefront_ck" CHECK ("storefront_id" is null or ("storefront_id" = btrim("storefront_id") and length("storefront_id") > 0)),
	CONSTRAINT "ccc_market_bootstrap_candidates_default_channel_ck" CHECK ("default_channel_id" = btrim("default_channel_id") and length("default_channel_id") > 0),
	CONSTRAINT "ccc_market_bootstrap_candidates_default_market_ck" CHECK ("default_commerce_market_id" = btrim("default_commerce_market_id") and length("default_commerce_market_id") > 0),
	CONSTRAINT "ccc_market_bootstrap_candidates_default_scope_ck" CHECK (("scope_kind" = 'SELLER') or ("scope_kind" in ('CHANNEL_SELLER', 'STOREFRONT_CHANNEL_SELLER') and "default_channel_id" = "channel_id"))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" ADD CONSTRAINT "ccc_market_bootstrap_candidates_revision_fk" FOREIGN KEY ("tenant_id","selling_legal_entity_id","policy_revision_id") REFERENCES "commerce_customer_context"."market_bootstrap_policy_revisions"("tenant_id","legal_entity_id","policy_revision_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidate_generations_rls_select" ON "commerce_customer_context"."market_bootstrap_policy_candidate_generations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_candidate_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidate_generations_rls_insert" ON "commerce_customer_context"."market_bootstrap_policy_candidate_generations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_candidate_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidate_generations_rls_update" ON "commerce_customer_context"."market_bootstrap_policy_candidate_generations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_candidate_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_candidate_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidate_generations_rls_delete" ON "commerce_customer_context"."market_bootstrap_policy_candidate_generations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_candidate_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidate_generations_rls_owner_routine" ON "commerce_customer_context"."market_bootstrap_policy_candidate_generations" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."market_bootstrap_policy_candidate_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_candidate_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidates_rls_select" ON "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_candidate_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidates_rls_insert" ON "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_candidate_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidates_rls_update" ON "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_candidate_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_candidate_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidates_rls_delete" ON "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."market_bootstrap_policy_candidate_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "ccc_market_bootstrap_candidates_rls_owner_routine" ON "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."market_bootstrap_policy_candidate_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_bootstrap_policy_candidate_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ADD COLUMN "applicable_from" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ADD COLUMN "applicable_to" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_revisions" ADD COLUMN "applicable_from" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_revisions" ADD COLUMN "applicable_to" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."payment_term_policy_revisions" ADD COLUMN "applicable_from" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."payment_term_policy_revisions" ADD COLUMN "applicable_to" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."purchase_currency_policy_revisions" ADD COLUMN "applicable_from" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."purchase_currency_policy_revisions" ADD COLUMN "applicable_to" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_assignments" ADD COLUMN "applicable_from" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_assignments" ADD COLUMN "applicable_to" timestamp with time zone;
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ADD CONSTRAINT "ccc_quantity_rule_applicability_ck" CHECK (("lifecycle" <> 'ACTIVE' or "applicable_from" is not null) and (("applicable_from" is null and "applicable_to" is null) or ("applicable_from" >= "effective_from" and ("effective_to" is null or "applicable_from" < "effective_to") and ("applicable_to" is null or ("applicable_to" >= "applicable_from" and ("effective_to" is null or "applicable_to" <= "effective_to"))))));
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_revisions" ADD CONSTRAINT "ccc_market_bootstrap_policy_applicability_ck" CHECK (("lifecycle" <> 'ACTIVE' or "applicable_from" is not null) and (("applicable_from" is null and "applicable_to" is null) or ("applicable_from" >= "effective_from" and ("effective_to" is null or "applicable_from" < "effective_to") and ("applicable_to" is null or ("applicable_to" >= "applicable_from" and ("effective_to" is null or "applicable_to" <= "effective_to"))))));
ALTER TABLE "commerce_customer_context"."payment_term_policy_revisions" ADD CONSTRAINT "ccc_payment_term_policy_applicability_ck" CHECK (("lifecycle" <> 'ACTIVE' or "applicable_from" is not null) and (("applicable_from" is null and "applicable_to" is null) or ("applicable_from" >= "effective_from" and ("effective_to" is null or "applicable_from" < "effective_to") and ("applicable_to" is null or ("applicable_to" >= "applicable_from" and ("effective_to" is null or "applicable_to" <= "effective_to"))))));
ALTER TABLE "commerce_customer_context"."purchase_currency_policy_revisions" ADD CONSTRAINT "ccc_purchase_currency_policy_applicability_ck" CHECK (("lifecycle" <> 'ACTIVE' or "applicable_from" is not null) and (("applicable_from" is null and "applicable_to" is null) or ("applicable_from" >= "effective_from" and ("effective_to" is null or "applicable_from" < "effective_to") and ("applicable_to" is null or ("applicable_to" >= "applicable_from" and ("effective_to" is null or "applicable_to" <= "effective_to"))))));
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_assignments" ADD CONSTRAINT "ccc_quantity_rule_assignments_applicability_ck" CHECK (("lifecycle" <> 'ACTIVE' or "applicable_from" is not null) and (("applicable_from" is null and "applicable_to" is null) or ("applicable_from" >= "effective_from" and ("effective_to" is null or "applicable_from" < "effective_to") and ("applicable_to" is null or ("applicable_to" > "applicable_from" and ("effective_to" is null or "applicable_to" <= "effective_to"))))));
--> statement-breakpoint
-- Drizzle owns the typed table definitions above. PostgreSQL owns the temporal, immutability,
-- routine-only access, and compare-and-swap invariants that Drizzle cannot express.
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_revisions"
  ADD CONSTRAINT "ccc_market_bootstrap_policy_no_overlap_excl"
  EXCLUDE USING gist (
    tenant_id WITH =, legal_entity_id WITH =, scope_kind WITH =,
    coalesce(channel_id, '') WITH =, coalesce(storefront_id, '') WITH =,
    (case when applicable_from is null then 'empty'::tstzrange
      else tstzrange(applicable_from, coalesce(applicable_to, 'infinity'::timestamptz), '[)') end) WITH &&
  );
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_currency_policy_revisions"
  ADD CONSTRAINT "ccc_purchase_currency_policy_no_overlap_excl"
  EXCLUDE USING gist (
    tenant_id WITH =, legal_entity_id WITH =, scope_kind WITH =,
    coalesce(channel_id, '') WITH =, coalesce(commerce_market_id, '') WITH =,
    coalesce(storefront_id, '') WITH =, rule_kind WITH =,
    (case when rule_kind = 'ALLOWED_CURRENCY_CONSTRAINT' then currency_code else '' end) WITH =,
    (case when applicable_from is null then 'empty'::tstzrange
      else tstzrange(applicable_from, coalesce(applicable_to, 'infinity'::timestamptz), '[)') end) WITH &&
  );
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."payment_term_policy_revisions"
  ADD CONSTRAINT "ccc_payment_term_policy_no_overlap_excl"
  EXCLUDE USING gist (
    tenant_id WITH =, legal_entity_id WITH =, scope_kind WITH =,
    coalesce(channel_id, '') WITH =, coalesce(commerce_market_id, '') WITH =,
    coalesce(storefront_id, '') WITH =, rule_kind WITH =,
    (case when rule_kind = 'APPLICABLE_PAYMENT_TERM_CONSTRAINT' then payment_term_resource_id else '' end) WITH =,
    (case when applicable_from is null then 'empty'::tstzrange
      else tstzrange(applicable_from, coalesce(applicable_to, 'infinity'::timestamptz), '[)') end) WITH &&
  );
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions"
  ADD CONSTRAINT "ccc_quantity_rule_no_overlap_excl"
  EXCLUDE USING gist (
    tenant_id WITH =, legal_entity_id WITH =, scope_kind WITH =,
    coalesce(channel_id, '') WITH =, coalesce(commerce_market_id, '') WITH =,
    coalesce(storefront_id, '') WITH =, selector_kind WITH =,
    coalesce(selector_resource_id, '') WITH =,
    (case when rule_kind = 'NON_RELAXABLE_CONSTRAINT' then policy_revision_id::text else rule_kind end) WITH =,
    (case when applicable_from is null then 'empty'::tstzrange
      else tstzrange(applicable_from, coalesce(applicable_to, 'infinity'::timestamptz), '[)') end) WITH &&
  );
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_assignments"
  ADD CONSTRAINT "ccc_quantity_rule_assignments_no_overlap_excl"
  EXCLUDE USING gist (
    tenant_id WITH =, legal_entity_id WITH =, profile_kind WITH =, profile_resource_id WITH =,
    policy_revision_id WITH =,
    (case when applicable_from is null then 'empty'::tstzrange
      else tstzrange(applicable_from, coalesce(applicable_to, 'infinity'::timestamptz), '[)') end) WITH &&
  );
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."derive_customer_commerce_policy_applicability"(
  p_revision jsonb,
  p_payload jsonb
) RETURNS TABLE(applicable_from timestamptz, applicable_to timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
WITH transition_bounds AS (
  SELECT
    min((transition->>'effectiveAt')::timestamptz)
      filter (where transition->>'lifecycle' = 'ACTIVE') AS activated_at,
    min((transition->>'effectiveAt')::timestamptz)
      filter (where transition->>'lifecycle' = 'RETIRED') AS retired_at
  FROM jsonb_array_elements(coalesce(p_payload #> '{state,lifecycleTransitions}', '[]'::jsonb)) transition
  WHERE transition->>'revisionId' = p_revision->>'revisionId'
), derived AS (
  SELECT
    case when p_revision->>'lifecycle' = 'ACTIVE'
      then (p_revision->>'effectiveFrom')::timestamptz
      when p_revision->>'lifecycle' = 'SCHEDULED' then activated_at
      else null end AS active_at,
    retired_at,
    nullif(p_revision->>'effectiveTo', '')::timestamptz AS semantic_end
  FROM transition_bounds
)
SELECT active_at,
       case when active_at is null then null
            when semantic_end is null then retired_at
            when retired_at is null then semantic_end
            else least(semantic_end, retired_at) end
FROM derived;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."guard_customer_commerce_policy_revision_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Customer Commerce Policy revision history cannot be deleted'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_policy_revision_history_immutable';
  END IF;
  IF (to_jsonb(NEW) - 'applicable_from' - 'applicable_to')
       IS DISTINCT FROM (to_jsonb(OLD) - 'applicable_from' - 'applicable_to') THEN
    RAISE EXCEPTION 'Customer Commerce Policy revision meaning is immutable from creation'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_policy_revision_meaning_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_assignments"(
  p_tenant_id uuid, p_legal_entity_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE
  v_generation bigint;
  v_assignments jsonb;
  v_metadata jsonb := '{}'::jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  SELECT generation, state_metadata INTO v_generation, v_metadata
    FROM customer_commerce_policy_completeness_generations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND field_family = 'COMMERCE_QUANTITY_ASSIGNMENT';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'actionInvocationId', action_invocation_id::text,
    'actorPrincipalId', actor_principal_id::text,
    'assignmentId', quantity_rule_assignment_id::text,
    'effectiveFrom', effective_from,
    'effectiveTo', effective_to,
    'idempotencyKey', idempotency_key,
    'lifecycle', lifecycle,
    'profile', jsonb_build_object(
      'kind', profile_kind,
      'profileRef', jsonb_build_object(
        'moduleId', 'commerce.customer-context',
        'resourceId', profile_resource_id,
        'resourceType', case profile_kind
          when 'RETAIL' then 'commerce.customer-context.retail-customer-profile'
          else 'commerce.customer-context.counterparty-purchasing-profile' end,
        'tenantId', tenant_id::text)),
    'reason', reason,
    'recordedAt', recorded_at,
    'ruleRevisionRef', jsonb_build_object(
      'moduleId', 'commerce.customer-context',
      'resourceId', policy_revision_id::text,
      'resourceType', 'commerce.customer-context.commerce-quantity-rule',
      'tenantId', tenant_id::text),
    'sellingLegalEntityId', legal_entity_id::text
  ) ORDER BY recorded_at, quantity_rule_assignment_id), '[]'::jsonb)
    INTO v_assignments
    FROM commerce_quantity_rule_assignments
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN QUERY SELECT v_metadata || jsonb_build_object(
    'assignments', v_assignments, 'generation', coalesce(v_generation, 0));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."persist_commerce_quantity_rule_assignments"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_expected_generation bigint, p_payload jsonb
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE
  v_assignment jsonb;
  v_applicable_from timestamptz;
  v_applicable_to timestamptz;
  v_unassigned_at timestamptz;
  v_profile jsonb;
  v_profile_ref jsonb;
  v_rule_ref jsonb;
BEGIN
  IF jsonb_typeof(p_payload #> '{state,assignments}') IS DISTINCT FROM 'array'
     OR (p_payload #> '{state,unassignments}' IS NOT NULL
         AND jsonb_typeof(p_payload #> '{state,unassignments}') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment payload is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_assignment_payload';
  END IF;
  PERFORM commerce_customer_context.lock_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'COMMERCE_QUANTITY_ASSIGNMENT', p_expected_generation, p_payload);
  IF EXISTS (
    SELECT 1 FROM commerce_quantity_rule_assignments existing
     WHERE existing.tenant_id = p_tenant_id AND existing.legal_entity_id = p_legal_entity_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_payload #> '{state,assignments}') item
          WHERE (item->>'assignmentId')::uuid = existing.quantity_rule_assignment_id)) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment state cannot discard history'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_rule_assignment_history_complete';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_payload #> '{state,assignments}')) <>
     (SELECT count(DISTINCT item->>'assignmentId')
        FROM jsonb_array_elements(p_payload #> '{state,assignments}') item) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment state contains duplicates'
      USING ERRCODE = '23505', CONSTRAINT = 'ccc_quantity_rule_assignment_duplicate';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_payload #> '{state,unassignments}', '[]'::jsonb))) <>
     (SELECT count(DISTINCT item->>'assignmentId')
        FROM jsonb_array_elements(coalesce(p_payload #> '{state,unassignments}', '[]'::jsonb)) item) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment state contains repeated unassignments'
      USING ERRCODE = '23505', CONSTRAINT = 'ccc_quantity_rule_unassignment_duplicate';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(coalesce(p_payload #> '{state,unassignments}', '[]'::jsonb)) unassignment
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_payload #> '{state,assignments}') assignment
        WHERE assignment->>'assignmentId' = unassignment->>'assignmentId'
          AND (unassignment->>'effectiveAt')::timestamptz > (assignment->>'effectiveFrom')::timestamptz
          AND (nullif(assignment->>'effectiveTo', '') IS NULL
               OR (unassignment->>'effectiveAt')::timestamptz < (assignment->>'effectiveTo')::timestamptz)
     )) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule unassignment must end a known assignment inside its period'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_unassignment_period';
  END IF;
  FOR v_assignment IN
    SELECT item.value
      FROM jsonb_array_elements(p_payload #> '{state,assignments}') item
     ORDER BY EXISTS (
       SELECT 1 FROM commerce_quantity_rule_assignments existing
        WHERE existing.quantity_rule_assignment_id = (item.value->>'assignmentId')::uuid) DESC
  LOOP
    v_profile := v_assignment->'profile';
    v_profile_ref := v_profile->'profileRef';
    v_rule_ref := v_assignment->'ruleRevisionRef';
    IF (v_assignment->>'sellingLegalEntityId')::uuid IS DISTINCT FROM p_legal_entity_id
       OR (v_profile_ref->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_rule_ref->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
       OR v_profile_ref->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
       OR v_rule_ref->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
       OR v_rule_ref->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.commerce-quantity-rule'
       OR (v_profile->>'kind' = 'RETAIL' AND
           v_profile_ref->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.retail-customer-profile')
       OR (v_profile->>'kind' = 'COUNTERPARTY' AND
           v_profile_ref->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.counterparty-purchasing-profile') THEN
      RAISE EXCEPTION 'Commerce Quantity Rule assignment owner references are invalid'
        USING ERRCODE = '42501', CONSTRAINT = 'ccc_quantity_rule_assignment_scope';
    END IF;
    v_applicable_from := case when v_assignment->>'lifecycle' = 'ACTIVE'
      then (v_assignment->>'effectiveFrom')::timestamptz else null end;
    SELECT min((unassignment->>'effectiveAt')::timestamptz) INTO v_unassigned_at
      FROM jsonb_array_elements(coalesce(p_payload #> '{state,unassignments}', '[]'::jsonb)) unassignment
     WHERE unassignment->>'assignmentId' = v_assignment->>'assignmentId';
    v_applicable_to := case
      when v_applicable_from is null then null
      when nullif(v_assignment->>'effectiveTo', '') IS NULL then v_unassigned_at
      when v_unassigned_at IS NULL then (v_assignment->>'effectiveTo')::timestamptz
      else least((v_assignment->>'effectiveTo')::timestamptz, v_unassigned_at) end;
    INSERT INTO commerce_quantity_rule_assignments (
      quantity_rule_assignment_id, tenant_id, legal_entity_id, policy_revision_id,
      profile_kind, profile_resource_id, effective_from, effective_to, applicable_from, applicable_to, lifecycle,
      idempotency_key, action_invocation_id, actor_principal_id, reason, recorded_at
    ) VALUES (
      (v_assignment->>'assignmentId')::uuid, p_tenant_id, p_legal_entity_id,
      (v_rule_ref->>'resourceId')::uuid, v_profile->>'kind', v_profile_ref->>'resourceId',
      (v_assignment->>'effectiveFrom')::timestamptz,
      nullif(v_assignment->>'effectiveTo', '')::timestamptz,
      v_applicable_from, v_applicable_to, v_assignment->>'lifecycle', v_assignment->>'idempotencyKey',
      (v_assignment->>'actionInvocationId')::uuid,
      (v_assignment->>'actorPrincipalId')::uuid, v_assignment->>'reason',
      (v_assignment->>'recordedAt')::timestamptz
    ) ON CONFLICT (quantity_rule_assignment_id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      legal_entity_id = excluded.legal_entity_id,
      policy_revision_id = excluded.policy_revision_id,
      profile_kind = excluded.profile_kind,
      profile_resource_id = excluded.profile_resource_id,
      effective_from = excluded.effective_from,
      effective_to = excluded.effective_to,
      applicable_from = excluded.applicable_from,
      applicable_to = excluded.applicable_to,
      lifecycle = excluded.lifecycle,
      idempotency_key = excluded.idempotency_key,
      action_invocation_id = excluded.action_invocation_id,
      actor_principal_id = excluded.actor_principal_id,
      reason = excluded.reason,
      recorded_at = excluded.recorded_at;
  END LOOP;
  PERFORM commerce_customer_context.store_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'COMMERCE_QUANTITY_ASSIGNMENT', p_expected_generation, p_payload);
  RETURN QUERY SELECT jsonb_build_object('applied', true);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ccc_market_bootstrap_policy_revision_guard"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."market_bootstrap_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_customer_commerce_policy_revision_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ccc_purchase_currency_policy_revision_guard"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."purchase_currency_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_customer_commerce_policy_revision_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ccc_payment_term_policy_revision_guard"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."payment_term_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_customer_commerce_policy_revision_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ccc_quantity_rule_revision_guard"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."commerce_quantity_rule_revisions"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_customer_commerce_policy_revision_mutation"();
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."guard_commerce_quantity_rule_assignment"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_revision commerce_customer_context.commerce_quantity_rule_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment history cannot be deleted'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_rule_assignment_history_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(NEW) - 'applicable_from' - 'applicable_to')
       IS DISTINCT FROM (to_jsonb(OLD) - 'applicable_from' - 'applicable_to') THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment meaning is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_rule_assignment_meaning_immutable';
  END IF;
  SELECT * INTO v_revision
    FROM commerce_customer_context.commerce_quantity_rule_revisions
   WHERE tenant_id = NEW.tenant_id
     AND legal_entity_id = NEW.legal_entity_id
     AND policy_revision_id = NEW.policy_revision_id;
  IF NOT FOUND OR NEW.effective_from < v_revision.effective_from
     OR (v_revision.effective_to IS NOT NULL AND
         (NEW.effective_to IS NULL OR NEW.effective_to > v_revision.effective_to)) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment must remain inside its revision period'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_assignment_revision_period';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ccc_quantity_rule_assignment_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "commerce_customer_context"."commerce_quantity_rule_assignments"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_commerce_quantity_rule_assignment"();
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."assert_customer_commerce_policy_scope"(
  p_tenant_id uuid,
  p_legal_entity_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified Customer Commerce Policy scope is invalid'
      USING ERRCODE = '42501', CONSTRAINT = 'ccc_policy_scope';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."lock_customer_commerce_policy_generation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_field_family text,
  p_expected_generation bigint,
  p_payload jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actual_generation bigint;
  v_next_generation bigint;
  v_existing_metadata jsonb := '{}'::jsonb;
  v_next_metadata jsonb := '{}'::jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':' || p_field_family,
    333
  ));
  SELECT generation, state_metadata INTO v_actual_generation, v_existing_metadata
    FROM customer_commerce_policy_completeness_generations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND field_family = p_field_family
   FOR UPDATE;
  v_actual_generation := coalesce(v_actual_generation, 0);
  v_existing_metadata := coalesce(v_existing_metadata, '{}'::jsonb);
  v_next_generation := nullif(p_payload #>> '{state,generation}', '')::bigint;
  v_next_metadata := coalesce(
    (p_payload->'state') - 'field' - 'generation' - 'revisions' - 'assignments',
    '{}'::jsonb
  );
  IF v_actual_generation <> p_expected_generation THEN
    RAISE EXCEPTION 'Customer Commerce Policy generation conflict'
      USING ERRCODE = '40001', CONSTRAINT = 'ccc_policy_generation_conflict';
  END IF;
  IF v_next_generation IS NULL OR v_next_generation <> p_expected_generation + 1 THEN
    RAISE EXCEPTION 'Customer Commerce Policy generation must advance exactly once'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_policy_generation_advance';
  END IF;
  IF NOT v_next_metadata @> v_existing_metadata THEN
    RAISE EXCEPTION 'Customer Commerce Policy state metadata cannot discard history'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_policy_state_metadata_history_complete';
  END IF;
  IF p_payload #>> '{completeness,ownerRevision}' IS DISTINCT FROM p_field_family || ':' || v_next_generation::text
     OR p_payload #>> '{completeness,scope,kind}' IS DISTINCT FROM 'EXACT_PREDICATE'
     OR p_payload #>> '{completeness,scope,predicateRef}' IS DISTINCT FROM
       'commerce.customer-context.policy.' || lower(p_field_family) || '.current' THEN
    RAISE EXCEPTION 'Customer Commerce Policy completeness evidence does not match the new generation'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_policy_completeness_mismatch';
  END IF;
  RETURN v_next_generation;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."store_customer_commerce_policy_generation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_field_family text,
  p_expected_generation bigint,
  p_payload jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_next_generation bigint := (p_payload #>> '{state,generation}')::bigint;
BEGIN
  INSERT INTO customer_commerce_policy_completeness_generations (
    tenant_id, legal_entity_id, field_family, generation, predicate_ref, owner_revision,
    observed_at, next_applicability_boundary, state_metadata
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_field_family, v_next_generation,
    p_payload #>> '{completeness,scope,predicateRef}',
    p_payload #>> '{completeness,ownerRevision}',
    (p_payload #>> '{completeness,observedAt}')::timestamptz,
    nullif(p_payload #>> '{completeness,nextApplicabilityBoundary}', '')::timestamptz,
    coalesce((p_payload->'state') - 'field' - 'generation' - 'revisions' - 'assignments', '{}'::jsonb)
  )
  ON CONFLICT (tenant_id, legal_entity_id, field_family) DO UPDATE SET
    generation = excluded.generation,
    predicate_ref = excluded.predicate_ref,
    owner_revision = excluded.owner_revision,
    observed_at = excluded.observed_at,
    next_applicability_boundary = excluded.next_applicability_boundary,
    state_metadata = excluded.state_metadata
  WHERE customer_commerce_policy_completeness_generations.generation = p_expected_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer Commerce Policy generation compare-and-swap failed'
      USING ERRCODE = '40001', CONSTRAINT = 'ccc_policy_generation_conflict';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."load_market_bootstrap_policy_state"(
  p_tenant_id uuid, p_legal_entity_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE v_generation bigint; v_revisions jsonb; v_metadata jsonb := '{}'::jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  SELECT generation, state_metadata INTO v_generation, v_metadata FROM customer_commerce_policy_completeness_generations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND field_family = 'MARKET_BOOTSTRAP';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'actionInvocationId', action_invocation_id::text, 'actorPrincipalId', actor_principal_id::text,
    'effectiveFrom', effective_from, 'effectiveTo', effective_to, 'field', 'MARKET_BOOTSTRAP',
    'idempotencyKey', idempotency_key, 'lifecycle', lifecycle, 'reason', reason,
    'revisionId', policy_revision_id::text, 'tenantId', tenant_id::text,
    'scope', jsonb_strip_nulls(jsonb_build_object(
      'kind', scope_kind, 'sellingLegalEntityId', legal_entity_id::text,
      'channelId', channel_id, 'commerceMarketId', commerce_market_id, 'storefrontId', storefront_id)),
    'value', jsonb_build_object('kind', 'DEFAULT_MARKET_TUPLE',
      'defaultChannelId', default_channel_id,
      'defaultCommerceMarketId', default_commerce_market_id,
      'defaultSellingLegalEntityId', default_selling_legal_entity_id)
  ) ORDER BY recorded_at, policy_revision_id), '[]'::jsonb) INTO v_revisions
    FROM market_bootstrap_policy_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN QUERY SELECT v_metadata || jsonb_build_object(
    'field', 'MARKET_BOOTSTRAP', 'generation', coalesce(v_generation, 0), 'revisions', v_revisions);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."persist_market_bootstrap_policy_state"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_expected_generation bigint, p_payload jsonb
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE
  v_revision jsonb;
  v_applicable_from timestamptz;
  v_applicable_to timestamptz;
BEGIN
  IF p_payload #>> '{state,field}' IS DISTINCT FROM 'MARKET_BOOTSTRAP'
     OR jsonb_typeof(p_payload #> '{state,revisions}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Market bootstrap policy payload is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_market_bootstrap_policy_payload';
  END IF;
  PERFORM commerce_customer_context.lock_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'MARKET_BOOTSTRAP', p_expected_generation, p_payload);
  IF EXISTS (
    SELECT 1 FROM market_bootstrap_policy_revisions existing
     WHERE existing.tenant_id = p_tenant_id AND existing.legal_entity_id = p_legal_entity_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
          WHERE (item->>'revisionId')::uuid = existing.policy_revision_id)) THEN
    RAISE EXCEPTION 'Market bootstrap policy state cannot discard history'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_market_bootstrap_policy_history_complete';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_payload #> '{state,revisions}')) <>
     (SELECT count(DISTINCT item->>'revisionId') FROM jsonb_array_elements(p_payload #> '{state,revisions}') item) THEN
    RAISE EXCEPTION 'Market bootstrap policy state contains duplicate revisions'
      USING ERRCODE = '23505', CONSTRAINT = 'ccc_market_bootstrap_policy_revision_duplicate';
  END IF;
  FOR v_revision IN
    SELECT item.value
      FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
     ORDER BY EXISTS (
       SELECT 1 FROM market_bootstrap_policy_revisions existing
        WHERE existing.policy_revision_id = (item.value->>'revisionId')::uuid) DESC
  LOOP
    IF (v_revision->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_revision #>> '{scope,sellingLegalEntityId}')::uuid IS DISTINCT FROM p_legal_entity_id
       OR (v_revision #>> '{value,defaultSellingLegalEntityId}')::uuid IS DISTINCT FROM p_legal_entity_id THEN
      RAISE EXCEPTION 'Market bootstrap policy revision scope is invalid'
        USING ERRCODE = '42501', CONSTRAINT = 'ccc_market_bootstrap_policy_scope';
    END IF;
    SELECT applicable_from, applicable_to INTO v_applicable_from, v_applicable_to
      FROM commerce_customer_context.derive_customer_commerce_policy_applicability(v_revision, p_payload);
    INSERT INTO market_bootstrap_policy_revisions (
      policy_revision_id, tenant_id, legal_entity_id, scope_kind, channel_id, commerce_market_id,
      storefront_id, effective_from, effective_to, applicable_from, applicable_to, lifecycle, idempotency_key,
      action_invocation_id, actor_principal_id, reason, default_channel_id,
      default_commerce_market_id, default_selling_legal_entity_id
    ) VALUES (
      (v_revision->>'revisionId')::uuid, p_tenant_id, p_legal_entity_id,
      v_revision #>> '{scope,kind}', v_revision #>> '{scope,channelId}',
      v_revision #>> '{scope,commerceMarketId}', v_revision #>> '{scope,storefrontId}',
      (v_revision->>'effectiveFrom')::timestamptz,
      nullif(v_revision->>'effectiveTo', '')::timestamptz, v_applicable_from, v_applicable_to,
      v_revision->>'lifecycle',
      v_revision->>'idempotencyKey', (v_revision->>'actionInvocationId')::uuid,
      (v_revision->>'actorPrincipalId')::uuid, v_revision->>'reason',
      v_revision #>> '{value,defaultChannelId}',
      v_revision #>> '{value,defaultCommerceMarketId}',
      (v_revision #>> '{value,defaultSellingLegalEntityId}')::uuid
    ) ON CONFLICT (policy_revision_id) DO UPDATE SET
      tenant_id = excluded.tenant_id, legal_entity_id = excluded.legal_entity_id,
      scope_kind = excluded.scope_kind, channel_id = excluded.channel_id,
      commerce_market_id = excluded.commerce_market_id, storefront_id = excluded.storefront_id,
      effective_from = excluded.effective_from, effective_to = excluded.effective_to,
      applicable_from = excluded.applicable_from, applicable_to = excluded.applicable_to,
      lifecycle = excluded.lifecycle, idempotency_key = excluded.idempotency_key,
      action_invocation_id = excluded.action_invocation_id,
      actor_principal_id = excluded.actor_principal_id, reason = excluded.reason,
      default_channel_id = excluded.default_channel_id,
      default_commerce_market_id = excluded.default_commerce_market_id,
      default_selling_legal_entity_id = excluded.default_selling_legal_entity_id;
  END LOOP;
  PERFORM commerce_customer_context.store_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'MARKET_BOOTSTRAP', p_expected_generation, p_payload);
  DELETE FROM market_bootstrap_policy_candidate_revisions
   WHERE tenant_id = p_tenant_id AND selling_legal_entity_id = p_legal_entity_id;
  INSERT INTO market_bootstrap_policy_candidate_revisions (
    policy_revision_id, tenant_id, selling_legal_entity_id, scope_kind, channel_id, storefront_id,
    effective_from, effective_to, lifecycle, activated_at, retired_at, default_channel_id,
    default_commerce_market_id
  )
  SELECT policy_revision_id, tenant_id, legal_entity_id, scope_kind, channel_id, storefront_id,
         effective_from, effective_to, lifecycle, applicable_from, applicable_to,
         default_channel_id, default_commerce_market_id
    FROM market_bootstrap_policy_revisions revision
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  INSERT INTO market_bootstrap_policy_candidate_generations (
    tenant_id, selling_legal_entity_id, generation, predicate_ref, owner_revision,
    declared_scope_ref, observed_at, next_applicability_boundary
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_expected_generation + 1,
    'commerce.customer-context.policy.market_bootstrap.current:' || p_tenant_id::text || ':' || p_legal_entity_id::text,
    'MARKET_BOOTSTRAP:' || p_tenant_id::text || ':' || p_legal_entity_id::text || ':' || (p_expected_generation + 1)::text,
    'commerce.customer-context.policy.market_bootstrap.all:' || p_tenant_id::text || ':' || p_legal_entity_id::text,
    (p_payload #>> '{completeness,observedAt}')::timestamptz,
    nullif(p_payload #>> '{completeness,nextApplicabilityBoundary}', '')::timestamptz
  )
  ON CONFLICT (tenant_id, selling_legal_entity_id) DO UPDATE SET
    generation = excluded.generation,
    predicate_ref = excluded.predicate_ref,
    owner_revision = excluded.owner_revision,
    declared_scope_ref = excluded.declared_scope_ref,
    observed_at = excluded.observed_at,
    next_applicability_boundary = excluded.next_applicability_boundary;
  RETURN QUERY SELECT jsonb_build_object('applied', true);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."load_current_market_bootstrap_policy_candidates"(
  p_tenant_id uuid, p_selling_legal_entity_ids uuid[], p_at timestamptz
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Market bootstrap candidate Tenant scope mismatch'
      USING ERRCODE = '42501', CONSTRAINT = 'ccc_market_bootstrap_candidates_tenant_scope';
  END IF;
  IF p_selling_legal_entity_ids IS NULL OR p_at IS NULL
     OR cardinality(p_selling_legal_entity_ids) > 256
     OR array_position(p_selling_legal_entity_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Market bootstrap candidate request is invalid'
      USING ERRCODE = '22023', CONSTRAINT = 'ccc_market_bootstrap_candidates_request';
  END IF;
  RETURN QUERY
  WITH normalized AS (
    SELECT seller_id, min(ordinality) AS first_ordinal
      FROM unnest(p_selling_legal_entity_ids) WITH ORDINALITY requested(seller_id, ordinality)
     GROUP BY seller_id
  ), partitions AS (
    SELECT requested.seller_id, requested.first_ordinal,
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'defaultTuple', jsonb_build_object(
                 'channelId', candidate.default_channel_id,
                 'commerceMarketId', candidate.default_commerce_market_id,
                 'sellingLegalEntityId', requested.seller_id::text),
               'policyRevisionId', candidate.policy_revision_id::text,
               'scope', jsonb_strip_nulls(jsonb_build_object(
                 'kind', candidate.scope_kind,
                 'sellingLegalEntityId', requested.seller_id::text,
                 'channelId', candidate.channel_id,
                 'storefrontId', candidate.storefront_id))
             ) ORDER BY candidate.scope_kind, candidate.channel_id, candidate.storefront_id,
                        candidate.policy_revision_id)
               FROM market_bootstrap_policy_candidate_revisions candidate
              WHERE candidate.tenant_id = p_tenant_id
                AND candidate.selling_legal_entity_id = requested.seller_id
                AND candidate.activated_at IS NOT NULL
                AND candidate.activated_at <= p_at
                AND (candidate.retired_at IS NULL OR p_at < candidate.retired_at)
                AND candidate.effective_from <= p_at
                AND (candidate.effective_to IS NULL OR p_at < candidate.effective_to)
           ), '[]'::jsonb) AS candidates,
           generation.generation, generation.predicate_ref, generation.owner_revision,
           generation.declared_scope_ref,
           (SELECT min(boundary.value)
              FROM market_bootstrap_policy_candidate_revisions boundary_candidate
              CROSS JOIN LATERAL unnest(array[
                boundary_candidate.activated_at,
                boundary_candidate.retired_at,
                boundary_candidate.effective_to
              ]) boundary(value)
             WHERE boundary_candidate.tenant_id = p_tenant_id
               AND boundary_candidate.selling_legal_entity_id = requested.seller_id
               AND boundary.value > p_at) AS next_boundary
      FROM normalized requested
      LEFT JOIN market_bootstrap_policy_candidate_generations generation
        ON generation.tenant_id = p_tenant_id
       AND generation.selling_legal_entity_id = requested.seller_id
  )
  SELECT jsonb_build_object('sellers', coalesce(jsonb_agg(jsonb_build_object(
    'sellingLegalEntityId', seller_id::text,
    'candidates', candidates,
    'completeness', jsonb_strip_nulls(jsonb_build_object(
      'observedAt', p_at,
      'nextApplicabilityBoundary', next_boundary,
      'ownerRevision', coalesce(owner_revision,
        'MARKET_BOOTSTRAP:' || p_tenant_id::text || ':' || seller_id::text || ':0'),
      'scope', jsonb_build_object(
        'kind', 'SAFELY_BROADER_SCOPE',
        'predicateRef', coalesce(predicate_ref,
          'commerce.customer-context.policy.market_bootstrap.current:' || p_tenant_id::text || ':' || seller_id::text),
        'declaredScopeRef', coalesce(declared_scope_ref,
          'commerce.customer-context.policy.market_bootstrap.all:' || p_tenant_id::text || ':' || seller_id::text)
      )))
  ) ORDER BY first_ordinal), '[]'::jsonb))
    FROM partitions;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."load_purchase_currency_policy_state"(
  p_tenant_id uuid, p_legal_entity_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE v_generation bigint; v_revisions jsonb; v_metadata jsonb := '{}'::jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  SELECT generation, state_metadata INTO v_generation, v_metadata FROM customer_commerce_policy_completeness_generations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND field_family = 'PURCHASE_CURRENCY';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'actionInvocationId', action_invocation_id::text, 'actorPrincipalId', actor_principal_id::text,
    'effectiveFrom', effective_from, 'effectiveTo', effective_to, 'field', 'PURCHASE_CURRENCY',
    'idempotencyKey', idempotency_key, 'lifecycle', lifecycle, 'reason', reason,
    'revisionId', policy_revision_id::text, 'tenantId', tenant_id::text,
    'scope', jsonb_strip_nulls(jsonb_build_object(
      'kind', scope_kind, 'sellingLegalEntityId', legal_entity_id::text,
      'channelId', channel_id, 'commerceMarketId', commerce_market_id, 'storefrontId', storefront_id)),
    'value', jsonb_build_object('kind', rule_kind, 'currencyCode', currency_code)
  ) ORDER BY recorded_at, policy_revision_id), '[]'::jsonb) INTO v_revisions
    FROM purchase_currency_policy_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN QUERY SELECT v_metadata || jsonb_build_object(
    'field', 'PURCHASE_CURRENCY', 'generation', coalesce(v_generation, 0), 'revisions', v_revisions);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."persist_purchase_currency_policy_state"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_expected_generation bigint, p_payload jsonb
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE
  v_revision jsonb;
  v_applicable_from timestamptz;
  v_applicable_to timestamptz;
BEGIN
  IF p_payload #>> '{state,field}' IS DISTINCT FROM 'PURCHASE_CURRENCY'
     OR jsonb_typeof(p_payload #> '{state,revisions}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Purchase Currency policy payload is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_purchase_currency_policy_payload';
  END IF;
  PERFORM commerce_customer_context.lock_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'PURCHASE_CURRENCY', p_expected_generation, p_payload);
  IF EXISTS (
    SELECT 1 FROM purchase_currency_policy_revisions existing
     WHERE existing.tenant_id = p_tenant_id AND existing.legal_entity_id = p_legal_entity_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
          WHERE (item->>'revisionId')::uuid = existing.policy_revision_id)) THEN
    RAISE EXCEPTION 'Purchase Currency policy state cannot discard history'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_purchase_currency_policy_history_complete';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_payload #> '{state,revisions}')) <>
     (SELECT count(DISTINCT item->>'revisionId') FROM jsonb_array_elements(p_payload #> '{state,revisions}') item) THEN
    RAISE EXCEPTION 'Purchase Currency policy state contains duplicate revisions'
      USING ERRCODE = '23505', CONSTRAINT = 'ccc_purchase_currency_policy_revision_duplicate';
  END IF;
  FOR v_revision IN
    SELECT item.value
      FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
     ORDER BY EXISTS (
       SELECT 1 FROM purchase_currency_policy_revisions existing
        WHERE existing.policy_revision_id = (item.value->>'revisionId')::uuid) DESC
  LOOP
    IF (v_revision->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_revision #>> '{scope,sellingLegalEntityId}')::uuid IS DISTINCT FROM p_legal_entity_id THEN
      RAISE EXCEPTION 'Purchase Currency policy revision scope is invalid'
        USING ERRCODE = '42501', CONSTRAINT = 'ccc_purchase_currency_policy_scope';
    END IF;
    SELECT applicable_from, applicable_to INTO v_applicable_from, v_applicable_to
      FROM commerce_customer_context.derive_customer_commerce_policy_applicability(v_revision, p_payload);
    INSERT INTO purchase_currency_policy_revisions (
      policy_revision_id, tenant_id, legal_entity_id, scope_kind, channel_id, commerce_market_id,
      storefront_id, effective_from, effective_to, applicable_from, applicable_to, lifecycle, idempotency_key,
      action_invocation_id, actor_principal_id, reason, rule_kind, currency_code
    ) VALUES (
      (v_revision->>'revisionId')::uuid, p_tenant_id, p_legal_entity_id,
      v_revision #>> '{scope,kind}', v_revision #>> '{scope,channelId}',
      v_revision #>> '{scope,commerceMarketId}', v_revision #>> '{scope,storefrontId}',
      (v_revision->>'effectiveFrom')::timestamptz,
      nullif(v_revision->>'effectiveTo', '')::timestamptz, v_applicable_from, v_applicable_to,
      v_revision->>'lifecycle',
      v_revision->>'idempotencyKey', (v_revision->>'actionInvocationId')::uuid,
      (v_revision->>'actorPrincipalId')::uuid, v_revision->>'reason',
      v_revision #>> '{value,kind}', v_revision #>> '{value,currencyCode}'
    ) ON CONFLICT (policy_revision_id) DO UPDATE SET
      tenant_id = excluded.tenant_id, legal_entity_id = excluded.legal_entity_id,
      scope_kind = excluded.scope_kind, channel_id = excluded.channel_id,
      commerce_market_id = excluded.commerce_market_id, storefront_id = excluded.storefront_id,
      effective_from = excluded.effective_from, effective_to = excluded.effective_to,
      applicable_from = excluded.applicable_from, applicable_to = excluded.applicable_to,
      lifecycle = excluded.lifecycle, idempotency_key = excluded.idempotency_key,
      action_invocation_id = excluded.action_invocation_id,
      actor_principal_id = excluded.actor_principal_id, reason = excluded.reason,
      rule_kind = excluded.rule_kind, currency_code = excluded.currency_code;
  END LOOP;
  PERFORM commerce_customer_context.store_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'PURCHASE_CURRENCY', p_expected_generation, p_payload);
  RETURN QUERY SELECT jsonb_build_object('applied', true);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."load_payment_term_policy_state"(
  p_tenant_id uuid, p_legal_entity_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE v_generation bigint; v_revisions jsonb; v_metadata jsonb := '{}'::jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  SELECT generation, state_metadata INTO v_generation, v_metadata FROM customer_commerce_policy_completeness_generations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND field_family = 'PAYMENT_TERM';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'actionInvocationId', action_invocation_id::text, 'actorPrincipalId', actor_principal_id::text,
    'effectiveFrom', effective_from, 'effectiveTo', effective_to, 'field', 'PAYMENT_TERM',
    'idempotencyKey', idempotency_key, 'lifecycle', lifecycle, 'reason', reason,
    'revisionId', policy_revision_id::text, 'tenantId', tenant_id::text,
    'scope', jsonb_strip_nulls(jsonb_build_object(
      'kind', scope_kind, 'sellingLegalEntityId', legal_entity_id::text,
      'channelId', channel_id, 'commerceMarketId', commerce_market_id, 'storefrontId', storefront_id)),
    'value', case when rule_kind = 'EXPLICIT_PAYMENT_TERM_CHOICE_POLICY'
      then jsonb_build_object('kind', rule_kind, 'enabled', enabled)
      else jsonb_build_object('kind', rule_kind, 'paymentTermRef', jsonb_build_object(
        'moduleId', 'payment.term-catalog', 'resourceType', 'payment.term-catalog.payment-term',
        'resourceId', payment_term_resource_id, 'tenantId', tenant_id::text)) end
  ) ORDER BY recorded_at, policy_revision_id), '[]'::jsonb) INTO v_revisions
    FROM payment_term_policy_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN QUERY SELECT v_metadata || jsonb_build_object(
    'field', 'PAYMENT_TERM', 'generation', coalesce(v_generation, 0), 'revisions', v_revisions);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."persist_payment_term_policy_state"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_expected_generation bigint, p_payload jsonb
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE
  v_revision jsonb;
  v_applicable_from timestamptz;
  v_applicable_to timestamptz;
BEGIN
  IF p_payload #>> '{state,field}' IS DISTINCT FROM 'PAYMENT_TERM'
     OR jsonb_typeof(p_payload #> '{state,revisions}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Payment Term policy payload is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_payment_term_policy_payload';
  END IF;
  PERFORM commerce_customer_context.lock_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'PAYMENT_TERM', p_expected_generation, p_payload);
  IF EXISTS (
    SELECT 1 FROM payment_term_policy_revisions existing
     WHERE existing.tenant_id = p_tenant_id AND existing.legal_entity_id = p_legal_entity_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
          WHERE (item->>'revisionId')::uuid = existing.policy_revision_id)) THEN
    RAISE EXCEPTION 'Payment Term policy state cannot discard history'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_payment_term_policy_history_complete';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_payload #> '{state,revisions}')) <>
     (SELECT count(DISTINCT item->>'revisionId') FROM jsonb_array_elements(p_payload #> '{state,revisions}') item) THEN
    RAISE EXCEPTION 'Payment Term policy state contains duplicate revisions'
      USING ERRCODE = '23505', CONSTRAINT = 'ccc_payment_term_policy_revision_duplicate';
  END IF;
  FOR v_revision IN
    SELECT item.value
      FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
     ORDER BY EXISTS (
       SELECT 1 FROM payment_term_policy_revisions existing
        WHERE existing.policy_revision_id = (item.value->>'revisionId')::uuid) DESC
  LOOP
    IF (v_revision->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_revision #>> '{scope,sellingLegalEntityId}')::uuid IS DISTINCT FROM p_legal_entity_id
       OR (v_revision #>> '{value,kind}') <> 'EXPLICIT_PAYMENT_TERM_CHOICE_POLICY' AND (
         v_revision #>> '{value,paymentTermRef,moduleId}' IS DISTINCT FROM 'payment.term-catalog'
         OR v_revision #>> '{value,paymentTermRef,resourceType}' IS DISTINCT FROM 'payment.term-catalog.payment-term'
         OR (v_revision #>> '{value,paymentTermRef,tenantId}')::uuid IS DISTINCT FROM p_tenant_id) THEN
      RAISE EXCEPTION 'Payment Term policy revision owner references are invalid'
        USING ERRCODE = '42501', CONSTRAINT = 'ccc_payment_term_policy_scope';
    END IF;
    SELECT applicable_from, applicable_to INTO v_applicable_from, v_applicable_to
      FROM commerce_customer_context.derive_customer_commerce_policy_applicability(v_revision, p_payload);
    INSERT INTO payment_term_policy_revisions (
      policy_revision_id, tenant_id, legal_entity_id, scope_kind, channel_id, commerce_market_id,
      storefront_id, effective_from, effective_to, applicable_from, applicable_to, lifecycle, idempotency_key,
      action_invocation_id, actor_principal_id, reason, rule_kind, payment_term_resource_id, enabled
    ) VALUES (
      (v_revision->>'revisionId')::uuid, p_tenant_id, p_legal_entity_id,
      v_revision #>> '{scope,kind}', v_revision #>> '{scope,channelId}',
      v_revision #>> '{scope,commerceMarketId}', v_revision #>> '{scope,storefrontId}',
      (v_revision->>'effectiveFrom')::timestamptz,
      nullif(v_revision->>'effectiveTo', '')::timestamptz, v_applicable_from, v_applicable_to,
      v_revision->>'lifecycle',
      v_revision->>'idempotencyKey', (v_revision->>'actionInvocationId')::uuid,
      (v_revision->>'actorPrincipalId')::uuid, v_revision->>'reason',
      v_revision #>> '{value,kind}', v_revision #>> '{value,paymentTermRef,resourceId}',
      nullif(v_revision #>> '{value,enabled}', '')::boolean
    ) ON CONFLICT (policy_revision_id) DO UPDATE SET
      tenant_id = excluded.tenant_id, legal_entity_id = excluded.legal_entity_id,
      scope_kind = excluded.scope_kind, channel_id = excluded.channel_id,
      commerce_market_id = excluded.commerce_market_id, storefront_id = excluded.storefront_id,
      effective_from = excluded.effective_from, effective_to = excluded.effective_to,
      applicable_from = excluded.applicable_from, applicable_to = excluded.applicable_to,
      lifecycle = excluded.lifecycle, idempotency_key = excluded.idempotency_key,
      action_invocation_id = excluded.action_invocation_id,
      actor_principal_id = excluded.actor_principal_id, reason = excluded.reason,
      rule_kind = excluded.rule_kind,
      payment_term_resource_id = excluded.payment_term_resource_id, enabled = excluded.enabled;
  END LOOP;
  PERFORM commerce_customer_context.store_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'PAYMENT_TERM', p_expected_generation, p_payload);
  RETURN QUERY SELECT jsonb_build_object('applied', true);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_state"(
  p_tenant_id uuid, p_legal_entity_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE v_generation bigint; v_revisions jsonb; v_metadata jsonb := '{}'::jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  SELECT generation, state_metadata INTO v_generation, v_metadata FROM customer_commerce_policy_completeness_generations
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND field_family = 'COMMERCE_QUANTITY_RULE';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'actionInvocationId', action_invocation_id::text, 'actorPrincipalId', actor_principal_id::text,
    'effectiveFrom', effective_from, 'effectiveTo', effective_to, 'field', 'COMMERCE_QUANTITY_RULE',
    'idempotencyKey', idempotency_key, 'lifecycle', lifecycle, 'reason', reason,
    'revisionId', policy_revision_id::text, 'tenantId', tenant_id::text,
    'scope', jsonb_strip_nulls(jsonb_build_object(
      'kind', scope_kind, 'sellingLegalEntityId', legal_entity_id::text,
      'channelId', channel_id, 'commerceMarketId', commerce_market_id, 'storefrontId', storefront_id)),
    'value', jsonb_build_object(
      'kind', 'COMMERCE_QUANTITY_RULE', 'constraintMode', rule_kind,
      'selector', case selector_kind
        when 'ALL' then jsonb_build_object('kind', 'ALL')
        when 'PRODUCT' then jsonb_build_object('kind', 'PRODUCT', 'productRef', jsonb_build_object(
          'moduleId', selector_resource_module_id, 'resourceType', selector_resource_type,
          'resourceId', selector_resource_id, 'tenantId', selector_tenant_id::text))
        when 'VARIANT' then jsonb_build_object('kind', 'VARIANT', 'variantRef', jsonb_build_object(
          'moduleId', selector_resource_module_id, 'resourceType', selector_resource_type,
          'resourceId', selector_resource_id, 'tenantId', selector_tenant_id::text))
        else jsonb_build_object('kind', 'PACKAGE_OPTION', 'packageOptionRef', jsonb_build_object(
          'moduleId', selector_resource_module_id, 'resourceType', selector_resource_type,
          'resourceId', selector_resource_id, 'tenantId', selector_tenant_id::text)) end,
      'basis', jsonb_build_object(
        'basisRef', jsonb_build_object('moduleId', quantity_basis_module_id,
          'resourceType', quantity_basis_resource_type, 'resourceId', quantity_basis_resource_id,
          'tenantId', quantity_basis_tenant_id::text),
        'ownerRevision', quantity_basis_owner_revision,
        'unitRef', jsonb_build_object('moduleId', quantity_unit_module_id,
          'resourceType', quantity_unit_resource_type, 'resourceId', quantity_unit_resource_id,
          'tenantId', quantity_unit_tenant_id::text)),
      'envelope', case restriction_kind
        when 'NO_COMMERCIAL_QUANTITY_RESTRICTION' then jsonb_build_object(
          'kind', 'NO_COMMERCIAL_QUANTITY_RESTRICTION')
        else jsonb_build_object('kind', 'BOUNDED', 'minimum', minimum,
          'maximum', maximum, 'multiple', multiple) end)
  ) ORDER BY recorded_at, policy_revision_id), '[]'::jsonb) INTO v_revisions
    FROM commerce_quantity_rule_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN QUERY SELECT v_metadata || jsonb_build_object(
    'field', 'COMMERCE_QUANTITY_RULE', 'generation', coalesce(v_generation, 0), 'revisions', v_revisions);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."persist_commerce_quantity_rule_state"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_expected_generation bigint, p_payload jsonb
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on
AS $$
DECLARE
  v_revision jsonb;
  v_applicable_from timestamptz;
  v_applicable_to timestamptz;
  v_selector jsonb;
  v_selector_ref jsonb;
  v_basis jsonb;
  v_envelope jsonb;
BEGIN
  IF p_payload #>> '{state,field}' IS DISTINCT FROM 'COMMERCE_QUANTITY_RULE'
     OR jsonb_typeof(p_payload #> '{state,revisions}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Commerce Quantity Rule payload is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_payload';
  END IF;
  PERFORM commerce_customer_context.lock_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'COMMERCE_QUANTITY_RULE', p_expected_generation, p_payload);
  IF EXISTS (
    SELECT 1 FROM commerce_quantity_rule_revisions existing
     WHERE existing.tenant_id = p_tenant_id AND existing.legal_entity_id = p_legal_entity_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
          WHERE (item->>'revisionId')::uuid = existing.policy_revision_id)) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule state cannot discard history'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_rule_history_complete';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_payload #> '{state,revisions}')) <>
     (SELECT count(DISTINCT item->>'revisionId') FROM jsonb_array_elements(p_payload #> '{state,revisions}') item) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule state contains duplicate revisions'
      USING ERRCODE = '23505', CONSTRAINT = 'ccc_quantity_rule_revision_duplicate';
  END IF;
  FOR v_revision IN
    SELECT item.value
      FROM jsonb_array_elements(p_payload #> '{state,revisions}') item
     ORDER BY EXISTS (
       SELECT 1 FROM commerce_quantity_rule_revisions existing
        WHERE existing.policy_revision_id = (item.value->>'revisionId')::uuid) DESC
  LOOP
    v_selector := v_revision #> '{value,selector}';
    v_selector_ref := case v_selector->>'kind'
      when 'PRODUCT' then v_selector->'productRef'
      when 'VARIANT' then v_selector->'variantRef'
      when 'PACKAGE_OPTION' then v_selector->'packageOptionRef'
      else null end;
    v_basis := v_revision #> '{value,basis}';
    v_envelope := v_revision #> '{value,envelope}';
    IF (v_revision->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_revision #>> '{scope,sellingLegalEntityId}')::uuid IS DISTINCT FROM p_legal_entity_id
       OR (v_basis #>> '{basisRef,tenantId}')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_basis #>> '{unitRef,tenantId}')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_selector_ref IS NOT NULL AND
           (v_selector_ref->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id) THEN
      RAISE EXCEPTION 'Commerce Quantity Rule owner references are invalid'
        USING ERRCODE = '42501', CONSTRAINT = 'ccc_quantity_rule_scope';
    END IF;
    SELECT applicable_from, applicable_to INTO v_applicable_from, v_applicable_to
      FROM commerce_customer_context.derive_customer_commerce_policy_applicability(v_revision, p_payload);
    INSERT INTO commerce_quantity_rule_revisions (
      policy_revision_id, tenant_id, legal_entity_id, scope_kind, channel_id, commerce_market_id,
      storefront_id, effective_from, effective_to, applicable_from, applicable_to, lifecycle, idempotency_key,
      action_invocation_id, actor_principal_id, reason, selector_kind,
      selector_resource_module_id, selector_resource_type, selector_resource_id, selector_tenant_id,
      rule_kind, quantity_basis_module_id, quantity_basis_resource_type, quantity_basis_resource_id,
      quantity_basis_tenant_id, quantity_basis_owner_revision, quantity_unit_module_id,
      quantity_unit_resource_type, quantity_unit_resource_id, quantity_unit_tenant_id,
      restriction_kind, minimum, maximum, multiple
    ) VALUES (
      (v_revision->>'revisionId')::uuid, p_tenant_id, p_legal_entity_id,
      v_revision #>> '{scope,kind}', v_revision #>> '{scope,channelId}',
      v_revision #>> '{scope,commerceMarketId}', v_revision #>> '{scope,storefrontId}',
      (v_revision->>'effectiveFrom')::timestamptz,
      nullif(v_revision->>'effectiveTo', '')::timestamptz, v_applicable_from, v_applicable_to,
      v_revision->>'lifecycle',
      v_revision->>'idempotencyKey', (v_revision->>'actionInvocationId')::uuid,
      (v_revision->>'actorPrincipalId')::uuid, v_revision->>'reason', v_selector->>'kind',
      v_selector_ref->>'moduleId', v_selector_ref->>'resourceType',
      v_selector_ref->>'resourceId', nullif(v_selector_ref->>'tenantId', '')::uuid,
      v_revision #>> '{value,constraintMode}', v_basis #>> '{basisRef,moduleId}',
      v_basis #>> '{basisRef,resourceType}', v_basis #>> '{basisRef,resourceId}',
      (v_basis #>> '{basisRef,tenantId}')::uuid, v_basis->>'ownerRevision',
      v_basis #>> '{unitRef,moduleId}', v_basis #>> '{unitRef,resourceType}',
      v_basis #>> '{unitRef,resourceId}', (v_basis #>> '{unitRef,tenantId}')::uuid,
      v_envelope->>'kind', v_envelope->>'minimum', v_envelope->>'maximum', v_envelope->>'multiple'
    ) ON CONFLICT (policy_revision_id) DO UPDATE SET
      tenant_id = excluded.tenant_id, legal_entity_id = excluded.legal_entity_id,
      scope_kind = excluded.scope_kind, channel_id = excluded.channel_id,
      commerce_market_id = excluded.commerce_market_id, storefront_id = excluded.storefront_id,
      effective_from = excluded.effective_from, effective_to = excluded.effective_to,
      applicable_from = excluded.applicable_from, applicable_to = excluded.applicable_to,
      lifecycle = excluded.lifecycle, idempotency_key = excluded.idempotency_key,
      action_invocation_id = excluded.action_invocation_id,
      actor_principal_id = excluded.actor_principal_id, reason = excluded.reason,
      selector_kind = excluded.selector_kind,
      selector_resource_module_id = excluded.selector_resource_module_id,
      selector_resource_type = excluded.selector_resource_type,
      selector_resource_id = excluded.selector_resource_id,
      selector_tenant_id = excluded.selector_tenant_id, rule_kind = excluded.rule_kind,
      quantity_basis_module_id = excluded.quantity_basis_module_id,
      quantity_basis_resource_type = excluded.quantity_basis_resource_type,
      quantity_basis_resource_id = excluded.quantity_basis_resource_id,
      quantity_basis_tenant_id = excluded.quantity_basis_tenant_id,
      quantity_basis_owner_revision = excluded.quantity_basis_owner_revision,
      quantity_unit_module_id = excluded.quantity_unit_module_id,
      quantity_unit_resource_type = excluded.quantity_unit_resource_type,
      quantity_unit_resource_id = excluded.quantity_unit_resource_id,
      quantity_unit_tenant_id = excluded.quantity_unit_tenant_id,
      restriction_kind = excluded.restriction_kind, minimum = excluded.minimum,
      maximum = excluded.maximum, multiple = excluded.multiple;
  END LOOP;
  PERFORM commerce_customer_context.store_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'COMMERCE_QUANTITY_RULE', p_expected_generation, p_payload);
  RETURN QUERY SELECT jsonb_build_object('applied', true);
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  routine record;
BEGIN
  FOR routine IN
    SELECT procedure.oid::regprocedure AS identity
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'commerce_customer_context'
       AND procedure.prosecdef
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path TO pg_catalog, commerce_customer_context, pg_temp',
      routine.identity
    );
  END LOOP;
END;
$$;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."purchase_currency_policy_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."payment_term_policy_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_assignments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."customer_commerce_policy_completeness_generations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_candidate_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."market_bootstrap_policy_candidate_generations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE
  "commerce_customer_context"."market_bootstrap_policy_revisions",
  "commerce_customer_context"."purchase_currency_policy_revisions",
  "commerce_customer_context"."payment_term_policy_revisions",
  "commerce_customer_context"."commerce_quantity_rule_revisions",
  "commerce_customer_context"."commerce_quantity_rule_assignments",
  "commerce_customer_context"."customer_commerce_policy_completeness_generations",
  "commerce_customer_context"."market_bootstrap_policy_candidate_revisions",
  "commerce_customer_context"."market_bootstrap_policy_candidate_generations"
FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."guard_customer_commerce_policy_revision_mutation"() FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "commerce_customer_context"."guard_commerce_quantity_rule_assignment"() FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "commerce_customer_context"."derive_customer_commerce_policy_applicability"(jsonb,jsonb) FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "commerce_customer_context"."assert_customer_commerce_policy_scope"(uuid,uuid) FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "commerce_customer_context"."lock_customer_commerce_policy_generation"(uuid,uuid,text,bigint,jsonb) FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "commerce_customer_context"."store_customer_commerce_policy_generation"(uuid,uuid,text,bigint,jsonb) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."load_current_market_bootstrap_policy_candidates"(uuid,uuid[],timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."load_market_bootstrap_policy_state"(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."persist_market_bootstrap_policy_state"(uuid,uuid,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."load_purchase_currency_policy_state"(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."persist_purchase_currency_policy_state"(uuid,uuid,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."load_payment_term_policy_state"(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."persist_payment_term_policy_state"(uuid,uuid,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_state"(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."persist_commerce_quantity_rule_state"(uuid,uuid,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_assignments"(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."persist_commerce_quantity_rule_assignments"(uuid,uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."load_current_market_bootstrap_policy_candidates"(uuid,uuid[],timestamptz) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."load_market_bootstrap_policy_state"(uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."persist_market_bootstrap_policy_state"(uuid,uuid,bigint,jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."load_purchase_currency_policy_state"(uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."persist_purchase_currency_policy_state"(uuid,uuid,bigint,jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."load_payment_term_policy_state"(uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."persist_payment_term_policy_state"(uuid,uuid,bigint,jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_state"(uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."persist_commerce_quantity_rule_state"(uuid,uuid,bigint,jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_assignments"(uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."persist_commerce_quantity_rule_assignments"(uuid,uuid,bigint,jsonb) TO "ontos_runtime";
