-- #797: retain the exact result returned by each successful Price/Fee Action.
-- The older fact receipts do not retain the original CREATED/REUSED or
-- REVISED/UNCHANGED distinction, so they cannot serve as result lookup proof.
CREATE TABLE pricing.price_fee_action_invocation_claims (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  action_invocation_id uuid NOT NULL,
  acting_principal_id uuid NOT NULL,
  action_kind text NOT NULL,
  canonical_request_payload jsonb NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_price_fee_action_claims_pk PRIMARY KEY (tenant_id, action_invocation_id),
  CONSTRAINT pricing_price_fee_action_claims_scope_uk
    UNIQUE (tenant_id, legal_entity_id, action_invocation_id),
  CONSTRAINT pricing_price_fee_action_claims_kind_ck CHECK (action_kind IN
    ('DEFINE_PRICE', 'REVISE_PRICE', 'DEFINE_COMMERCIAL_FEE',
     'REVISE_COMMERCIAL_FEE', 'MANAGE_COMMERCIAL_FEE_REVISION')),
  CONSTRAINT pricing_price_fee_action_claims_payload_ck
    CHECK (jsonb_typeof(canonical_request_payload) = 'object')
);

ALTER TABLE pricing.price_fee_action_invocation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_fee_action_invocation_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_price_fee_action_claims_scope_select
  ON pricing.price_fee_action_invocation_claims FOR SELECT TO
    ontos_runtime, pricing_management_routine_writer
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
CREATE POLICY pricing_price_fee_action_claims_scope_insert
  ON pricing.price_fee_action_invocation_claims FOR INSERT TO pricing_management_routine_writer
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
CREATE POLICY pricing_price_fee_action_claims_scope_update
  ON pricing.price_fee_action_invocation_claims FOR UPDATE TO pricing_management_routine_writer
  USING (false) WITH CHECK (false);
CREATE POLICY pricing_price_fee_action_claims_scope_delete
  ON pricing.price_fee_action_invocation_claims FOR DELETE TO pricing_management_routine_writer
  USING (false);

CREATE TABLE pricing.price_fee_action_result_receipts (
  price_fee_action_result_receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  action_invocation_id uuid NOT NULL,
  acting_principal_id uuid NOT NULL,
  action_kind text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_price_fee_action_results_invocation_uk
    UNIQUE (tenant_id, action_invocation_id),
  CONSTRAINT pricing_price_fee_action_results_claim_fk
    FOREIGN KEY (tenant_id, legal_entity_id, action_invocation_id)
    REFERENCES pricing.price_fee_action_invocation_claims
      (tenant_id, legal_entity_id, action_invocation_id) ON DELETE RESTRICT,
  CONSTRAINT pricing_price_fee_action_results_kind_ck CHECK (action_kind IN
    ('DEFINE_PRICE', 'REVISE_PRICE', 'DEFINE_COMMERCIAL_FEE',
     'REVISE_COMMERCIAL_FEE', 'MANAGE_COMMERCIAL_FEE_REVISION')),
  CONSTRAINT pricing_price_fee_action_results_payload_ck
    CHECK (jsonb_typeof(request_payload) = 'object' AND jsonb_typeof(result_payload) = 'object'),
  CONSTRAINT pricing_price_fee_action_results_outcome_ck CHECK (CASE
    WHEN action_kind = 'DEFINE_PRICE' THEN result_payload ->> 'outcome' IN ('CREATED', 'REUSED')
    WHEN action_kind = 'REVISE_PRICE' THEN result_payload ->> 'outcome' IN ('REVISED', 'UNCHANGED')
    WHEN action_kind = 'DEFINE_COMMERCIAL_FEE' THEN result_payload ->> 'outcome' IN
      ('COMMERCIAL_FEE_CREATED', 'COMMERCIAL_FEE_REUSED')
    ELSE result_payload ->> 'outcome' IN ('COMMERCIAL_FEE_REVISED', 'COMMERCIAL_FEE_UNCHANGED')
  END)
);

ALTER TABLE pricing.price_fee_action_result_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_fee_action_result_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_price_fee_action_results_scope_select
  ON pricing.price_fee_action_result_receipts FOR SELECT TO
    ontos_runtime, pricing_management_routine_writer
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
CREATE POLICY pricing_price_fee_action_results_scope_insert
  ON pricing.price_fee_action_result_receipts FOR INSERT TO pricing_management_routine_writer
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
CREATE POLICY pricing_price_fee_action_results_scope_update
  ON pricing.price_fee_action_result_receipts FOR UPDATE TO pricing_management_routine_writer
  USING (false) WITH CHECK (false);
