CREATE SCHEMA IF NOT EXISTS "pricing";

CREATE TABLE "pricing"."currency_support_revisions" (
  "currency_support_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "legal_entity_id" uuid NOT NULL,
  "context_revision" text NOT NULL,
  "storefront_id" text NOT NULL,
  "market_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "cart_id" text NOT NULL,
  "subject_fingerprint" text NOT NULL,
  "generation" integer NOT NULL,
  "pricing_revision" text NOT NULL,
  "supported_currencies" jsonb NOT NULL,
  "effective_from" timestamptz NOT NULL,
  "effective_to" timestamptz,
  "action_invocation_id" uuid NOT NULL,
  "actor_principal_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "recorded_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "pricing_currency_support_generation_ck" CHECK ("generation" > 0),
  CONSTRAINT "pricing_currency_support_revision_ck" CHECK ("pricing_revision" ~ '^pricing-currency-support:[1-9][0-9]*$'),
  CONSTRAINT "pricing_currency_support_period_ck" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "pricing_currency_support_currencies_ck" CHECK (jsonb_typeof("supported_currencies") = 'array' AND jsonb_array_length("supported_currencies") > 0),
  CONSTRAINT "pricing_currency_support_reason_ck" CHECK ("reason" = btrim("reason") AND length("reason") BETWEEN 1 AND 1000),
  CONSTRAINT "pricing_currency_support_scope_generation_uk" UNIQUE ("tenant_id", "legal_entity_id", "context_revision", "storefront_id", "market_id", "channel_id", "cart_id", "subject_fingerprint", "generation"),
  CONSTRAINT "pricing_currency_support_action_uk" UNIQUE ("tenant_id", "action_invocation_id")
);

CREATE INDEX "pricing_currency_support_current_idx" ON "pricing"."currency_support_revisions" ("tenant_id", "legal_entity_id", "context_revision", "storefront_id", "market_id", "channel_id", "cart_id", "subject_fingerprint", "effective_from");
ALTER TABLE "pricing"."currency_support_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."currency_support_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pricing_currency_support_scope_select" ON "pricing"."currency_support_revisions" FOR SELECT USING ("tenant_id" = current_setting('ontos.tenant_id', true)::uuid AND "legal_entity_id" = current_setting('ontos.legal_entity_id', true)::uuid);
CREATE POLICY "pricing_currency_support_scope_insert" ON "pricing"."currency_support_revisions" FOR INSERT WITH CHECK ("tenant_id" = current_setting('ontos.tenant_id', true)::uuid AND "legal_entity_id" = current_setting('ontos.legal_entity_id', true)::uuid);
CREATE POLICY "pricing_currency_support_scope_update" ON "pricing"."currency_support_revisions" FOR UPDATE USING ("tenant_id" = current_setting('ontos.tenant_id', true)::uuid AND "legal_entity_id" = current_setting('ontos.legal_entity_id', true)::uuid) WITH CHECK ("tenant_id" = current_setting('ontos.tenant_id', true)::uuid AND "legal_entity_id" = current_setting('ontos.legal_entity_id', true)::uuid);
CREATE POLICY "pricing_currency_support_scope_delete" ON "pricing"."currency_support_revisions" FOR DELETE USING (false);

CREATE OR REPLACE FUNCTION "pricing"."read_current_supported_currencies"(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pricing
AS $function$
  SELECT jsonb_build_object(
    'generation', revision.generation,
    'nextApplicabilityBoundary', CASE WHEN revision.effective_to IS NULL THEN NULL ELSE to_char(revision.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'observedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pricingRevision', revision.pricing_revision,
    'supportedCurrencies', revision.supported_currencies
  )
  FROM pricing.currency_support_revisions AS revision
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.context_revision = p_input ->> 'contextRevision'
    AND revision.storefront_id = p_input ->> 'storefrontId'
    AND revision.market_id = p_input ->> 'marketId'
    AND revision.channel_id = p_input ->> 'channelId'
    AND revision.cart_id = p_input ->> 'cartId'
    AND revision.subject_fingerprint = p_input ->> 'subjectFingerprint'
    AND revision.effective_from <= (p_input ->> 'effectiveAt')::timestamptz
    AND (revision.effective_to IS NULL OR (p_input ->> 'effectiveAt')::timestamptz < revision.effective_to)
  ORDER BY revision.generation DESC
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION "pricing"."read_current_supported_currencies"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "pricing"."read_current_supported_currencies"(uuid, uuid, jsonb) TO ontos_runtime;
