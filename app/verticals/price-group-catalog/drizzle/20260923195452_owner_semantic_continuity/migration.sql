ALTER TABLE "price_group_catalog"."price_group_definition_revisions" DROP CONSTRAINT "price_group_catalog_definitions_stable_meaning_fk";--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions" ADD COLUMN "compared_definition_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions" ADD COLUMN "semantic_continuity_decision" text;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" DROP CONSTRAINT "price_group_catalog_groups_scope_meaning_uk";--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ADD COLUMN "canonical_meaning" text;--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."canonical_price_group_meaning"(p_classification_purpose text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT regexp_replace(lower(btrim(p_classification_purpose)), '[[:space:]]+', ' ', 'g')
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."price_group_meaning_fingerprint"(p_classification_purpose text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT encode(sha256(convert_to(
    'pricing.price-group-catalog:classification-purpose:v1:' ||
      price_group_catalog.canonical_price_group_meaning(p_classification_purpose),
    'UTF8'
  )), 'hex')
$function$;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions"
DISABLE TRIGGER "price_group_catalog_definitions_append_only";
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups"
DISABLE TRIGGER "price_groups_guard_update";
--> statement-breakpoint
UPDATE "price_group_catalog"."price_groups"
SET "canonical_meaning" = price_group_catalog.canonical_price_group_meaning("classification_purpose");
--> statement-breakpoint
UPDATE "price_group_catalog"."price_group_definition_revisions" AS definition
SET "compared_definition_revision_id" = CASE
      WHEN definition."revision_number" > 1 THEN definition."previous_definition_revision_id" ELSE NULL END,
    "semantic_continuity_decision" = CASE
      WHEN definition."revision_number" > 1 THEN 'SAME_MEANING' ELSE NULL END
FROM "price_group_catalog"."price_groups" AS price_group
WHERE price_group."tenant_id" = definition."tenant_id"
  AND price_group."price_group_id" = definition."price_group_id";
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups"
ENABLE TRIGGER "price_groups_guard_update";
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions"
ENABLE TRIGGER "price_group_catalog_definitions_append_only";
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ALTER COLUMN "canonical_meaning" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ADD CONSTRAINT "price_group_catalog_groups_scope_meaning_uk" UNIQUE("tenant_id","meaning_fingerprint");--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ADD CONSTRAINT "price_group_catalog_groups_scope_canonical_meaning_uk" UNIQUE("tenant_id","canonical_meaning");--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" ADD CONSTRAINT "price_group_catalog_groups_canonical_meaning_ck" CHECK ("canonical_meaning" = regexp_replace(lower(btrim("canonical_meaning")), '[[:space:]]+', ' ', 'g') and length("canonical_meaning") between 1 and 1000);--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_groups" DROP COLUMN "classification_purpose";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "price_group_catalog"."guard_price_group_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  schedule_operation text;
  schedule_group_id uuid;
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.price_group_id IS DISTINCT FROM NEW.price_group_id
    OR OLD.business_code IS DISTINCT FROM NEW.business_code
    OR OLD.canonical_meaning IS DISTINCT FROM NEW.canonical_meaning
    OR OLD.meaning_fingerprint IS DISTINCT FROM NEW.meaning_fingerprint
    OR OLD.active_from IS DISTINCT FROM NEW.active_from
    OR OLD.created_at_catalog_revision IS DISTINCT FROM NEW.created_at_catalog_revision
    OR OLD.created_by_action_invocation_id IS DISTINCT FROM NEW.created_by_action_invocation_id
    OR OLD.created_by_principal_id IS DISTINCT FROM NEW.created_by_principal_id
    OR OLD.creation_reason IS DISTINCT FROM NEW.creation_reason
    OR OLD.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION 'Price Group identity and creation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle_state = 'RETIRED'
    AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
      OR NEW.retired_effective_at IS DISTINCT FROM OLD.retired_effective_at) THEN
    RAISE EXCEPTION 'RETIRED Price Group is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.current_definition_schedule_revision IS DISTINCT FROM OLD.current_definition_schedule_revision THEN
    IF NEW.current_definition_schedule_revision <= OLD.current_definition_schedule_revision THEN
      RAISE EXCEPTION 'Price Group definition schedule revision must advance'
        USING ERRCODE = '23514';
    END IF;
    SELECT ledger.operation_kind, ledger.price_group_id
      INTO schedule_operation, schedule_group_id
      FROM price_group_catalog.price_group_catalog_ledger AS ledger
     WHERE ledger.tenant_id = NEW.tenant_id
       AND ledger.catalog_revision = NEW.current_definition_schedule_revision;
    IF schedule_operation NOT IN ('CREATE_DEFINITION_REVISION', 'RETIRE_PRICE_GROUP')
      OR schedule_group_id <> NEW.price_group_id THEN
      RAISE EXCEPTION 'Price Group schedule must bind its exact revision or retirement ledger entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.lifecycle_state = 'ACTIVE' THEN
    IF NEW.retired_effective_at IS NOT NULL THEN
      RAISE EXCEPTION 'ACTIVE Price Group cannot carry retirement evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.lifecycle_state = 'RETIRED' THEN
    IF NEW.retired_effective_at IS NULL THEN
      RAISE EXCEPTION 'RETIRED Price Group requires an effective instant'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported Price Group lifecycle transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "price_group_catalog"."guard_interval_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  schedule_operation text;
  schedule_group_id uuid;
  retirement_at timestamptz;
  group_state text;
BEGIN
  SELECT ledger.operation_kind, ledger.price_group_id
    INTO schedule_operation, schedule_group_id
    FROM price_group_catalog.price_group_catalog_ledger AS ledger
   WHERE ledger.tenant_id = NEW.tenant_id
     AND ledger.catalog_revision = NEW.schedule_catalog_revision;
  IF schedule_operation NOT IN ('CREATE_PRICE_GROUP', 'CREATE_DEFINITION_REVISION', 'RETIRE_PRICE_GROUP')
    OR schedule_group_id <> NEW.price_group_id THEN
    RAISE EXCEPTION 'Definition effective interval must bind an exact schedule ledger entry'
      USING ERRCODE = '23514';
  END IF;

  SELECT price_group.lifecycle_state, price_group.retired_effective_at
    INTO group_state, retirement_at
    FROM price_group_catalog.price_groups AS price_group
   WHERE price_group.tenant_id = NEW.tenant_id
     AND price_group.price_group_id = NEW.price_group_id;
  IF group_state = 'RETIRED'
    AND (NEW.effective_from >= retirement_at
      OR NEW.effective_to IS NULL
      OR NEW.effective_to > retirement_at) THEN
    RAISE EXCEPTION 'Definition effective interval cannot reopen a retired Price Group'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
ALTER TABLE "price_group_catalog"."price_group_definition_revisions" ADD CONSTRAINT "price_group_catalog_definitions_continuity_ck" CHECK (("revision_number" = 1 and "compared_definition_revision_id" is null and "semantic_continuity_decision" is null) or ("revision_number" > 1 and "semantic_continuity_decision" = 'SAME_MEANING' and "compared_definition_revision_id" = "previous_definition_revision_id"));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "price_group_catalog"."definition_json"(
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
    'revisionNumber', definition.revision_number,
    'semanticContinuity', CASE WHEN definition.semantic_continuity_decision IS NULL THEN NULL ELSE jsonb_build_object(
      'comparedDefinitionRevisionId', definition.compared_definition_revision_id,
      'decision', definition.semantic_continuity_decision,
      'provenance', jsonb_build_object(
        'actionInvocationId', definition.action_invocation_id,
        'actorPrincipalId', definition.acting_principal_id,
        'reason', definition.reason,
        'trustedAt', to_char(ledger.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    ) END
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
CREATE FUNCTION "price_group_catalog"."create_price_group_with_complete_schedule"(
  p_tenant_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing price_group_catalog.price_group_catalog_ledger%ROWTYPE;
  v_price_group_id uuid := nullif(p_input->>'priceGroupId', '')::uuid;
  v_definition_revision_id uuid := nullif(p_input->>'definitionRevisionId', '')::uuid;
  v_expected bigint := (p_input->>'expectedCatalogRevision')::bigint;
  v_accepted bigint := v_expected + 1;
  v_canonical_meaning text := price_group_catalog.canonical_price_group_meaning(
    p_input->>'classificationPurpose'
  );
  v_meaning_fingerprint text := price_group_catalog.price_group_meaning_fingerprint(
    v_canonical_meaning
  );
  v_existing_semantic_price_group_id uuid;
  v_existing_semantic_fingerprint text;
  v_contract jsonb;
  v_definition jsonb;
  v_intent price_group_catalog.price_group_containment_projection_intents%ROWTYPE;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text, 334));

  IF nullif(p_input->>'effectiveTo', '')::timestamptz IS NOT NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'effective_period_conflict',
      'effectiveFrom', p_input->>'effectiveFrom',
      'trustedEffectiveAt', p_input->>'trustedEffectiveAt',
      'reason', 'An ACTIVE Price Group initial definition must remain open-ended until retirement is accepted'
    );
    RETURN;
  END IF;
  IF (p_input->>'effectiveFrom')::timestamptz < (p_input->>'trustedEffectiveAt')::timestamptz THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'effective_period_conflict',
      'effectiveFrom', p_input->>'effectiveFrom',
      'trustedEffectiveAt', p_input->>'trustedEffectiveAt',
      'reason', 'A Price Group cannot become effective before its trusted operation time'
    );
    RETURN;
  END IF;

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
          AND price_group.canonical_meaning = v_canonical_meaning
          AND price_group.meaning_fingerprint = v_meaning_fingerprint
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
        WHERE definition.tenant_id = p_tenant_id
          AND definition.price_group_id = v_price_group_id
          AND definition.definition_revision_id = v_definition_revision_id
          AND definition.revision_number = 1
          AND definition.previous_definition_revision_id IS NULL
          AND definition.semantic_continuity_decision IS NULL
          AND definition.compared_definition_revision_id IS NULL
          AND definition.display_name = p_input->>'displayName'
          AND definition.description = p_input->>'description'
          AND definition.classification_purpose = p_input->>'classificationPurpose'
          AND definition.meaning_fingerprint = v_meaning_fingerprint
      )
      AND EXISTS (
        SELECT 1 FROM price_group_catalog.price_group_definition_effective_intervals AS interval
        WHERE interval.tenant_id = p_tenant_id
          AND interval.price_group_id = v_price_group_id
          AND interval.definition_revision_id = v_definition_revision_id
          AND interval.schedule_catalog_revision = v_existing.catalog_revision
          AND interval.effective_from = (p_input->>'effectiveFrom')::timestamptz
          AND interval.effective_to IS NULL
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
    ELSE
      RETURN QUERY SELECT jsonb_build_object('_tag', 'idempotency_conflict');
      RETURN;
    END IF;
  ELSE
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
      AND canonical_meaning = v_canonical_meaning;
    IF FOUND THEN
      RETURN QUERY SELECT jsonb_build_object(
        '_tag', 'semantic_identity_conflict',
        'existingPriceGroupId', v_existing_semantic_price_group_id,
        'existingMeaningFingerprint', v_existing_semantic_fingerprint,
        'requestedMeaningFingerprint', v_meaning_fingerprint
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
      price_group_id, tenant_id, business_code, canonical_meaning, meaning_fingerprint,
      active_from, current_definition_schedule_revision, created_at_catalog_revision,
      created_by_action_invocation_id, created_by_principal_id, creation_reason
    ) VALUES (
      v_price_group_id, p_tenant_id, p_input->>'businessCode', v_canonical_meaning, v_meaning_fingerprint,
      (p_input->>'effectiveFrom')::timestamptz, v_accepted, v_accepted,
      (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
    );
    INSERT INTO price_group_catalog.price_group_definition_revisions (
      definition_revision_id, tenant_id, price_group_id, revision_number,
      previous_definition_revision_id, compared_definition_revision_id, semantic_continuity_decision,
      display_name, description, classification_purpose, meaning_fingerprint,
      accepted_catalog_revision, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_definition_revision_id, p_tenant_id, v_price_group_id, 1, NULL, NULL, NULL,
      p_input->>'displayName', p_input->>'description', p_input->>'classificationPurpose',
      v_meaning_fingerprint, v_accepted, (p_input->>'actionInvocationId')::uuid,
      (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
    );
    INSERT INTO price_group_catalog.price_group_definition_effective_intervals (
      tenant_id, price_group_id, definition_revision_id, schedule_catalog_revision,
      effective_from, effective_to, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      p_tenant_id, v_price_group_id, v_definition_revision_id, v_accepted,
      (p_input->>'effectiveFrom')::timestamptz, NULL,
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
  END IF;

  INSERT INTO price_group_catalog.price_group_containment_projection_intents (
    tenant_id, price_group_id, definition_revision_id, definition_catalog_revision,
    source_action_invocation_id, operation, catalog_version, state, requested_at
  ) VALUES (
    p_tenant_id, v_price_group_id, v_definition_revision_id,
    (v_definition->>'acceptedCatalogRevision')::bigint,
    (p_input->>'actionInvocationId')::uuid, 'TOUCH_CONTAINMENT', '1', 'PENDING',
    (p_input->>'trustedEffectiveAt')::timestamptz
  ) ON CONFLICT (tenant_id, source_action_invocation_id) DO NOTHING;

  SELECT intent.* INTO v_intent
  FROM price_group_catalog.price_group_containment_projection_intents AS intent
  WHERE intent.tenant_id = p_tenant_id
    AND intent.source_action_invocation_id = (p_input->>'actionInvocationId')::uuid;
  IF NOT FOUND
    OR v_intent.price_group_id <> v_price_group_id
    OR v_intent.definition_revision_id <> v_definition_revision_id
    OR v_intent.definition_catalog_revision <> (v_definition->>'acceptedCatalogRevision')::bigint
  THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'idempotency_conflict');
    RETURN;
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    '_tag', CASE WHEN v_existing.tenant_id IS NULL THEN 'accepted' ELSE 'replayed' END,
    'definition', v_definition,
    'projection', jsonb_build_object(
      'mutationId', v_intent.mutation_id,
      'operation', 'touch_containment',
      'staged', true
    )
  );
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."create_definition_revision_with_continuity"(
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
CREATE OR REPLACE FUNCTION "price_group_catalog"."retire_price_group"(p_tenant_id uuid, p_input jsonb)
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
  v_selected_effective_from timestamptz;
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
          AND definition.meaning_fingerprint = p_input#>>'{expectedCurrent,meaningFingerprint}'
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
    ELSE
      RETURN QUERY SELECT jsonb_build_object('_tag', 'idempotency_conflict');
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
  SELECT interval.effective_from
    INTO v_selected_effective_from
  FROM price_group_catalog.price_group_definition_effective_intervals AS interval
  WHERE interval.tenant_id = p_tenant_id
    AND interval.price_group_id = v_price_group_id
    AND interval.schedule_catalog_revision = v_group_expected
    AND interval.definition_revision_id = v_definition_revision_id;
  IF (p_input->>'effectiveAt')::timestamptz <= v_selected_effective_from THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'retirement_effective_time_conflict',
      'effectiveAt', p_input->>'effectiveAt',
      'trustedEffectiveAt', p_input->>'trustedEffectiveAt',
      'reason', 'A Price Group retirement must be strictly after the selected definition effective start'
    );
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
    WHERE definition.tenant_id = p_tenant_id
      AND definition.price_group_id = v_price_group_id
      AND definition.definition_revision_id = v_definition_revision_id
      AND definition.revision_number = (p_input#>>'{expectedCurrent,definitionRevisionNumber}')::bigint
      AND definition.meaning_fingerprint = p_input#>>'{expectedCurrent,meaningFingerprint}'
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
  INSERT INTO price_group_catalog.price_group_definition_effective_intervals (
    tenant_id, price_group_id, definition_revision_id, schedule_catalog_revision,
    effective_from, effective_to, action_invocation_id, acting_principal_id, reason
  )
  SELECT interval.tenant_id, interval.price_group_id, interval.definition_revision_id, v_accepted,
    interval.effective_from,
    CASE WHEN interval.definition_revision_id = v_definition_revision_id
      THEN (p_input->>'effectiveAt')::timestamptz ELSE interval.effective_to END,
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid, p_input->>'reason'
  FROM price_group_catalog.price_group_definition_effective_intervals AS interval
  WHERE interval.tenant_id = p_tenant_id
    AND interval.price_group_id = v_price_group_id
    AND interval.schedule_catalog_revision = v_group_expected
    AND interval.effective_from < (p_input->>'effectiveAt')::timestamptz;
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
    retired_effective_at = (p_input->>'effectiveAt')::timestamptz,
    current_definition_schedule_revision = v_accepted
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
CREATE FUNCTION "price_group_catalog"."retirement_acceptance_json"(
  p_tenant_id uuid,
  p_price_group_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'acceptedCatalogRevision', retirement.accepted_catalog_revision,
    'currentDefinitionRevisionId', retirement.current_definition_revision_id,
    'currentDefinitionRevisionNumber', definition.revision_number,
    'priceGroupRef', jsonb_build_object(
      'moduleId', 'pricing.price-group-catalog', 'resourceId', retirement.price_group_id,
      'resourceType', 'pricing.price-group-catalog.price-group', 'tenantId', retirement.tenant_id
    ),
    'retirementEffectiveAt', to_char(retirement.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'retirementProvenance', jsonb_build_object(
      'actionInvocationId', retirement.action_invocation_id,
      'actorPrincipalId', retirement.acting_principal_id,
      'reason', retirement.reason,
      'trustedAt', to_char(ledger.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'trustedOperationAt', to_char(ledger.trusted_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'verifiedAt', to_char(retirement.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM price_group_catalog.price_group_retirements AS retirement
  INNER JOIN price_group_catalog.price_group_definition_revisions AS definition
    ON definition.tenant_id = retirement.tenant_id
   AND definition.price_group_id = retirement.price_group_id
   AND definition.definition_revision_id = retirement.current_definition_revision_id
  INNER JOIN price_group_catalog.price_group_catalog_ledger AS ledger
    ON ledger.tenant_id = retirement.tenant_id
   AND ledger.catalog_revision = retirement.accepted_catalog_revision
  WHERE retirement.tenant_id = p_tenant_id AND retirement.price_group_id = p_price_group_id
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."read_current_definition_with_retirement"(
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
  v_schedule bigint;
  v_candidates uuid[];
  v_definition jsonb;
  v_identity jsonb;
  v_retirement jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT * INTO v_group FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  v_schedule := v_group.current_definition_schedule_revision;
  IF v_group.retired_effective_at IS NOT NULL AND p_at >= v_group.retired_effective_at THEN
    SELECT array_agg(interval.definition_revision_id ORDER BY interval.definition_revision_id)
      INTO v_candidates
    FROM price_group_catalog.price_group_definition_effective_intervals AS interval
    WHERE interval.tenant_id = p_tenant_id AND interval.price_group_id = p_price_group_id
      AND interval.schedule_catalog_revision = v_schedule
      AND interval.effective_from < v_group.retired_effective_at
      AND interval.effective_to = v_group.retired_effective_at;
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
  SELECT jsonb_build_object(
    'businessCode', price_group.business_code,
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
  IF v_definition IS NULL OR v_identity IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(v_candidates[1])); RETURN;
  END IF;
  v_retirement := price_group_catalog.retirement_acceptance_json(p_tenant_id, p_price_group_id);
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'current', 'catalogRevision', v_schedule, 'definition', v_definition, 'identity', v_identity
  ) || CASE WHEN v_retirement IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('scheduledRetirement', v_retirement) END;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "price_group_catalog"."read_definition_revision_with_retirement"(
  p_tenant_id uuid, p_price_group_id uuid, p_definition_revision_id uuid, p_at timestamptz
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group price_group_catalog.price_groups%ROWTYPE;
  v_definition jsonb;
  v_identity jsonb;
  v_retirement jsonb;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT * INTO v_group FROM price_group_catalog.price_groups
  WHERE tenant_id = p_tenant_id AND price_group_id = p_price_group_id;
  IF NOT FOUND THEN RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM price_group_catalog.price_group_definition_revisions AS definition
    WHERE definition.tenant_id = p_tenant_id AND definition.price_group_id = p_price_group_id
      AND definition.definition_revision_id = p_definition_revision_id) THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'not_found'); RETURN;
  END IF;
  v_definition := price_group_catalog.definition_json(
    p_tenant_id, p_price_group_id, p_definition_revision_id, v_group.current_definition_schedule_revision
  );
  SELECT jsonb_build_object(
    'businessCode', price_group.business_code,
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
  IF v_definition IS NULL OR v_identity IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('_tag', 'currentness_failure',
      'reason', 'UNVERIFIABLE_CURRENTNESS',
      'candidateDefinitionRevisionIds', jsonb_build_array(p_definition_revision_id)); RETURN;
  END IF;
  v_retirement := price_group_catalog.retirement_acceptance_json(p_tenant_id, p_price_group_id);
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'found', 'definition', v_definition, 'identity', v_identity
  ) || CASE WHEN v_retirement IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('scheduledRetirement', v_retirement) END;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."create_price_group_with_complete_schedule"(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."canonical_price_group_meaning"(text) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."price_group_meaning_fingerprint"(text) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."create_definition_revision_with_continuity"(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."retirement_acceptance_json"(uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."read_current_definition_with_retirement"(uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "price_group_catalog"."read_definition_revision_with_retirement"(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "price_group_catalog"."create_price_group_with_containment_projection"(uuid, jsonb) FROM "ontos_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "price_group_catalog"."create_definition_revision"(uuid, jsonb) FROM "ontos_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "price_group_catalog"."read_current_definition"(uuid, uuid, timestamptz) FROM "ontos_runtime";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "price_group_catalog"."read_definition_revision"(uuid, uuid, uuid, timestamptz) FROM "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."create_price_group_with_complete_schedule"(uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."create_definition_revision_with_continuity"(uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."read_current_definition_with_retirement"(uuid, uuid, timestamptz) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "price_group_catalog"."read_definition_revision_with_retirement"(uuid, uuid, uuid, timestamptz) TO "ontos_runtime";
