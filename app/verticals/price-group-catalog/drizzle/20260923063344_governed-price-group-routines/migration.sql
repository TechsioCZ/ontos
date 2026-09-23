-- Custom SQL migration file, put your code below! --
-- Runtime code reaches the Price Group owner only through this exact routine allowlist.
CREATE FUNCTION "price_group_catalog"."assert_operation_scope"(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'price group catalog operation scope mismatch' USING ERRCODE = '42501';
  END IF;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."definition_json"(
  p_tenant_id uuid,
  p_price_group_id uuid,
  p_definition_revision_id uuid,
  p_schedule_catalog_revision bigint
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'acceptedCatalogRevision', definition.accepted_catalog_revision,
    'classificationPurpose', definition.classification_purpose,
    'compatibilityContracts', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object('contractId', support.contract_id, 'version', support.contract_version)
        ORDER BY support.contract_id, support.contract_version
      )
      FROM price_group_catalog.price_group_compatibility_support AS support
      WHERE support.tenant_id = definition.tenant_id
        AND support.price_group_id = definition.price_group_id
        AND support.definition_revision_id = definition.definition_revision_id
    ), '[]'::jsonb),
    'created', jsonb_build_object(
      'actionInvocationId', definition.action_invocation_id,
      'actorPrincipalId', definition.acting_principal_id,
      'reason', definition.reason,
      'trustedAt', to_char(ledger.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'definitionRevisionId', definition.definition_revision_id,
    'description', definition.description,
    'displayName', definition.display_name,
    'effectivePeriod', jsonb_build_object(
      'effectiveFrom', to_char(interval.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN interval.effective_to IS NULL THEN NULL
        ELSE to_char(interval.effective_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'meaningFingerprint', definition.meaning_fingerprint,
    'previousDefinitionRevisionId', definition.previous_definition_revision_id,
    'priceGroupRef', jsonb_build_object(
      'moduleId', 'pricing.price-group-catalog',
      'resourceId', definition.price_group_id,
      'resourceType', 'pricing.price-group-catalog.price-group',
      'tenantId', definition.tenant_id
    ),
    'revisionNumber', definition.revision_number
  )
  FROM price_group_catalog.price_group_definition_revisions AS definition
  INNER JOIN price_group_catalog.price_group_definition_effective_intervals AS interval
    ON interval.tenant_id = definition.tenant_id
   AND interval.price_group_id = definition.price_group_id
   AND interval.definition_revision_id = definition.definition_revision_id
   AND interval.schedule_catalog_revision = p_schedule_catalog_revision
  INNER JOIN price_group_catalog.price_group_catalog_ledger AS ledger
    ON ledger.tenant_id = definition.tenant_id
   AND ledger.catalog_revision = definition.accepted_catalog_revision
  WHERE definition.tenant_id = p_tenant_id
    AND definition.price_group_id = p_price_group_id
    AND definition.definition_revision_id = p_definition_revision_id
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."create_price_group"(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing price_group_catalog.price_group_catalog_ledger%ROWTYPE;
  v_existing_semantic_price_group_id uuid;
  v_existing_semantic_fingerprint text;
  v_price_group_id uuid := nullif(p_input->>'priceGroupId', '')::uuid;
  v_definition_revision_id uuid := nullif(p_input->>'definitionRevisionId', '')::uuid;
  v_expected bigint := (p_input->>'expectedCatalogRevision')::bigint;
  v_accepted bigint := v_expected + 1;
  v_contract jsonb;
  v_definition jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text, 334));

  SELECT * INTO v_existing
  FROM price_group_catalog.price_group_catalog_ledger
  WHERE tenant_id = p_tenant_id
    AND action_invocation_id = (p_input->>'actionInvocationId')::uuid;
  IF FOUND THEN
    v_price_group_id := coalesce(v_price_group_id, v_existing.price_group_id);
    v_definition_revision_id := coalesce(v_definition_revision_id, v_existing.definition_revision_id);
    IF v_existing.operation_kind = 'CREATE_PRICE_GROUP'
      AND v_existing.price_group_id = v_price_group_id
      AND v_existing.definition_revision_id = v_definition_revision_id
      AND v_existing.expected_catalog_revision = v_expected
      AND v_existing.acting_principal_id = (p_input->>'actingPrincipalId')::uuid
      AND v_existing.trusted_effective_at = (p_input->>'trustedEffectiveAt')::timestamptz
      AND v_existing.reason = p_input->>'reason'
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_groups AS price_group
        WHERE price_group.tenant_id = p_tenant_id
          AND price_group.price_group_id = v_price_group_id
          AND price_group.business_code = p_input->>'businessCode'
          AND price_group.meaning_fingerprint = p_input->>'meaningFingerprint'
          AND price_group.classification_purpose = p_input->>'classificationPurpose'
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
        WHERE definition.tenant_id = p_tenant_id
          AND definition.price_group_id = v_price_group_id
          AND definition.definition_revision_id = v_definition_revision_id
          AND definition.revision_number = 1
          AND definition.previous_definition_revision_id IS NULL
          AND definition.display_name = p_input->>'displayName'
          AND definition.description = p_input->>'description'
          AND definition.classification_purpose = p_input->>'classificationPurpose'
          AND definition.meaning_fingerprint = p_input->>'meaningFingerprint'
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_effective_intervals AS interval
        WHERE interval.tenant_id = p_tenant_id
          AND interval.price_group_id = v_price_group_id
          AND interval.definition_revision_id = v_definition_revision_id
          AND interval.schedule_catalog_revision = v_existing.catalog_revision
          AND interval.effective_from = (p_input->>'effectiveFrom')::timestamptz
          AND interval.effective_to IS NOT DISTINCT FROM nullif(p_input->>'effectiveTo', '')::timestamptz
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

  v_price_group_id := coalesce(v_price_group_id, gen_random_uuid());
  v_definition_revision_id := coalesce(v_definition_revision_id, gen_random_uuid());

  IF EXISTS (SELECT 1 FROM price_group_catalog.price_groups
    WHERE tenant_id = p_tenant_id AND business_code = p_input->>'businessCode') THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'business_code_conflict', 'conflictingCode', p_input->>'businessCode'
    );
    RETURN;
  END IF;
  SELECT price_group_id, meaning_fingerprint
    INTO v_existing_semantic_price_group_id, v_existing_semantic_fingerprint
  FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id
    AND meaning_fingerprint = p_input->>'meaningFingerprint'
    AND classification_purpose = p_input->>'classificationPurpose';
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'semantic_identity_conflict',
      'existingPriceGroupId', v_existing_semantic_price_group_id,
      'existingMeaningFingerprint', v_existing_semantic_fingerprint,
      'requestedMeaningFingerprint', p_input->>'meaningFingerprint'
    );
    RETURN;
  END IF;
  IF coalesce((SELECT max(catalog_revision) FROM price_group_catalog.price_group_catalog_ledger
    WHERE tenant_id = p_tenant_id), 0) <> v_expected THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict');
    RETURN;
  END IF;

  INSERT INTO price_group_catalog.price_group_catalog_ledger (
    tenant_id, expected_catalog_revision, catalog_revision, operation_kind, price_group_id,
    definition_revision_id, action_invocation_id, acting_principal_id, trusted_effective_at, reason
  ) VALUES (
    p_tenant_id, v_expected, v_accepted, 'CREATE_PRICE_GROUP', v_price_group_id,
    v_definition_revision_id, (p_input->>'actionInvocationId')::uuid,
    (p_input->>'actingPrincipalId')::uuid, (p_input->>'trustedEffectiveAt')::timestamptz,
    p_input->>'reason'
  );
  INSERT INTO price_group_catalog.price_groups (
    price_group_id, tenant_id, business_code, meaning_fingerprint, classification_purpose,
    active_from, current_definition_schedule_revision, created_at_catalog_revision,
    created_by_action_invocation_id, created_by_principal_id, creation_reason
  ) VALUES (
    v_price_group_id, p_tenant_id, p_input->>'businessCode', p_input->>'meaningFingerprint',
    p_input->>'classificationPurpose', (p_input->>'effectiveFrom')::timestamptz, v_accepted, v_accepted,
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
  );
  INSERT INTO price_group_catalog.price_group_definition_revisions (
    definition_revision_id, tenant_id, price_group_id, revision_number,
    previous_definition_revision_id, display_name, description, classification_purpose,
    meaning_fingerprint, accepted_catalog_revision, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_definition_revision_id, p_tenant_id, v_price_group_id, 1, NULL,
    p_input->>'displayName', p_input->>'description', p_input->>'classificationPurpose',
    p_input->>'meaningFingerprint', v_accepted, (p_input->>'actionInvocationId')::uuid,
    (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
  );
  INSERT INTO price_group_catalog.price_group_definition_effective_intervals (
    tenant_id, price_group_id, definition_revision_id, schedule_catalog_revision,
    effective_from, effective_to, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    p_tenant_id, v_price_group_id, v_definition_revision_id, v_accepted,
    (p_input->>'effectiveFrom')::timestamptz, nullif(p_input->>'effectiveTo', '')::timestamptz,
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
  v_definition := price_group_catalog.definition_json(
    p_tenant_id, v_price_group_id, v_definition_revision_id, v_accepted
  );
  RETURN QUERY SELECT jsonb_build_object('_tag', 'accepted', 'definition', v_definition);
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."create_definition_revision"(p_tenant_id uuid, p_input jsonb)
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
  v_fence_expected bigint;
  v_accepted bigint;
  v_previous uuid;
  v_revision bigint;
  v_candidates uuid[];
  v_contract jsonb;
  v_definition jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text, 334));
  SELECT * INTO v_existing FROM price_group_catalog.price_group_catalog_ledger
  WHERE tenant_id = p_tenant_id AND action_invocation_id = (p_input->>'actionInvocationId')::uuid;
  IF FOUND THEN
    v_definition_revision_id := coalesce(v_definition_revision_id, v_existing.definition_revision_id);
    IF v_existing.operation_kind = 'CREATE_DEFINITION_REVISION'
      AND v_existing.price_group_id = v_price_group_id
      AND v_existing.definition_revision_id = v_definition_revision_id
      AND v_existing.acting_principal_id = (p_input->>'actingPrincipalId')::uuid
      AND v_existing.trusted_effective_at = (p_input->>'trustedEffectiveAt')::timestamptz
      AND v_existing.reason = p_input->>'reason'
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
        WHERE definition.tenant_id = p_tenant_id
          AND definition.price_group_id = v_price_group_id
          AND definition.definition_revision_id = v_definition_revision_id
          AND definition.previous_definition_revision_id = (p_input#>>'{expectedCurrent,definitionRevisionId}')::uuid
          AND definition.display_name = p_input->>'displayName'
          AND definition.description = p_input->>'description'
          AND definition.classification_purpose = p_input->>'classificationPurpose'
          AND definition.meaning_fingerprint = p_input->>'meaningFingerprint'
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_effective_intervals AS interval
        WHERE interval.tenant_id = p_tenant_id
          AND interval.price_group_id = v_price_group_id
          AND interval.definition_revision_id = v_definition_revision_id
          AND interval.schedule_catalog_revision = v_existing.catalog_revision
          AND interval.effective_from = (p_input->>'effectiveFrom')::timestamptz
          AND interval.effective_to IS NOT DISTINCT FROM nullif(p_input->>'effectiveTo', '')::timestamptz
      )
      AND v_group_expected = (
        SELECT max(interval.schedule_catalog_revision)
        FROM price_group_catalog.price_group_definition_effective_intervals AS interval
        WHERE interval.tenant_id = p_tenant_id
          AND interval.price_group_id = v_price_group_id
          AND interval.schedule_catalog_revision < v_existing.catalog_revision
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS previous_definition
        WHERE previous_definition.tenant_id = p_tenant_id
          AND previous_definition.price_group_id = v_price_group_id
          AND previous_definition.definition_revision_id = (p_input#>>'{expectedCurrent,definitionRevisionId}')::uuid
          AND previous_definition.revision_number = (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint
          AND previous_definition.meaning_fingerprint = p_input#>>'{expectedCurrent,meaningFingerprint}'
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

  v_definition_revision_id := coalesce(v_definition_revision_id, gen_random_uuid());

  SELECT * INTO v_group FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  IF v_group.lifecycle_state = 'RETIRED'
    AND ((p_input->>'trustedEffectiveAt')::timestamptz >= v_group.retired_effective_at
      OR (p_input->>'effectiveFrom')::timestamptz >= v_group.retired_effective_at
      OR nullif(p_input->>'effectiveTo', '')::timestamptz IS NULL
      OR nullif(p_input->>'effectiveTo', '')::timestamptz <> v_group.retired_effective_at) THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'effective_period_conflict',
      'effectiveFrom', p_input->>'effectiveFrom',
      'trustedEffectiveAt', p_input->>'trustedEffectiveAt',
      'reason', 'A revision accepted after retirement scheduling must start before and end exactly at the retirement boundary'
    ); RETURN;
  END IF;
  IF v_group.meaning_fingerprint <> p_input->>'meaningFingerprint'
    OR v_group.classification_purpose <> p_input->>'classificationPurpose' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'material_meaning_change'); RETURN;
  END IF;
  IF v_group.current_definition_schedule_revision <> v_group_expected
    OR v_group.meaning_fingerprint <> p_input#>>'{expectedCurrent,meaningFingerprint}' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
    INTO v_candidates
  FROM price_group_catalog.price_group_definition_effective_intervals AS interval
  WHERE interval.tenant_id = p_tenant_id
    AND interval.price_group_id = v_price_group_id
    AND interval.schedule_catalog_revision = v_group.current_definition_schedule_revision
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
  IF v_previous <> (p_input#>>'{expectedCurrent,definitionRevisionId}')::uuid THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  SELECT revision_number INTO v_revision
  FROM price_group_catalog.price_group_definition_revisions
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id
    AND definition_revision_id = v_previous;
  IF v_revision IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(v_previous)); RETURN;
  END IF;
  IF v_revision <> (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  v_revision := v_revision + 1;

  SELECT coalesce(max(catalog_revision), 0) INTO v_fence_expected
  FROM price_group_catalog.price_group_catalog_ledger
  WHERE tenant_id = p_tenant_id;
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
    previous_definition_revision_id, display_name, description, classification_purpose,
    meaning_fingerprint, accepted_catalog_revision, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_definition_revision_id, p_tenant_id, v_price_group_id, v_revision, v_previous,
    p_input->>'displayName', p_input->>'description', p_input->>'classificationPurpose',
    p_input->>'meaningFingerprint', v_accepted, (p_input->>'actionInvocationId')::uuid,
    (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
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
    (p_input->>'effectiveFrom')::timestamptz, nullif(p_input->>'effectiveTo', '')::timestamptz,
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
  UPDATE price_group_catalog.price_groups
  SET current_definition_schedule_revision = v_accepted
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id;
  v_definition := price_group_catalog.definition_json(
    p_tenant_id, v_price_group_id, v_definition_revision_id, v_accepted
  );
  RETURN QUERY SELECT jsonb_build_object('_tag', 'accepted', 'definition', v_definition);
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."retire_price_group"(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group price_group_catalog.price_groups%ROWTYPE;
  v_existing price_group_catalog.price_group_catalog_ledger%ROWTYPE;
  v_retirement price_group_catalog.price_group_retirements%ROWTYPE;
  v_price_group_id uuid := (p_input#>>'{expectedCurrent,priceGroupRef,resourceId}')::uuid;
  v_definition_revision_id uuid := (p_input#>>'{expectedCurrent,definitionRevisionId}')::uuid;
  v_group_expected bigint := (p_input#>>'{expectedCurrent,catalogRevision}')::bigint;
  v_retirement_schedule bigint;
  v_fence_expected bigint;
  v_accepted bigint;
  v_candidates uuid[];
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text, 334));
  SELECT * INTO v_existing FROM price_group_catalog.price_group_catalog_ledger
  WHERE tenant_id = p_tenant_id AND action_invocation_id = (p_input->>'actionInvocationId')::uuid;
  IF FOUND THEN
    SELECT max(ledger.catalog_revision)
      INTO v_retirement_schedule
    FROM price_group_catalog.price_group_catalog_ledger AS ledger
    WHERE ledger.tenant_id = p_tenant_id
      AND ledger.price_group_id = v_price_group_id
      AND ledger.catalog_revision < v_existing.catalog_revision
      AND ledger.operation_kind IN ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION');
    IF v_existing.operation_kind = 'RETIRE_PRICE_GROUP'
      AND v_existing.price_group_id = v_price_group_id
      AND v_existing.definition_revision_id = v_definition_revision_id
      AND v_existing.trusted_effective_at = (p_input->>'trustedEffectiveAt')::timestamptz
      AND v_existing.acting_principal_id = (p_input->>'actingPrincipalId')::uuid
      AND v_existing.reason = p_input->>'reason'
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_retirements AS retirement
        WHERE retirement.tenant_id = p_tenant_id
          AND retirement.price_group_id = v_price_group_id
          AND retirement.effective_at = (p_input->>'effectiveAt')::timestamptz
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_groups AS price_group
        WHERE price_group.tenant_id = p_tenant_id
          AND price_group.price_group_id = v_price_group_id
          AND price_group.meaning_fingerprint = p_input#>>'{expectedCurrent,meaningFingerprint}'
      )
      AND v_retirement_schedule = v_group_expected
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
        WHERE definition.tenant_id = p_tenant_id
          AND definition.price_group_id = v_price_group_id
          AND definition.definition_revision_id = v_definition_revision_id
          AND definition.revision_number = (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint
      )
    THEN
      SELECT * INTO v_retirement
      FROM price_group_catalog.price_group_retirements
      WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id;
      RETURN QUERY SELECT jsonb_build_object('_tag', 'replayed', 'retirement', jsonb_build_object(
        'acceptedCatalogRevision', v_retirement.accepted_catalog_revision,
        'currentDefinitionRevisionId', v_retirement.current_definition_revision_id,
        'currentDefinitionRevisionNumber', (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint,
        'priceGroupRef', jsonb_build_object(
          'moduleId', 'pricing.price-group-catalog', 'resourceId', v_price_group_id,
          'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', p_tenant_id
        ),
        'retirementEffectiveAt', to_char(v_retirement.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'retirementProvenance', jsonb_build_object(
          'actionInvocationId', v_retirement.action_invocation_id,
          'actorPrincipalId', v_retirement.acting_principal_id,
          'reason', v_retirement.reason,
          'trustedAt', to_char(v_existing.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        'trustedOperationAt', to_char(v_existing.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'verifiedAt', to_char(v_retirement.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ));
    ELSE RETURN QUERY SELECT jsonb_build_object('_tag', 'idempotency_conflict');
    END IF;
    RETURN;
  END IF;
  IF (p_input->>'effectiveAt')::timestamptz < (p_input->>'trustedEffectiveAt')::timestamptz THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'retirement_effective_time_conflict',
      'effectiveAt', p_input->>'effectiveAt',
      'trustedEffectiveAt', p_input->>'trustedEffectiveAt'
    );
    RETURN;
  END IF;
  SELECT * INTO v_group FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  IF v_group.lifecycle_state <> 'ACTIVE' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'lifecycle_conflict'); RETURN;
  END IF;
  IF v_group.current_definition_schedule_revision <> v_group_expected
    OR v_group.meaning_fingerprint <> p_input#>>'{expectedCurrent,meaningFingerprint}' THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
    INTO v_candidates
  FROM price_group_catalog.price_group_definition_effective_intervals AS interval
  WHERE interval.tenant_id = p_tenant_id AND interval.price_group_id = v_price_group_id
    AND interval.schedule_catalog_revision = v_group_expected
    AND interval.effective_from <= (p_input->>'effectiveAt')::timestamptz
    AND (interval.effective_to IS NULL OR (p_input->>'effectiveAt')::timestamptz < interval.effective_to);
  IF coalesce(cardinality(v_candidates), 0) <> 1 THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', CASE WHEN coalesce(cardinality(v_candidates), 0) = 0
        THEN 'ZERO_CURRENT_DEFINITIONS' ELSE 'MULTIPLE_CURRENT_DEFINITIONS' END,
      'candidateDefinitionRevisionIds', coalesce(to_jsonb(v_candidates), '[]'::jsonb)); RETURN;
  END IF;
  IF v_candidates[1] <> v_definition_revision_id THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
    WHERE definition.tenant_id = p_tenant_id
      AND definition.price_group_id = v_price_group_id
      AND definition.definition_revision_id = v_definition_revision_id
      AND definition.revision_number = (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'catalog_conflict'); RETURN;
  END IF;
  SELECT coalesce(max(catalog_revision), 0) INTO v_fence_expected
  FROM price_group_catalog.price_group_catalog_ledger
  WHERE tenant_id = p_tenant_id;
  v_accepted := v_fence_expected + 1;
  INSERT INTO price_group_catalog.price_group_catalog_ledger (
    tenant_id, expected_catalog_revision, catalog_revision, operation_kind, price_group_id,
    definition_revision_id, action_invocation_id, acting_principal_id, trusted_effective_at, reason
  ) VALUES (
    p_tenant_id, v_fence_expected, v_accepted, 'RETIRE_PRICE_GROUP', v_price_group_id,
    v_definition_revision_id, (p_input->>'actionInvocationId')::uuid,
    (p_input->>'actingPrincipalId')::uuid, (p_input->>'trustedEffectiveAt')::timestamptz, p_input->>'reason'
  );
  INSERT INTO price_group_catalog.price_group_retirements (
    tenant_id, price_group_id, current_definition_revision_id, effective_at,
    expected_catalog_revision, accepted_catalog_revision, action_invocation_id, acting_principal_id, reason, recorded_at
  ) VALUES (
    p_tenant_id, v_price_group_id, v_definition_revision_id, (p_input->>'effectiveAt')::timestamptz,
    v_fence_expected, v_accepted, (p_input->>'actionInvocationId')::uuid,
    (p_input->>'actingPrincipalId')::uuid, p_input->>'reason',
    greatest(clock_timestamp(), (p_input->>'trustedEffectiveAt')::timestamptz)
  ) RETURNING * INTO v_retirement;
  UPDATE price_group_catalog.price_groups SET lifecycle_state = 'RETIRED',
    retired_effective_at = (p_input->>'effectiveAt')::timestamptz
  WHERE tenant_id = p_tenant_id AND price_group_id = v_price_group_id;
  RETURN QUERY SELECT jsonb_build_object('_tag', 'accepted', 'retirement', jsonb_build_object(
    'acceptedCatalogRevision', v_retirement.accepted_catalog_revision,
    'currentDefinitionRevisionId', v_retirement.current_definition_revision_id,
    'currentDefinitionRevisionNumber', (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint,
    'priceGroupRef', jsonb_build_object(
      'moduleId', 'pricing.price-group-catalog', 'resourceId', v_price_group_id,
      'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', p_tenant_id
    ),
    'retirementEffectiveAt', to_char(v_retirement.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'retirementProvenance', jsonb_build_object(
      'actionInvocationId', v_retirement.action_invocation_id,
      'actorPrincipalId', v_retirement.acting_principal_id,
      'reason', v_retirement.reason,
      'trustedAt', to_char((p_input->>'trustedEffectiveAt')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'trustedOperationAt', to_char((p_input->>'trustedEffectiveAt')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'verifiedAt', to_char(v_retirement.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ));
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."read_current_definition"(
  p_tenant_id uuid, p_price_group_id uuid, p_at timestamptz
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group price_group_catalog.price_groups%ROWTYPE;
  v_retirement price_group_catalog.price_group_retirements%ROWTYPE;
  v_schedule bigint;
  v_candidates uuid[];
  v_definition jsonb;
  v_identity jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT * INTO v_group
  FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  v_schedule := v_group.current_definition_schedule_revision;
  IF v_group.retired_effective_at IS NOT NULL AND p_at >= v_group.retired_effective_at THEN
    SELECT * INTO v_retirement
    FROM price_group_catalog.price_group_retirements
    WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
        'reason', 'UNVERIFIABLE_CURRENTNESS', 'candidateDefinitionRevisionIds', '[]'::jsonb); RETURN;
    END IF;
    SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
      INTO v_candidates
    FROM price_group_catalog.price_group_definition_effective_intervals AS interval
    WHERE interval.tenant_id = p_tenant_id AND interval.price_group_id = p_price_group_id
      AND interval.schedule_catalog_revision = v_schedule
      AND interval.effective_from < v_group.retired_effective_at
      AND (interval.effective_to IS NULL OR v_group.retired_effective_at <= interval.effective_to);
  ELSE
    SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
      INTO v_candidates
    FROM price_group_catalog.price_group_definition_effective_intervals AS interval
    WHERE interval.tenant_id = p_tenant_id AND interval.price_group_id = p_price_group_id
      AND interval.schedule_catalog_revision = v_schedule AND interval.effective_from <= p_at
      AND (interval.effective_to IS NULL OR p_at < interval.effective_to);
  END IF;
  IF coalesce(cardinality(v_candidates), 0) = 0 THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'ZERO_CURRENT_DEFINITIONS', 'candidateDefinitionRevisionIds', '[]'::jsonb); RETURN;
  ELSIF cardinality(v_candidates) > 1 THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'MULTIPLE_CURRENT_DEFINITIONS', 'candidateDefinitionRevisionIds', to_jsonb(v_candidates)); RETURN;
  END IF;
  v_definition := price_group_catalog.definition_json(
    p_tenant_id, p_price_group_id, v_candidates[1], v_schedule
  );
  IF v_definition IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(v_candidates[1])); RETURN;
  END IF;
  SELECT jsonb_build_object(
    'businessCode', price_group.business_code,
    'classificationPurpose', price_group.classification_purpose,
    'created', jsonb_build_object(
      'actionInvocationId', price_group.created_by_action_invocation_id,
      'actorPrincipalId', price_group.created_by_principal_id,
      'reason', price_group.creation_reason,
      'trustedAt', to_char(creation.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'createdAtCatalogRevision', price_group.created_at_catalog_revision,
    'lifecycle', jsonb_build_object(
      'activeFrom', to_char(price_group.active_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'retiredAt', CASE WHEN price_group.retired_effective_at IS NULL OR p_at < price_group.retired_effective_at THEN NULL
        ELSE to_char(price_group.retired_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'state', CASE WHEN price_group.retired_effective_at IS NOT NULL AND p_at >= price_group.retired_effective_at
        THEN 'RETIRED' ELSE 'ACTIVE' END
    ),
    'meaningFingerprint', price_group.meaning_fingerprint,
    'priceGroupRef', jsonb_build_object(
      'moduleId', 'pricing.price-group-catalog', 'resourceId', price_group.price_group_id,
      'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', price_group.tenant_id
    )
  ) INTO v_identity
  FROM price_group_catalog.price_groups AS price_group
  INNER JOIN price_group_catalog.price_group_catalog_ledger AS creation
    ON creation.tenant_id = price_group.tenant_id
   AND creation.catalog_revision = price_group.created_at_catalog_revision
  WHERE price_group.tenant_id = p_tenant_id AND price_group.price_group_id = p_price_group_id;
  IF v_identity IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(v_candidates[1])); RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'current', 'catalogRevision', v_schedule, 'definition', v_definition, 'identity', v_identity
  );
END;
$function$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "price_group_catalog"."read_definition_revision"(uuid, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."read_definition_revision"(
  p_tenant_id uuid, p_price_group_id uuid, p_definition_revision_id uuid, p_at timestamptz
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_schedule bigint;
  v_definition jsonb;
  v_identity jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT price_group.current_definition_schedule_revision INTO v_schedule
  FROM price_group_catalog.price_groups AS price_group
  WHERE price_group.tenant_id = p_tenant_id
    AND price_group.price_group_id = p_price_group_id;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM price_group_catalog.price_group_definition_revisions AS definition
    WHERE definition.tenant_id = p_tenant_id
      AND definition.price_group_id = p_price_group_id
      AND definition.definition_revision_id = p_definition_revision_id
  ) THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  v_definition := price_group_catalog.definition_json(
    p_tenant_id, p_price_group_id, p_definition_revision_id, v_schedule
  );
  IF v_definition IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(p_definition_revision_id)); RETURN;
  END IF;
  SELECT jsonb_build_object(
    'businessCode', price_group.business_code,
    'classificationPurpose', price_group.classification_purpose,
    'created', jsonb_build_object(
      'actionInvocationId', price_group.created_by_action_invocation_id,
      'actorPrincipalId', price_group.created_by_principal_id,
      'reason', price_group.creation_reason,
      'trustedAt', to_char(creation.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'createdAtCatalogRevision', price_group.created_at_catalog_revision,
    'lifecycle', jsonb_build_object(
      'activeFrom', to_char(price_group.active_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'retiredAt', CASE WHEN price_group.retired_effective_at IS NULL OR p_at < price_group.retired_effective_at THEN NULL
        ELSE to_char(price_group.retired_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'state', CASE WHEN price_group.retired_effective_at IS NOT NULL AND p_at >= price_group.retired_effective_at
        THEN 'RETIRED' ELSE 'ACTIVE' END
    ),
    'meaningFingerprint', price_group.meaning_fingerprint,
    'priceGroupRef', jsonb_build_object(
      'moduleId', 'pricing.price-group-catalog', 'resourceId', price_group.price_group_id,
      'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', price_group.tenant_id
    )
  ) INTO v_identity
  FROM price_group_catalog.price_groups AS price_group
  INNER JOIN price_group_catalog.price_group_catalog_ledger AS creation
    ON creation.tenant_id = price_group.tenant_id
   AND creation.catalog_revision = price_group.created_at_catalog_revision
  WHERE price_group.tenant_id = p_tenant_id AND price_group.price_group_id = p_price_group_id;
  IF v_identity IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(p_definition_revision_id)); RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'found', 'definition', v_definition, 'identity', v_identity
  );
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."validate_compatibility"(
  p_tenant_id uuid,
  p_price_group_id uuid,
  p_contract_id text,
  p_contract_version bigint,
  p_trusted_operation_at timestamptz,
  p_expected_current jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group price_group_catalog.price_groups%ROWTYPE;
  v_retirement price_group_catalog.price_group_retirements%ROWTYPE;
  v_candidates uuid[];
  v_definition_id uuid;
  v_definition_revision_number bigint;
  v_catalog_revision bigint;
  v_retirement_trusted_at timestamptz;
  v_from timestamptz;
  v_to timestamptz;
  v_verified_at timestamptz := clock_timestamp();
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT * INTO v_group FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id;
  IF NOT FOUND THEN
    SELECT coalesce(max(catalog_revision), 0) INTO v_catalog_revision
    FROM price_group_catalog.price_group_catalog_ledger
    WHERE tenant_id = p_tenant_id;
    RETURN QUERY SELECT jsonb_build_object('_tag', 'decision', 'decision', jsonb_build_object(
      'catalogObservation', jsonb_build_object(
        'catalogRevision', v_catalog_revision,
        'observedAt', to_char(v_verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'trustedOperationAt', to_char(p_trusted_operation_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'kind', 'MISSING', 'priceGroupRef', jsonb_build_object(
        'moduleId', 'pricing.price-group-catalog', 'resourceId', p_price_group_id,
        'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', p_tenant_id
      )
    )); RETURN;
  END IF;
  IF v_group.lifecycle_state = 'RETIRED' AND p_trusted_operation_at >= v_group.retired_effective_at THEN
    SELECT * INTO v_retirement
    FROM price_group_catalog.price_group_retirements
    WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
        'reason', 'UNVERIFIABLE_CURRENTNESS', 'candidateDefinitionRevisionIds', '[]'::jsonb); RETURN;
    END IF;
    SELECT ledger.trusted_effective_at INTO v_retirement_trusted_at
    FROM price_group_catalog.price_group_catalog_ledger AS ledger
    WHERE ledger.tenant_id = p_tenant_id
      AND ledger.catalog_revision = v_retirement.accepted_catalog_revision;
    IF v_retirement_trusted_at IS NULL THEN
      RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
        'reason', 'UNVERIFIABLE_CURRENTNESS',
        'candidateDefinitionRevisionIds', jsonb_build_array(v_retirement.current_definition_revision_id)); RETURN;
    END IF;
    SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
      INTO v_candidates
    FROM price_group_catalog.price_group_definition_effective_intervals AS interval
    WHERE interval.tenant_id = p_tenant_id
      AND interval.price_group_id = p_price_group_id
      AND interval.schedule_catalog_revision = v_group.current_definition_schedule_revision
      AND interval.effective_from < v_group.retired_effective_at
      AND (interval.effective_to IS NULL OR v_group.retired_effective_at <= interval.effective_to);
    IF coalesce(cardinality(v_candidates), 0) <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
        'reason', CASE WHEN coalesce(cardinality(v_candidates), 0) = 0
          THEN 'ZERO_CURRENT_DEFINITIONS' ELSE 'MULTIPLE_CURRENT_DEFINITIONS' END,
        'candidateDefinitionRevisionIds', coalesce(to_jsonb(v_candidates), '[]'::jsonb)); RETURN;
    END IF;
    v_definition_id := v_candidates[1];
    SELECT revision_number INTO v_definition_revision_number
    FROM price_group_catalog.price_group_definition_revisions
    WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id
      AND definition_revision_id = v_definition_id;
    IF v_definition_revision_number IS NULL THEN
      RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
        'reason', 'UNVERIFIABLE_CURRENTNESS',
        'candidateDefinitionRevisionIds', jsonb_build_array(v_definition_id)); RETURN;
    END IF;
    RETURN QUERY SELECT jsonb_build_object('_tag', 'decision', 'decision', jsonb_build_object(
      'kind', 'RETIRED', 'evidence', jsonb_build_object(
        'acceptedCatalogRevision', v_retirement.accepted_catalog_revision,
        'currentDefinitionRevisionId', v_definition_id,
        'currentDefinitionRevisionNumber', v_definition_revision_number,
        'priceGroupRef', jsonb_build_object(
          'moduleId', 'pricing.price-group-catalog', 'resourceId', p_price_group_id,
          'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', p_tenant_id
        ),
        'retiredAt', to_char(v_retirement.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'retirementProvenance', jsonb_build_object(
          'actionInvocationId', v_retirement.action_invocation_id,
          'actorPrincipalId', v_retirement.acting_principal_id,
          'reason', v_retirement.reason,
          'trustedAt', to_char(v_retirement_trusted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        'trustedOperationAt', to_char(p_trusted_operation_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'verifiedAt', to_char(v_verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    )); RETURN;
  END IF;
  SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
    INTO v_candidates
  FROM price_group_catalog.price_group_definition_effective_intervals AS interval
  WHERE interval.tenant_id = p_tenant_id AND interval.price_group_id = p_price_group_id
    AND interval.schedule_catalog_revision = v_group.current_definition_schedule_revision
    AND interval.effective_from <= p_trusted_operation_at
    AND (interval.effective_to IS NULL OR p_trusted_operation_at < interval.effective_to);
  IF coalesce(cardinality(v_candidates), 0) = 0 THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'ZERO_CURRENT_DEFINITIONS', 'candidateDefinitionRevisionIds', '[]'::jsonb); RETURN;
  ELSIF cardinality(v_candidates) > 1 THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'MULTIPLE_CURRENT_DEFINITIONS', 'candidateDefinitionRevisionIds', to_jsonb(v_candidates)); RETURN;
  END IF;
  v_definition_id := v_candidates[1];
  SELECT revision_number INTO v_definition_revision_number
  FROM price_group_catalog.price_group_definition_revisions
  WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id
    AND definition_revision_id = v_definition_id;
  IF v_definition_revision_number IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(v_definition_id)); RETURN;
  END IF;
  IF (p_expected_current->>'catalogRevision')::bigint <> v_group.current_definition_schedule_revision
    OR (p_expected_current->>'definitionRevisionId')::uuid <> v_definition_id
    OR (p_expected_current->>'definitionRevisionNumber')::bigint <> v_definition_revision_number
    OR p_expected_current->>'meaningFingerprint' <> v_group.meaning_fingerprint
    OR (p_expected_current#>>'{priceGroupRef,tenantId}')::uuid <> p_tenant_id
    OR (p_expected_current#>>'{priceGroupRef,resourceId}')::uuid <> p_price_group_id THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'expected_current_conflict'); RETURN;
  END IF;
  SELECT effective_from, effective_to INTO v_from, v_to
  FROM price_group_catalog.price_group_definition_effective_intervals
  WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id
    AND schedule_catalog_revision = v_group.current_definition_schedule_revision
    AND definition_revision_id = v_definition_id;
  IF NOT EXISTS (
    SELECT 1 FROM price_group_catalog.price_group_compatibility_support
    WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id
      AND definition_revision_id = v_definition_id AND contract_id = p_contract_id
      AND contract_version = p_contract_version
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'decision', 'decision', jsonb_build_object(
      'kind', 'INCOMPATIBLE', 'evidence', jsonb_build_object(
        'definitionRevisionId', v_definition_id,
        'definitionRevisionNumber', v_definition_revision_number,
        'evaluatedCatalogRevision', v_group.current_definition_schedule_revision,
        'meaningFingerprint', v_group.meaning_fingerprint,
        'priceGroupRef', jsonb_build_object(
          'moduleId', 'pricing.price-group-catalog', 'resourceId', p_price_group_id,
          'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', p_tenant_id
        ),
        'requiredContract', jsonb_build_object('contractId', p_contract_id, 'version', p_contract_version),
        'trustedOperationAt', to_char(p_trusted_operation_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'verifiedAt', to_char(v_verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    )); RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object('_tag', 'decision', 'decision', jsonb_build_object(
    'kind', 'USABLE', 'evidence', jsonb_build_object(
      'catalogRevision', v_group.current_definition_schedule_revision,
      'definitionEffectivePeriod', jsonb_build_object(
        'effectiveFrom', to_char(v_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN v_to IS NULL THEN NULL ELSE to_char(v_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
      ),
      'definitionRevisionId', v_definition_id,
      'definitionRevisionNumber', v_definition_revision_number,
      'meaningFingerprint', v_group.meaning_fingerprint,
      'priceGroupRef', jsonb_build_object(
        'moduleId', 'pricing.price-group-catalog', 'resourceId', p_price_group_id,
        'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', p_tenant_id
      ), 'requiredContract', jsonb_build_object('contractId', p_contract_id, 'version', p_contract_version),
      'trustedOperationAt', to_char(p_trusted_operation_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'verifiedAt', to_char(v_verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  ));
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."assert_operation_scope"(uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."definition_json"(uuid, uuid, uuid, bigint) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."create_price_group"(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."create_definition_revision"(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."retire_price_group"(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."read_current_definition"(uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."read_definition_revision"(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."validate_compatibility"(uuid, uuid, text, bigint, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."create_price_group"(uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."create_definition_revision"(uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."retire_price_group"(uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."read_current_definition"(uuid, uuid, timestamptz) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."read_definition_revision"(uuid, uuid, uuid, timestamptz) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."validate_compatibility"(uuid, uuid, text, bigint, timestamptz, jsonb) TO "ontos_runtime";