CREATE POLICY pricing_price_fee_action_results_scope_delete
  ON pricing.price_fee_action_result_receipts FOR DELETE TO pricing_management_routine_writer
  USING (false);
REVOKE INSERT, UPDATE, DELETE ON TABLE pricing.price_fee_action_invocation_claims,
  pricing.price_fee_action_result_receipts FROM ontos_runtime;
GRANT SELECT ON TABLE pricing.price_fee_action_invocation_claims,
  pricing.price_fee_action_result_receipts TO ontos_runtime;

-- Move the pre-result implementations behind journaled compatibility names.
-- Existing callers keep their deployed signatures below; all known public
-- signatures now enter the same Tenant-wide invocation claim and exact receipt.
ALTER FUNCTION pricing.define_price_v2(uuid, uuid, jsonb)
  RENAME TO define_price_unwrapped_v2;
ALTER FUNCTION pricing.revise_price_v2(uuid, uuid, jsonb)
  RENAME TO revise_price_unwrapped_v2;
ALTER FUNCTION pricing.define_commercial_fee_v1(uuid, uuid, jsonb)
  RENAME TO define_commercial_fee_unwrapped_v1;
ALTER FUNCTION pricing.revise_commercial_fee_v1(uuid, uuid, jsonb)
  RENAME TO revise_commercial_fee_unwrapped_v1;
ALTER FUNCTION pricing.manage_commercial_fee_revision_v1(uuid, uuid, jsonb)
  RENAME TO manage_commercial_fee_revision_unwrapped_v1;

