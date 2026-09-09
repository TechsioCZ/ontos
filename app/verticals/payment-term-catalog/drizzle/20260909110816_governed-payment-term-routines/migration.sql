-- Runtime code reaches the catalog only through scope-injected, owner-controlled routines.
REVOKE ALL ON ALL TABLES IN SCHEMA "payment_term_catalog" FROM "ontos_runtime";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "payment_term_catalog" FROM "ontos_runtime";
GRANT USAGE ON SCHEMA "payment_term_catalog" TO "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."assert_operation_scope"(
  p_tenant_id uuid,
  p_legal_entity_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'payment term catalog operation scope mismatch' USING ERRCODE = '42501';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."definition_json"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payment_term_id uuid,
  p_revision_number integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'code', term.business_code,
    'compatibleWith', jsonb_build_array('customer-payment-terms.v1'),
    'compatibilityId', revision.compatibility_key,
    'created', jsonb_build_object(
      'actionInvocationId', term.created_by_action_invocation_id,
      'actorPrincipalId', term.created_by_principal_id,
      'at', to_char(term.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reason', term.creation_reason
    ),
    'description', revision.explanation,
    'definitionRevisionId', revision.payment_term_revision_id,
    'lifecycle', jsonb_build_object(
      'effectiveFrom', to_char(term.active_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN term.retired_effective_at IS NULL THEN NULL ELSE to_char(term.retired_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'state', term.lifecycle_state
    ),
    'metadataRevision', revision.revision_number,
    'name', revision.display_name,
    'paymentTermRef', jsonb_build_object(
      'moduleId', 'payment.term-catalog',
      'resourceId', term.payment_term_id,
      'resourceType', 'payment.term-catalog.payment-term',
      'tenantId', term.tenant_id
    ),
    'retired', CASE
      WHEN term.retired_effective_at IS NULL THEN NULL
      ELSE jsonb_build_object(
        'actionInvocationId', term.retired_by_action_invocation_id,
        'actorPrincipalId', term.retired_by_principal_id,
        'at', to_char(term.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reason', term.retirement_reason
      )
    END,
    'semanticFingerprint', revision.semantic_fingerprint,
    'semanticRevisionId', revision.semantic_revision_id,
    'semantics', CASE
      WHEN revision.semantic_kind = 'IMMEDIATE' THEN jsonb_build_object(
        'calculationRuleVersion', 1,
        'calendarRule', 'NOT_APPLICABLE',
        'kind', 'IMMEDIATE'
      )
      ELSE jsonb_build_object(
        'calculationRuleVersion', 1,
        'calendarRule', 'CALENDAR_DAYS_UTC',
        'days', revision.net_days,
        'dueDateAnchor', 'INVOICE_ISSUED_AT',
        'kind', 'NET_DAYS'
      )
    END,
    'updated', jsonb_build_object(
      'actionInvocationId', revision.action_invocation_id,
      'actorPrincipalId', revision.acting_principal_id,
      'at', to_char(revision.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reason', revision.change_reason
    )
  )
  FROM "payment_term_catalog"."payment_terms" AS term
  INNER JOIN LATERAL (
    SELECT candidate.*
    FROM "payment_term_catalog"."payment_term_revisions" AS candidate
    WHERE candidate.tenant_id = term.tenant_id
      AND candidate.legal_entity_id = term.legal_entity_id
      AND candidate.payment_term_id = term.payment_term_id
      AND (p_revision_number IS NULL OR candidate.revision_number = p_revision_number)
    ORDER BY candidate.revision_number DESC
    LIMIT 1
  ) AS revision ON true
  WHERE term.tenant_id = p_tenant_id
    AND term.legal_entity_id = p_legal_entity_id
    AND term.payment_term_id = p_payment_term_id
$$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."get_current"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payment_term_id uuid
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  RETURN QUERY SELECT "payment_term_catalog"."definition_json"(
    p_tenant_id, p_legal_entity_id, p_payment_term_id, NULL
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."create_term"(
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

  v_canonical := CASE
    WHEN v_semantic_kind = 'IMMEDIATE' THEN 'IMMEDIATE|1|NOT_APPLICABLE|' || (p_input->>'compatibilityKey')
    ELSE 'NET_DAYS|' || v_net_days::text || '|INVOICE_ISSUED_AT|CALENDAR_DAYS_UTC|1|' || (p_input->>'compatibilityKey')
  END;
  v_fingerprint := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');
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
CREATE FUNCTION "payment_term_catalog"."correct_term"(
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
  v_term "payment_term_catalog"."payment_terms"%ROWTYPE;
  v_revision "payment_term_catalog"."payment_term_revisions"%ROWTYPE;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  SELECT * INTO v_term
  FROM "payment_term_catalog"."payment_terms"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = (p_input->>'paymentTermId')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found');
    RETURN;
  END IF;
  IF v_term.lifecycle_state = 'RETIRED' THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'retired',
      'retiredEffectiveAt', to_char(v_term.retired_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    RETURN;
  END IF;
  SELECT * INTO v_revision
  FROM "payment_term_catalog"."payment_term_revisions"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_term.payment_term_id
  ORDER BY revision_number DESC
  LIMIT 1;
  IF v_revision.revision_number <> (p_input->>'expectedMetadataRevision')::integer THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'revision_conflict', 'actualMetadataRevision', v_revision.revision_number
    );
    RETURN;
  END IF;
  INSERT INTO "payment_term_catalog"."payment_term_revisions" (
    semantic_revision_id, tenant_id, legal_entity_id, payment_term_id, revision_number,
    change_kind, display_name, explanation, semantic_kind, net_days, due_date_anchor,
    calendar_rule, calculation_rule_version, compatibility_key, semantic_fingerprint,
    change_reason, action_invocation_id, acting_principal_id
  ) VALUES (
    v_revision.semantic_revision_id, p_tenant_id, p_legal_entity_id, v_term.payment_term_id,
    v_revision.revision_number + 1, 'COSMETIC_CORRECTION', p_input->>'displayName',
    p_input->>'explanation', v_revision.semantic_kind, v_revision.net_days,
    v_revision.due_date_anchor, v_revision.calendar_rule, v_revision.calculation_rule_version,
    v_revision.compatibility_key, v_revision.semantic_fingerprint, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  UPDATE "payment_term_catalog"."payment_terms"
  SET updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_term.payment_term_id;
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'corrected',
    'definition', "payment_term_catalog"."definition_json"(
      p_tenant_id, p_legal_entity_id, v_term.payment_term_id, NULL
    )
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."retire_term"(
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
  v_term "payment_term_catalog"."payment_terms"%ROWTYPE;
  v_revision_number integer;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  SELECT * INTO v_term
  FROM "payment_term_catalog"."payment_terms"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = (p_input->>'paymentTermId')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found');
    RETURN;
  END IF;
  IF v_term.lifecycle_state = 'RETIRED' THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'already_retired',
      'retiredEffectiveAt', to_char(v_term.retired_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    RETURN;
  END IF;
  SELECT revision_number INTO v_revision_number
  FROM "payment_term_catalog"."payment_term_revisions"
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_term.payment_term_id
  ORDER BY revision_number DESC
  LIMIT 1;
  IF v_revision_number <> (p_input->>'expectedMetadataRevision')::integer THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'revision_conflict', 'actualMetadataRevision', v_revision_number
    );
    RETURN;
  END IF;
  UPDATE "payment_term_catalog"."payment_terms"
  SET lifecycle_state = 'RETIRED',
    retired_effective_at = (p_input->>'effectiveAt')::timestamptz,
    retirement_reason = p_input->>'reason',
    retired_by_action_invocation_id = (p_input->>'actionInvocationId')::uuid,
    retired_by_principal_id = (p_input->>'actingPrincipalId')::uuid,
    updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND payment_term_id = v_term.payment_term_id;
  INSERT INTO "payment_term_catalog"."payment_term_lifecycle_events" (
    tenant_id, legal_entity_id, payment_term_id, event_kind, effective_at, reason,
    action_invocation_id, acting_principal_id
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_term.payment_term_id, 'RETIRED',
    (p_input->>'effectiveAt')::timestamptz, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'retired',
    'definition', "payment_term_catalog"."definition_json"(
      p_tenant_id, p_legal_entity_id, v_term.payment_term_id, NULL
    )
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."reconcile_term"(
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
CREATE FUNCTION "payment_term_catalog"."get_history"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payment_term_id uuid
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  IF NOT EXISTS (
    SELECT 1 FROM "payment_term_catalog"."payment_terms"
    WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
      AND payment_term_id = p_payment_term_id
  ) THEN
    RETURN QUERY SELECT NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'aliases', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'aliasRef', jsonb_build_object(
          'moduleId', 'payment.term-catalog', 'resourceId', alias_record.alias_payment_term_id,
          'resourceType', 'payment.term-catalog.payment-term', 'tenantId', p_tenant_id
        ),
        'canonicalRef', jsonb_build_object(
          'moduleId', 'payment.term-catalog', 'resourceId', alias_record.canonical_payment_term_id,
          'resourceType', 'payment.term-catalog.payment-term', 'tenantId', p_tenant_id
        ),
        'reconciled', jsonb_build_object(
          'actionInvocationId', alias_record.action_invocation_id,
          'actorPrincipalId', alias_record.acting_principal_id,
          'at', to_char(alias_record.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'reason', alias_record.reason
        )
      ) ORDER BY alias_record.recorded_at)
      FROM "payment_term_catalog"."payment_term_aliases" AS alias_record
      WHERE alias_record.tenant_id = p_tenant_id
        AND alias_record.legal_entity_id = p_legal_entity_id
        AND (alias_record.alias_payment_term_id = p_payment_term_id
          OR alias_record.canonical_payment_term_id = p_payment_term_id)
    ), '[]'::jsonb),
    'lifecycle', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'actionInvocationId', event_record.action_invocation_id,
        'actingPrincipalId', event_record.acting_principal_id,
        'effectiveAt', to_char(event_record.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'eventKind', event_record.event_kind,
        'reason', event_record.reason,
        'recordedAt', to_char(event_record.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY event_record.effective_at, event_record.recorded_at)
      FROM "payment_term_catalog"."payment_term_lifecycle_events" AS event_record
      WHERE event_record.tenant_id = p_tenant_id
        AND event_record.legal_entity_id = p_legal_entity_id
        AND event_record.payment_term_id = p_payment_term_id
    ), '[]'::jsonb),
    'revisions', coalesce((
      SELECT jsonb_agg(
        "payment_term_catalog"."definition_json"(
          p_tenant_id, p_legal_entity_id, p_payment_term_id, revision.revision_number
        ) ORDER BY revision.revision_number
      )
      FROM "payment_term_catalog"."payment_term_revisions" AS revision
      WHERE revision.tenant_id = p_tenant_id
        AND revision.legal_entity_id = p_legal_entity_id
        AND revision.payment_term_id = p_payment_term_id
    ), '[]'::jsonb)
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."list_current"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_limit integer
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
    AND NOT EXISTS (
      SELECT 1 FROM "payment_term_catalog"."payment_term_aliases" AS alias_record
      WHERE alias_record.tenant_id = term.tenant_id
        AND alias_record.legal_entity_id = term.legal_entity_id
        AND alias_record.alias_payment_term_id = term.payment_term_id
    )
  ORDER BY term.business_code
  LIMIT greatest(1, least(p_limit, 200));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."resolve_reference"(
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
  v_canonical_id uuid;
  v_definition jsonb;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  SELECT canonical_payment_term_id INTO v_canonical_id
  FROM "payment_term_catalog"."payment_term_aliases"
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND alias_payment_term_id = p_payment_term_id;
  v_canonical_id := coalesce(v_canonical_id, p_payment_term_id);
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
REVOKE ALL ON FUNCTION "payment_term_catalog"."assert_operation_scope"(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."definition_json"(uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."get_current"(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."correct_term"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."retire_term"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."reconcile_term"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."get_history"(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."list_current"(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."resolve_reference"(uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."get_current"(uuid, uuid, uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."correct_term"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."retire_term"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."reconcile_term"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."get_history"(uuid, uuid, uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."list_current"(uuid, uuid, integer) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."resolve_reference"(uuid, uuid, uuid, timestamptz, text) TO "ontos_runtime";
