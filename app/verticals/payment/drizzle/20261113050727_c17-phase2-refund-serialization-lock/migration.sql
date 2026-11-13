-- Custom SQL migration file, put your code below! --
-- C17 phase 2 GoPay refund baseline freshness (#1158, Codex review of PR #1479). A GoPay refund is attributed to the
-- one refund-history row that is new since its baseline, which holds only while GoPay refunds of a provider payment
-- are serialised. The executor checks for unresolved refunds and then reads the baseline over HTTP, both before
-- psp_prepare_dispatch takes the target's lock. Another refund of the same payment could be prepared, sent and
-- confirmed in that gap: the late refund then passed the unresolved check with a baseline missing the other row.
--
-- The check now also returns refundDispatchCount, the number of refund dispatches of the provider payment in the same
-- snapshot. psp_prepare_dispatch takes it back with the baseline and, under the target's lock, refuses with
-- REFUND_BASELINE_STALE (nothing written) when the count changed. Dispatch rows are never deleted and a refund is
-- only prepared (the one way to a provider send) under that lock, so an equal count means none was prepared since
-- the check; every refund that existed then was resolved, so its history row (if any) was already in the baseline.
-- No provider call is made on a refusal; the next delivery checks and reads again. No lock is held across the read.

-- A. Refund dispatches of one provider payment in a binding (any state), other than the asking operation.
CREATE FUNCTION payment.psp_refund_dispatch_count(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_provider_payment_ref text,
  p_excluding_operation_id uuid
) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, payment, pg_temp AS $$
  SELECT count(*)::integer
  FROM payment.psp_provider_dispatches AS refund
  WHERE refund.tenant_id = p_tenant_id AND refund.legal_entity_id = p_legal_entity_id
    AND refund.binding_id = p_binding_id AND refund.operation_kind = 'REFUND'
    AND refund.provider_payment_ref = p_provider_payment_ref
    AND refund.operation_id IS DISTINCT FROM p_excluding_operation_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payment.psp_refund_dispatch_count(uuid, uuid, uuid, text, uuid) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint

-- B. Routine: as before, plus refundDispatchCount from the same snapshot as the unresolved refunds.
CREATE OR REPLACE FUNCTION payment.psp_has_unresolved_refund(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_provider_payment_ref text,
  p_excluding_operation_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_unresolved uuid[];
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  v_unresolved := payment.psp_unresolved_refund_ids(
    p_tenant_id, p_legal_entity_id, p_binding_id, p_provider_payment_ref, p_excluding_operation_id
  );
  result := jsonb_build_object(
    'operationIds', to_jsonb(v_unresolved),
    'refundDispatchCount', payment.psp_refund_dispatch_count(
      p_tenant_id, p_legal_entity_id, p_binding_id, p_provider_payment_ref, p_excluding_operation_id
    ),
    'unresolved', cardinality(v_unresolved) > 0
  );
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- C. psp_prepare_dispatch gains p_refund_dispatch_count (after p_provider_refund_baseline): present exactly when the
--    baseline is. The signature changes, so the old one is dropped (its grants go with it) and the new one granted.
DROP FUNCTION payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, jsonb, uuid, text, text, uuid);
--> statement-breakpoint
-- Routine: as before; a GoPay REFUND also carries the refund dispatch count its baseline was read under and is
-- refused with REFUND_BASELINE_STALE when another refund dispatch of the payment was prepared since.
CREATE FUNCTION payment.psp_prepare_dispatch(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_material_hash text,
  p_credential_revision integer,
  p_endpoint_ref text,
  p_request_hash text,
  p_idempotency_key_hash text,
  p_return_token text,
  p_request_body_base64 text,
  p_request_headers jsonb,
  p_replay_window_ms integer,
  p_provider_payment_ref text,
  p_provider_refund_baseline jsonb,
  p_refund_dispatch_count integer,
  p_origin_action_invocation_id uuid,
  p_origin_composition_revision text,
  p_worker_key text,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_conflict text;
  v_operation payment.payment_operations%ROWTYPE;
  v_dispatch payment.psp_provider_dispatches%ROWTYPE;
  v_target payment.psp_provider_dispatches%ROWTYPE;
  v_body bytea;
  v_new_request_conflict text;
  v_family text;
  v_unresolved uuid[];
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  SELECT operation.* INTO v_operation FROM payment.payment_operations AS operation
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id;
  IF NOT FOUND THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'operation_unknown');
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM payment.psp_lock_operation(p_tenant_id, coalesce(v_operation.target_operation_id, v_operation.operation_id));
  v_conflict := payment.psp_dispatch_identity_conflict(p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, p_material_hash);
  IF v_conflict IS NULL AND (
    (p_request_body_base64 IS NOT NULL AND p_request_body_base64 !~ '^[A-Za-z0-9+/]*={0,2}$')
    OR (p_request_body_base64 IS NULL) <> (p_request_headers IS NULL)
    OR (p_request_headers IS NOT NULL AND jsonb_typeof(p_request_headers) <> 'array')
  ) THEN
    v_conflict := 'request_body_invalid';
  END IF;
  IF v_conflict IS NULL THEN
    SELECT binding.provider_family INTO v_family FROM payment.psp_provider_account_bindings AS binding
    WHERE binding.tenant_id = p_tenant_id AND binding.legal_entity_id = p_legal_entity_id
      AND binding.binding_id = p_binding_id;
    IF (v_operation.kind = 'REFUND' AND v_family = 'GOPAY') <> (p_provider_refund_baseline IS NOT NULL)
      OR (p_provider_refund_baseline IS NOT NULL) <> (p_refund_dispatch_count IS NOT NULL)
    THEN
      v_conflict := 'refund_baseline_mismatch';
    ELSIF p_refund_dispatch_count < 0 THEN
      v_conflict := 'refund_baseline_invalid';
    ELSIF p_provider_refund_baseline IS NOT NULL AND (
      jsonb_typeof(p_provider_refund_baseline) <> 'array'
      OR jsonb_array_length(p_provider_refund_baseline) > 1000
      OR jsonb_path_exists(p_provider_refund_baseline, '$[*] ? (@.type() != "string")')
    ) THEN
      v_conflict := 'refund_baseline_invalid';
    END IF;
  END IF;
  IF v_conflict IS NOT NULL THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', v_conflict);
    RETURN NEXT;
    RETURN;
  END IF;
  -- A new request needs an ACTIVE credential and, for a cancel or refund, the acknowledged provider target.
  IF NOT EXISTS (
    SELECT 1 FROM payment.psp_credential_revisions AS credential
    WHERE credential.tenant_id = p_tenant_id AND credential.legal_entity_id = p_legal_entity_id
      AND credential.binding_id = p_binding_id AND credential.revision = p_credential_revision
      AND credential.status = 'ACTIVE'
  ) THEN
    v_new_request_conflict := 'credential_not_active';
  ELSIF v_operation.target_operation_id IS NOT NULL THEN
    SELECT dispatch.* INTO v_target FROM payment.psp_provider_dispatches AS dispatch
    WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
      AND dispatch.operation_id = v_operation.target_operation_id;
    IF v_target.dispatch_id IS NULL OR v_target.state <> 'ACKNOWLEDGED' OR v_target.provider_payment_ref IS NULL
      OR p_provider_payment_ref IS DISTINCT FROM v_target.provider_payment_ref
    THEN
      v_new_request_conflict := 'target_not_acknowledged';
    END IF;
  ELSIF p_provider_payment_ref IS NOT NULL THEN
    v_new_request_conflict := 'provider_target_not_applicable';
  END IF;
  v_body := CASE WHEN p_request_body_base64 IS NULL THEN NULL ELSE decode(p_request_body_base64, 'base64') END;
  SELECT dispatch.* INTO v_dispatch FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_dispatch.binding_id <> p_binding_id OR v_dispatch.material_hash <> p_material_hash THEN
      result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'material_mismatch', 'record', payment.psp_dispatch_json(v_dispatch));
    ELSIF v_dispatch.state = 'NOT_SENT' AND v_dispatch.not_sent_reason = 'WITHHELD_FOR_CANCELLATION' THEN
      PERFORM payment.psp_forget_payer_contact(p_tenant_id, p_legal_entity_id, p_operation_id);
      result := jsonb_build_object('_tag', 'WITHHELD', 'record', payment.psp_dispatch_json(v_dispatch));
    ELSIF v_dispatch.state = 'AWAITING_TARGET' AND v_new_request_conflict IS NOT NULL THEN
      result := jsonb_build_object('_tag', 'CONFLICT', 'reason', v_new_request_conflict, 'record', payment.psp_dispatch_json(v_dispatch));
    ELSIF v_dispatch.state = 'AWAITING_TARGET' THEN
      -- Only a registered cancel is AWAITING_TARGET; it never carries a refund baseline (checked above).
      UPDATE payment.psp_provider_dispatches AS dispatch
      SET state = 'PREPARED',
        credential_revision = p_credential_revision,
        endpoint_ref = p_endpoint_ref,
        request_hash = p_request_hash,
        idempotency_key_hash = p_idempotency_key_hash,
        request_body = v_body,
        request_headers = p_request_headers,
        replay_starts_at = CASE WHEN p_replay_window_ms IS NULL THEN NULL ELSE now() END,
        replay_expires_at = CASE WHEN p_replay_window_ms IS NULL THEN NULL ELSE now() + make_interval(secs => p_replay_window_ms / 1000.0) END,
        prepared_at = now(),
        provider_payment_ref = p_provider_payment_ref,
        transition_delivery_id = p_delivery_id,
        transitioned_at = now()
      WHERE dispatch.dispatch_id = v_dispatch.dispatch_id
      RETURNING * INTO v_dispatch;
      PERFORM payment.psp_forget_payer_contact(p_tenant_id, p_legal_entity_id, p_operation_id);
      result := jsonb_build_object('_tag', 'PREPARED', 'record', payment.psp_dispatch_json(v_dispatch));
    ELSIF v_dispatch.prepared_at IS NOT NULL AND (v_dispatch.request_hash IS DISTINCT FROM p_request_hash
      OR v_dispatch.endpoint_ref IS DISTINCT FROM p_endpoint_ref
      OR v_dispatch.idempotency_key_hash IS DISTINCT FROM p_idempotency_key_hash
      OR v_dispatch.request_body IS DISTINCT FROM v_body
      OR v_dispatch.request_headers IS DISTINCT FROM p_request_headers)
    THEN
      result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'request_mismatch', 'record', payment.psp_dispatch_json(v_dispatch));
    ELSE
      result := jsonb_build_object('_tag', 'EXISTING', 'record', payment.psp_dispatch_json(v_dispatch));
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_operation.kind = 'CANCEL_OR_VOID' OR v_new_request_conflict IS NOT NULL THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', coalesce(v_new_request_conflict, 'cancel_not_registered'));
    RETURN NEXT;
    RETURN;
  END IF;
  -- GoPay refunds stay strictly serialised per provider payment: this is what makes "exactly one row new since the
  -- baseline" attributable to this dispatch.
  IF v_operation.kind = 'REFUND' AND v_family IN ('GOPAY', 'COMGATE') THEN
    v_unresolved := payment.psp_unresolved_refund_ids(
      p_tenant_id, p_legal_entity_id, p_binding_id, p_provider_payment_ref, p_operation_id
    );
    IF cardinality(v_unresolved) > 0 THEN
      result := jsonb_build_object('_tag', 'DEFERRED', 'unresolvedRefundOperationIds', to_jsonb(v_unresolved));
      RETURN NEXT;
      RETURN;
    END IF;
    -- The baseline was read after a check that counted p_refund_dispatch_count refund dispatches. Another one
    -- prepared since (even one that completed meanwhile) may own a history row the baseline lacks: refuse.
    IF p_refund_dispatch_count IS NOT NULL AND payment.psp_refund_dispatch_count(
      p_tenant_id, p_legal_entity_id, p_binding_id, p_provider_payment_ref, p_operation_id
    ) <> p_refund_dispatch_count THEN
      result := jsonb_build_object('_tag', 'REFUND_BASELINE_STALE');
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  IF v_operation.kind = 'COLLECT' AND EXISTS (
    SELECT 1 FROM payment.psp_provider_dispatches AS cancel
    WHERE cancel.tenant_id = p_tenant_id AND cancel.legal_entity_id = p_legal_entity_id
      AND cancel.target_operation_id = p_operation_id AND cancel.operation_kind = 'CANCEL_OR_VOID'
  ) THEN
    v_dispatch := payment.psp_insert_dispatch(
      p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, 'NOT_SENT', 'WITHHELD_FOR_CANCELLATION',
      p_origin_action_invocation_id, p_origin_composition_revision, p_worker_key, p_delivery_id
    );
    PERFORM payment.psp_forget_payer_contact(p_tenant_id, p_legal_entity_id, p_operation_id);
    result := jsonb_build_object('_tag', 'WITHHELD', 'record', payment.psp_dispatch_json(v_dispatch));
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO payment.psp_provider_dispatches (
    tenant_id, legal_entity_id, delivery_id, origin_action_invocation_id, origin_composition_revision, worker_key,
    binding_id, environment, material_hash, operation_id, operation_kind, order_reference, payment_id,
    provider_account_ref, provider_family, state, target_operation_id, credential_revision, endpoint_ref,
    request_hash, idempotency_key_hash, return_token, request_body, request_headers, replay_starts_at,
    replay_expires_at, prepared_at, provider_payment_ref, provider_refund_baseline
  )
  SELECT p_tenant_id, p_legal_entity_id, p_delivery_id, p_origin_action_invocation_id, p_origin_composition_revision,
    p_worker_key, binding.binding_id, binding.environment, v_operation.material_hash, v_operation.operation_id,
    v_operation.kind, replace(v_operation.operation_id::text, '-', ''), v_operation.payment_id,
    binding.provider_account_ref, binding.provider_family, 'PREPARED', v_operation.target_operation_id,
    p_credential_revision, p_endpoint_ref, p_request_hash, p_idempotency_key_hash, p_return_token, v_body,
    p_request_headers,
    CASE WHEN p_replay_window_ms IS NULL THEN NULL ELSE now() END,
    CASE WHEN p_replay_window_ms IS NULL THEN NULL ELSE now() + make_interval(secs => p_replay_window_ms / 1000.0) END,
    now(), p_provider_payment_ref, p_provider_refund_baseline
  FROM payment.psp_provider_account_bindings AS binding
  WHERE binding.tenant_id = p_tenant_id AND binding.legal_entity_id = p_legal_entity_id
    AND binding.binding_id = p_binding_id
  RETURNING * INTO v_dispatch;
  PERFORM payment.psp_forget_payer_contact(p_tenant_id, p_legal_entity_id, p_operation_id);
  result := jsonb_build_object('_tag', 'PREPARED', 'record', payment.psp_dispatch_json(v_dispatch));
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- D. Grants of the new signature (same as the grant of the dropped one).
REVOKE ALL ON FUNCTION
  payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, jsonb, integer, uuid, text, text, uuid)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, jsonb, integer, uuid, text, text, uuid)
TO ontos_runtime;