CREATE FUNCTION pricing.execute_price_fee_action_with_result_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb, p_action_kind text
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_receipt record;
  v_result jsonb;
  v_legacy_exists boolean;
  v_existing_claim boolean := false;
  v_claimed integer := 0;
  v_canonical_input jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing result scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_input) <> 'object'
    OR p_action_kind NOT IN ('DEFINE_PRICE', 'REVISE_PRICE', 'DEFINE_COMMERCIAL_FEE',
      'REVISE_COMMERCIAL_FEE', 'MANAGE_COMMERCIAL_FEE_REVISION')
  THEN
    RAISE EXCEPTION 'Pricing result input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing result invocation is invalid' USING ERRCODE = '22023';
  END;
  IF v_invocation_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Pricing result invocation or principal is missing' USING ERRCODE = '22023';
  END IF;
  -- Correlation and trusted clock identify this transport attempt. An
  -- acknowledgement is owner-issued evidence submitted on a later attempt for
  -- the same business command. None are part of the immutable command claim;
  -- effectiveFrom/effectiveTo carry business effectivity.
  v_canonical_input := p_input - 'requestCorrelationId' - 'trustedOperationAt' - 'acknowledgement';

  -- Serialize every Price/Fee Action using the same invocation, across intents.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text || ':pricing-action-result:' || v_invocation_id::text, 0)
  );
  SELECT receipt.* INTO v_receipt
    FROM pricing.price_fee_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.action_invocation_id = v_invocation_id;
  IF FOUND THEN
    IF v_receipt.action_kind = p_action_kind AND v_receipt.request_payload = v_canonical_input THEN
      RETURN QUERY SELECT v_receipt.result_payload;
    ELSIF p_action_kind IN ('DEFINE_PRICE', 'REVISE_PRICE') THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'outcome', 'CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT');
    ELSE
      IF jsonb_typeof(p_input -> 'identityKey') <> 'object' THEN
        RAISE EXCEPTION 'Pricing Commercial Fee identity is invalid' USING ERRCODE = '22023';
      END IF;
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'identityKey', p_input -> 'identityKey',
        'outcome', 'COMMERCIAL_FEE_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    END IF;
    RETURN;
  END IF;

  -- Historical receipts prove an invocation occurred, but cannot prove its
  -- original result. Never claim an exact result or authoritative absence.
  IF p_action_kind IN ('DEFINE_PRICE', 'REVISE_PRICE') THEN
    SELECT EXISTS (
      SELECT 1 FROM pricing.price_invocation_receipts AS receipt
       WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
         AND receipt.action_invocation_id = v_invocation_id
      UNION ALL
      SELECT 1 FROM pricing.price_schedule_revisions AS revision
       WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
         AND revision.action_invocation_id = v_invocation_id
      UNION ALL
      SELECT 1 FROM pricing.price_revisions AS revision
       WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
         AND revision.action_invocation_id = v_invocation_id
    ) INTO v_legacy_exists;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM pricing.fee_action_invocation_receipts AS receipt
       WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
         AND receipt.action_invocation_id = v_invocation_id
      UNION ALL
      SELECT 1 FROM pricing.fee_schedule_revisions AS revision
       WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
         AND revision.action_invocation_id = v_invocation_id
      UNION ALL
      SELECT 1 FROM pricing.fee_revisions AS revision
       WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
         AND revision.action_invocation_id = v_invocation_id
    ) INTO v_legacy_exists;
  END IF;
  IF v_legacy_exists THEN
    RAISE EXCEPTION 'Pricing Action result predates exact receipt authority' USING ERRCODE = 'P7602';
  END IF;

  SELECT true INTO v_existing_claim
    FROM pricing.price_fee_action_invocation_claims AS claim
   WHERE claim.tenant_id = p_tenant_id
     AND claim.legal_entity_id = p_legal_entity_id
     AND claim.action_invocation_id = v_invocation_id
     AND claim.acting_principal_id = v_principal_id
     AND claim.action_kind = p_action_kind
     AND claim.canonical_request_payload = v_canonical_input;
  IF NOT FOUND AND EXISTS (
    SELECT 1 FROM pricing.price_fee_action_invocation_claims AS claim
     WHERE claim.tenant_id = p_tenant_id
       AND claim.legal_entity_id = p_legal_entity_id
       AND claim.action_invocation_id = v_invocation_id
  ) THEN
    IF p_action_kind IN ('DEFINE_PRICE', 'REVISE_PRICE') THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'outcome', 'CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT');
    ELSE
      IF jsonb_typeof(p_input -> 'identityKey') <> 'object' THEN
        RAISE EXCEPTION 'Pricing Commercial Fee identity is invalid' USING ERRCODE = '22023';
      END IF;
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'identityKey', p_input -> 'identityKey',
        'outcome', 'COMMERCIAL_FEE_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    END IF;
    RETURN;
  END IF;

  BEGIN
    -- Claim the Tenant-wide invocation before any owner mutation. The unique
    -- constraint sees a claim from another SLE even though RLS correctly hides
    -- its payload. A zero-row insert therefore becomes a typed conflict without
    -- exposing cross-SLE data or executing the owner mutation.
    IF v_existing_claim THEN
      v_claimed := 1;
    ELSE
      INSERT INTO pricing.price_fee_action_invocation_claims (
        tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
        action_kind, canonical_request_payload
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_invocation_id, v_principal_id,
        p_action_kind, v_canonical_input
      ) ON CONFLICT (tenant_id, action_invocation_id) DO NOTHING;
      GET DIAGNOSTICS v_claimed = ROW_COUNT;
    END IF;
    IF v_claimed <> 1 THEN
      IF p_action_kind IN ('DEFINE_PRICE', 'REVISE_PRICE') THEN
        RETURN QUERY SELECT pg_catalog.jsonb_build_object(
          'outcome', 'CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT');
      ELSE
        IF jsonb_typeof(p_input -> 'identityKey') <> 'object' THEN
          RAISE EXCEPTION 'Pricing Commercial Fee identity is invalid' USING ERRCODE = '22023';
        END IF;
        RETURN QUERY SELECT pg_catalog.jsonb_build_object(
          'identityKey', p_input -> 'identityKey',
          'outcome', 'COMMERCIAL_FEE_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
      END IF;
      RETURN;
    END IF;

    CASE p_action_kind
      WHEN 'DEFINE_PRICE' THEN
        SELECT result.payload INTO v_result FROM pricing.define_price_unwrapped_v2(
          p_tenant_id, p_legal_entity_id, p_input) AS result;
      WHEN 'REVISE_PRICE' THEN
        SELECT result.payload INTO v_result FROM pricing.revise_price_unwrapped_v2(
          p_tenant_id, p_legal_entity_id, p_input) AS result;
      WHEN 'DEFINE_COMMERCIAL_FEE' THEN
        SELECT result.payload INTO v_result FROM pricing.define_commercial_fee_unwrapped_v1(
          p_tenant_id, p_legal_entity_id, p_input) AS result;
      WHEN 'REVISE_COMMERCIAL_FEE' THEN
        SELECT result.payload INTO v_result FROM pricing.revise_commercial_fee_unwrapped_v1(
          p_tenant_id, p_legal_entity_id, p_input) AS result;
      WHEN 'MANAGE_COMMERCIAL_FEE_REVISION' THEN
        SELECT result.payload INTO v_result FROM pricing.manage_commercial_fee_revision_unwrapped_v1(
          p_tenant_id, p_legal_entity_id, p_input) AS result;
    END CASE;
    IF v_result IS NULL OR jsonb_typeof(v_result) <> 'object' THEN
      RAISE EXCEPTION 'Pricing Action returned no result' USING ERRCODE = 'P7602';
    END IF;
    IF (p_action_kind = 'DEFINE_PRICE' AND v_result ->> 'outcome' IN ('CREATED', 'REUSED'))
      OR (p_action_kind = 'REVISE_PRICE' AND v_result ->> 'outcome' IN ('REVISED', 'UNCHANGED'))
      OR (p_action_kind = 'DEFINE_COMMERCIAL_FEE'
        AND v_result ->> 'outcome' IN ('COMMERCIAL_FEE_CREATED', 'COMMERCIAL_FEE_REUSED'))
      OR (p_action_kind IN ('REVISE_COMMERCIAL_FEE', 'MANAGE_COMMERCIAL_FEE_REVISION')
        AND v_result ->> 'outcome' IN ('COMMERCIAL_FEE_REVISED', 'COMMERCIAL_FEE_UNCHANGED'))
    THEN
      INSERT INTO pricing.price_fee_action_result_receipts (
        tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
        action_kind, request_payload, result_payload
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_invocation_id, v_principal_id,
        p_action_kind, v_canonical_input, v_result
      );
    ELSIF (p_action_kind = 'REVISE_PRICE' AND v_result ->> 'outcome' = 'ACKNOWLEDGEMENT_REQUIRED')
      OR (p_action_kind IN ('REVISE_COMMERCIAL_FEE', 'MANAGE_COMMERCIAL_FEE_REVISION')
        AND v_result ->> 'outcome' = 'COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED')
    THEN
      -- Keep the invocation claim and the owner-issued acknowledgement ledger.
      -- A later attempt may add that exact acknowledgement while retaining the
      -- same canonical business command and invocation.
      NULL;
    ELSE
      -- Roll the pre-mutation claim back for a rejected/no-result command while
      -- preserving its typed result in the local variable for the caller.
      RAISE EXCEPTION 'Pricing Action did not commit' USING ERRCODE = 'P7603';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P7603' THEN
    NULL;
  END;
  RETURN QUERY SELECT v_result;
END;
$function$;

CREATE FUNCTION pricing.define_price_v2(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'DEFINE_PRICE') AS result;
$function$;

CREATE FUNCTION pricing.revise_price_v2(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'REVISE_PRICE') AS result;
$function$;

CREATE FUNCTION pricing.define_price_v3(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'DEFINE_PRICE') AS result;
$function$;

CREATE FUNCTION pricing.revise_price_v3(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'REVISE_PRICE') AS result;
$function$;

CREATE FUNCTION pricing.define_commercial_fee_v1(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'DEFINE_COMMERCIAL_FEE') AS result;
$function$;

CREATE FUNCTION pricing.revise_commercial_fee_v1(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'REVISE_COMMERCIAL_FEE') AS result;
$function$;

CREATE FUNCTION pricing.manage_commercial_fee_revision_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'MANAGE_COMMERCIAL_FEE_REVISION') AS result;
$function$;

