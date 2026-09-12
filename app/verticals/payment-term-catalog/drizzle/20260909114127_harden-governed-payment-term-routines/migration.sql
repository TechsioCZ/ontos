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
  v_net_days integer := CASE WHEN p_input->'semantics'->>'kind' = 'NET_DAYS' THEN (p_input->'semantics'->>'days')::integer ELSE NULL END;
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

  PERFORM payment_term_id
  FROM "payment_term_catalog"."payment_terms"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id IN (v_alias_id, v_canonical_id)
  ORDER BY payment_term_id
  FOR UPDATE;
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
REVOKE ALL ON FUNCTION "payment_term_catalog"."list_current"(uuid, uuid, integer) FROM "ontos_runtime";
--> statement-breakpoint
DROP FUNCTION "payment_term_catalog"."list_current"(uuid, uuid, integer);
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."list_current"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_limit integer,
  p_at timestamptz
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT "payment_term_catalog"."definition_json"(
    p_tenant_id, p_legal_entity_id, term.payment_term_id, NULL
  )
  FROM "payment_term_catalog"."payment_terms" AS term
  WHERE term.tenant_id = p_tenant_id
    AND term.legal_entity_id = p_legal_entity_id
    AND term.active_from <= p_at
    AND (term.retired_effective_at IS NULL OR p_at < term.retired_effective_at)
    AND NOT EXISTS (
      SELECT 1 FROM "payment_term_catalog"."payment_term_aliases" AS alias_record
      WHERE alias_record.tenant_id = term.tenant_id
        AND alias_record.legal_entity_id = term.legal_entity_id
        AND alias_record.alias_payment_term_id = term.payment_term_id
    )
  ORDER BY term.business_code
  LIMIT greatest(1, least(p_limit, 200)) + 1;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payment_term_catalog"."resolve_reference"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payment_term_id uuid,
  p_at timestamptz,
  p_expected_compatibility_key text
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_canonical_id uuid := p_payment_term_id;
  v_next_id uuid;
  v_visited uuid[] := ARRAY[p_payment_term_id];
  v_depth integer := 0;
  v_definition jsonb;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  LOOP
    SELECT canonical_payment_term_id INTO v_next_id
    FROM "payment_term_catalog"."payment_term_aliases"
    WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
      AND alias_payment_term_id = v_canonical_id;
    EXIT WHEN NOT FOUND;
    IF v_next_id = ANY(v_visited) THEN
      RETURN QUERY SELECT jsonb_build_object(
        '_tag', 'broken_alias',
        'reason', 'cycle',
        'requestedPaymentTermId', p_payment_term_id
      );
      RETURN;
    END IF;
    v_depth := v_depth + 1;
    IF v_depth > 64 THEN
      RETURN QUERY SELECT jsonb_build_object(
        '_tag', 'broken_alias',
        'reason', 'depth_exceeded',
        'requestedPaymentTermId', p_payment_term_id
      );
      RETURN;
    END IF;
    v_canonical_id := v_next_id;
    v_visited := array_append(v_visited, v_canonical_id);
  END LOOP;

  v_definition := "payment_term_catalog"."definition_json"(
    p_tenant_id, p_legal_entity_id, v_canonical_id, NULL
  );
  IF v_definition IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'missing', 'requestedPaymentTermId', p_payment_term_id
    );
  ELSIF (v_definition->'lifecycle'->>'effectiveFrom')::timestamptz > p_at THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'not_yet_active',
      'activeFrom', v_definition->'lifecycle'->>'effectiveFrom',
      'canonicalPaymentTermId', v_canonical_id,
      'definition', v_definition,
      'requestedPaymentTermId', p_payment_term_id
    );
  ELSIF v_definition->'lifecycle'->>'effectiveTo' IS NOT NULL
    AND (v_definition->'lifecycle'->>'effectiveTo')::timestamptz <= p_at
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'retired',
      'canonicalPaymentTermId', v_canonical_id,
      'definition', v_definition,
      'requestedPaymentTermId', p_payment_term_id,
      'retiredEffectiveAt', v_definition->'lifecycle'->>'effectiveTo'
    );
  ELSIF p_expected_compatibility_key IS NOT NULL
    AND v_definition->>'compatibilityId' <> p_expected_compatibility_key
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'incompatible',
      'actualCompatibilityKey', v_definition->>'compatibilityId',
      'canonicalPaymentTermId', v_canonical_id,
      'definition', v_definition,
      'requestedPaymentTermId', p_payment_term_id
    );
  ELSE
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'resolved',
      'canonicalPaymentTermId', v_canonical_id,
      'definition', v_definition,
      'requestedPaymentTermId', p_payment_term_id
    );
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."reconcile_term"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."list_current"(uuid, uuid, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."resolve_reference"(uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."reconcile_term"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."list_current"(uuid, uuid, integer, timestamptz) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."resolve_reference"(uuid, uuid, uuid, timestamptz, text) TO "ontos_runtime";
