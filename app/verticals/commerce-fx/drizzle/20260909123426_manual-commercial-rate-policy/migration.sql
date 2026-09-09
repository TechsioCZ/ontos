CREATE SCHEMA "commerce_fx";
--> statement-breakpoint
CREATE TABLE "commerce_fx"."manual_rate_policy_heads" (
	"manual_rate_policy_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"market_id" text NOT NULL,
	"storefront_id" text NOT NULL,
	"purpose" text NOT NULL,
	"source_currency_code" text NOT NULL,
	"target_currency_code" text NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_fx_manual_heads_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","manual_rate_policy_head_id"),
	CONSTRAINT "commerce_fx_manual_heads_context_uk" UNIQUE("tenant_id","legal_entity_id","channel_id","market_id","storefront_id","purpose","source_currency_code","target_currency_code"),
	CONSTRAINT "commerce_fx_manual_heads_channel_ck" CHECK ("channel_id" = btrim("channel_id") and length("channel_id") between 1 and 64 and "channel_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
	CONSTRAINT "commerce_fx_manual_heads_market_ck" CHECK ("market_id" = btrim("market_id") and length("market_id") between 1 and 64 and "market_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
	CONSTRAINT "commerce_fx_manual_heads_storefront_ck" CHECK ("storefront_id" = btrim("storefront_id") and length("storefront_id") between 1 and 64 and "storefront_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
	CONSTRAINT "commerce_fx_manual_heads_purpose_ck" CHECK ("purpose" in ('PRICING', 'PURCHASE_LIMIT_COMPARISON', 'PAYMENT', 'DISPLAY')),
	CONSTRAINT "commerce_fx_manual_heads_pair_ck" CHECK ("source_currency_code" ~ '^[A-Z]{3}$' and "target_currency_code" ~ '^[A-Z]{3}$' and "source_currency_code" <> "target_currency_code"),
	CONSTRAINT "commerce_fx_manual_heads_revision_ck" CHECK ("current_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_fx"."manual_rate_policy_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_fx"."manual_rate_policy_mutation_journal" (
	"manual_rate_policy_mutation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"request_payload" jsonb NOT NULL,
	"result_payload" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_fx_manual_journal_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","manual_rate_policy_mutation_id"),
	CONSTRAINT "commerce_fx_manual_journal_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "commerce_fx"."manual_rate_policy_mutation_journal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_fx"."manual_rate_policy_revisions" (
	"manual_rate_policy_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"manual_rate_policy_head_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"operation" text NOT NULL,
	"arithmetic_version" text,
	"rate" text,
	"direction" text,
	"rate_source_id" text NOT NULL,
	"source_revision" text NOT NULL,
	"rate_observed_at" timestamp with time zone,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"inverse_rate_permitted" boolean,
	"maximum_rate_age_seconds" integer,
	"rounding_increment" text,
	"rounding_mode" text,
	"rounding_rule_revision" text,
	"target_minor_units" integer,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_fx_manual_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","manual_rate_policy_revision_id"),
	CONSTRAINT "commerce_fx_manual_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","manual_rate_policy_head_id","revision"),
	CONSTRAINT "commerce_fx_manual_revisions_source_uk" UNIQUE("tenant_id","legal_entity_id","manual_rate_policy_head_id","source_revision"),
	CONSTRAINT "commerce_fx_manual_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "commerce_fx_manual_revisions_operation_ck" CHECK ("operation" in ('SET', 'WITHDRAW')),
	CONSTRAINT "commerce_fx_manual_revisions_source_id_ck" CHECK ("rate_source_id" = btrim("rate_source_id") and length("rate_source_id") between 1 and 64 and "rate_source_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
	CONSTRAINT "commerce_fx_manual_revisions_source_revision_ck" CHECK ("source_revision" = btrim("source_revision") and length("source_revision") between 1 and 200 and "source_revision" ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$'),
	CONSTRAINT "commerce_fx_manual_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "commerce_fx_manual_revisions_set_shape_ck" CHECK (("operation" = 'SET' and "arithmetic_version" is not null and "arithmetic_version" = 'commercial-fx-arithmetic.v1' and "rate" is not null and "rate" ~ '^(?:0|[1-9][0-9]{0,37})(?:[.][0-9]{1,18})?$' and "rate" !~ '^0(?:[.]0+)?$' and "direction" is not null and "direction" in ('SOURCE_TO_TARGET', 'TARGET_TO_SOURCE') and "rate_observed_at" is not null and "effective_to" is not null and "effective_to" > "effective_from" and "inverse_rate_permitted" is not null and "maximum_rate_age_seconds" is not null and "maximum_rate_age_seconds" between 0 and 31536000 and "rounding_increment" is not null and "rounding_increment" ~ '^(?:0|[1-9][0-9]{0,37})(?:[.][0-9]{1,18})?$' and "rounding_increment" !~ '^0(?:[.]0+)?$' and "rounding_increment"::numeric = trunc("rounding_increment"::numeric, "target_minor_units") and "rounding_mode" is not null and "rounding_mode" in ('ceil', 'floor', 'to-zero', 'from-zero', 'half-ceil', 'half-floor', 'half-to-zero', 'half-from-zero', 'half-even', 'half-odd') and "rounding_rule_revision" is not null and "rounding_rule_revision" = btrim("rounding_rule_revision") and length("rounding_rule_revision") between 1 and 200 and "rounding_rule_revision" ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$' and "target_minor_units" is not null and "target_minor_units" between 0 and 18 and ("direction" = 'SOURCE_TO_TARGET' or "inverse_rate_permitted")) or ("operation" = 'WITHDRAW' and "arithmetic_version" is null and "rate" is null and "direction" is null and "rate_observed_at" is null and "effective_to" is null and "inverse_rate_permitted" is null and "maximum_rate_age_seconds" is null and "rounding_increment" is null and "rounding_mode" is null and "rounding_rule_revision" is null and "target_minor_units" is null))
);
--> statement-breakpoint
ALTER TABLE "commerce_fx"."manual_rate_policy_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_fx"."manual_rate_policy_revisions" ADD CONSTRAINT "commerce_fx_manual_revisions_head_fk" FOREIGN KEY ("tenant_id","legal_entity_id","manual_rate_policy_head_id") REFERENCES "commerce_fx"."manual_rate_policy_heads"("tenant_id","legal_entity_id","manual_rate_policy_head_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_heads_scope_select" ON "commerce_fx"."manual_rate_policy_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_heads_scope_insert" ON "commerce_fx"."manual_rate_policy_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_fx"."manual_rate_policy_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_heads_scope_update" ON "commerce_fx"."manual_rate_policy_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_fx"."manual_rate_policy_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_heads_scope_delete" ON "commerce_fx"."manual_rate_policy_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_heads_scope_owner_routine" ON "commerce_fx"."manual_rate_policy_heads" AS PERMISSIVE FOR ALL TO public USING ("commerce_fx"."manual_rate_policy_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_fx"."manual_rate_policy_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_journal_scope_select" ON "commerce_fx"."manual_rate_policy_mutation_journal" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_journal_scope_insert" ON "commerce_fx"."manual_rate_policy_mutation_journal" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_fx"."manual_rate_policy_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_journal_scope_update" ON "commerce_fx"."manual_rate_policy_mutation_journal" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_fx"."manual_rate_policy_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_journal_scope_delete" ON "commerce_fx"."manual_rate_policy_mutation_journal" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_journal_scope_owner_routine" ON "commerce_fx"."manual_rate_policy_mutation_journal" AS PERMISSIVE FOR ALL TO public USING ("commerce_fx"."manual_rate_policy_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_fx"."manual_rate_policy_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_revisions_scope_select" ON "commerce_fx"."manual_rate_policy_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_revisions_scope_insert" ON "commerce_fx"."manual_rate_policy_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_fx"."manual_rate_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_revisions_scope_update" ON "commerce_fx"."manual_rate_policy_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_fx"."manual_rate_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_revisions_scope_delete" ON "commerce_fx"."manual_rate_policy_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_fx"."manual_rate_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_fx_manual_revisions_scope_owner_routine" ON "commerce_fx"."manual_rate_policy_revisions" AS PERMISSIVE FOR ALL TO public USING ("commerce_fx"."manual_rate_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_fx"."manual_rate_policy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_fx"."manual_rate_policy_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "commerce_fx"."manual_rate_policy_heads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commerce_fx"."manual_rate_policy_mutation_journal" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commerce_fx"."manual_rate_policy_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "commerce_fx"."reject_manual_rate_policy_append_only_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'manual Commercial FX evidence is append-only' USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "commerce_fx_manual_revisions_append_only"
BEFORE UPDATE OR DELETE ON "commerce_fx"."manual_rate_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION "commerce_fx"."reject_manual_rate_policy_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "commerce_fx_manual_journal_append_only"
BEFORE UPDATE OR DELETE ON "commerce_fx"."manual_rate_policy_mutation_journal"
FOR EACH ROW EXECUTE FUNCTION "commerce_fx"."reject_manual_rate_policy_append_only_change"();
--> statement-breakpoint
CREATE FUNCTION "commerce_fx"."reject_manual_rate_policy_head_identity_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW."manual_rate_policy_head_id" <> OLD."manual_rate_policy_head_id"
    OR NEW."tenant_id" <> OLD."tenant_id"
    OR NEW."legal_entity_id" <> OLD."legal_entity_id"
    OR NEW."channel_id" <> OLD."channel_id"
    OR NEW."market_id" <> OLD."market_id"
    OR NEW."storefront_id" <> OLD."storefront_id"
    OR NEW."purpose" <> OLD."purpose"
    OR NEW."source_currency_code" <> OLD."source_currency_code"
    OR NEW."target_currency_code" <> OLD."target_currency_code"
  THEN
    RAISE EXCEPTION 'manual Commercial FX policy identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "commerce_fx_manual_head_identity_immutable"
BEFORE UPDATE ON "commerce_fx"."manual_rate_policy_heads"
FOR EACH ROW EXECUTE FUNCTION "commerce_fx"."reject_manual_rate_policy_head_identity_change"();
--> statement-breakpoint
CREATE FUNCTION "commerce_fx"."assert_operation_scope"(p_tenant_id uuid, p_legal_entity_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce FX operation scope is unavailable' USING ERRCODE = '42501';
  END IF;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "commerce_fx"."manual_rate_policy_revision_json"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_revision_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'tenantId', revision.tenant_id,
    'sellingLegalEntityId', revision.legal_entity_id,
    'policyRevisionId', revision.manual_rate_policy_revision_id,
    'revision', revision.revision,
    'recordedAt', to_char(
      revision.recorded_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'context', jsonb_build_object(
      'channelId', head.channel_id,
      'marketId', head.market_id,
      'storefrontId', head.storefront_id,
      'purpose', head.purpose,
      'sourceCurrencyCode', head.source_currency_code,
      'targetCurrencyCode', head.target_currency_code
    ),
    'change', CASE revision.operation
      WHEN 'SET' THEN jsonb_build_object(
        'operation', revision.operation,
        'arithmeticVersion', revision.arithmetic_version,
        'rate', revision.rate,
        'direction', revision.direction,
        'rateSourceId', revision.rate_source_id,
        'sourceRevision', revision.source_revision,
        'rateObservedAt', to_char(
          revision.rate_observed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'effectiveFrom', to_char(
          revision.effective_from AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'effectiveTo', to_char(
          revision.effective_to AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'inverseRatePermitted', revision.inverse_rate_permitted,
        'maximumRateAgeSeconds', revision.maximum_rate_age_seconds,
        'roundingIncrement', revision.rounding_increment,
        'roundingMode', revision.rounding_mode,
        'roundingRuleRevision', revision.rounding_rule_revision,
        'targetMinorUnits', revision.target_minor_units
      )
      ELSE jsonb_build_object(
        'operation', revision.operation,
        'rateSourceId', revision.rate_source_id,
        'sourceRevision', revision.source_revision,
        'effectiveFrom', to_char(
          revision.effective_from AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      )
    END
  )
  FROM "commerce_fx"."manual_rate_policy_revisions" AS revision
  INNER JOIN "commerce_fx"."manual_rate_policy_heads" AS head
    ON head.tenant_id = revision.tenant_id
   AND head.legal_entity_id = revision.legal_entity_id
   AND head.manual_rate_policy_head_id = revision.manual_rate_policy_head_id
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.manual_rate_policy_revision_id = p_revision_id
$function$;
--> statement-breakpoint
CREATE FUNCTION "commerce_fx"."change_manual_rate_policy"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_action_invocation_id uuid := (p_input->>'actionInvocationId')::uuid;
  v_acting_principal_id uuid := (p_input->>'actingPrincipalId')::uuid;
  v_change jsonb := p_input->'change';
  v_context jsonb := p_input->'context';
  v_expected_revision integer := (p_input->>'expectedRevision')::integer;
  v_head "commerce_fx"."manual_rate_policy_heads"%ROWTYPE;
  v_previous "commerce_fx"."manual_rate_policy_revisions"%ROWTYPE;
  v_request jsonb := p_input;
  v_result jsonb;
  v_revision_id uuid;
  v_existing_request jsonb;
  v_existing_result jsonb;
  v_current_revision integer;
BEGIN
  PERFORM "commerce_fx"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  -- Serialize one idempotency identity before reading its durable journal record. Hash collisions
  -- only reduce concurrency; they cannot change an outcome or mix scoped evidence.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':' || p_legal_entity_id::text || ':' || v_action_invocation_id::text,
      0
    )
  );

  SELECT journal.request_payload, journal.result_payload
  INTO v_existing_request, v_existing_result
  FROM "commerce_fx"."manual_rate_policy_mutation_journal" AS journal
  WHERE journal.tenant_id = p_tenant_id
    AND journal.legal_entity_id = p_legal_entity_id
    AND journal.action_invocation_id = v_action_invocation_id;

  IF FOUND THEN
    IF v_existing_request = v_request THEN
      RETURN QUERY SELECT v_existing_result;
    ELSE
      SELECT coalesce(head.current_revision, 0)
      INTO v_current_revision
      FROM "commerce_fx"."manual_rate_policy_heads" AS head
      WHERE head.tenant_id = p_tenant_id
        AND head.legal_entity_id = p_legal_entity_id
        AND head.channel_id = v_context->>'channelId'
        AND head.market_id = v_context->>'marketId'
        AND head.storefront_id = v_context->>'storefrontId'
        AND head.purpose = v_context->>'purpose'
        AND head.source_currency_code = v_context->>'sourceCurrencyCode'
        AND head.target_currency_code = v_context->>'targetCurrencyCode';
      RETURN QUERY SELECT jsonb_build_object(
        '_tag', 'ACTION_INVOCATION_REUSED',
        'currentRevision', coalesce(v_current_revision, 0)
      );
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v_head
  FROM "commerce_fx"."manual_rate_policy_heads" AS head
  WHERE head.tenant_id = p_tenant_id
    AND head.legal_entity_id = p_legal_entity_id
    AND head.channel_id = v_context->>'channelId'
    AND head.market_id = v_context->>'marketId'
    AND head.storefront_id = v_context->>'storefrontId'
    AND head.purpose = v_context->>'purpose'
    AND head.source_currency_code = v_context->>'sourceCurrencyCode'
    AND head.target_currency_code = v_context->>'targetCurrencyCode'
  FOR UPDATE;

  IF NOT FOUND THEN
    IF v_expected_revision <> 0 THEN
      RETURN QUERY SELECT jsonb_build_object(
        '_tag', 'REVISION_CONFLICT',
        'currentRevision', 0
      );
      RETURN;
    END IF;
    INSERT INTO "commerce_fx"."manual_rate_policy_heads" (
      tenant_id, legal_entity_id, channel_id, market_id, storefront_id, purpose,
      source_currency_code, target_currency_code, updated_at
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_context->>'channelId', v_context->>'marketId',
      v_context->>'storefrontId', v_context->>'purpose',
      v_context->>'sourceCurrencyCode', v_context->>'targetCurrencyCode', statement_timestamp()
    )
    ON CONFLICT ON CONSTRAINT commerce_fx_manual_heads_context_uk DO NOTHING
    RETURNING * INTO v_head;

    IF NOT FOUND THEN
      SELECT * INTO STRICT v_head
      FROM "commerce_fx"."manual_rate_policy_heads" AS head
      WHERE head.tenant_id = p_tenant_id
        AND head.legal_entity_id = p_legal_entity_id
        AND head.channel_id = v_context->>'channelId'
        AND head.market_id = v_context->>'marketId'
        AND head.storefront_id = v_context->>'storefrontId'
        AND head.purpose = v_context->>'purpose'
        AND head.source_currency_code = v_context->>'sourceCurrencyCode'
        AND head.target_currency_code = v_context->>'targetCurrencyCode'
      FOR UPDATE;
    END IF;
  END IF;

  IF v_head.current_revision <> v_expected_revision THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'REVISION_CONFLICT',
      'currentRevision', v_head.current_revision
    );
    RETURN;
  END IF;

  IF v_head.current_revision > 0 THEN
    SELECT * INTO STRICT v_previous
    FROM "commerce_fx"."manual_rate_policy_revisions" AS revision
    WHERE revision.tenant_id = p_tenant_id
      AND revision.legal_entity_id = p_legal_entity_id
      AND revision.manual_rate_policy_head_id = v_head.manual_rate_policy_head_id
      AND revision.revision = v_head.current_revision;

    IF v_previous.operation = v_change->>'operation'
      AND v_previous.rate_source_id = v_change->>'rateSourceId'
      AND v_previous.source_revision = v_change->>'sourceRevision'
      AND v_previous.effective_from = (v_change->>'effectiveFrom')::timestamptz
      AND (
        v_previous.operation = 'WITHDRAW'
        OR (
          v_previous.rate = v_change->>'rate'
          AND v_previous.arithmetic_version = v_change->>'arithmeticVersion'
          AND v_previous.direction = v_change->>'direction'
          AND v_previous.rate_observed_at = (v_change->>'rateObservedAt')::timestamptz
          AND v_previous.effective_to = (v_change->>'effectiveTo')::timestamptz
          AND v_previous.inverse_rate_permitted = (v_change->>'inverseRatePermitted')::boolean
          AND v_previous.maximum_rate_age_seconds = (v_change->>'maximumRateAgeSeconds')::integer
          AND v_previous.rounding_increment = v_change->>'roundingIncrement'
          AND v_previous.rounding_mode = v_change->>'roundingMode'
          AND v_previous.rounding_rule_revision = v_change->>'roundingRuleRevision'
          AND v_previous.target_minor_units = (v_change->>'targetMinorUnits')::integer
        )
      )
    THEN
      v_result := jsonb_build_object(
        '_tag', 'UNCHANGED',
        'current', "commerce_fx"."manual_rate_policy_revision_json"(
          p_tenant_id, p_legal_entity_id, v_previous.manual_rate_policy_revision_id
        )
      );
      INSERT INTO "commerce_fx"."manual_rate_policy_mutation_journal" (
        tenant_id, legal_entity_id, action_invocation_id, request_payload, result_payload,
        recorded_at
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_action_invocation_id, v_request, v_result,
        statement_timestamp()
      );
      RETURN QUERY SELECT v_result;
      RETURN;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "commerce_fx"."manual_rate_policy_revisions" AS revision
    WHERE revision.tenant_id = p_tenant_id
      AND revision.legal_entity_id = p_legal_entity_id
      AND revision.manual_rate_policy_head_id = v_head.manual_rate_policy_head_id
      AND revision.source_revision = v_change->>'sourceRevision'
  ) THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'SOURCE_REVISION_REUSED',
      'currentRevision', v_head.current_revision
    );
    RETURN;
  END IF;

  IF v_change->>'operation' = 'SET'
    AND (v_change->>'rateObservedAt')::timestamptz > statement_timestamp()
  THEN
    RAISE EXCEPTION 'manual FX observation cannot be in the future' USING ERRCODE = '22007';
  END IF;

  INSERT INTO "commerce_fx"."manual_rate_policy_revisions" (
    tenant_id, legal_entity_id, manual_rate_policy_head_id, revision, operation,
    arithmetic_version, rate, direction, rate_source_id, source_revision, rate_observed_at,
    effective_from, effective_to, inverse_rate_permitted, maximum_rate_age_seconds,
    rounding_increment, rounding_mode, rounding_rule_revision, target_minor_units,
    reason, action_invocation_id, acting_principal_id,
    recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_head.manual_rate_policy_head_id,
    v_head.current_revision + 1, v_change->>'operation', v_change->>'arithmeticVersion',
    v_change->>'rate',
    v_change->>'direction', v_change->>'rateSourceId', v_change->>'sourceRevision',
    (v_change->>'rateObservedAt')::timestamptz,
    (v_change->>'effectiveFrom')::timestamptz,
    (v_change->>'effectiveTo')::timestamptz,
    (v_change->>'inverseRatePermitted')::boolean,
    (v_change->>'maximumRateAgeSeconds')::integer,
    v_change->>'roundingIncrement', v_change->>'roundingMode',
    v_change->>'roundingRuleRevision', (v_change->>'targetMinorUnits')::integer,
    p_input->>'reason', v_action_invocation_id, v_acting_principal_id, statement_timestamp()
  ) RETURNING manual_rate_policy_revision_id INTO v_revision_id;

  UPDATE "commerce_fx"."manual_rate_policy_heads"
  SET current_revision = current_revision + 1, updated_at = statement_timestamp()
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND manual_rate_policy_head_id = v_head.manual_rate_policy_head_id;

  v_result := jsonb_build_object(
    '_tag', 'APPLIED',
    'current', "commerce_fx"."manual_rate_policy_revision_json"(
      p_tenant_id, p_legal_entity_id, v_revision_id
    )
  );
  INSERT INTO "commerce_fx"."manual_rate_policy_mutation_journal" (
    tenant_id, legal_entity_id, action_invocation_id, request_payload, result_payload,
    recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_action_invocation_id, v_request, v_result,
    statement_timestamp()
  );
  RETURN QUERY SELECT v_result;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "commerce_fx"."resolve_manual_rate_policy"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_channel_id text,
  p_market_id text,
  p_storefront_id text,
  p_purpose text,
  p_source_currency_code text,
  p_target_currency_code text,
  p_operation_at timestamptz
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_head "commerce_fx"."manual_rate_policy_heads"%ROWTYPE;
  v_revision "commerce_fx"."manual_rate_policy_revisions"%ROWTYPE;
  v_revision_count integer;
BEGIN
  PERFORM "commerce_fx"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  SELECT * INTO v_head
  FROM "commerce_fx"."manual_rate_policy_heads" AS head
  WHERE head.tenant_id = p_tenant_id
    AND head.legal_entity_id = p_legal_entity_id
    AND head.channel_id = p_channel_id
    AND head.market_id = p_market_id
    AND head.storefront_id = p_storefront_id
    AND head.purpose = p_purpose
    AND head.source_currency_code = p_source_currency_code
    AND head.target_currency_code = p_target_currency_code;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'NOT_CONFIGURED');
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_revision_count
  FROM "commerce_fx"."manual_rate_policy_revisions" AS revision
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.manual_rate_policy_head_id = v_head.manual_rate_policy_head_id;
  IF v_revision_count <> v_head.current_revision THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'INDETERMINATE');
    RETURN;
  END IF;

  -- Explicit version precedence: latest effective start, then latest CAS revision. Expiry never
  -- falls back to an older overlapping rate.
  SELECT * INTO v_revision
  FROM "commerce_fx"."manual_rate_policy_revisions" AS revision
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.manual_rate_policy_head_id = v_head.manual_rate_policy_head_id
    AND revision.effective_from <= p_operation_at
    AND revision.recorded_at <= p_operation_at
  ORDER BY revision.effective_from DESC, revision.revision DESC
  LIMIT 1;
  IF NOT FOUND OR v_revision.operation = 'WITHDRAW' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'NOT_CONFIGURED');
    RETURN;
  END IF;
  IF v_revision.effective_to <= p_operation_at THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'STALE');
    RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'RESOLVED',
    'current', "commerce_fx"."manual_rate_policy_revision_json"(
      p_tenant_id, p_legal_entity_id, v_revision.manual_rate_policy_revision_id
    )
  );
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "commerce_fx"."read_manual_rate_policy_revision"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_revision_id uuid,
  p_channel_id text,
  p_market_id text,
  p_storefront_id text,
  p_purpose text,
  p_source_currency_code text,
  p_target_currency_code text
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_revision_id uuid;
BEGIN
  PERFORM "commerce_fx"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  SELECT revision.manual_rate_policy_revision_id INTO v_revision_id
  FROM "commerce_fx"."manual_rate_policy_revisions" AS revision
  INNER JOIN "commerce_fx"."manual_rate_policy_heads" AS head
    ON head.tenant_id = revision.tenant_id
   AND head.legal_entity_id = revision.legal_entity_id
   AND head.manual_rate_policy_head_id = revision.manual_rate_policy_head_id
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.manual_rate_policy_revision_id = p_revision_id
    AND head.channel_id = p_channel_id
    AND head.market_id = p_market_id
    AND head.storefront_id = p_storefront_id
    AND head.purpose = p_purpose
    AND head.source_currency_code = p_source_currency_code
    AND head.target_currency_code = p_target_currency_code;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'INDETERMINATE');
    RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'RESOLVED',
    'current', "commerce_fx"."manual_rate_policy_revision_json"(
      p_tenant_id, p_legal_entity_id, v_revision_id
    )
  );
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "commerce_fx" FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "commerce_fx" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "commerce_fx" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "commerce_fx" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_fx"."reject_manual_rate_policy_append_only_change"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_fx"."reject_manual_rate_policy_head_identity_change"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_fx"."assert_operation_scope"(uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_fx"."manual_rate_policy_revision_json"(uuid, uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_fx"."change_manual_rate_policy"(uuid, uuid, jsonb) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_fx"."resolve_manual_rate_policy"(uuid, uuid, text, text, text, text, text, text, timestamptz) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_fx"."read_manual_rate_policy_revision"(uuid, uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_fx"."change_manual_rate_policy"(uuid, uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_fx"."resolve_manual_rate_policy"(uuid, uuid, text, text, text, text, text, text, timestamptz) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_fx"."read_manual_rate_policy_revision"(uuid, uuid, uuid, text, text, text, text, text, text) TO "ontos_runtime";