CREATE FUNCTION pricing.define_commercial_fee_v2(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'DEFINE_COMMERCIAL_FEE') AS result;
$function$;

CREATE FUNCTION pricing.revise_commercial_fee_v2(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'REVISE_COMMERCIAL_FEE') AS result;
$function$;

CREATE FUNCTION pricing.manage_commercial_fee_revision_v2(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_price_fee_action_with_result_v1(
    p_tenant_id, p_legal_entity_id, p_input, 'MANAGE_COMMERCIAL_FEE_REVISION') AS result;
$function$;

CREATE FUNCTION pricing.lookup_price_action_result_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_receipt record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price result scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Price result lookup input is invalid' USING ERRCODE = '22023';
  END;
  IF jsonb_typeof(p_input) <> 'object' OR v_invocation_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Pricing Price result lookup input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT receipt.* INTO v_receipt FROM pricing.price_fee_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.action_invocation_id = v_invocation_id
     AND receipt.acting_principal_id = v_principal_id;
  IF FOUND THEN
    IF v_receipt.action_kind IN ('DEFINE_PRICE', 'REVISE_PRICE') THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text,
        'outcome', 'PRICE_ACTION_RESULT_FOUND', 'result', v_receipt.result_payload);
    ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text, 'outcome', 'PRICE_ACTION_RESULT_ABSENT');
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.price_invocation_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
       AND receipt.action_invocation_id = v_invocation_id
       AND receipt.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.price_schedule_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.price_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
  ) THEN
    RAISE EXCEPTION 'Pricing Price result predates exact receipt authority' USING ERRCODE = 'P7602';
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'actionInvocationId', v_invocation_id::text, 'outcome', 'PRICE_ACTION_RESULT_ABSENT');
END;
$function$;

