ALTER TABLE "assortment"."assortment_applicability_bindings" ADD COLUMN "fixture_scope_version" text;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_applicability_bindings" ADD CONSTRAINT "assortment_bindings_fixture_scope_version_ck" CHECK ("fixture_scope_version" is null or (
        "fixture_scope_version" = 'C14_CANONICAL_V1'
        and "binding_kind" = 'COMMERCE_CUSTOMER_GROUP'
        and "channel_resource_id" in ('B2C', 'B2B')
        and "market_resource_id" is not null
        and "storefront_resource_id" is not null
      ));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assortment"."write_c14_rule_fixture"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid,
  p_source_admission_id uuid,
  p_source_principal_id uuid,
  p_fixture jsonb
)
RETURNS TABLE(binding_id uuid, revision_id uuid, rule_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, assortment, pg_temp
SET row_security = on
AS $$
DECLARE
  v_stable_code text := p_fixture->>'stableCode';
  v_reason text := p_fixture->>'reason';
  v_effective_from timestamptz;
  v_provenance text;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
      OR p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL
      OR p_source_admission_id IS NULL OR p_source_principal_id IS NULL
      OR p_tenant_id::text IS DISTINCT FROM current_setting('ontos.tenant_id', true)
      OR p_legal_entity_id::text IS DISTINCT FROM current_setting('ontos.legal_entity_id', true)
      OR NOT EXISTS (
        SELECT FROM trust.read_source_execution_fence(p_tenant_id, p_source_admission_id) AS source
        WHERE source.action_key = 'integration.symmy.admit-symmy-job'
          AND source.legal_entity_id = p_legal_entity_id
          AND source.original_principal_id = p_source_principal_id
          AND source.fence_state = 'open'
      ) THEN
    RAISE EXCEPTION 'Assortment fixture operation scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_fixture) IS DISTINCT FROM 'object'
      OR NOT p_fixture ?& ARRAY['channel', 'effectiveFrom', 'effect', 'fingerprint', 'group', 'market',
                                'product', 'purpose', 'reason', 'scopeVersion', 'stableCode', 'storefront', 'storefrontAppId']
      OR (SELECT count(*) FROM jsonb_each(p_fixture)) <> 13
      OR EXISTS (SELECT FROM jsonb_each(p_fixture) AS field
        WHERE jsonb_typeof(field.value) <> 'string' OR length(btrim(field.value #>> '{}')) NOT BETWEEN 1 AND 500)
      OR p_fixture->>'scopeVersion' IS DISTINCT FROM 'C14_CANONICAL_V1'
      OR p_fixture->>'channel' NOT IN ('B2C', 'B2B')
      OR p_fixture->>'market' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR p_fixture->>'storefront' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR char_length(p_fixture->>'storefrontAppId') > 100
      OR p_fixture->>'storefrontAppId' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      OR v_stable_code !~ '^symmy-[0-9a-f]{64}$'
      OR p_fixture->>'effect' NOT IN ('ALLOW', 'DENY')
      OR p_fixture->>'purpose' NOT IN ('VISIBILITY', 'PURCHASE')
      OR p_fixture->>'fingerprint' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Assortment fixture operation payload is invalid' USING ERRCODE = '22023';
  END IF;

  v_effective_from := (p_fixture->>'effectiveFrom')::timestamptz;
  IF NOT isfinite(v_effective_from) THEN
    RAISE EXCEPTION 'Assortment fixture effective time is invalid' USING ERRCODE = '22023';
  END IF;
  v_provenance := 'internal-c14-assortment:' || substr(v_stable_code, 7);
  rule_id := gen_random_uuid();
  revision_id := gen_random_uuid();
  binding_id := gen_random_uuid();

  INSERT INTO "assortment"."assortment_stable_rules" (
    stable_rule_id, tenant_id, stable_code, action_invocation_id, actor_principal_id, idempotency_key, provenance_ref, reason
  ) VALUES (
    rule_id, p_tenant_id, v_stable_code, p_action_invocation_id, p_actor_principal_id,
    p_action_invocation_id::text, v_provenance, v_reason
  );
  INSERT INTO "assortment"."assortment_rule_revisions" (
    rule_revision_id, tenant_id, stable_rule_id, revision_number, purpose, effect, selector_kind,
    selector_target_owner_module_id, selector_target_resource_type, selector_target_resource_id,
    semantic_fingerprint, action_invocation_id, actor_principal_id, idempotency_key, provenance_ref, reason
  ) VALUES (
    revision_id, p_tenant_id, rule_id, 1, p_fixture->>'purpose', p_fixture->>'effect', 'PRODUCT',
    'commerce.catalog', 'commerce.catalog.product', p_fixture->>'product', p_fixture->>'fingerprint',
    p_action_invocation_id, p_actor_principal_id, p_action_invocation_id::text, v_provenance, v_reason
  );
  INSERT INTO "assortment"."assortment_applicability_bindings" (
    applicability_binding_id, tenant_id, legal_entity_id, rule_revision_id, binding_kind, customer_group_resource_id,
    channel_resource_id, market_resource_id, storefront_resource_id, effective_from, fixture_scope_version,
    action_invocation_id, actor_principal_id, idempotency_key, provenance_ref, reason
  ) VALUES (
    binding_id, p_tenant_id, p_legal_entity_id, revision_id, 'COMMERCE_CUSTOMER_GROUP', p_fixture->>'group',
    p_fixture->>'channel', p_fixture->>'market', p_fixture->>'storefront', v_effective_from, p_fixture->>'scopeVersion',
    p_action_invocation_id, p_actor_principal_id, p_action_invocation_id::text, v_provenance, v_reason
  );
  RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  -- The function subtransaction rolls back all three inserts on a competing immutable fixture identity.
  RETURN;
END;
$$;
