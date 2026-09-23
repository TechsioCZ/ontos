ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" RENAME COLUMN "quantity_basis_owner_revision" TO "quantity_target_divisibility_revision";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" RENAME COLUMN "quantity_basis_module_id" TO "quantity_target_module_id";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" RENAME COLUMN "quantity_basis_resource_id" TO "quantity_target_resource_id";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" RENAME COLUMN "quantity_basis_resource_type" TO "quantity_target_resource_type";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" RENAME COLUMN "quantity_basis_tenant_id" TO "quantity_target_tenant_id";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" DROP CONSTRAINT "ccc_quantity_rule_basis_revision_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" RENAME CONSTRAINT "ccc_quantity_rule_basis_resource_ck" TO "ccc_quantity_rule_target_resource_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ADD COLUMN "quantity_unit_rule_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ALTER COLUMN "quantity_target_divisibility_revision" SET DATA TYPE integer USING "quantity_target_divisibility_revision"::integer;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" DROP CONSTRAINT "ccc_quantity_rule_selector_ck", ADD CONSTRAINT "ccc_quantity_rule_selector_ck" CHECK (("selector_kind" = 'ALL' and "selector_resource_module_id" is null and "selector_resource_type" is null and "selector_resource_id" is null and "selector_tenant_id" is null) or ("selector_kind" = 'PRODUCT' and "selector_resource_module_id" = 'commerce.catalog' and "selector_resource_type" = 'commerce.catalog.product' and "selector_resource_id" is not null and "selector_tenant_id" = "tenant_id") or ("selector_kind" = 'VARIANT' and "selector_resource_module_id" = 'commerce.catalog' and "selector_resource_type" = 'commerce.catalog.variant' and "selector_resource_id" is not null and "selector_tenant_id" = "tenant_id") or ("selector_kind" = 'PACKAGE_OPTION' and "selector_resource_module_id" = 'commerce.catalog' and "selector_resource_type" = 'commerce.catalog.package-definition' and "selector_resource_id" is not null and "selector_tenant_id" = "tenant_id"));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" DROP CONSTRAINT "ccc_quantity_rule_basis_ck", ADD CONSTRAINT "ccc_quantity_rule_basis_ck" CHECK ("quantity_target_module_id" = 'commerce.catalog' and "quantity_target_resource_type" in ('commerce.catalog.variant', 'commerce.catalog.package-definition') and "quantity_target_tenant_id" = "tenant_id" and "quantity_target_divisibility_revision" between 1 and 2147483647 and "quantity_unit_module_id" = 'commerce.catalog' and "quantity_unit_resource_type" = 'commerce.catalog.product-unit' and "quantity_unit_tenant_id" = "tenant_id" and "quantity_unit_rule_revision" between 1 and 2147483647);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" DROP CONSTRAINT "ccc_quantity_rule_target_resource_ck", ADD CONSTRAINT "ccc_quantity_rule_target_resource_ck" CHECK ("quantity_target_resource_id" = btrim("quantity_target_resource_id") and length("quantity_target_resource_id") > 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_state"(
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
        'targetRef', jsonb_build_object('moduleId', quantity_target_module_id,
          'resourceType', quantity_target_resource_type, 'resourceId', quantity_target_resource_id,
          'tenantId', quantity_target_tenant_id::text),
        'targetDivisibilityRevision', quantity_target_divisibility_revision,
        'unitRef', jsonb_build_object('moduleId', quantity_unit_module_id,
          'resourceType', quantity_unit_resource_type, 'resourceId', quantity_unit_resource_id,
          'tenantId', quantity_unit_tenant_id::text),
        'unitRuleRevision', quantity_unit_rule_revision),
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
CREATE OR REPLACE FUNCTION "commerce_customer_context"."persist_commerce_quantity_rule_state"(
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
       OR (v_basis #>> '{targetRef,tenantId}')::uuid IS DISTINCT FROM p_tenant_id
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
      rule_kind, quantity_target_module_id, quantity_target_resource_type, quantity_target_resource_id,
      quantity_target_tenant_id, quantity_target_divisibility_revision, quantity_unit_module_id,
      quantity_unit_resource_type, quantity_unit_resource_id, quantity_unit_tenant_id,
      quantity_unit_rule_revision, restriction_kind, minimum, maximum, multiple
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
      v_revision #>> '{value,constraintMode}', v_basis #>> '{targetRef,moduleId}',
      v_basis #>> '{targetRef,resourceType}', v_basis #>> '{targetRef,resourceId}',
      (v_basis #>> '{targetRef,tenantId}')::uuid,
      (v_basis->>'targetDivisibilityRevision')::integer,
      v_basis #>> '{unitRef,moduleId}', v_basis #>> '{unitRef,resourceType}',
      v_basis #>> '{unitRef,resourceId}', (v_basis #>> '{unitRef,tenantId}')::uuid,
      (v_basis->>'unitRuleRevision')::integer,
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
      quantity_target_module_id = excluded.quantity_target_module_id,
      quantity_target_resource_type = excluded.quantity_target_resource_type,
      quantity_target_resource_id = excluded.quantity_target_resource_id,
      quantity_target_tenant_id = excluded.quantity_target_tenant_id,
      quantity_target_divisibility_revision = excluded.quantity_target_divisibility_revision,
      quantity_unit_module_id = excluded.quantity_unit_module_id,
      quantity_unit_resource_type = excluded.quantity_unit_resource_type,
      quantity_unit_resource_id = excluded.quantity_unit_resource_id,
      quantity_unit_tenant_id = excluded.quantity_unit_tenant_id,
      quantity_unit_rule_revision = excluded.quantity_unit_rule_revision,
      restriction_kind = excluded.restriction_kind, minimum = excluded.minimum,
      maximum = excluded.maximum, multiple = excluded.multiple;
  END LOOP;
  PERFORM commerce_customer_context.store_customer_commerce_policy_generation(
    p_tenant_id, p_legal_entity_id, 'COMMERCE_QUANTITY_RULE', p_expected_generation, p_payload);
  RETURN QUERY SELECT jsonb_build_object('applied', true);
END;
$$;
