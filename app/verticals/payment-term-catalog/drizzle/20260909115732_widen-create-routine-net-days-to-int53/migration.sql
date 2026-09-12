CREATE OR REPLACE FUNCTION "payment_term_catalog"."create_term"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_existing_id uuid;
  v_payment_term_id uuid := coalesce(nullif(p_input->>'paymentTermId', '')::uuid, gen_random_uuid());
  v_semantic_kind text := p_input->'semantics'->>'kind';
  v_net_days bigint := CASE WHEN p_input->'semantics'->>'kind' = 'NET_DAYS' THEN (p_input->'semantics'->>'days')::bigint ELSE NULL END;
  v_canonical text;
  v_fingerprint text;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  v_canonical := CASE
    WHEN v_semantic_kind = 'IMMEDIATE' THEN 'IMMEDIATE|1|NOT_APPLICABLE|' || (p_input->>'compatibilityKey')
    ELSE 'NET_DAYS|' || v_net_days::text || '|INVOICE_ISSUED_AT|CALENDAR_DAYS_UTC|1|' || (p_input->>'compatibilityKey')
  END;
  v_fingerprint := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- Serialise competing requests on both durable business keys. The fixed lock order
  -- makes the following existence checks authoritative for this transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payment-term-code|' || p_tenant_id::text || '|' || p_legal_entity_id::text || '|' || (p_input->>'businessCode'),
    0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payment-term-semantics|' || p_tenant_id::text || '|' || p_legal_entity_id::text || '|' || v_fingerprint,
    0
  ));

  SELECT term.payment_term_id INTO v_existing_id
  FROM "payment_term_catalog"."payment_terms" AS term
  WHERE term.tenant_id = p_tenant_id
    AND term.legal_entity_id = p_legal_entity_id
    AND term.business_code = p_input->>'businessCode'
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'business_code_conflict', 'existingPaymentTermId', v_existing_id
    );
    RETURN;
  END IF;

  SELECT revision.payment_term_id INTO v_existing_id
  FROM "payment_term_catalog"."payment_term_revisions" AS revision
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.semantic_fingerprint = v_fingerprint
    AND revision.revision_number = 1
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'duplicate_semantics', 'existingPaymentTermId', v_existing_id
    );
    RETURN;
  END IF;

  INSERT INTO "payment_term_catalog"."payment_terms" (
    payment_term_id, tenant_id, legal_entity_id, business_code, active_from,
    creation_reason, created_by_action_invocation_id, created_by_principal_id
  ) VALUES (
    v_payment_term_id, p_tenant_id, p_legal_entity_id, p_input->>'businessCode',
    (p_input->>'activeFrom')::timestamptz, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  INSERT INTO "payment_term_catalog"."payment_term_revisions" (
    tenant_id, legal_entity_id, payment_term_id, revision_number, change_kind,
    display_name, explanation, semantic_kind, net_days, due_date_anchor, calendar_rule,
    calculation_rule_version, compatibility_key, semantic_fingerprint, change_reason,
    action_invocation_id, acting_principal_id
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_payment_term_id, 1, 'CREATED',
    p_input->>'displayName', p_input->>'explanation', v_semantic_kind, v_net_days,
    CASE WHEN v_semantic_kind = 'NET_DAYS' THEN 'INVOICE_ISSUED_AT' ELSE NULL END,
    CASE WHEN v_semantic_kind = 'NET_DAYS' THEN 'CALENDAR_DAYS_UTC' ELSE 'NOT_APPLICABLE' END,
    1, p_input->>'compatibilityKey', v_fingerprint, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  INSERT INTO "payment_term_catalog"."payment_term_lifecycle_events" (
    tenant_id, legal_entity_id, payment_term_id, event_kind, effective_at, reason,
    action_invocation_id, acting_principal_id
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_payment_term_id, 'ACTIVATED',
    (p_input->>'activeFrom')::timestamptz, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'created',
    'definition', "payment_term_catalog"."definition_json"(
      p_tenant_id, p_legal_entity_id, v_payment_term_id, NULL
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) TO "ontos_runtime";
