-- No historical receipt or proof is reclassified. Old rows remain PERSON.
CREATE FUNCTION commerce_customer_context.project_organization_membership_result(p_result jsonb, p_reason_code text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'processingKind', 'ORG_BUSINESS_REFERENCE',
    'reasonCode', p_reason_code,
    'source', jsonb_build_object(
      'assertionId', p_result #> '{source,assertionId}',
      'effectId', p_result #> '{source,effectId}',
      'order', p_result #> '{source,order}',
      'sourceRecordId', p_result #> '{source,sourceRecordId}'
    ),
    'items', COALESCE((
      SELECT jsonb_agg(
        CASE WHEN item->>'outcome' IN ('ASSIGNED', 'ENDED') THEN jsonb_build_object(
          'outcome', item->'outcome',
          'membership', jsonb_build_object(
            'assignedAt', item #> '{membership,assignedAt}',
            'effectiveFrom', item #> '{membership,effectiveFrom}',
            'effectiveTo', item #> '{membership,effectiveTo}',
            'groupRef', item #> '{membership,groupRef}',
            'membershipRef', item #> '{membership,membershipRef}',
            'profile', item #> '{membership,profile}',
            'revision', item #> '{membership,revision}',
            'state', item #> '{membership,state}',
            'removal', CASE WHEN item #> '{membership,removal}' IS NULL
              OR item #> '{membership,removal}' = 'null'::jsonb THEN 'null'::jsonb
              ELSE jsonb_build_object(
                'effectiveAt', item #> '{membership,removal,effectiveAt}',
                'kind', item #> '{membership,removal,kind}',
                'recordedAt', item #> '{membership,removal,recordedAt}'
              ) END
          )
        ) ELSE jsonb_build_object(
          'groupRef', COALESCE(item->'groupRef', item #> '{membership,groupRef}'),
          'outcome', item->'outcome'
        ) END ORDER BY position
      )
      FROM jsonb_array_elements(p_result->'items') WITH ORDINALITY AS entry(item, position)
    ), '[]'::jsonb)
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.project_organization_membership_result(jsonb, text)
  FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.classify_membership_source_receipt()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_kind text := current_setting('ontos.ccc_membership_processing_kind', true);
  v_code text := current_setting('ontos.ccc_membership_reason_code', true);
BEGIN
  -- Only the public wrappers below set this mode immediately around native admission.
  -- Both PUBLIC and runtime have no direct INSERT privilege on this owner ledger.
  IF v_kind = 'ORG_BUSINESS_REFERENCE' THEN
    IF v_code IS NULL OR v_code NOT IN ('SOURCE_MEMBERSHIP_ASSERTED', 'SOURCE_MEMBERSHIP_WITHDRAWN',
      'SOURCE_COMPLETE_SET_RECONCILED', 'SOURCE_PARTIAL_SET_ASSERTED') THEN
      RAISE EXCEPTION 'Organization membership reason code is required' USING ERRCODE = '23514';
    END IF;
    NEW.processing_kind := 'ORG_BUSINESS_REFERENCE';
    NEW.result := commerce_customer_context.project_organization_membership_result(NEW.result, v_code);
  ELSE
    NEW.processing_kind := 'PERSON';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.classify_membership_source_receipt() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER a_ccc_membership_source_receipt_processing
BEFORE INSERT ON commerce_customer_context.customer_group_membership_source_receipts
FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.classify_membership_source_receipt();
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.classify_membership_snapshot_proof()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.processing_kind := CASE
    WHEN current_setting('ontos.ccc_membership_processing_kind', true) = 'ORG_BUSINESS_REFERENCE'
    THEN 'ORG_BUSINESS_REFERENCE' ELSE 'PERSON' END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.classify_membership_snapshot_proof() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER ccc_membership_snapshot_proof_processing
BEFORE INSERT ON commerce_customer_context.customer_group_membership_snapshot_proofs
FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.classify_membership_snapshot_proof();
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  RENAME TO apply_membership_source_classified_internal;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_membership_source_classified_internal(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.apply_customer_group_membership_source(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid,
  p_invocation_id uuid, p_recorded_at timestamptz, p_payload jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_prior_kind text := current_setting('ontos.ccc_membership_processing_kind', true);
  v_prior_code text := current_setting('ontos.ccc_membership_reason_code', true);
  v_kind text := CASE WHEN p_payload->>'processingKind' = 'ORG_BUSINESS_REFERENCE'
    THEN 'ORG_BUSINESS_REFERENCE' ELSE 'PERSON' END;
  v_code text;
  v_payload jsonb := p_payload;
  v_outcome text;
  v_result jsonb;
  v_receipt_kind text;
BEGIN
  -- Caller-controlled session settings can never choose the native processing class.
  PERFORM set_config('ontos.ccc_membership_processing_kind', v_kind, true);
  PERFORM set_config('ontos.ccc_membership_reason_code', '', true);
  IF v_kind = 'ORG_BUSINESS_REFERENCE' THEN
    v_code := CASE p_payload->>'operation'
      WHEN 'ASSIGN' THEN 'SOURCE_MEMBERSHIP_ASSERTED'
      WHEN 'REMOVE' THEN 'SOURCE_MEMBERSHIP_WITHDRAWN'
      WHEN 'COMPLETE' THEN 'SOURCE_COMPLETE_SET_RECONCILED'
      WHEN 'PARTIAL' THEN 'SOURCE_PARTIAL_SET_ASSERTED' END;
    IF p_payload #>> '{profile,profileKind}' IS DISTINCT FROM 'COUNTERPARTY'
      OR p_payload ? 'reason' OR v_code IS NULL OR p_payload->>'reasonCode' IS DISTINCT FROM v_code THEN
      v_outcome := 'SOURCE_CONFLICT';
      v_result := NULL;
    ELSE
      PERFORM set_config('ontos.ccc_membership_reason_code', v_code, true);
      -- The native ledger receives the explicit finite code, never an inferred business reason.
      v_payload := p_payload || jsonb_build_object('reason', v_code);
      SELECT admitted.outcome, admitted.result INTO v_outcome, v_result
      FROM commerce_customer_context.apply_membership_source_classified_internal(
        p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, v_payload
      ) AS admitted;
    END IF;
  ELSIF p_payload ? 'processingKind' OR p_payload ? 'reasonCode' THEN
    v_outcome := 'SOURCE_CONFLICT';
    v_result := NULL;
  ELSE
    SELECT admitted.outcome, admitted.result INTO v_outcome, v_result
      FROM commerce_customer_context.apply_membership_source_classified_internal(
      p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, v_payload
    ) AS admitted;
  END IF;
  IF v_outcome IN ('APPLIED', 'REPLAY') THEN
    SELECT receipt.processing_kind INTO v_receipt_kind
    FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
    WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
      AND receipt.customer_profile_id = (p_payload #>> '{profile,profileRef,resourceId}')::uuid
      AND receipt.issuer = p_payload #>> '{manager,issuer}'
      AND receipt.source_namespace = p_payload #>> '{manager,sourceNamespace}'
      AND receipt.effect_id = p_payload #>> '{source,effectId}';
    IF v_receipt_kind IS DISTINCT FROM v_kind THEN
      v_outcome := 'SOURCE_CONFLICT';
      v_result := NULL;
    END IF;
  END IF;
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RETURN QUERY SELECT v_outcome, CASE WHEN v_kind = 'ORG_BUSINESS_REFERENCE'
    AND v_outcome IN ('APPLIED', 'REPLAY') THEN
      commerce_customer_context.project_organization_membership_result(v_result, v_code)
    ELSE v_result END;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RAISE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb) TO ontos_runtime;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.admit_customer_group_membership_snapshot(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  RENAME TO admit_membership_snapshot_classified_internal;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.admit_membership_snapshot_classified_internal(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.admit_customer_group_membership_snapshot(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid,
  p_invocation_id uuid, p_recorded_at timestamptz, p_payload jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_prior_kind text := current_setting('ontos.ccc_membership_processing_kind', true);
  v_prior_code text := current_setting('ontos.ccc_membership_reason_code', true);
  v_snapshot jsonb := p_payload->'snapshot';
  v_kind text := CASE WHEN v_snapshot->>'processingKind' = 'ORG_BUSINESS_REFERENCE'
    THEN 'ORG_BUSINESS_REFERENCE' ELSE 'PERSON' END;
  v_payload jsonb := p_payload;
  v_outcome text;
  v_result jsonb;
  v_proof_kind text;
BEGIN
  PERFORM set_config('ontos.ccc_membership_processing_kind', v_kind, true);
  PERFORM set_config('ontos.ccc_membership_reason_code', '', true);
  IF v_kind = 'ORG_BUSINESS_REFERENCE' THEN
    IF v_snapshot #>> '{profile,profileKind}' IS DISTINCT FROM 'COUNTERPARTY'
      OR v_snapshot ? 'reason' OR v_snapshot->>'operation' IS DISTINCT FROM 'COMPLETE'
      OR v_snapshot->>'reasonCode' IS DISTINCT FROM 'SOURCE_COMPLETE_SET_RECONCILED' THEN
      v_outcome := 'SOURCE_CONFLICT';
    ELSE
      PERFORM set_config('ontos.ccc_membership_reason_code', 'SOURCE_COMPLETE_SET_RECONCILED', true);
      v_payload := jsonb_set(p_payload, '{snapshot}', v_snapshot ||
        jsonb_build_object('reason', 'SOURCE_COMPLETE_SET_RECONCILED'));
      SELECT admitted.outcome, admitted.result INTO v_outcome, v_result
      FROM commerce_customer_context.admit_membership_snapshot_classified_internal(
        p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, v_payload
      ) AS admitted;
    END IF;
  ELSIF v_snapshot ? 'processingKind' OR v_snapshot ? 'reasonCode' THEN
    v_outcome := 'SOURCE_CONFLICT';
  ELSE
    SELECT admitted.outcome, admitted.result INTO v_outcome, v_result
    FROM commerce_customer_context.admit_membership_snapshot_classified_internal(
      p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, v_payload
    ) AS admitted;
  END IF;
  IF v_outcome IN ('APPLIED', 'REPLAY') THEN
    SELECT proof.processing_kind INTO v_proof_kind
    FROM commerce_customer_context.customer_group_membership_snapshot_proofs AS proof
    WHERE proof.tenant_id = p_tenant_id AND proof.legal_entity_id = p_legal_entity_id
      AND proof.proof_ref = v_snapshot->>'completenessProofRef';
    IF v_proof_kind IS DISTINCT FROM v_kind THEN
      v_outcome := 'SOURCE_CONFLICT';
      v_result := NULL;
    END IF;
  END IF;
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RETURN QUERY SELECT v_outcome, v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RAISE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.admit_customer_group_membership_snapshot(uuid, uuid, uuid, uuid, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.admit_customer_group_membership_snapshot(uuid, uuid, uuid, uuid, timestamptz, jsonb) TO ontos_runtime;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid, uuid, uuid, jsonb)
  RENAME TO read_membership_source_receipt_classified_internal;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_membership_source_receipt_classified_internal(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid, p_query jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_prior_kind text := current_setting('ontos.ccc_membership_processing_kind', true);
  v_prior_code text := current_setting('ontos.ccc_membership_reason_code', true);
  v_kind text := CASE WHEN p_query->>'processingKind' = 'ORG_BUSINESS_REFERENCE'
    THEN 'ORG_BUSINESS_REFERENCE' ELSE 'PERSON' END;
  v_outcome text;
  v_result jsonb;
  v_receipt_kind text;
BEGIN
  PERFORM set_config('ontos.ccc_membership_processing_kind', v_kind, true);
  PERFORM set_config('ontos.ccc_membership_reason_code', '', true);
  IF (v_kind = 'ORG_BUSINESS_REFERENCE' AND
      p_query #>> '{profile,profileKind}' IS DISTINCT FROM 'COUNTERPARTY')
    OR (v_kind = 'PERSON' AND p_query ? 'processingKind') THEN
    v_outcome := 'SOURCE_AUTHORITY_DENIED';
  ELSE
    SELECT recovered.outcome, recovered.result INTO v_outcome, v_result
    FROM commerce_customer_context.read_membership_source_receipt_classified_internal(
      p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_query
    ) AS recovered;
  END IF;
  IF v_outcome = 'FOUND' THEN
    SELECT receipt.processing_kind INTO v_receipt_kind
    FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
    WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
      AND receipt.customer_profile_id = (p_query #>> '{profile,profileRef,resourceId}')::uuid
      AND receipt.issuer = p_query #>> '{manager,issuer}'
      AND receipt.source_namespace = p_query #>> '{manager,sourceNamespace}'
      AND receipt.effect_id = p_query->>'effectId';
    IF v_receipt_kind IS DISTINCT FROM v_kind THEN
      v_outcome := 'SOURCE_AUTHORITY_DENIED';
      v_result := NULL;
    ELSIF v_kind = 'ORG_BUSINESS_REFERENCE' THEN
      IF v_result->>'processingKind' IS DISTINCT FROM 'ORG_BUSINESS_REFERENCE'
        OR v_result->>'reasonCode' IS NULL OR v_result->>'reasonCode' NOT IN (
          'SOURCE_MEMBERSHIP_ASSERTED', 'SOURCE_MEMBERSHIP_WITHDRAWN',
          'SOURCE_COMPLETE_SET_RECONCILED', 'SOURCE_PARTIAL_SET_ASSERTED') THEN
        v_outcome := 'SOURCE_AUTHORITY_DENIED';
        v_result := NULL;
      ELSE
        v_result := commerce_customer_context.project_organization_membership_result(v_result, v_result->>'reasonCode');
      END IF;
    END IF;
  END IF;
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RETURN QUERY SELECT v_outcome, v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RAISE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid, uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid, uuid, uuid, jsonb) TO ontos_runtime;
