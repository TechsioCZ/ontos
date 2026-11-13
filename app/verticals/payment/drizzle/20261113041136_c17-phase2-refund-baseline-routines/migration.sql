-- Custom SQL migration file, put your code below! --
-- C17 phase 2 GoPay refund proof (#1156, #1158). The preceding generated migration adds
-- psp_provider_dispatches.provider_refund_baseline and its CHECK.
--
-- The GoPay refund history names no request and carries date-only dates (real v3 sandbox, 2026-11-13), so a refund
-- is attributed by the pre-dispatch baseline: the history row ids the adapter read through the binding before the
-- send. psp_prepare_dispatch persists it in the same transaction as the request hash (#1158 durable handoff). It is
-- written once: the column is in neither the mutable nor the request column list of guard_psp_dispatch_update, so
-- the existing guard freezes it. It is not part of the request identity (EXISTING vs CONFLICT ignores it).
-- No backfill: no C17 dispatch was ever deployed.

-- B. Record JSON: the routines return the baseline as `providerRefundBaseline` (array of row id strings).
CREATE OR REPLACE FUNCTION payment.psp_dispatch_json(p_dispatch payment.psp_provider_dispatches) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, payment, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'bindingId', p_dispatch.binding_id,
    'credentialRevision', p_dispatch.credential_revision,
    'customerRedirectUrl', p_dispatch.customer_redirect_url,
    'deliveryId', p_dispatch.delivery_id,
    'dispatchId', p_dispatch.dispatch_id,
    'endpointRef', p_dispatch.endpoint_ref,
    'environment', p_dispatch.environment,
    'idempotencyKeyHash', p_dispatch.idempotency_key_hash,
    'materialHash', p_dispatch.material_hash,
    'notSentReason', p_dispatch.not_sent_reason,
    'operationId', p_dispatch.operation_id,
    'operationKind', p_dispatch.operation_kind,
    'orderReference', p_dispatch.order_reference,
    'originActionInvocationId', p_dispatch.origin_action_invocation_id,
    'paymentId', p_dispatch.payment_id,
    'preparedAt', payment.psp_utc_text(p_dispatch.prepared_at),
    'providerAccountRef', p_dispatch.provider_account_ref,
    'providerFamily', p_dispatch.provider_family,
    'providerPaymentRef', p_dispatch.provider_payment_ref,
    'providerRefundBaseline', p_dispatch.provider_refund_baseline,
    'providerRefundRef', p_dispatch.provider_refund_ref,
    'recordedAt', payment.psp_utc_text(p_dispatch.recorded_at),
    'replayExpiresAt', payment.psp_utc_text(p_dispatch.replay_expires_at),
    'replayStartsAt', payment.psp_utc_text(p_dispatch.replay_starts_at),
    'requestBody', replace(encode(p_dispatch.request_body, 'base64'), E'\n', ''),
    'requestHeaders', p_dispatch.request_headers,
    'requestHash', p_dispatch.request_hash,
    'respondedAt', payment.psp_utc_text(p_dispatch.responded_at),
    'returnToken', p_dispatch.return_token,
    'state', p_dispatch.state,
    'targetOperationId', p_dispatch.target_operation_id,
    'workerKey', p_dispatch.worker_key
  ));
$$;
--> statement-breakpoint

-- C. psp_prepare_dispatch gains p_provider_refund_baseline (after p_provider_payment_ref). The signature changes,
--    so the old one is dropped (its grants go with it) and the new one is granted below.
DROP FUNCTION payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, uuid, text, text, uuid);
--> statement-breakpoint
-- Routine: as before, plus the GoPay refund baseline. A GoPay REFUND is never prepared without one (a refund whose
-- effect could never be attributed is never sent); any other dispatch never carries one. The baseline is written
-- with the new row only and is not compared for EXISTING: a concurrent identical prepare that read another
-- baseline still finds the first row, which alone is sent.
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
    IF (v_operation.kind = 'REFUND' AND v_family = 'GOPAY') <> (p_provider_refund_baseline IS NOT NULL) THEN
      v_conflict := 'refund_baseline_mismatch';
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

-- D. Grants of the new signature (same as the phase 1 grant of the dropped one).
REVOKE ALL ON FUNCTION
  payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, jsonb, uuid, text, text, uuid)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, jsonb, uuid, text, text, uuid)
TO ontos_runtime;
