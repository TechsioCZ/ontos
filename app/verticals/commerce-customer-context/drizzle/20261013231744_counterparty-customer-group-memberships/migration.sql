-- Current Customer Group memberships of COUNTERPARTY profiles, looked up by group business code and Party
-- counterparty id. A reader needs no group or profile ids and no write Action: unknown codes and counterparties
-- without a purchasing profile are simply absent from the result.
CREATE FUNCTION "commerce_customer_context"."read_counterparty_customer_group_memberships"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_business_codes text[],
  p_counterparty_resource_ids text[],
  p_effective_at timestamptz
)
RETURNS TABLE (groups_json jsonb, items_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_effective_at IS NULL OR p_business_codes IS NULL OR p_counterparty_resource_ids IS NULL
    OR cardinality(p_business_codes) NOT BETWEEN 1 AND 20
    OR cardinality(p_counterparty_resource_ids) > 200
    OR array_position(p_business_codes, NULL) IS NOT NULL
    OR array_position(p_counterparty_resource_ids, NULL) IS NOT NULL
  THEN
    RAISE EXCEPTION 'Invalid counterparty Customer Group membership query' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH selected_groups AS MATERIALIZED (
    SELECT customer_group.customer_group_id, customer_group.stable_code
    FROM commerce_customer_context.customer_groups AS customer_group
    WHERE customer_group.tenant_id = p_tenant_id
      AND customer_group.legal_entity_id = p_legal_entity_id
      AND customer_group.stable_code = ANY (p_business_codes)
  ), selected_profiles AS MATERIALIZED (
    SELECT counterparty_profile.counterparty_purchasing_profile_id, counterparty_profile.counterparty_resource_id
    FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty_profile
    WHERE counterparty_profile.tenant_id = p_tenant_id
      AND counterparty_profile.legal_entity_id = p_legal_entity_id
      AND counterparty_profile.counterparty_resource_id = ANY (p_counterparty_resource_ids)
  ), current_memberships AS MATERIALIZED (
    SELECT membership.customer_group_membership_id, selected_profile.counterparty_resource_id
    FROM commerce_customer_context.customer_group_memberships AS membership
    JOIN selected_groups AS selected_group
      ON selected_group.customer_group_id = membership.customer_group_id
    JOIN selected_profiles AS selected_profile
      ON selected_profile.counterparty_purchasing_profile_id = membership.customer_profile_id
    WHERE membership.tenant_id = p_tenant_id
      AND membership.legal_entity_id = p_legal_entity_id
      AND membership.lifecycle <> 'CANCELLED'
      AND membership.effective_from <= p_effective_at
      AND (membership.effective_to IS NULL OR p_effective_at < membership.effective_to)
      AND (
        SELECT history.to_lifecycle
        FROM commerce_customer_context.customer_profile_lifecycle_history AS history
        WHERE history.tenant_id = p_tenant_id
          AND history.legal_entity_id = p_legal_entity_id
          AND history.customer_profile_id = membership.customer_profile_id
          AND history.recorded_at <= p_effective_at
        ORDER BY history.recorded_at DESC, history.revision DESC
        LIMIT 1
      ) = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM commerce_customer_context.customer_group_lifecycle_periods AS period
        WHERE period.tenant_id = p_tenant_id
          AND period.legal_entity_id = p_legal_entity_id
          AND period.customer_group_id = membership.customer_group_id
          AND period.active_from <= p_effective_at
          AND (period.archived_at IS NULL OR p_effective_at < period.archived_at)
      )
  )
  SELECT
    coalesce((
      SELECT jsonb_agg(
        commerce_customer_context.customer_group_document(
          p_tenant_id, p_legal_entity_id, selected_group.customer_group_id
        ) ORDER BY selected_group.stable_code
      ) FROM selected_groups AS selected_group
    ), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'counterpartyResourceId', current_membership.counterparty_resource_id,
          'membership', commerce_customer_context.customer_group_membership_document(
            p_tenant_id, p_legal_entity_id, current_membership.customer_group_membership_id
          )
        ) ORDER BY current_membership.counterparty_resource_id, current_membership.customer_group_membership_id::text
      ) FROM current_memberships AS current_membership
    ), '[]'::jsonb);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_counterparty_customer_group_memberships"(uuid, uuid, text[], text[], timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_counterparty_customer_group_memberships"(uuid, uuid, text[], text[], timestamptz) TO "ontos_runtime";
