CREATE OR REPLACE FUNCTION "inventory"."find_reservation_confirmation_by_ref_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_confirmation_id uuid
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation Confirmation worker scope mismatch';
  END IF;

  RETURN QUERY
  SELECT confirmation.snapshot
  FROM "inventory"."reservation_confirmations" AS confirmation
  INNER JOIN "inventory"."reservation_create_effects" AS create_effect
    ON create_effect.tenant_id = confirmation.tenant_id
    AND create_effect.reservation_id = confirmation.reservation_id
    AND create_effect.attempt_id = confirmation.attempt_id
    AND create_effect.state = 'ESTABLISHED'
  WHERE confirmation.tenant_id = p_tenant_id
    AND confirmation.confirmation_id = p_confirmation_id
    AND create_effect.legal_entity_id = p_legal_entity_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."find_reservation_confirmation_by_attempt_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_reservation_id uuid,
  p_attempt_id text
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation Confirmation worker scope mismatch';
  END IF;

  RETURN QUERY
  SELECT confirmation.snapshot
  FROM "inventory"."reservation_confirmations" AS confirmation
  INNER JOIN "inventory"."reservation_create_effects" AS create_effect
    ON create_effect.tenant_id = confirmation.tenant_id
    AND create_effect.reservation_id = confirmation.reservation_id
    AND create_effect.attempt_id = confirmation.attempt_id
    AND create_effect.state = 'ESTABLISHED'
  WHERE confirmation.tenant_id = p_tenant_id
    AND confirmation.reservation_id = p_reservation_id
    AND confirmation.attempt_id = p_attempt_id
    AND create_effect.legal_entity_id = p_legal_entity_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."create_or_read_reservation_confirmation_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_candidate jsonb
) RETURNS TABLE(record jsonb, outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_binding "inventory"."catalog_to_stock_bindings"%ROWTYPE;
  current_effect "inventory"."reservation_create_effects"%ROWTYPE;
  requirement jsonb;
  stored_record jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_candidate #>> '{ref,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_candidate #>> '{reservation,ref,tenantId}' IS DISTINCT FROM p_tenant_id::text
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation Confirmation worker scope mismatch';
  END IF;

  SELECT create_effect.*
  INTO current_effect
  FROM "inventory"."reservation_create_effects" AS create_effect
  WHERE create_effect.tenant_id = p_tenant_id
    AND create_effect.legal_entity_id = p_legal_entity_id
    AND create_effect.reservation_id = (p_candidate #>> '{reservation,ref,resourceId}')::uuid
    AND create_effect.attempt_id = p_candidate #>> '{reservation,origin,attemptId}'
    AND create_effect.state = 'ESTABLISHED'
  FOR UPDATE;

  IF NOT FOUND OR current_effect.record_json -> 'reservation' IS DISTINCT FROM p_candidate -> 'reservation' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_confirmations_exact_reservation_ck',
      MESSAGE = 'Reservation Confirmation worker input must match one established Reservation create effect';
  END IF;

  SELECT confirmation.snapshot
  INTO stored_record
  FROM "inventory"."reservation_confirmations" AS confirmation
  WHERE confirmation.tenant_id = p_tenant_id
    AND (
      confirmation.confirmation_id = (p_candidate #>> '{ref,resourceId}')::uuid
      OR (
        confirmation.reservation_id = (p_candidate #>> '{reservation,ref,resourceId}')::uuid
        AND confirmation.attempt_id = p_candidate #>> '{reservation,origin,attemptId}'
      )
      OR confirmation.authority_effect_id = p_candidate #>> '{authorityEvidence,effectId}'
    )
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF ((stored_record - 'health') - 'revision')
      IS DISTINCT FROM ((p_candidate - 'health') - 'revision')
    THEN
      IF stored_record #>> '{ref,resourceId}'
          IS DISTINCT FROM p_candidate #>> '{ref,resourceId}'
        AND stored_record #>> '{reservation,ref,resourceId}'
          IS NOT DISTINCT FROM p_candidate #>> '{reservation,ref,resourceId}'
        AND stored_record #>> '{reservation,origin,attemptId}'
          IS NOT DISTINCT FROM p_candidate #>> '{reservation,origin,attemptId}'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          CONSTRAINT = 'inventory_reservation_confirmations_reservation_attempt_uk',
          MESSAGE = 'Reservation Confirmation Attempt already has a different Confirmation';
      END IF;

      RAISE EXCEPTION USING
        ERRCODE = '23505',
        CONSTRAINT = 'inventory_reservation_confirmations_scope_id_uk',
        MESSAGE = 'Reservation Confirmation identity already belongs to different proof';
    END IF;

    RETURN QUERY SELECT stored_record, 'EXISTING'::text;
    RETURN;
  END IF;

  FOR requirement IN
    SELECT expected.entry
    FROM pg_catalog.jsonb_array_elements(p_candidate #> '{reservation,requirements}') AS expected(entry)
    ORDER BY expected.entry #>> '{exactSelectionMeaning,kind}', expected.entry #>> '{exactSelectionMeaning,id}'
  LOOP
    SELECT binding.*
    INTO current_binding
    FROM "inventory"."catalog_to_stock_bindings" AS binding
    WHERE binding.tenant_id = p_tenant_id
      AND binding.exact_selection_kind = requirement #>> '{exactSelectionMeaning,kind}'
      AND binding.exact_selection_meaning_id = requirement #>> '{exactSelectionMeaning,id}'
    FOR UPDATE;

    IF NOT FOUND
      OR current_binding.binding_id::text IS DISTINCT FROM requirement #>> '{bindingRef,resourceId}'
      OR current_binding.stock_item_id::text IS DISTINCT FROM requirement #>> '{stockItem,stockItemRef,resourceId}'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_confirmations_exact_reservation_ck',
        MESSAGE = 'Reservation Confirmation cannot issue against a corrected Catalog-to-Stock Binding';
    END IF;
  END LOOP;

  INSERT INTO "inventory"."reservation_confirmations" (
    confirmation_id,
    tenant_id,
    reservation_id,
    attempt_id,
    owner_configuration_id,
    issuer_backend_kind,
    issuer_backend_id,
    authority_effect_id,
    owner_evidence_ref,
    issued_at,
    expires_at,
    current_health_state,
    current_revision,
    snapshot,
    updated_at
  ) VALUES (
    (p_candidate #>> '{ref,resourceId}')::uuid,
    p_tenant_id,
    (p_candidate #>> '{reservation,ref,resourceId}')::uuid,
    p_candidate #>> '{reservation,origin,attemptId}',
    (p_candidate #>> '{reservation,authority,configurationId}')::uuid,
    p_candidate #>> '{authorityEvidence,issuer,backend}',
    p_candidate #>> '{authorityEvidence,issuer,backendId}',
    p_candidate #>> '{authorityEvidence,effectId}',
    p_candidate #>> '{issuanceRank,ownerEvidenceRef}',
    (p_candidate ->> 'issuedAt')::timestamptz,
    (p_candidate ->> 'expiresAt')::timestamptz,
    p_candidate #>> '{health,state}',
    (p_candidate ->> 'revision')::integer,
    p_candidate,
    (p_candidate #>> '{health,observation,effectiveAt}')::timestamptz
  )
  ON CONFLICT DO NOTHING
  RETURNING snapshot INTO stored_record;

  IF stored_record IS NOT NULL THEN
    INSERT INTO "inventory"."reservation_confirmation_history" (
      tenant_id,
      confirmation_id,
      revision,
      health_state,
      snapshot,
      transitioned_at
    ) VALUES (
      p_tenant_id,
      (stored_record #>> '{ref,resourceId}')::uuid,
      (stored_record ->> 'revision')::integer,
      stored_record #>> '{health,state}',
      stored_record,
      (stored_record #>> '{health,observation,effectiveAt}')::timestamptz
    );
    RETURN QUERY SELECT stored_record, 'INSERTED'::text;
    RETURN;
  END IF;

  SELECT confirmation.snapshot
  INTO stored_record
  FROM "inventory"."reservation_confirmations" AS confirmation
  WHERE confirmation.tenant_id = p_tenant_id
    AND (
      confirmation.confirmation_id = (p_candidate #>> '{ref,resourceId}')::uuid
      OR (
        confirmation.reservation_id = (p_candidate #>> '{reservation,ref,resourceId}')::uuid
        AND confirmation.attempt_id = p_candidate #>> '{reservation,origin,attemptId}'
      )
      OR confirmation.authority_effect_id = p_candidate #>> '{authorityEvidence,effectId}'
    )
  LIMIT 1;

  IF stored_record IS NOT NULL THEN
    IF ((stored_record - 'health') - 'revision')
      IS DISTINCT FROM ((p_candidate - 'health') - 'revision')
    THEN
      IF stored_record #>> '{ref,resourceId}'
          IS DISTINCT FROM p_candidate #>> '{ref,resourceId}'
        AND stored_record #>> '{reservation,ref,resourceId}'
          IS NOT DISTINCT FROM p_candidate #>> '{reservation,ref,resourceId}'
        AND stored_record #>> '{reservation,origin,attemptId}'
          IS NOT DISTINCT FROM p_candidate #>> '{reservation,origin,attemptId}'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          CONSTRAINT = 'inventory_reservation_confirmations_reservation_attempt_uk',
          MESSAGE = 'Reservation Confirmation Attempt already has a different Confirmation';
      END IF;

      RAISE EXCEPTION USING
        ERRCODE = '23505',
        CONSTRAINT = 'inventory_reservation_confirmations_scope_id_uk',
        MESSAGE = 'Reservation Confirmation identity already belongs to different proof';
    END IF;

    RETURN QUERY SELECT stored_record, 'EXISTING'::text;
    RETURN;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '40001',
    MESSAGE = 'Reservation Confirmation create-or-read could not resolve the concurrent write';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."read_reservation_confirmation_history_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_confirmation_id uuid
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation Confirmation worker scope mismatch';
  END IF;

  RETURN QUERY
  SELECT history.snapshot
  FROM "inventory"."reservation_confirmation_history" AS history
  INNER JOIN "inventory"."reservation_confirmations" AS confirmation
    ON confirmation.tenant_id = history.tenant_id
    AND confirmation.confirmation_id = history.confirmation_id
  INNER JOIN "inventory"."reservation_create_effects" AS create_effect
    ON create_effect.tenant_id = confirmation.tenant_id
    AND create_effect.reservation_id = confirmation.reservation_id
    AND create_effect.attempt_id = confirmation.attempt_id
    AND create_effect.state = 'ESTABLISHED'
  WHERE history.tenant_id = p_tenant_id
    AND history.confirmation_id = p_confirmation_id
    AND create_effect.legal_entity_id = p_legal_entity_id
  ORDER BY history.revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."save_reservation_confirmation_revision_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_current jsonb,
  p_next jsonb
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  stored_record jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_current #>> '{ref,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_next #>> '{ref,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR NOT EXISTS (
      SELECT 1
      FROM "inventory"."reservation_create_effects" AS create_effect
      WHERE create_effect.tenant_id = p_tenant_id
        AND create_effect.legal_entity_id = p_legal_entity_id
        AND create_effect.reservation_id = (p_current #>> '{reservation,ref,resourceId}')::uuid
        AND create_effect.attempt_id = p_current #>> '{reservation,origin,attemptId}'
        AND create_effect.state = 'ESTABLISHED'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation Confirmation worker scope mismatch';
  END IF;

  UPDATE "inventory"."reservation_confirmations" AS confirmation
  SET current_health_state = p_next #>> '{health,state}',
    current_revision = (p_next ->> 'revision')::integer,
    snapshot = p_next,
    updated_at = (p_next #>> '{health,observation,effectiveAt}')::timestamptz
  WHERE confirmation.tenant_id = p_tenant_id
    AND confirmation.confirmation_id = (p_current #>> '{ref,resourceId}')::uuid
    AND confirmation.current_revision = (p_current ->> 'revision')::integer
  RETURNING confirmation.snapshot INTO stored_record;

  IF stored_record IS NOT NULL THEN
    INSERT INTO "inventory"."reservation_confirmation_history" (
      tenant_id,
      confirmation_id,
      revision,
      health_state,
      snapshot,
      transitioned_at
    ) VALUES (
      p_tenant_id,
      (stored_record #>> '{ref,resourceId}')::uuid,
      (stored_record ->> 'revision')::integer,
      stored_record #>> '{health,state}',
      stored_record,
      (stored_record #>> '{health,observation,effectiveAt}')::timestamptz
    );
    RETURN QUERY SELECT stored_record;
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."find_reservation_confirmation_by_ref_for_worker"(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "inventory"."find_reservation_confirmation_by_attempt_for_worker"(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "inventory"."create_or_read_reservation_confirmation_for_worker"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "inventory"."read_reservation_confirmation_history_for_worker"(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "inventory"."save_reservation_confirmation_revision_for_worker"(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "inventory"."find_reservation_confirmation_by_ref_for_worker"(uuid, uuid, uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "inventory"."find_reservation_confirmation_by_attempt_for_worker"(uuid, uuid, uuid, text) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "inventory"."create_or_read_reservation_confirmation_for_worker"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "inventory"."read_reservation_confirmation_history_for_worker"(uuid, uuid, uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "inventory"."save_reservation_confirmation_revision_for_worker"(uuid, uuid, jsonb, jsonb) TO "ontos_runtime";
