CREATE POLICY "assortment_bindings_c14_fixture_insert" ON "assortment"."assortment_applicability_bindings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_user <> session_user
      and "assortment"."assortment_applicability_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
      and "assortment"."assortment_applicability_bindings"."provenance_ref" ~ '^internal-c14-assortment:[0-9a-f]{64}$'
      and "assortment"."assortment_applicability_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_revisions_c14_fixture_insert" ON "assortment"."assortment_rule_revisions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_user <> session_user
      and "assortment"."assortment_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
      and "assortment"."assortment_rule_revisions"."provenance_ref" ~ '^internal-c14-assortment:[0-9a-f]{64}$'
      and true);--> statement-breakpoint
CREATE POLICY "assortment_stable_rules_c14_fixture_insert" ON "assortment"."assortment_stable_rules" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_user <> session_user
      and "assortment"."assortment_stable_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
      and "assortment"."assortment_stable_rules"."provenance_ref" ~ '^internal-c14-assortment:[0-9a-f]{64}$'
      and true);
--> statement-breakpoint
CREATE FUNCTION "assortment"."import_c14_rule_fixture"(
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
                                'product', 'purpose', 'reason', 'stableCode', 'storefront']
      OR (SELECT count(*) FROM jsonb_each(p_fixture)) <> 11
      OR EXISTS (SELECT FROM jsonb_each(p_fixture) AS field
        WHERE jsonb_typeof(field.value) <> 'string' OR length(btrim(field.value #>> '{}')) NOT BETWEEN 1 AND 500)
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
    channel_resource_id, market_resource_id, storefront_resource_id, effective_from,
    action_invocation_id, actor_principal_id, idempotency_key, provenance_ref, reason
  ) VALUES (
    binding_id, p_tenant_id, p_legal_entity_id, revision_id, 'COMMERCE_CUSTOMER_GROUP', p_fixture->>'group',
    p_fixture->>'channel', p_fixture->>'market', p_fixture->>'storefront', v_effective_from,
    p_action_invocation_id, p_actor_principal_id, p_action_invocation_id::text, v_provenance, v_reason
  );
  RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  -- The function subtransaction rolls back all three inserts on a competing immutable fixture identity.
  RETURN;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "assortment"."import_c14_rule_fixture"(uuid,uuid,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "assortment"."import_c14_rule_fixture"(uuid,uuid,uuid,uuid,uuid,uuid,jsonb) TO "ontos_runtime";
