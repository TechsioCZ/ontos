-- Preserve valid pre-retirement definition scheduling after retirement acceptance advances the group schedule.
CREATE OR REPLACE FUNCTION "price_group_catalog"."create_definition_revision_with_continuity"(
  p_tenant_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group price_group_catalog.price_groups%ROWTYPE;
  v_existing price_group_catalog.price_group_catalog_ledger%ROWTYPE;
  v_price_group_id uuid := (p_input#>>'{expectedCurrent,priceGroupRef,resourceId}')::uuid;
  v_definition_revision_id uuid := nullif(p_input->>'definitionRevisionId', '')::uuid;
  v_group_expected bigint := (p_input#>>'{expectedCurrent,catalogRevision}')::bigint;
  v_expected_schedule bigint;
  v_retirement_catalog_revision bigint;
  v_fence_expected bigint;
  v_accepted bigint;
  v_replay_expected_catalog_revision bigint;
  v_previous uuid;
  v_revision bigint;
  v_candidates uuid[];
  v_contract jsonb;
  v_definition jsonb;
  v_effective_to timestamptz := nullif(p_input->>'effectiveTo', '')::timestamptz;
  v_decision text := p_input#>>'{semanticDecision,decision}';
  v_compared uuid := nullif(p_input#>>'{semanticDecision,comparedDefinitionRevisionId}', '')::uuid;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text, 334));

  SELECT * INTO v_existing FROM price_group_catalog.price_group_catalog_ledger
  WHERE tenant_id = p_tenant_id AND action_invocation_id = (p_input->>'actionInvocationId')::uuid;
  IF FOUND THEN
    v_definition_revision_id := coalesce(v_definition_revision_id, v_existing.definition_revision_id);
    SELECT max(interval.schedule_catalog_revision)
      INTO v_replay_expected_catalog_revision
    FROM price_group_catalog.price_group_definition_effective_intervals AS interval
    WHERE interval.tenant_id = p_tenant_id
      AND interval.price_group_id = v_price_group_id
      AND interval.schedule_catalog_revision < v_existing.catalog_revision;
    IF v_existing.operation_kind = 'CREATE_DEFINITION_REVISION'
      AND v_existing.price_group_id = v_price_group_id
      AND v_existing.definition_revision_id = v_definition_revision_id
      AND v_existing.acting_principal_id = (p_input->>'actingPrincipalId')::uuid
      AND v_existing.trusted_effective_at = (p_input->>'trustedEffectiveAt')::timestamptz
      AND v_existing.reason = p_input->>'reason'
      AND v_replay_expected_catalog_revision = v_group_expected
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_groups AS price_group
        WHERE price_group.tenant_id = p_tenant_id
          AND price_group.price_group_id = v_price_group_id
          AND price_group.meaning_fingerprint = p_input#>>'{expectedCurrent,meaningFingerprint}'
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
        WHERE definition.tenant_id = p_tenant_id
          AND definition.price_group_id = v_price_group_id
          AND definition.definition_revision_id = v_definition_revision_id
          AND definition.previous_definition_revision_id = (p_input#>>'{expectedCurrent,definitionRevisionId}')::uuid
          AND definition.compared_definition_revision_id = v_compared
          AND definition.semantic_continuity_decision = v_decision
          AND definition.display_name = p_input->>'displayName'
          AND definition.description = p_input->>'description'
          AND definition.classification_purpose = p_input->>'classificationPurpose'
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS predecessor
        WHERE predecessor.tenant_id = p_tenant_id
          AND predecessor.price_group_id = v_price_group_id
          AND predecessor.definition_revision_id = (p_input#>>'{expectedCurrent,definitionRevisionId}')::uuid
          AND predecessor.revision_number = (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint
          AND predecessor.meaning_fingerprint = p_input#>>'{expectedCurrent,meaningFingerprint}'
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_effective_intervals AS interval
        WHERE interval.tenant_id = p_tenant_id
          AND interval.price_group_id = v_price_group_id
          AND interval.definition_revision_id = v_definition_revision_id
          AND interval.schedule_catalog_revision = v_existing.catalog_revision
          AND interval.effective_from = (p_input->>'effectiveFrom')::timestamptz
          AND interval.effective_to IS NOT DISTINCT FROM v_effective_to
      )
      AND (
        SELECT count(*) FROM price_group_catalog.price_group_compatibility_support AS support
        WHERE support.tenant_id = p_tenant_id
          AND support.price_group_id = v_price_group_id
          AND support.definition_revision_id = v_definition_revision_id
      ) = jsonb_array_length(p_input->'compatibilityContracts')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_input->'compatibilityContracts') AS requested(contract)
        WHERE NOT EXISTS (
          SELECT 1 FROM price_group_catalog.price_group_compatibility_support AS support
          WHERE support.tenant_id = p_tenant_id
            AND support.price_group_id = v_price_group_id
            AND support.definition_revision_id = v_definition_revision_id
            AND support.contract_id = requested.contract->>'contractId'
            AND support.contract_version = (requested.contract->>'version')::bigint
        )
      )
    THEN
      v_definition := price_group_catalog.definition_json(
        p_tenant_id, v_price_group_id, v_definition_revision_id, v_existing.catalog_revision
      );
      RETURN QUERY SELECT jsonb_build_object('_tag', 'replayed', 'definition', v_definition);
    ELSE
      RETURN QUERY SELECT jsonb_build_object('_tag', 'idempotency_conflict');
    END IF;
    RETURN;
  END IF;

  IF (p_input->>'effectiveFrom')::timestamptz < (p_input->>'trustedEffectiveAt')::timestamptz THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'effective_period_conflict',
      'effectiveFrom', p_input->>'effectiveFrom',
      'trustedEffectiveAt', p_input->>'trustedEffectiveAt'
    );
    RETURN;
  END IF;

  SELECT * INTO v_group FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  IF (v_group.retired_effective_at IS NULL AND v_effective_to IS NOT NULL)
    OR (v_group.retired_effective_at IS NOT NULL AND (
      (p_input->>'trustedEffectiveAt')::timestamptz >= v_group.retired_effective_at
      OR (p_input->>'effectiveFrom')::timestamptz >= v_group.retired_effective_at
      OR v_effective_to IS DISTINCT FROM v_group.retired_effective_at
    )) THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'effective_period_conflict',
      'effectiveFrom', p_input->>'effectiveFrom',
      'trustedEffectiveAt', p_input->>'trustedEffectiveAt',
      'reason', CASE WHEN v_group.retired_effective_at IS NULL
        THEN 'An ACTIVE Price Group definition schedule must remain open-ended'
        ELSE 'A scheduled-retirement definition must end exactly at the retirement boundary' END
    );
    RETURN;
  END IF;

  v_expected_schedule := v_group.current_definition_schedule_revision;
  IF v_group.retired_effective_at IS NOT NULL THEN
    SELECT retirement.accepted_catalog_revision
      INTO v_retirement_catalog_revision
    FROM price_group_catalog.price_group_retirements AS retirement
    WHERE retirement.tenant_id = p_tenant_id
      AND retirement.price_group_id = v_price_group_id;
    IF v_retirement_catalog_revision IS NULL THEN
      RETURN QUERY SELECT jsonb_build_object(
        '_tag', 'currentness_failure',
        'reason', 'UNVERIFIABLE_CURRENTNESS',
        'candidateDefinitionRevisionIds', '[]'::jsonb
      );
      RETURN;
    END IF;
    IF v_group.current_definition_schedule_revision = v_retirement_catalog_revision THEN
      SELECT max(ledger.catalog_revision)
        INTO v_expected_schedule
      FROM price_group_catalog.price_group_catalog_ledger AS ledger
      WHERE ledger.tenant_id = p_tenant_id
        AND ledger.price_group_id = v_price_group_id
        AND ledger.catalog_revision < v_retirement_catalog_revision
        AND ledger.operation_kind IN ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION');
      IF v_expected_schedule IS NULL THEN
        RETURN QUERY SELECT jsonb_build_object(
          '_tag', 'currentness_failure',
          'reason', 'UNVERIFIABLE_CURRENTNESS',
          'candidateDefinitionRevisionIds', '[]'::jsonb
        );
        RETURN;
      END IF;
    END IF;
  END IF;
  IF v_expected_schedule <> v_group_expected
    OR v_group.meaning_fingerprint <> p_input#>>'{expectedCurrent,meaningFingerprint}' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
    INTO v_candidates
  FROM price_group_catalog.price_group_definition_effective_intervals AS interval
  WHERE interval.tenant_id = p_tenant_id
    AND interval.price_group_id = v_price_group_id
    AND interval.schedule_catalog_revision = v_expected_schedule
    AND interval.effective_from <= (p_input->>'trustedEffectiveAt')::timestamptz
    AND (interval.effective_to IS NULL OR (p_input->>'trustedEffectiveAt')::timestamptz < interval.effective_to);
  IF coalesce(cardinality(v_candidates), 0) = 0 THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'ZERO_CURRENT_DEFINITIONS', 'candidateDefinitionRevisionIds', '[]'::jsonb); RETURN;
  ELSIF cardinality(v_candidates) > 1 THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'MULTIPLE_CURRENT_DEFINITIONS', 'candidateDefinitionRevisionIds', to_jsonb(v_candidates)); RETURN;
  END IF;
  v_previous := v_candidates[1];
  SELECT revision_number INTO v_revision
  FROM price_group_catalog.price_group_definition_revisions
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id
    AND definition_revision_id = v_previous;
  IF v_previous <> (p_input#>>'{expectedCurrent,definitionRevisionId}')::uuid
    OR v_revision <> (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  IF v_decision = 'MATERIAL_CHANGE' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'material_meaning_change'); RETURN;
  END IF;
  IF v_decision <> 'SAME_MEANING' OR v_compared IS DISTINCT FROM v_previous THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;

  v_definition_revision_id := coalesce(v_definition_revision_id, gen_random_uuid());
  v_revision := v_revision + 1;
  SELECT coalesce(max(catalog_revision), 0) INTO v_fence_expected
  FROM price_group_catalog.price_group_catalog_ledger WHERE tenant_id = p_tenant_id;
  v_accepted := v_fence_expected + 1;
  INSERT INTO price_group_catalog.price_group_catalog_ledger (
    tenant_id, expected_catalog_revision, catalog_revision, operation_kind, price_group_id,
    definition_revision_id, action_invocation_id, acting_principal_id, trusted_effective_at, reason
  ) VALUES (
    p_tenant_id, v_fence_expected, v_accepted, 'CREATE_DEFINITION_REVISION', v_price_group_id,
    v_definition_revision_id, (p_input->>'actionInvocationId')::uuid,
    (p_input->>'actingPrincipalId')::uuid, (p_input->>'trustedEffectiveAt')::timestamptz, p_input->>'reason'
  );
  INSERT INTO price_group_catalog.price_group_definition_revisions (
    definition_revision_id, tenant_id, price_group_id, revision_number,
    previous_definition_revision_id, compared_definition_revision_id, semantic_continuity_decision,
    display_name, description, classification_purpose, meaning_fingerprint,
    accepted_catalog_revision, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_definition_revision_id, p_tenant_id, v_price_group_id, v_revision,
    v_previous, v_previous, 'SAME_MEANING', p_input->>'displayName', p_input->>'description',
    p_input->>'classificationPurpose', v_group.meaning_fingerprint, v_accepted,
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
  );
  INSERT INTO price_group_catalog.price_group_definition_effective_intervals (
    tenant_id, price_group_id, definition_revision_id, schedule_catalog_revision,
    effective_from, effective_to, action_invocation_id, acting_principal_id, reason
  )
  SELECT interval.tenant_id, interval.price_group_id, interval.definition_revision_id, v_accepted,
    interval.effective_from,
    CASE WHEN interval.effective_to IS NULL OR interval.effective_to > (p_input->>'effectiveFrom')::timestamptz
      THEN (p_input->>'effectiveFrom')::timestamptz ELSE interval.effective_to END,
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
  FROM price_group_catalog.price_group_definition_effective_intervals AS interval
  WHERE interval.tenant_id = p_tenant_id AND interval.price_group_id = v_price_group_id
    AND interval.schedule_catalog_revision = v_group.current_definition_schedule_revision
    AND interval.effective_from < (p_input->>'effectiveFrom')::timestamptz;
  INSERT INTO price_group_catalog.price_group_definition_effective_intervals (
    tenant_id, price_group_id, definition_revision_id, schedule_catalog_revision,
    effective_from, effective_to, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    p_tenant_id, v_price_group_id, v_definition_revision_id, v_accepted,
    (p_input->>'effectiveFrom')::timestamptz, v_effective_to,
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
  );
  FOR v_contract IN SELECT value FROM jsonb_array_elements(p_input->'compatibilityContracts') LOOP
    INSERT INTO price_group_catalog.price_group_compatibility_support (
      tenant_id, price_group_id, definition_revision_id, contract_id, contract_version,
      declared_at_catalog_revision, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      p_tenant_id, v_price_group_id, v_definition_revision_id, v_contract->>'contractId',
      (v_contract->>'version')::bigint, v_accepted, (p_input->>'actionInvocationId')::uuid,
      (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
    );
  END LOOP;
  UPDATE price_group_catalog.price_groups SET current_definition_schedule_revision = v_accepted
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id;
  v_definition := price_group_catalog.definition_json(
    p_tenant_id, v_price_group_id, v_definition_revision_id, v_accepted
  );
  RETURN QUERY SELECT jsonb_build_object('_tag', 'accepted', 'definition', v_definition);
END;
$function$;
--> statement-breakpoint