CREATE FUNCTION pricing.lookup_commercial_fee_action_result_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_receipt record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result lookup input is invalid' USING ERRCODE = '22023';
  END;
  IF jsonb_typeof(p_input) <> 'object' OR v_invocation_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result lookup input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT receipt.* INTO v_receipt FROM pricing.price_fee_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.action_invocation_id = v_invocation_id
     AND receipt.acting_principal_id = v_principal_id;
  IF FOUND THEN
    IF v_receipt.action_kind IN ('DEFINE_COMMERCIAL_FEE', 'REVISE_COMMERCIAL_FEE',
      'MANAGE_COMMERCIAL_FEE_REVISION') THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text,
        'outcome', 'COMMERCIAL_FEE_ACTION_RESULT_FOUND', 'result', v_receipt.result_payload);
    ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text, 'outcome', 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT');
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.fee_action_invocation_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
       AND receipt.action_invocation_id = v_invocation_id
       AND receipt.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.fee_schedule_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.fee_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
  ) THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result predates exact receipt authority' USING ERRCODE = 'P7602';
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'actionInvocationId', v_invocation_id::text, 'outcome', 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT');
END;
$function$;

ALTER POLICY pricing_prices_scope_select
  ON pricing.prices TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_prices_scope_insert
  ON pricing.prices TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_revisions_scope_select
  ON pricing.price_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_revisions_scope_insert
  ON pricing.price_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_invocation_receipts_scope_select
  ON pricing.price_invocation_receipts TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_invocation_receipts_scope_insert
  ON pricing.price_invocation_receipts TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_acknowledgements_scope_select
  ON pricing.price_schedule_acknowledgements TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_acknowledgements_scope_insert
  ON pricing.price_schedule_acknowledgements TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_entries_scope_select
  ON pricing.price_schedule_entries TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_entries_scope_insert
  ON pricing.price_schedule_entries TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_heads_scope_select
  ON pricing.price_schedule_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_heads_scope_insert
  ON pricing.price_schedule_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_heads_scope_update
  ON pricing.price_schedule_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_revisions_scope_select
  ON pricing.price_schedule_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_schedule_revisions_scope_insert
  ON pricing.price_schedule_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_source_assertions_scope_select
  ON pricing.price_source_assertions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_source_assertions_scope_insert
  ON pricing.price_source_assertions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_source_deliveries_scope_select
  ON pricing.price_source_assertion_deliveries TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_price_source_deliveries_scope_insert
  ON pricing.price_source_assertion_deliveries TO ontos_runtime, pricing_management_routine_writer;

ALTER POLICY pricing_fees_scope_select
  ON pricing.fees TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fees_scope_insert
  ON pricing.fees TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_revisions_scope_select
  ON pricing.fee_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_revisions_scope_insert
  ON pricing.fee_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_action_invocation_receipts_scope_select
  ON pricing.fee_action_invocation_receipts TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_action_invocation_receipts_scope_insert
  ON pricing.fee_action_invocation_receipts TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_acknowledgements_scope_select
  ON pricing.fee_schedule_acknowledgements TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_acknowledgements_scope_insert
  ON pricing.fee_schedule_acknowledgements TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_entries_scope_select
  ON pricing.fee_schedule_entries TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_entries_scope_insert
  ON pricing.fee_schedule_entries TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_heads_scope_select
  ON pricing.fee_schedule_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_heads_scope_insert
  ON pricing.fee_schedule_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_heads_scope_update
  ON pricing.fee_schedule_heads TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_revisions_scope_select
  ON pricing.fee_schedule_revisions TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_fee_schedule_revisions_scope_insert
  ON pricing.fee_schedule_revisions TO ontos_runtime, pricing_management_routine_writer;

