CREATE OR REPLACE FUNCTION "payment_term_catalog"."reconcile_term"(
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
  v_alias_id uuid := (p_input->>'aliasPaymentTermId')::uuid;
  v_canonical_id uuid := (p_input->>'canonicalPaymentTermId')::uuid;
  v_existing_canonical_id uuid;
  v_inbound_alias_count integer;
  v_alias_term "payment_term_catalog"."payment_terms"%ROWTYPE;
  v_canonical_term "payment_term_catalog"."payment_terms"%ROWTYPE;
  v_alias_revision "payment_term_catalog"."payment_term_revisions"%ROWTYPE;
  v_canonical_revision "payment_term_catalog"."payment_term_revisions"%ROWTYPE;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);

  -- All graph validation and insertion for one legal-entity catalog is atomic.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payment-term-alias-graph|' || p_tenant_id::text || '|' || p_legal_entity_id::text,
    0
  ));

  IF v_alias_id = v_canonical_id THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'same_identity');
    RETURN;
  END IF;
  SELECT canonical_payment_term_id INTO v_existing_canonical_id
  FROM "payment_term_catalog"."payment_term_aliases"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND alias_payment_term_id = v_alias_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', CASE WHEN v_existing_canonical_id = v_canonical_id THEN 'already_reconciled' ELSE 'reconciliation_conflict' END,
      'canonicalPaymentTermId', v_existing_canonical_id
    );
    RETURN;
  END IF;
  SELECT canonical_payment_term_id INTO v_existing_canonical_id
  FROM "payment_term_catalog"."payment_term_aliases"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND alias_payment_term_id = v_canonical_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'canonical_is_alias', 'canonicalPaymentTermId', v_existing_canonical_id
    );
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "payment_term_catalog"."payment_term_aliases"
    WHERE tenant_id = p_tenant_id
      AND legal_entity_id = p_legal_entity_id
      AND canonical_payment_term_id = v_alias_id
  ) THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'reconciliation_conflict', 'canonicalPaymentTermId', v_alias_id
    );
    RETURN;
  END IF;

  SELECT * INTO v_alias_term
  FROM "payment_term_catalog"."payment_terms"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_alias_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found', 'missing', 'alias');
    RETURN;
  END IF;
  SELECT * INTO v_canonical_term
  FROM "payment_term_catalog"."payment_terms"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_canonical_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found', 'missing', 'canonical');
    RETURN;
  END IF;
  IF v_alias_term.active_from IS DISTINCT FROM v_canonical_term.active_from
    OR v_alias_term.retired_effective_at IS DISTINCT FROM v_canonical_term.retired_effective_at
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'reconciliation_conflict', 'canonicalPaymentTermId', v_canonical_id
    );
    RETURN;
  END IF;

  SELECT * INTO v_alias_revision
  FROM "payment_term_catalog"."payment_term_revisions"
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_alias_id
  ORDER BY revision_number DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found', 'missing', 'alias');
    RETURN;
  END IF;
  SELECT * INTO v_canonical_revision
  FROM "payment_term_catalog"."payment_term_revisions"
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_canonical_id
  ORDER BY revision_number DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found', 'missing', 'canonical');
    RETURN;
  END IF;
  IF v_alias_revision.revision_number <> (p_input->>'expectedAliasMetadataRevision')::integer THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'revision_conflict', 'target', 'alias',
      'actualMetadataRevision', v_alias_revision.revision_number
    );
    RETURN;
  END IF;
  IF v_canonical_revision.revision_number <> (p_input->>'expectedCanonicalMetadataRevision')::integer THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'revision_conflict', 'target', 'canonical',
      'actualMetadataRevision', v_canonical_revision.revision_number
    );
    RETURN;
  END IF;
  IF v_alias_revision.semantic_fingerprint <> v_canonical_revision.semantic_fingerprint THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'incompatible_semantics');
    RETURN;
  END IF;
  SELECT count(*)::integer INTO v_inbound_alias_count
  FROM "payment_term_catalog"."payment_term_aliases"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND canonical_payment_term_id = v_canonical_id;
  IF v_inbound_alias_count >= 199 THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'reconciliation_conflict', 'canonicalPaymentTermId', v_canonical_id
    );
    RETURN;
  END IF;
  INSERT INTO "payment_term_catalog"."payment_term_aliases" (
    tenant_id, legal_entity_id, alias_payment_term_id, canonical_payment_term_id,
    reason, action_invocation_id, acting_principal_id
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_alias_id, v_canonical_id, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'reconciled',
    'alias', jsonb_build_object(
      'aliasRef', jsonb_build_object(
        'moduleId', 'payment.term-catalog', 'resourceId', v_alias_id,
        'resourceType', 'payment.term-catalog.payment-term', 'tenantId', p_tenant_id
      ),
      'canonicalRef', jsonb_build_object(
        'moduleId', 'payment.term-catalog', 'resourceId', v_canonical_id,
        'resourceType', 'payment.term-catalog.payment-term', 'tenantId', p_tenant_id
      ),
      'reconciled', jsonb_build_object(
        'actionInvocationId', p_input->>'actionInvocationId',
        'actorPrincipalId', p_input->>'actingPrincipalId',
        'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reason', p_input->>'reason'
      )
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment_term_catalog"."reconcile_term"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."reconcile_term"(uuid, uuid, jsonb) TO "ontos_runtime";
