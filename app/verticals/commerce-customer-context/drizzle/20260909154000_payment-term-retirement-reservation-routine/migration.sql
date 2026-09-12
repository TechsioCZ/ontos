-- Customer Context owns the durable barrier for Payment Term retirement.  The routine is the only
-- write path used by the cross-module Action gateway: reserve is idempotent by Action invocation,
-- commit/release are idempotent by reservation reference, and one advisory key is taken per term
-- resource id in sorted order so aliases cannot be reserved concurrently with each other.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."reserve_payment_term_retirement"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_action_invocation_id uuid;
  v_actor_principal_id uuid;
  v_effective_at timestamptz;
  v_operation text;
  v_reason text;
  v_reservation_id uuid;
  v_resource_ids text[];
  v_existing payment_term_retirement_reservations%ROWTYPE;
  v_resource_id text;
BEGIN
  PERFORM assert_customer_payment_terms_scope(p_tenant_id, p_legal_entity_id);
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RETURN QUERY SELECT 'INVALID_REQUEST'::text, NULL::jsonb;
    RETURN;
  END IF;

  BEGIN
    v_action_invocation_id := (p_input->>'actionInvocationId')::uuid;
    v_actor_principal_id := (p_input->>'actorPrincipalId')::uuid;
    v_effective_at := (p_input->>'effectiveAt')::timestamptz;
    v_reservation_id := nullif(p_input->>'reservationRef', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN QUERY SELECT 'INVALID_REQUEST'::text, NULL::jsonb;
    RETURN;
  END;
  v_operation := p_input->>'operation';
  v_reason := nullif(btrim(p_input->>'reason'), '');

  IF v_action_invocation_id IS NULL OR v_actor_principal_id IS NULL
     OR v_effective_at IS NULL OR v_operation NOT IN ('RESERVE', 'COMMIT', 'RELEASE')
     OR v_reason IS NULL OR length(v_reason) > 500
     OR jsonb_typeof(p_input->'paymentTermResourceIds') IS DISTINCT FROM 'array'
  THEN
    RETURN QUERY SELECT 'INVALID_REQUEST'::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT array_agg(resource_id ORDER BY resource_id)
    INTO v_resource_ids
    FROM (
      SELECT DISTINCT value AS resource_id
      FROM jsonb_array_elements_text(p_input->'paymentTermResourceIds') AS item(value)
      WHERE btrim(value) <> ''
    ) AS ids;
  IF v_resource_ids IS NULL OR cardinality(v_resource_ids) < 1 OR cardinality(v_resource_ids) > 200
     OR cardinality(v_resource_ids) <> jsonb_array_length(p_input->'paymentTermResourceIds')
  THEN
    RETURN QUERY SELECT 'INVALID_REQUEST'::text, NULL::jsonb;
    RETURN;
  END IF;

  -- The same advisory namespace is used by the entitlement/preference guard trigger below.
  -- Sorting is essential: a request containing multiple aliases must not deadlock another batch.
  FOREACH v_resource_id IN ARRAY v_resource_ids LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_tenant_id::text || ':' || p_legal_entity_id::text || ':payment-term-retirement:' || v_resource_id,
      0
    ));
  END LOOP;

  IF v_operation = 'RESERVE' THEN
    IF v_reservation_id IS NOT NULL THEN
      RETURN QUERY SELECT 'INVALID_REQUEST'::text, NULL::jsonb;
      RETURN;
    END IF;

    SELECT reservation.* INTO v_existing
      FROM payment_term_retirement_reservations AS reservation
     WHERE reservation.tenant_id = p_tenant_id
       AND reservation.legal_entity_id = p_legal_entity_id
       AND reservation.action_invocation_id = v_action_invocation_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_existing.effective_at IS DISTINCT FROM v_effective_at
         OR v_existing.payment_term_resource_ids <> v_resource_ids
         OR v_existing.lifecycle = 'RELEASED'
      THEN
        RETURN QUERY SELECT 'CONFLICT'::text, NULL::jsonb;
        RETURN;
      END IF;
      RETURN QUERY SELECT v_existing.lifecycle, jsonb_build_object(
        'effectiveAt', v_existing.effective_at,
        'lifecycle', v_existing.lifecycle,
        'paymentTermResourceIds', to_jsonb(v_existing.payment_term_resource_ids),
        'reservationRef', v_existing.payment_term_retirement_reservation_id
      );
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM payment_term_retirement_reservations AS reservation
       WHERE reservation.tenant_id = p_tenant_id
         AND reservation.legal_entity_id = p_legal_entity_id
         AND reservation.lifecycle IN ('RESERVED', 'COMMITTED')
         AND reservation.payment_term_resource_ids && v_resource_ids
    ) THEN
      RETURN QUERY SELECT 'CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;

    INSERT INTO payment_term_retirement_reservations (
      tenant_id,
      legal_entity_id,
      payment_term_resource_ids,
      effective_at,
      lifecycle,
      action_invocation_id,
      actor_principal_id,
      reason,
      recorded_at,
      created_at,
      updated_at
    ) VALUES (
      p_tenant_id,
      p_legal_entity_id,
      v_resource_ids,
      v_effective_at,
      'RESERVED',
      v_action_invocation_id,
      v_actor_principal_id,
      v_reason,
      now(),
      now(),
      now()
    ) RETURNING * INTO v_existing;
  ELSE
    IF v_reservation_id IS NULL THEN
      RETURN QUERY SELECT 'INVALID_REQUEST'::text, NULL::jsonb;
      RETURN;
    END IF;
    SELECT reservation.* INTO v_existing
      FROM payment_term_retirement_reservations AS reservation
     WHERE reservation.tenant_id = p_tenant_id
       AND reservation.legal_entity_id = p_legal_entity_id
       AND reservation.payment_term_retirement_reservation_id = v_reservation_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::jsonb;
      RETURN;
    END IF;
    IF v_existing.effective_at IS DISTINCT FROM v_effective_at
       OR v_existing.payment_term_resource_ids <> v_resource_ids
    THEN
      RETURN QUERY SELECT 'CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
    IF v_operation = 'COMMIT' THEN
      IF v_existing.lifecycle = 'RELEASED' THEN
        RETURN QUERY SELECT 'CONFLICT'::text, NULL::jsonb;
        RETURN;
      END IF;
      IF v_existing.lifecycle = 'RESERVED' THEN
        UPDATE payment_term_retirement_reservations
           SET lifecycle = 'COMMITTED', updated_at = now(), recorded_at = now()
         WHERE tenant_id = p_tenant_id
           AND legal_entity_id = p_legal_entity_id
           AND payment_term_retirement_reservation_id = v_reservation_id
        RETURNING * INTO v_existing;
      END IF;
    ELSE
      IF v_existing.lifecycle = 'COMMITTED' THEN
        RETURN QUERY SELECT 'CONFLICT'::text, NULL::jsonb;
        RETURN;
      END IF;
      IF v_existing.lifecycle = 'RESERVED' THEN
        UPDATE payment_term_retirement_reservations
           SET lifecycle = 'RELEASED', updated_at = now(), recorded_at = now()
         WHERE tenant_id = p_tenant_id
           AND legal_entity_id = p_legal_entity_id
           AND payment_term_retirement_reservation_id = v_reservation_id
        RETURNING * INTO v_existing;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_existing.lifecycle, jsonb_build_object(
    'effectiveAt', v_existing.effective_at,
    'lifecycle', v_existing.lifecycle,
    'paymentTermResourceIds', to_jsonb(v_existing.payment_term_resource_ids),
    'reservationRef', v_existing.payment_term_retirement_reservation_id
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."reserve_payment_term_retirement"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."reserve_payment_term_retirement"(uuid, uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint

-- A future grant or preference is rejected while the canonical term or one of its aliases is
-- RESERVED/COMMITTED.  Shortening an existing fact to the retirement instant remains legal, which
-- lets an explicit migration/grace workflow close its existing use before COMMIT.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."guard_payment_term_retirement_reservation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $guard$
BEGIN
  IF NEW.lifecycle IN ('ACTIVE', 'ENDED') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      NEW.tenant_id::text || ':' || NEW.legal_entity_id::text || ':payment-term-retirement:' || NEW.payment_term_resource_id,
      0
    ));
    IF EXISTS (
      SELECT 1
        FROM payment_term_retirement_reservations AS reservation
       WHERE reservation.tenant_id = NEW.tenant_id
         AND reservation.legal_entity_id = NEW.legal_entity_id
         AND reservation.lifecycle IN ('RESERVED', 'COMMITTED')
         AND reservation.payment_term_resource_ids @> ARRAY[NEW.payment_term_resource_id]::text[]
         AND (NEW.effective_to IS NULL OR NEW.effective_to > reservation.effective_at)
    ) THEN
      RAISE EXCEPTION 'Payment Term retirement is reserved; grant or preference must be explicitly migrated first'
        USING ERRCODE = '55P03',
              CONSTRAINT = 'payment_term_retirement_reservation';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_payment_term_entitlements_retirement_guard
  ON "commerce_customer_context"."customer_payment_term_entitlements";
CREATE TRIGGER customer_payment_term_entitlements_retirement_guard
  BEFORE INSERT OR UPDATE ON "commerce_customer_context"."customer_payment_term_entitlements"
  FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_payment_term_retirement_reservation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_payment_term_preferences_retirement_guard
  ON "commerce_customer_context"."customer_payment_term_preferences";
CREATE TRIGGER customer_payment_term_preferences_retirement_guard
  BEFORE INSERT OR UPDATE ON "commerce_customer_context"."customer_payment_term_preferences"
  FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_payment_term_retirement_reservation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."guard_payment_term_retirement_reservation"() FROM PUBLIC;