GRANT SELECT, INSERT ON TABLE pricing.prices, pricing.price_revisions,
  pricing.price_invocation_receipts, pricing.price_schedule_acknowledgements,
  pricing.price_schedule_entries, pricing.price_schedule_revisions,
  pricing.price_source_assertions, pricing.price_source_assertion_deliveries,
  pricing.fees, pricing.fee_revisions, pricing.fee_action_invocation_receipts,
  pricing.fee_schedule_acknowledgements, pricing.fee_schedule_entries,
  pricing.fee_schedule_revisions, pricing.price_fee_action_invocation_claims,
  pricing.price_fee_action_result_receipts
  TO pricing_management_routine_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.price_schedule_heads,
  pricing.fee_schedule_heads TO pricing_management_routine_writer;

GRANT EXECUTE ON FUNCTION pricing.define_price_v1(uuid,uuid,jsonb),
  pricing.revise_price_v1(uuid,uuid,jsonb),
  pricing.define_price_unwrapped_v2(uuid,uuid,jsonb),
  pricing.revise_price_unwrapped_v2(uuid,uuid,jsonb),
  pricing.bind_price_source_provenance_v1(uuid,uuid,uuid,uuid,jsonb),
  pricing.bind_price_retirement_provenance_v1(uuid,uuid,uuid,uuid,jsonb),
  pricing.price_source_provenance_json_v1(uuid,uuid,uuid,uuid),
  pricing.scheduled_price_revision_json_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz),
  pricing.price_schedule_acknowledgement_v1(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,text,numeric,text,uuid),
  pricing.define_commercial_fee_unwrapped_v1(uuid,uuid,jsonb),
  pricing.revise_commercial_fee_unwrapped_v1(uuid,uuid,jsonb),
  pricing.manage_commercial_fee_revision_unwrapped_v1(uuid,uuid,jsonb),
  pricing.fee_id_for_identity_v1(uuid,uuid,jsonb),
  pricing.fee_identity_json_v1(uuid,uuid,uuid),
  pricing.scheduled_fee_revision_json_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz)
  TO pricing_management_routine_writer;

REVOKE ALL ON FUNCTION pricing.execute_price_fee_action_with_result_v1(uuid,uuid,jsonb,text)
  FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.define_price_v1(uuid,uuid,jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.revise_price_v1(uuid,uuid,jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.define_price_unwrapped_v2(uuid,uuid,jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.revise_price_unwrapped_v2(uuid,uuid,jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.bind_price_source_provenance_v1(uuid,uuid,uuid,uuid,jsonb)
  FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.bind_price_retirement_provenance_v1(uuid,uuid,uuid,uuid,jsonb)
  FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.define_commercial_fee_unwrapped_v1(uuid,uuid,jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.revise_commercial_fee_unwrapped_v1(uuid,uuid,jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.manage_commercial_fee_revision_unwrapped_v1(uuid,uuid,jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.define_price_v2(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_price_v2(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.define_price_v3(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_price_v3(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.define_commercial_fee_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_commercial_fee_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.manage_commercial_fee_revision_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.define_commercial_fee_v2(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_commercial_fee_v2(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.manage_commercial_fee_revision_v2(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.lookup_price_action_result_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.lookup_commercial_fee_action_result_v1(uuid,uuid,jsonb) FROM PUBLIC;

GRANT CREATE ON SCHEMA pricing TO pricing_management_routine_writer;
ALTER FUNCTION pricing.execute_price_fee_action_with_result_v1(uuid,uuid,jsonb,text)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.define_price_v2(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.revise_price_v2(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.define_price_v3(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.revise_price_v3(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.define_commercial_fee_v1(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.revise_commercial_fee_v1(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.manage_commercial_fee_revision_v1(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.define_commercial_fee_v2(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.revise_commercial_fee_v2(uuid,uuid,jsonb) OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.manage_commercial_fee_revision_v2(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.lookup_price_action_result_v1(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.lookup_commercial_fee_action_result_v1(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
REVOKE CREATE ON SCHEMA pricing FROM pricing_management_routine_writer;

GRANT EXECUTE ON FUNCTION pricing.define_price_v2(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_price_v2(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.define_price_v3(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_price_v3(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.define_commercial_fee_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_commercial_fee_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.manage_commercial_fee_revision_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.define_commercial_fee_v2(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_commercial_fee_v2(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.manage_commercial_fee_revision_v2(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.lookup_price_action_result_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.lookup_commercial_fee_action_result_v1(uuid,uuid,jsonb) TO ontos_runtime;
