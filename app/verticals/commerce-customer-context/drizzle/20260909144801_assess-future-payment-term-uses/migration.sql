-- Retirement inventory is a horizon query, not a point-in-time "current" query. A future-effective
-- entitlement can still depend on a definition retired before its start, and a suspended or archived
-- profile can later reactivate without rewriting its retained entitlement history.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."assess_payment_term_entitlement_use"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payment_term_resource_ids uuid[],
  p_effective_at timestamptz
)
RETURNS TABLE(
  outcome text,
  current_customer_entitlement_count integer,
  evidence_reference text,
  observed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_count integer;
  v_max_revision integer;
  v_observed_at timestamptz := statement_timestamp();
  v_term_set_fingerprint text;
BEGIN
  PERFORM commerce_customer_context.assert_customer_payment_terms_scope(
    p_tenant_id, p_legal_entity_id
  );
  IF p_payment_term_resource_ids IS NULL
    OR cardinality(p_payment_term_resource_ids) NOT BETWEEN 1 AND 200
    OR array_position(p_payment_term_resource_ids, NULL) IS NOT NULL
    OR cardinality(p_payment_term_resource_ids) <> (
      SELECT count(DISTINCT resource_id)::integer
      FROM unnest(p_payment_term_resource_ids) AS resource_id
    )
    OR p_effective_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid payment term affected-use assessment input' USING ERRCODE = '22023';
  END IF;
  SELECT md5(string_agg(resource_id::text, ',' ORDER BY resource_id::text))
  INTO v_term_set_fingerprint
  FROM unnest(p_payment_term_resource_ids) AS resource_id;
  SELECT count(*)::integer, coalesce(max(entitlement.revision), 0)::integer
  INTO v_count, v_max_revision
  FROM commerce_customer_context.customer_payment_term_entitlements AS entitlement
  WHERE entitlement.tenant_id = p_tenant_id
    AND entitlement.legal_entity_id = p_legal_entity_id
    AND entitlement.payment_term_resource_id = ANY(p_payment_term_resource_ids::text[])
    AND entitlement.lifecycle IN ('ACTIVE', 'ENDED')
    AND (
      entitlement.effective_to IS NULL
      OR entitlement.effective_to > p_effective_at
    );
  RETURN QUERY SELECT
    'ASSESSED'::text,
    v_count,
    format(
      'commerce.customer-context:payment-term-entitlement-use-horizon:%s:%s:%s:%s',
      v_term_set_fingerprint,
      extract(epoch from p_effective_at)::numeric,
      v_max_revision,
      v_count
    ),
    v_observed_at;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."assess_payment_term_entitlement_use"(uuid, uuid, uuid[], timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."assess_payment_term_entitlement_use"(uuid, uuid, uuid[], timestamptz) TO "ontos_runtime";
