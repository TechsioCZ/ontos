ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ALTER COLUMN "quantity_target_divisibility_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ALTER COLUMN "quantity_target_module_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ALTER COLUMN "quantity_target_resource_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ALTER COLUMN "quantity_target_resource_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ALTER COLUMN "quantity_target_tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ALTER COLUMN "quantity_unit_rule_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" ADD CONSTRAINT "ccc_quantity_rule_audience_ck" CHECK ("audience" in ('SHARED', 'ASSIGNMENT_ONLY'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions" DROP CONSTRAINT "ccc_quantity_rule_basis_ck", ADD CONSTRAINT "ccc_quantity_rule_basis_ck" CHECK ("quantity_unit_module_id" = 'commerce.catalog' and "quantity_unit_resource_type" = 'commerce.catalog.product-unit' and "quantity_unit_tenant_id" = "tenant_id" and (("quantity_target_module_id" is null and "quantity_target_resource_type" is null and "quantity_target_resource_id" is null and "quantity_target_tenant_id" is null and "quantity_target_divisibility_revision" is null and "quantity_unit_rule_revision" is null) or ("quantity_target_module_id" is not null and "quantity_target_resource_type" is not null and "quantity_target_resource_id" is not null and "quantity_target_tenant_id" is not null and "quantity_target_divisibility_revision" is not null and "quantity_unit_rule_revision" is not null and "quantity_target_module_id" = 'commerce.catalog' and "quantity_target_resource_type" in ('commerce.catalog.variant', 'commerce.catalog.package-definition') and "quantity_target_tenant_id" = "tenant_id" and "quantity_target_divisibility_revision" between 1 and 2147483647 and "quantity_unit_rule_revision" between 1 and 2147483647)));
-- Legacy revisions retain NULL audience and their original exact basis. No history is rewritten.
-- Current projection qualifies legacy audience from the complete retained assignment history.
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions"
  DROP CONSTRAINT "ccc_quantity_rule_no_overlap_excl";
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."commerce_quantity_rule_revisions"
  ADD CONSTRAINT "ccc_quantity_rule_no_overlap_excl"
  EXCLUDE USING gist (
    tenant_id WITH =, legal_entity_id WITH =, scope_kind WITH =,
    coalesce(channel_id, '') WITH =, coalesce(commerce_market_id, '') WITH =,
    coalesce(storefront_id, '') WITH =, selector_kind WITH =,
    coalesce(selector_resource_id, '') WITH =,
    (case when rule_kind = 'NON_RELAXABLE_CONSTRAINT' or audience = 'ASSIGNMENT_ONLY' then policy_revision_id::text else rule_kind end) WITH =,
    (case when applicable_from is null then 'empty'::tstzrange
      else tstzrange(applicable_from, coalesce(applicable_to, 'infinity'::timestamptz), '[)') end) WITH &&
  );

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
    'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveTo', to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'field', 'COMMERCE_QUANTITY_RULE',
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
      'basis', case when quantity_target_resource_id is null then jsonb_build_object(
        'kind', 'PURCHASE_UNIT',
        'unitRef', jsonb_build_object('moduleId', quantity_unit_module_id,
          'resourceType', quantity_unit_resource_type, 'resourceId', quantity_unit_resource_id,
          'tenantId', quantity_unit_tenant_id::text))
      else jsonb_build_object(
        'targetRef', jsonb_build_object('moduleId', quantity_target_module_id,
          'resourceType', quantity_target_resource_type, 'resourceId', quantity_target_resource_id,
          'tenantId', quantity_target_tenant_id::text),
        'targetDivisibilityRevision', quantity_target_divisibility_revision,
        'unitRef', jsonb_build_object('moduleId', quantity_unit_module_id,
          'resourceType', quantity_unit_resource_type, 'resourceId', quantity_unit_resource_id,
          'tenantId', quantity_unit_tenant_id::text),
        'unitRuleRevision', quantity_unit_rule_revision) end,
      'envelope', case restriction_kind
        when 'NO_COMMERCIAL_QUANTITY_RESTRICTION' then jsonb_build_object(
          'kind', 'NO_COMMERCIAL_QUANTITY_RESTRICTION')
        else jsonb_build_object('kind', 'BOUNDED', 'minimum', minimum,
          'maximum', maximum, 'multiple', multiple) end)
      || case when audience is null then '{}'::jsonb else jsonb_build_object('audience', audience) end
  ) ORDER BY recorded_at, policy_revision_id), '[]'::jsonb) INTO v_revisions
    FROM commerce_quantity_rule_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN QUERY SELECT coalesce(v_metadata, '{}'::jsonb) || jsonb_build_object(
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
    IF (v_basis->>'kind' IS NOT NULL AND v_basis->>'kind' <> 'PURCHASE_UNIT')
       OR (v_basis->>'kind' = 'PURCHASE_UNIT' AND
           v_basis ?| array['targetRef', 'targetDivisibilityRevision', 'unitRuleRevision']) THEN
      RAISE EXCEPTION 'Commerce Quantity policy basis cannot mix purchase Unit and exact physical evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_basis_ck';
    END IF;
    IF (v_revision->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
       OR (v_revision #>> '{scope,sellingLegalEntityId}')::uuid IS DISTINCT FROM p_legal_entity_id
       OR (v_basis->>'kind' IS DISTINCT FROM 'PURCHASE_UNIT' AND
           (v_basis #>> '{targetRef,tenantId}')::uuid IS DISTINCT FROM p_tenant_id)
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
      rule_kind, audience, quantity_target_module_id, quantity_target_resource_type, quantity_target_resource_id,
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
      v_revision #>> '{value,constraintMode}', v_revision #>> '{value,audience}', v_basis #>> '{targetRef,moduleId}',
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
      audience = excluded.audience,
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

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."guard_commerce_quantity_rule_assignment"()
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
  -- Same serialization key as the governed assignment write, including the first assignment.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.legal_entity_id::text || ':COMMERCE_QUANTITY_ASSIGNMENT', 333));
  IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.commerce_quantity_rule_assignments
       WHERE quantity_rule_assignment_id = NEW.quantity_rule_assignment_id)
     AND (v_revision.audience = 'SHARED' OR (v_revision.audience IS NULL AND NOT EXISTS (
       SELECT 1 FROM commerce_customer_context.commerce_quantity_rule_assignments
        WHERE tenant_id = NEW.tenant_id AND legal_entity_id = NEW.legal_entity_id
          AND policy_revision_id = NEW.policy_revision_id))) THEN
    RAISE EXCEPTION 'A shared quantity revision cannot acquire an implicit private audience'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_assignment_audience';
  END IF;
  IF v_revision.rule_kind = 'REPLACEABLE_ENVELOPE' AND NEW.applicable_from IS NOT NULL AND EXISTS (
    SELECT 1 FROM commerce_customer_context.commerce_quantity_rule_assignments assignment
    JOIN commerce_customer_context.commerce_quantity_rule_revisions revision
      ON revision.tenant_id = assignment.tenant_id AND revision.legal_entity_id = assignment.legal_entity_id
     AND revision.policy_revision_id = assignment.policy_revision_id
    WHERE assignment.tenant_id = NEW.tenant_id AND assignment.legal_entity_id = NEW.legal_entity_id
      AND assignment.quantity_rule_assignment_id <> NEW.quantity_rule_assignment_id
      AND assignment.profile_kind = NEW.profile_kind AND assignment.profile_resource_id = NEW.profile_resource_id
      AND assignment.applicable_from IS NOT NULL AND revision.rule_kind = 'REPLACEABLE_ENVELOPE'
      AND revision.scope_kind = v_revision.scope_kind AND revision.channel_id IS NOT DISTINCT FROM v_revision.channel_id
      AND revision.commerce_market_id IS NOT DISTINCT FROM v_revision.commerce_market_id
      AND revision.storefront_id IS NOT DISTINCT FROM v_revision.storefront_id
      AND revision.selector_kind = v_revision.selector_kind
      AND revision.selector_resource_id IS NOT DISTINCT FROM v_revision.selector_resource_id
      AND tstzrange(assignment.applicable_from, assignment.applicable_to, '[)') &&
          tstzrange(NEW.applicable_from, NEW.applicable_to, '[)')
  ) THEN
    RAISE EXCEPTION 'Profile quantity envelopes cannot conflict at the same declared rank'
      USING ERRCODE = '23P01', CONSTRAINT = 'ccc_quantity_rule_assignments_no_overlap_excl';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Owner loads must emit canonical UTC millisecond instants and an object for a never-written field.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."load_commerce_quantity_rule_assignments"(
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
    'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveTo', to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
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
    'recordedAt', to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
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
  RETURN QUERY SELECT coalesce(v_metadata, '{}'::jsonb) || jsonb_build_object(
    'assignments', v_assignments, 'generation', coalesce(v_generation, 0));
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."load_purchase_currency_policy_state"(
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
    'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveTo', to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'field', 'PURCHASE_CURRENCY',
    'idempotencyKey', idempotency_key, 'lifecycle', lifecycle, 'reason', reason,
    'revisionId', policy_revision_id::text, 'tenantId', tenant_id::text,
    'scope', jsonb_strip_nulls(jsonb_build_object(
      'kind', scope_kind, 'sellingLegalEntityId', legal_entity_id::text,
      'channelId', channel_id, 'commerceMarketId', commerce_market_id, 'storefrontId', storefront_id)),
    'value', jsonb_build_object('kind', rule_kind, 'currencyCode', currency_code)
  ) ORDER BY recorded_at, policy_revision_id), '[]'::jsonb) INTO v_revisions
    FROM purchase_currency_policy_revisions
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  RETURN QUERY SELECT coalesce(v_metadata, '{}'::jsonb) || jsonb_build_object(
    'field', 'PURCHASE_CURRENCY', 'generation', coalesce(v_generation, 0), 'revisions', v_revisions);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."load_payment_term_policy_state"(
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
    'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveTo', to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'field', 'PAYMENT_TERM',
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
  RETURN QUERY SELECT coalesce(v_metadata, '{}'::jsonb) || jsonb_build_object(
    'field', 'PAYMENT_TERM', 'generation', coalesce(v_generation, 0), 'revisions', v_revisions);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."load_market_bootstrap_policy_state"(
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
    'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveTo', to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'field', 'MARKET_BOOTSTRAP',
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
  RETURN QUERY SELECT coalesce(v_metadata, '{}'::jsonb) || jsonb_build_object(
    'field', 'MARKET_BOOTSTRAP', 'generation', coalesce(v_generation, 0), 'revisions', v_revisions);
END;
$$;
