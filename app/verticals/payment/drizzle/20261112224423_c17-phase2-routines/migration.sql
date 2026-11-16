-- Custom SQL migration file, put your code below! --
-- C17 phase 2 (#1153, #1155, #1157, #1158, #1234; plan D-P2..D-P5). The preceding generated migration owns the
-- payer contact and binding route tables, their checks, keys and policies, and the recovery request index. This
-- migration adds what typed DDL cannot express: FORCE RLS, least-privilege grants, the insert-once route guard,
-- the payer contact lifecycle inside the scoped routines, the per-family refund serialisation and the two
-- cross-Tenant maintenance routines of the reconciliation driver.
-- No backfill: no C17 gateway table was ever deployed, so no binding exists without its route.
ALTER TABLE payment.psp_operation_payer_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_binding_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON payment.psp_operation_payer_contacts, payment.psp_binding_routes FROM PUBLIC, ontos_runtime;
-- The collection Action inserts the contact in its own scoped transaction; only the routines below read or delete it.
GRANT INSERT ON payment.psp_operation_payer_contacts TO ontos_runtime;
-- The binding configuration Action creates the route; the route Read resolves it inside the caller's Tenant.
GRANT SELECT, INSERT ON payment.psp_binding_routes TO ontos_runtime;
--> statement-breakpoint
-- A route never changes and is never removed: a retired binding still resolves (#1155).
CREATE TRIGGER payment_psp_binding_routes_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.psp_binding_routes FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
--> statement-breakpoint
-- Deletes the payer contact of one operation: it is needed only until the dispatch that uses it is prepared or
-- is recorded as never sent (plan D-P3). Internal; called only by the scoped routines in the same transaction.
CREATE FUNCTION payment.psp_forget_payer_contact(p_tenant_id uuid, p_legal_entity_id uuid, p_operation_id uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$
  DELETE FROM payment.psp_operation_payer_contacts AS contact
  WHERE contact.tenant_id = p_tenant_id AND contact.legal_entity_id = p_legal_entity_id
    AND contact.operation_id = p_operation_id;
$$;
--> statement-breakpoint
-- Routine: as before, plus the operation's payer contact (absent when none was supplied or it was already used).
CREATE OR REPLACE FUNCTION payment.psp_read_operation_for_execution(p_tenant_id uuid, p_legal_entity_id uuid, p_operation_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'amountMinor', operation.amount_minor,
    'createdAt', payment.psp_utc_text(operation.created_at),
    'cancelDispatchExists', EXISTS (
      SELECT 1 FROM payment.psp_provider_dispatches AS cancel
      WHERE cancel.tenant_id = operation.tenant_id AND cancel.legal_entity_id = operation.legal_entity_id
        AND cancel.target_operation_id = operation.operation_id AND cancel.operation_kind = 'CANCEL_OR_VOID'
    ),
    'cancelOperationExists', EXISTS (
      SELECT 1 FROM payment.payment_operations AS cancel
      WHERE cancel.tenant_id = operation.tenant_id AND cancel.legal_entity_id = operation.legal_entity_id
        AND cancel.target_operation_id = operation.operation_id AND cancel.kind = 'CANCEL_OR_VOID'
    ),
    'currency', operation.currency,
    'customerConfigurationId', payment_row.customer_configuration_id,
    'kind', operation.kind,
    'materialHash', operation.material_hash,
    'operationId', operation.operation_id,
    'outcome', operation.outcome,
    'payerContact', CASE WHEN contact.operation_id IS NULL THEN NULL ELSE jsonb_build_object(
      'email', contact.email,
      'fullName', contact.full_name,
      'phone', contact.phone
    ) END,
    'paymentId', operation.payment_id,
    'targetOperationId', operation.target_operation_id
  )) || jsonb_build_object(
    'binding', operation.binding,
    'provenance', jsonb_build_object(
      'actionInvocationId', operation.action_invocation_id,
      'actorPrincipalId', operation.actor_principal_id,
      'compositionRevision', operation.composition_revision
    )
  )
  FROM payment.payment_operations AS operation
  JOIN payment.payments AS payment_row
    ON payment_row.tenant_id = operation.tenant_id AND payment_row.legal_entity_id = operation.legal_entity_id
    AND payment_row.payment_id = operation.payment_id
  LEFT JOIN payment.psp_operation_payer_contacts AS contact
    ON contact.tenant_id = operation.tenant_id AND contact.legal_entity_id = operation.legal_entity_id
    AND contact.operation_id = operation.operation_id
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id;
END;
$$;

--> statement-breakpoint
-- Refunds per provider payment are serialized (GoPay/Comgate). A refund is unresolved while it is prepared or
-- unknown. A GoPay refund also stays unresolved while it is acknowledged without definitive refund evidence. An
-- acknowledged Comgate refund no longer blocks: each refund has its own refId and economic effect key, Payment
-- owns the refund capacity and Comgate caps the total (1402), so the statement lookup proves each one (D-P2).
CREATE OR REPLACE FUNCTION payment.psp_unresolved_refund_ids(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_provider_payment_ref text,
  p_excluding_operation_id uuid
) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = pg_catalog, payment, pg_temp AS $$
  SELECT coalesce(array_agg(refund.operation_id ORDER BY refund.recorded_at, refund.operation_id), ARRAY[]::uuid[])
  FROM payment.psp_provider_dispatches AS refund
  WHERE refund.tenant_id = p_tenant_id AND refund.legal_entity_id = p_legal_entity_id
    AND refund.binding_id = p_binding_id AND refund.operation_kind = 'REFUND'
    AND refund.provider_payment_ref = p_provider_payment_ref
    AND refund.operation_id IS DISTINCT FROM p_excluding_operation_id
    AND (
      refund.state IN ('PREPARED', 'OUTCOME_UNKNOWN')
      OR (refund.provider_family = 'GOPAY' AND refund.state = 'ACKNOWLEDGED' AND NOT EXISTS (
        SELECT 1 FROM payment.psp_provider_evidence AS evidence
        WHERE evidence.tenant_id = refund.tenant_id AND evidence.legal_entity_id = refund.legal_entity_id
          AND evidence.operation_id = refund.operation_id
          AND evidence.fact_kind IN ('REFUND_CONFIRMED', 'REFUND_NOT_EFFECTED')
      ))
    );
$$;

--> statement-breakpoint
-- Routine: as before; the payer contact of the operation is deleted in the transaction that writes PREPARED or
-- WITHHELD. DEFERRED is still decided under the target's lock, after the family-specific unresolved check.
CREATE OR REPLACE FUNCTION payment.psp_prepare_dispatch(
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
  IF v_operation.kind = 'REFUND' THEN
    SELECT binding.provider_family INTO v_family FROM payment.psp_provider_account_bindings AS binding
    WHERE binding.tenant_id = p_tenant_id AND binding.legal_entity_id = p_legal_entity_id
      AND binding.binding_id = p_binding_id;
    IF v_family IN ('GOPAY', 'COMGATE') THEN
      v_unresolved := payment.psp_unresolved_refund_ids(
        p_tenant_id, p_legal_entity_id, p_binding_id, p_provider_payment_ref, p_operation_id
      );
      IF cardinality(v_unresolved) > 0 THEN
        result := jsonb_build_object('_tag', 'DEFERRED', 'unresolvedRefundOperationIds', to_jsonb(v_unresolved));
        RETURN NEXT;
        RETURN;
      END IF;
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
    replay_expires_at, prepared_at, provider_payment_ref
  )
  SELECT p_tenant_id, p_legal_entity_id, p_delivery_id, p_origin_action_invocation_id, p_origin_composition_revision,
    p_worker_key, binding.binding_id, binding.environment, v_operation.material_hash, v_operation.operation_id,
    v_operation.kind, replace(v_operation.operation_id::text, '-', ''), v_operation.payment_id,
    binding.provider_account_ref, binding.provider_family, 'PREPARED', v_operation.target_operation_id,
    p_credential_revision, p_endpoint_ref, p_request_hash, p_idempotency_key_hash, p_return_token, v_body,
    p_request_headers,
    CASE WHEN p_replay_window_ms IS NULL THEN NULL ELSE now() END,
    CASE WHEN p_replay_window_ms IS NULL THEN NULL ELSE now() + make_interval(secs => p_replay_window_ms / 1000.0) END,
    now(), p_provider_payment_ref
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
-- Shared body of the two "never sent" records; a recorded never-sent operation no longer needs its payer contact.
CREATE OR REPLACE FUNCTION payment.psp_record_unsent(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_material_hash text,
  p_state text,
  p_not_sent_reason text,
  p_origin_action_invocation_id uuid,
  p_origin_composition_revision text,
  p_worker_key text,
  p_delivery_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_conflict text;
  v_lock uuid;
  v_dispatch payment.psp_provider_dispatches%ROWTYPE;
BEGIN
  SELECT coalesce(operation.target_operation_id, operation.operation_id) INTO v_lock
  FROM payment.payment_operations AS operation
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id;
  IF v_lock IS NOT NULL THEN
    PERFORM payment.psp_lock_operation(p_tenant_id, v_lock);
  END IF;
  v_conflict := payment.psp_dispatch_identity_conflict(p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, p_material_hash);
  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('_tag', 'CONFLICT', 'reason', v_conflict);
  END IF;
  SELECT dispatch.* INTO v_dispatch FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    v_dispatch := payment.psp_insert_dispatch(
      p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, p_state, p_not_sent_reason,
      p_origin_action_invocation_id, p_origin_composition_revision, p_worker_key, p_delivery_id
    );
    PERFORM payment.psp_forget_payer_contact(p_tenant_id, p_legal_entity_id, p_operation_id);
    RETURN jsonb_build_object('_tag', 'RECORDED', 'record', payment.psp_dispatch_json(v_dispatch));
  END IF;
  IF v_dispatch.binding_id <> p_binding_id OR v_dispatch.material_hash <> p_material_hash THEN
    RETURN jsonb_build_object('_tag', 'CONFLICT', 'reason', 'material_mismatch', 'record', payment.psp_dispatch_json(v_dispatch));
  END IF;
  IF v_dispatch.state = p_state AND v_dispatch.not_sent_reason IS NOT DISTINCT FROM p_not_sent_reason THEN
    RETURN jsonb_build_object('_tag', 'UNCHANGED', 'record', payment.psp_dispatch_json(v_dispatch));
  END IF;
  IF v_dispatch.state <> 'AWAITING_TARGET' THEN
    RETURN jsonb_build_object('_tag', 'CONFLICT', 'reason', 'illegal_transition', 'record', payment.psp_dispatch_json(v_dispatch));
  END IF;
  UPDATE payment.psp_provider_dispatches AS dispatch
  SET state = p_state, not_sent_reason = p_not_sent_reason, transition_delivery_id = p_delivery_id, transitioned_at = now()
  WHERE dispatch.dispatch_id = v_dispatch.dispatch_id
  RETURNING * INTO v_dispatch;
  PERFORM payment.psp_forget_payer_contact(p_tenant_id, p_legal_entity_id, p_operation_id);
  RETURN jsonb_build_object('_tag', 'RECORDED', 'record', payment.psp_dispatch_json(v_dispatch));
END;
$$;

--> statement-breakpoint
-- Cross-Tenant maintenance (plan D-P3/D-P5). Like the Core Outbox poller, these run on the runtime role in a
-- transaction with no operational scope installed; a transaction that installed a Tenant or Selling Legal Entity
-- is a request, and no request may act across the Tenant boundary.
CREATE FUNCTION payment.psp_assert_no_operational_scope() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF nullif(current_setting('ontos.tenant_id', true), '') IS NOT NULL
    OR nullif(current_setting('ontos.legal_entity_id', true), '') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Cross-Tenant Payment maintenance requires worker scope';
  END IF;
END;
$$;
--> statement-breakpoint
-- Routine: deletes payer contacts older than p_max_age (never one at exactly that age) and returns how many. A
-- contact still unused by then belongs to a collection that was never prepared. At least one hour is required
-- so a misconfigured caller cannot delete contacts a pending collection is about to use.
CREATE FUNCTION payment.purge_expired_payer_contacts(p_max_age interval) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM payment.psp_assert_no_operational_scope();
  IF p_max_age IS NULL OR p_max_age < interval '1 hour' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A payer contact retention of at least one hour is required';
  END IF;
  DELETE FROM payment.psp_operation_payer_contacts AS contact WHERE contact.created_at < now() - p_max_age;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
--> statement-breakpoint
-- Routine: the gateway operations the reconciliation driver may request recovery for now, across every Tenant and
-- Selling Legal Entity, in keyset order (tenant_id, legal_entity_id, operation_id) after the given cursor.
-- Rows are the gateway reconciliation debt of `selectReconciliationDebt` that carry a recommended trigger: the
-- Payment outcome is not definitive and the ledger state is OUTCOME_UNKNOWN, TARGET_UNRESOLVED, UNSUPPORTED or
-- NOT_SENT, or the dispatch is ACKNOWLEDGED and the operation is older than the gateway wait budget (24 hours,
-- GATEWAY_WAIT_BUDGET_MS), or evidence is still pending submission. The trigger is EXECUTION_OUTCOME_UNKNOWN for
-- OUTCOME_UNKNOWN and TARGET_UNRESOLVED, otherwise OUTCOME_OVERDUE (plan section 13.10). Excluded in SQL, so they
-- can never fill a page ahead of due work: operations held by an OPEN reconciliation case, operations whose
-- binding has no route, operations with max_rounds recovery requests, and operations still inside the backoff
-- min(15 minutes * 2^(round - 1), 24 hours) after their last recovery request. round is the number of recovery
-- requests of the operation; every instant is this transaction's own now() (#1234).
CREATE FUNCTION payment.list_due_gateway_reconciliation(
  p_after_tenant_id uuid,
  p_after_legal_entity_id uuid,
  p_after_operation_id uuid,
  p_page_limit integer,
  p_max_rounds integer
) RETURNS TABLE(
  tenant_id uuid,
  legal_entity_id uuid,
  operation_id uuid,
  payment_id uuid,
  provider_family text,
  route_key text,
  recommended_trigger text,
  round integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM payment.psp_assert_no_operational_scope();
  -- A partial cursor is not a position: comparing against a NULL part would silently end the listing.
  IF NOT ((p_after_tenant_id IS NULL AND p_after_legal_entity_id IS NULL AND p_after_operation_id IS NULL)
    OR (p_after_tenant_id IS NOT NULL AND p_after_legal_entity_id IS NOT NULL AND p_after_operation_id IS NOT NULL))
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A reconciliation cursor needs its Tenant, Legal Entity and operation';
  END IF;
  IF p_page_limit IS NULL OR p_page_limit NOT BETWEEN 1 AND 500 OR p_max_rounds IS NULL OR p_max_rounds NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Reconciliation page limit or round budget out of range';
  END IF;
  RETURN QUERY
  SELECT dispatch.tenant_id, dispatch.legal_entity_id, dispatch.operation_id, dispatch.payment_id,
    dispatch.provider_family, route.route_key,
    CASE WHEN dispatch.state IN ('OUTCOME_UNKNOWN', 'TARGET_UNRESOLVED') THEN 'EXECUTION_OUTCOME_UNKNOWN' ELSE 'OUTCOME_OVERDUE' END,
    recovery.rounds
  FROM payment.psp_provider_dispatches AS dispatch
  JOIN payment.payment_operations AS operation
    ON operation.tenant_id = dispatch.tenant_id AND operation.legal_entity_id = dispatch.legal_entity_id
    AND operation.operation_id = dispatch.operation_id
  JOIN payment.psp_binding_routes AS route
    ON route.tenant_id = dispatch.tenant_id AND route.legal_entity_id = dispatch.legal_entity_id
    AND route.binding_id = dispatch.binding_id
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS rounds, max(request.requested_at) AS last_requested_at
    FROM payment.recovery_requests AS request
    WHERE request.tenant_id = dispatch.tenant_id AND request.legal_entity_id = dispatch.legal_entity_id
      AND request.operation_id = dispatch.operation_id
  ) AS recovery
  WHERE (p_after_tenant_id IS NULL
      OR (dispatch.tenant_id, dispatch.legal_entity_id, dispatch.operation_id)
        > (p_after_tenant_id, p_after_legal_entity_id, p_after_operation_id))
    AND operation.outcome NOT IN ('EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED')
    AND (
      dispatch.state IN ('OUTCOME_UNKNOWN', 'TARGET_UNRESOLVED', 'UNSUPPORTED', 'NOT_SENT')
      OR (dispatch.state = 'ACKNOWLEDGED' AND operation.created_at <= now() - interval '24 hours')
      OR EXISTS (
        SELECT 1 FROM payment.psp_provider_evidence AS evidence
        WHERE evidence.tenant_id = dispatch.tenant_id AND evidence.legal_entity_id = dispatch.legal_entity_id
          AND evidence.operation_id = dispatch.operation_id AND evidence.submission_state = 'PENDING_SUBMISSION'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM payment.reconciliation_cases AS held
      WHERE held.tenant_id = dispatch.tenant_id AND held.legal_entity_id = dispatch.legal_entity_id
        AND held.operation_id = dispatch.operation_id AND held.status = 'OPEN'
    )
    AND recovery.rounds < p_max_rounds
    AND (
      recovery.last_requested_at IS NULL
      OR recovery.last_requested_at
        + least(interval '15 minutes' * (2 ^ least(recovery.rounds - 1, 7)), interval '24 hours') <= now()
    )
  ORDER BY dispatch.tenant_id, dispatch.legal_entity_id, dispatch.operation_id
  LIMIT p_page_limit;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  payment.psp_forget_payer_contact(uuid, uuid, uuid),
  payment.psp_assert_no_operational_scope()
FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  payment.purge_expired_payer_contacts(interval),
  payment.list_due_gateway_reconciliation(uuid, uuid, uuid, integer, integer)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  payment.purge_expired_payer_contacts(interval),
  payment.list_due_gateway_reconciliation(uuid, uuid, uuid, integer, integer)
TO ontos_runtime;
