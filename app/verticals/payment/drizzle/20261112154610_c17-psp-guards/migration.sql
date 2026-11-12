-- Custom SQL migration file, put your code below! --
-- C17 gateway guards (#1155-#1158). The preceding generated migration owns the psp_ tables, checks,
-- unique/partial indexes, FKs and policies. This migration adds what typed DDL cannot express: FORCE RLS,
-- least-privilege grants, insert-once/transition triggers and the SECURITY DEFINER scoped routines that
-- are the only write path for worker-owned rows (workers get no database executor).
ALTER TABLE payment.psp_provider_account_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_provider_account_binding_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_credential_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_gateway_enablements FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_gateway_enablement_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_provider_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_provider_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.psp_provider_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON
  payment.psp_provider_account_bindings,
  payment.psp_provider_account_binding_revisions,
  payment.psp_credential_revisions,
  payment.psp_gateway_enablements,
  payment.psp_gateway_enablement_revisions,
  payment.psp_provider_dispatches,
  payment.psp_provider_notifications,
  payment.psp_provider_evidence
FROM PUBLIC, ontos_runtime;
-- Action-side configuration and capture rows are written by governed Actions in their Core transaction.
GRANT SELECT, INSERT ON
  payment.psp_provider_account_bindings,
  payment.psp_provider_account_binding_revisions,
  payment.psp_credential_revisions,
  payment.psp_gateway_enablements,
  payment.psp_gateway_enablement_revisions,
  payment.psp_provider_notifications
TO ontos_runtime;
-- Worker-owned rows are readable by Reads and Actions but written only through the scoped routines below.
GRANT SELECT ON payment.psp_provider_dispatches, payment.psp_provider_evidence TO ontos_runtime;
GRANT UPDATE (status, current_credential_revision, notification_url, revision, reason, configured_at, action_invocation_id, actor_principal_id, composition_revision) ON payment.psp_provider_account_bindings TO ontos_runtime;
GRANT UPDATE (status, retired_at, retired_by_action_invocation_id) ON payment.psp_credential_revisions TO ontos_runtime;
GRANT UPDATE (binding_id, environment, enabled, return_url, revision, reason, configured_at, action_invocation_id, actor_principal_id, composition_revision) ON payment.psp_gateway_enablements TO ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER payment_psp_binding_revisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.psp_provider_account_binding_revisions FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_psp_enablement_revisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.psp_gateway_enablement_revisions FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_psp_bindings_no_delete BEFORE DELETE OR TRUNCATE ON payment.psp_provider_account_bindings FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_psp_credentials_no_delete BEFORE DELETE OR TRUNCATE ON payment.psp_credential_revisions FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_psp_enablements_no_delete BEFORE DELETE OR TRUNCATE ON payment.psp_gateway_enablements FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_psp_dispatches_no_delete BEFORE DELETE OR TRUNCATE ON payment.psp_provider_dispatches FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_psp_notifications_no_delete BEFORE DELETE OR TRUNCATE ON payment.psp_provider_notifications FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_psp_evidence_no_delete BEFORE DELETE OR TRUNCATE ON payment.psp_provider_evidence FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
--> statement-breakpoint
-- A binding keeps its account identity forever; each change is exactly the next revision and a retired
-- binding never becomes Current again (#1155 "Binding is immutable for an existing payment").
CREATE FUNCTION payment.guard_psp_binding_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.binding_id, NEW.provider_account_ref, NEW.provider_family, NEW.environment, NEW.merchant_identity)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.binding_id, OLD.provider_account_ref, OLD.provider_family, OLD.environment, OLD.merchant_identity)
    OR NEW.revision <> OLD.revision + 1
    OR NEW.configured_at < OLD.configured_at
    OR NEW.current_credential_revision < OLD.current_credential_revision
    OR (OLD.status = 'RETIRED_FOR_NEW_INTENTS' AND NEW.status <> OLD.status)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_binding_transition_ck', MESSAGE = 'Invalid Provider Account Binding revision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_bindings_transition BEFORE UPDATE ON payment.psp_provider_account_bindings FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_binding_update();
--> statement-breakpoint
-- At commit every binding names an ACTIVE credential revision of itself.
CREATE FUNCTION payment.require_psp_binding_credential() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM payment.psp_provider_account_bindings AS binding
    JOIN payment.psp_credential_revisions AS credential
      ON credential.tenant_id = binding.tenant_id
      AND credential.legal_entity_id = binding.legal_entity_id
      AND credential.binding_id = binding.binding_id
      AND credential.revision = binding.current_credential_revision
      AND credential.status = 'ACTIVE'
    WHERE binding.tenant_id = NEW.tenant_id
      AND binding.legal_entity_id = NEW.legal_entity_id
      AND binding.binding_id = NEW.binding_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_binding_credential_ck', MESSAGE = 'Provider Account Binding lacks its active credential revision';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_psp_bindings_credential AFTER INSERT OR UPDATE ON payment.psp_provider_account_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payment.require_psp_binding_credential();
CREATE CONSTRAINT TRIGGER payment_psp_credentials_binding AFTER INSERT OR UPDATE ON payment.psp_credential_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payment.require_psp_binding_credential();
--> statement-breakpoint
-- A credential revision only retires, once; its secret reference never changes.
CREATE FUNCTION payment.guard_psp_credential_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'retired_at' - 'retired_by_action_invocation_id') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'retired_at' - 'retired_by_action_invocation_id')
    OR OLD.status <> 'ACTIVE' OR NEW.status <> 'RETIRED'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_credential_transition_ck', MESSAGE = 'Invalid credential revision transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_credentials_transition BEFORE UPDATE ON payment.psp_credential_revisions FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_credential_update();
--> statement-breakpoint
CREATE FUNCTION payment.guard_psp_enablement_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.enablement_id, NEW.customer_configuration_id, NEW.provider_family)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.enablement_id, OLD.customer_configuration_id, OLD.provider_family)
    OR NEW.revision <> OLD.revision + 1 OR NEW.configured_at < OLD.configured_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_enablement_transition_ck', MESSAGE = 'Invalid Gateway Enablement revision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_enablements_transition BEFORE UPDATE ON payment.psp_gateway_enablements FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_enablement_update();
--> statement-breakpoint
-- Dispatch ledger (#1156/#1158). Rows start as AWAITING_TARGET, PREPARED, NOT_SENT or UNSUPPORTED.
CREATE FUNCTION payment.guard_psp_dispatch_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('AWAITING_TARGET', 'PREPARED', 'NOT_SENT', 'UNSUPPORTED')
    OR NEW.responded_at IS NOT NULL OR NEW.transitioned_at IS NOT NULL
    OR NEW.provider_refund_ref IS NOT NULL OR NEW.customer_redirect_url IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_dispatch_transition_ck', MESSAGE = 'Invalid initial provider dispatch state';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_dispatches_insert BEFORE INSERT ON payment.psp_provider_dispatches FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_dispatch_insert();
--> statement-breakpoint
-- AWAITING_TARGET -> PREPARED | NOT_SENT | TARGET_UNRESOLVED | UNSUPPORTED; PREPARED -> ACKNOWLEDGED |
-- REJECTED_BEFORE_EFFECT | OUTCOME_UNKNOWN; OUTCOME_UNKNOWN -> ACKNOWLEDGED | REJECTED_BEFORE_EFFECT. Identity
-- and material never change; request columns are written once, when a registered cancel is prepared;
-- provider references and the redirect are written once.
CREATE FUNCTION payment.guard_psp_dispatch_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
DECLARE
  mutable_columns constant text[] := ARRAY['state', 'not_sent_reason', 'provider_payment_ref', 'provider_refund_ref', 'customer_redirect_url', 'responded_at', 'transition_delivery_id', 'transitioned_at'];
  request_columns constant text[] := ARRAY['credential_revision', 'endpoint_ref', 'request_hash', 'idempotency_key_hash', 'request_body', 'request_headers', 'replay_starts_at', 'replay_expires_at', 'prepared_at'];
BEGIN
  IF NOT (
      (OLD.state = 'AWAITING_TARGET' AND NEW.state IN ('PREPARED', 'NOT_SENT', 'TARGET_UNRESOLVED', 'UNSUPPORTED'))
      OR (OLD.state = 'PREPARED' AND NEW.state IN ('ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN'))
      OR (OLD.state = 'OUTCOME_UNKNOWN' AND NEW.state IN ('ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT'))
    )
    OR (to_jsonb(NEW) - mutable_columns - request_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns - request_columns)
    OR (
      NOT (OLD.state = 'AWAITING_TARGET' AND NEW.state = 'PREPARED')
      AND (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns)
    )
    OR (OLD.provider_payment_ref IS NOT NULL AND NEW.provider_payment_ref IS DISTINCT FROM OLD.provider_payment_ref)
    OR (OLD.provider_refund_ref IS NOT NULL AND NEW.provider_refund_ref IS DISTINCT FROM OLD.provider_refund_ref)
    OR (OLD.customer_redirect_url IS NOT NULL AND NEW.customer_redirect_url IS DISTINCT FROM OLD.customer_redirect_url)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_dispatch_transition_ck', MESSAGE = 'Invalid provider dispatch transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_dispatches_transition BEFORE UPDATE ON payment.psp_provider_dispatches FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_dispatch_update();
--> statement-breakpoint
CREATE FUNCTION payment.guard_psp_notification_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('CAPTURED', 'IGNORED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_notification_transition_ck', MESSAGE = 'Invalid initial provider notification state';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_notifications_insert BEFORE INSERT ON payment.psp_provider_notifications FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_notification_insert();
--> statement-breakpoint
-- The captured envelope is immutable; only the processing columns advance (#1157).
CREATE FUNCTION payment.guard_psp_notification_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
DECLARE
  processing_columns constant text[] := ARRAY['state', 'correlated_operation_id', 'processed_delivery_id', 'processed_at'];
BEGIN
  IF NOT (
      (OLD.state = 'CAPTURED' AND NEW.state IN ('HELD_UNCORRELATED', 'SUBMITTED', 'SUBMISSION_HELD', 'SUBMISSION_DENIED'))
      OR (OLD.state = 'HELD_UNCORRELATED' AND NEW.state IN ('SUBMITTED', 'SUBMISSION_HELD', 'SUBMISSION_DENIED'))
      OR (OLD.state = 'SUBMISSION_HELD' AND NEW.state IN ('SUBMITTED', 'SUBMISSION_DENIED'))
    )
    OR (to_jsonb(NEW) - processing_columns) IS DISTINCT FROM (to_jsonb(OLD) - processing_columns)
    OR (OLD.correlated_operation_id IS NOT NULL AND NEW.correlated_operation_id IS DISTINCT FROM OLD.correlated_operation_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_notification_transition_ck', MESSAGE = 'Invalid provider notification transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_notifications_transition BEFORE UPDATE ON payment.psp_provider_notifications FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_notification_update();
--> statement-breakpoint
CREATE FUNCTION payment.guard_psp_evidence_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF NEW.submission_state <> 'PENDING_SUBMISSION' OR NEW.submission_executor_principal_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_evidence_transition_ck', MESSAGE = 'Provider evidence starts pending submission without an executor';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_evidence_insert BEFORE INSERT ON payment.psp_provider_evidence FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_evidence_insert();
--> statement-breakpoint
-- Evidence is append-only except two steps while it is PENDING_SUBMISSION: pinning the submission executor once
-- (nothing else changes), and the one terminal submission step (the pinned executor never changes).
CREATE FUNCTION payment.guard_psp_evidence_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
DECLARE
  submission_columns constant text[] := ARRAY['submission_state', 'observation_id', 'submitted_delivery_id', 'submitted_at'];
  executor_column constant text := 'submission_executor_principal_id';
BEGIN
  IF OLD.submission_state <> 'PENDING_SUBMISSION'
    OR NOT (
      (
        NEW.submission_state = 'PENDING_SUBMISSION' AND OLD.submission_executor_principal_id IS NULL
        AND NEW.submission_executor_principal_id IS NOT NULL
        AND (to_jsonb(NEW) - executor_column) IS NOT DISTINCT FROM (to_jsonb(OLD) - executor_column)
      )
      OR (
        NEW.submission_state <> 'PENDING_SUBMISSION'
        AND (to_jsonb(NEW) - submission_columns) IS NOT DISTINCT FROM (to_jsonb(OLD) - submission_columns)
      )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_psp_evidence_transition_ck', MESSAGE = 'Provider evidence is append-only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_psp_evidence_transition BEFORE UPDATE ON payment.psp_provider_evidence FOR EACH ROW EXECUTE FUNCTION payment.guard_psp_evidence_update();
--> statement-breakpoint
-- Internal helpers of the scoped routines. They are never executable by PUBLIC or the runtime role.
CREATE FUNCTION payment.psp_assert_worker_scope(p_tenant_id uuid, p_legal_entity_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Payment gateway routine scope mismatch';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_utc_text(p_instant timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT to_char(p_instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
--> statement-breakpoint
-- The advisory lock that serializes every ledger decision about one target operation (#1156 cancel race).
CREATE FUNCTION payment.psp_lock_operation(p_tenant_id uuid, p_operation_id uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('payment.psp.operation:' || p_tenant_id::text || ':' || p_operation_id::text, 0));
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_dispatch_json(p_dispatch payment.psp_provider_dispatches) RETURNS jsonb
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
CREATE FUNCTION payment.psp_evidence_json(p_evidence payment.psp_provider_evidence) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, payment, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'bindingId', p_evidence.binding_id,
    'deliveryId', p_evidence.delivery_id,
    'economicEffectKey', p_evidence.economic_effect_key,
    'environment', p_evidence.environment,
    'evidenceId', p_evidence.evidence_id,
    'evidenceOrigin', p_evidence.evidence_origin,
    'factFamily', p_evidence.fact_family,
    'factKind', p_evidence.fact_kind,
    'notificationId', p_evidence.notification_id,
    'observationId', p_evidence.observation_id,
    'observedAmountMinor', p_evidence.observed_amount_minor,
    'observedCurrency', p_evidence.observed_currency,
    'operationId', p_evidence.operation_id,
    'paymentId', p_evidence.payment_id,
    'providerAccountRef', p_evidence.provider_account_ref,
    'providerFamily', p_evidence.provider_family,
    'providerOccurredAt', payment.psp_utc_text(p_evidence.provider_occurred_at),
    'reason', p_evidence.reason,
    'receivedAt', payment.psp_utc_text(p_evidence.received_at),
    'recordedAt', payment.psp_utc_text(p_evidence.recorded_at),
    'sourceOccurrenceId', p_evidence.source_occurrence_id,
    'sourceRevision', p_evidence.source_revision,
    'submissionExecutorPrincipalId', p_evidence.submission_executor_principal_id,
    'submissionState', p_evidence.submission_state,
    'submittedAt', payment.psp_utc_text(p_evidence.submitted_at),
    'submittedDeliveryId', p_evidence.submitted_delivery_id,
    'verifiedAt', payment.psp_utc_text(p_evidence.verified_at)
  )) || jsonb_build_object('providerRefs', p_evidence.provider_refs)
    || CASE WHEN p_evidence.discrepancy IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('discrepancy', p_evidence.discrepancy) END;
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_notification_json(p_notification payment.psp_provider_notifications) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, payment, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'authenticity', p_notification.authenticity,
    'bindingId', p_notification.binding_id,
    'claimedStatus', p_notification.claimed_status,
    'correlatedOperationId', p_notification.correlated_operation_id,
    'deliveryIdentity', p_notification.delivery_identity,
    'environment', p_notification.environment,
    'notificationId', p_notification.notification_id,
    'processedAt', payment.psp_utc_text(p_notification.processed_at),
    'processedDeliveryId', p_notification.processed_delivery_id,
    'providerAccountRef', p_notification.provider_account_ref,
    'providerEventAt', payment.psp_utc_text(p_notification.provider_event_at),
    'providerFamily', p_notification.provider_family,
    'providerOccurrenceId', p_notification.provider_occurrence_id,
    'rawBody', replace(encode(p_notification.raw_body, 'base64'), E'\n', ''),
    'receivedAt', payment.psp_utc_text(p_notification.received_at),
    'state', p_notification.state,
    'transportDeliveryRef', p_notification.transport_delivery_ref,
    'verifiedAt', payment.psp_utc_text(p_notification.verified_at)
  )) || jsonb_build_object(
    'headers', p_notification.headers,
    'providerRefs', p_notification.provider_refs,
    'query', p_notification.query
  );
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_target_json(
  p_binding payment.psp_provider_account_bindings,
  p_credential payment.psp_credential_revisions,
  p_return_url text
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, payment, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'bindingId', p_binding.binding_id,
    'credentialRevision', p_credential.revision,
    'credentialSecretRef', p_credential.secret_ref,
    'credentialStatus', p_credential.status,
    'environment', p_binding.environment,
    'notificationUrl', p_binding.notification_url,
    'providerAccountRef', p_binding.provider_account_ref,
    'providerFamily', p_binding.provider_family,
    'returnUrl', p_return_url,
    'status', p_binding.status
  )) || jsonb_build_object('merchantIdentity', p_binding.merchant_identity);
$$;
--> statement-breakpoint
-- Why a worker-supplied dispatch identity does not belong to the C16 operation, or NULL when it does: the
-- operation exists in scope, the binding is exactly the operation's GATEWAY_ACCOUNT binding and (when given)
-- the material hash is the operation's C16 materialHash (plan D13).
CREATE FUNCTION payment.psp_dispatch_identity_conflict(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_material_hash text
) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, payment, pg_temp AS $$
DECLARE
  v_operation payment.payment_operations%ROWTYPE;
  v_binding payment.psp_provider_account_bindings%ROWTYPE;
BEGIN
  SELECT operation.* INTO v_operation FROM payment.payment_operations AS operation
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id AND operation.operation_id = p_operation_id;
  IF NOT FOUND THEN
    RETURN 'operation_unknown';
  END IF;
  SELECT binding.* INTO v_binding FROM payment.psp_provider_account_bindings AS binding
  WHERE binding.tenant_id = p_tenant_id AND binding.legal_entity_id = p_legal_entity_id AND binding.binding_id = p_binding_id;
  IF NOT FOUND THEN
    RETURN 'binding_unknown';
  END IF;
  IF v_operation.binding ->> '_tag' IS DISTINCT FROM 'GATEWAY_ACCOUNT'
    OR v_operation.binding ->> 'providerFamily' IS DISTINCT FROM v_binding.provider_family
    OR v_operation.binding ->> 'providerAccountRef' IS DISTINCT FROM v_binding.provider_account_ref
    OR v_operation.binding ->> 'environment' IS DISTINCT FROM v_binding.environment
  THEN
    RETURN 'binding_mismatch';
  END IF;
  IF p_material_hash IS NOT NULL AND p_material_hash IS DISTINCT FROM v_operation.material_hash THEN
    RETURN 'material_mismatch';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_insert_dispatch(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_state text,
  p_not_sent_reason text,
  p_origin_action_invocation_id uuid,
  p_origin_composition_revision text,
  p_worker_key text,
  p_delivery_id uuid
) RETURNS payment.psp_provider_dispatches
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
DECLARE
  v_dispatch payment.psp_provider_dispatches%ROWTYPE;
BEGIN
  INSERT INTO payment.psp_provider_dispatches (
    tenant_id, legal_entity_id, delivery_id, origin_action_invocation_id, origin_composition_revision, worker_key,
    binding_id, environment, material_hash, not_sent_reason, operation_id, operation_kind, order_reference,
    payment_id, provider_account_ref, provider_family, state, target_operation_id
  )
  SELECT p_tenant_id, p_legal_entity_id, p_delivery_id, p_origin_action_invocation_id, p_origin_composition_revision,
    p_worker_key, binding.binding_id, binding.environment, operation.material_hash, p_not_sent_reason,
    operation.operation_id, operation.kind, replace(operation.operation_id::text, '-', ''), operation.payment_id,
    binding.provider_account_ref, binding.provider_family, p_state, operation.target_operation_id
  FROM payment.payment_operations AS operation
  JOIN payment.psp_provider_account_bindings AS binding
    ON binding.tenant_id = operation.tenant_id AND binding.legal_entity_id = operation.legal_entity_id
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id AND binding.binding_id = p_binding_id
  RETURNING * INTO v_dispatch;
  RETURN v_dispatch;
END;
$$;
--> statement-breakpoint
-- Routine: the C16 operation and Payment facts the executor needs, and whether a CANCEL targets it. The
-- operation's creation time and original provenance let recovery check C16 lineage against the stored row.
CREATE FUNCTION payment.psp_read_operation_for_execution(p_tenant_id uuid, p_legal_entity_id uuid, p_operation_id uuid)
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
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id;
END;
$$;
--> statement-breakpoint
-- Routine: the exact binding of a historical or current operation (never a Current substitute), always with the
-- binding's current credential revision: a rotation authenticates the same account (#1158), so a dispatch's
-- recorded revision never selects a credential.
CREATE FUNCTION payment.psp_resolve_execution_target(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_provider_account_ref text,
  p_environment text,
  p_customer_configuration_id text
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT payment.psp_target_json(binding, credential, (
    SELECT enablement.return_url FROM payment.psp_gateway_enablements AS enablement
    WHERE enablement.tenant_id = binding.tenant_id AND enablement.legal_entity_id = binding.legal_entity_id
      AND enablement.customer_configuration_id = p_customer_configuration_id
      AND enablement.provider_family = binding.provider_family AND enablement.binding_id = binding.binding_id
  ))
  FROM payment.psp_provider_account_bindings AS binding
  JOIN payment.psp_credential_revisions AS credential
    ON credential.tenant_id = binding.tenant_id AND credential.legal_entity_id = binding.legal_entity_id
    AND credential.binding_id = binding.binding_id
    AND credential.revision = binding.current_credential_revision
  WHERE binding.tenant_id = p_tenant_id AND binding.legal_entity_id = p_legal_entity_id
    AND binding.provider_account_ref = p_provider_account_ref AND binding.environment = p_environment;
END;
$$;
--> statement-breakpoint
-- Routine: the binding a captured notification was addressed to, with its current credential revision.
CREATE FUNCTION payment.psp_resolve_notification_binding(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_provider_account_ref text,
  p_environment text
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT payment.psp_target_json(binding, credential, NULL)
  FROM payment.psp_provider_account_bindings AS binding
  JOIN payment.psp_credential_revisions AS credential
    ON credential.tenant_id = binding.tenant_id AND credential.legal_entity_id = binding.legal_entity_id
    AND credential.binding_id = binding.binding_id AND credential.revision = binding.current_credential_revision
  WHERE binding.tenant_id = p_tenant_id AND binding.legal_entity_id = p_legal_entity_id
    AND binding.provider_account_ref = p_provider_account_ref AND binding.environment = p_environment;
END;
$$;
--> statement-breakpoint
-- Routine: registers a CANCEL as AWAITING_TARGET under the target operation's advisory lock and reports the
-- target's ledger row read under the same lock (#1156 "Cancellation races with collection").
CREATE FUNCTION payment.psp_register_cancel(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_material_hash text,
  p_origin_action_invocation_id uuid,
  p_origin_composition_revision text,
  p_worker_key text,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_conflict text;
  v_operation payment.payment_operations%ROWTYPE;
  v_cancel payment.psp_provider_dispatches%ROWTYPE;
  v_target payment.psp_provider_dispatches%ROWTYPE;
  v_outcome text := 'EXISTING';
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  SELECT operation.* INTO v_operation FROM payment.payment_operations AS operation
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id;
  IF NOT FOUND OR v_operation.kind <> 'CANCEL_OR_VOID' THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'operation_unknown');
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM payment.psp_lock_operation(p_tenant_id, v_operation.target_operation_id);
  v_conflict := payment.psp_dispatch_identity_conflict(p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, p_material_hash);
  IF v_conflict IS NOT NULL THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', v_conflict);
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT dispatch.* INTO v_cancel FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_cancel.binding_id <> p_binding_id OR v_cancel.material_hash <> p_material_hash THEN
      result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'material_mismatch');
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    v_cancel := payment.psp_insert_dispatch(
      p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, 'AWAITING_TARGET', NULL,
      p_origin_action_invocation_id, p_origin_composition_revision, p_worker_key, p_delivery_id
    );
    v_outcome := 'REGISTERED';
  END IF;
  SELECT dispatch.* INTO v_target FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.operation_id = v_operation.target_operation_id;
  result := jsonb_build_object('_tag', v_outcome, 'cancel', payment.psp_dispatch_json(v_cancel))
    || CASE WHEN v_target.dispatch_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('target', payment.psp_dispatch_json(v_target)) END;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Refunds per provider payment are serialized (GoPay/Comgate). A refund is unresolved while it is prepared,
-- unknown, or acknowledged without definitive refund evidence.
CREATE FUNCTION payment.psp_unresolved_refund_ids(
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
      OR (refund.state = 'ACKNOWLEDGED' AND NOT EXISTS (
        SELECT 1 FROM payment.psp_provider_evidence AS evidence
        WHERE evidence.tenant_id = refund.tenant_id AND evidence.legal_entity_id = refund.legal_entity_id
          AND evidence.operation_id = refund.operation_id
          AND evidence.fact_kind IN ('REFUND_CONFIRMED', 'REFUND_NOT_EFFECTED')
      ))
    );
$$;
--> statement-breakpoint
-- Routine: persists the prepared provider request before the first send (#1158). It returns PREPARED,
-- EXISTING (same request), WITHHELD (a CANCEL targets this COLLECT), DEFERRED (a GoPay/Comgate REFUND while
-- another refund of the same provider payment is unresolved, decided under the target's lock) or CONFLICT
-- (changed material/request).
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
  result := jsonb_build_object('_tag', 'PREPARED', 'record', payment.psp_dispatch_json(v_dispatch));
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Routine: records the provider response (or its absence) of a prepared dispatch, or TARGET_UNRESOLVED for a
-- cancel whose target never resolved. A repeated identical record is UNCHANGED; an illegal one is CONFLICT.
CREATE FUNCTION payment.psp_record_dispatch_outcome(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_to_state text,
  p_provider_payment_ref text,
  p_provider_refund_ref text,
  p_customer_redirect_url text,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_dispatch payment.psp_provider_dispatches%ROWTYPE;
  v_operation_lock uuid;
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  SELECT coalesce(operation.target_operation_id, operation.operation_id) INTO v_operation_lock
  FROM payment.payment_operations AS operation
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id;
  IF v_operation_lock IS NOT NULL THEN
    PERFORM payment.psp_lock_operation(p_tenant_id, v_operation_lock);
  END IF;
  SELECT dispatch.* INTO v_dispatch FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    result := jsonb_build_object('_tag', 'NOT_FOUND');
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_dispatch.state = p_to_state
    AND (p_provider_payment_ref IS NULL OR p_provider_payment_ref IS NOT DISTINCT FROM v_dispatch.provider_payment_ref)
    AND (p_provider_refund_ref IS NULL OR p_provider_refund_ref IS NOT DISTINCT FROM v_dispatch.provider_refund_ref)
    AND (p_customer_redirect_url IS NULL OR p_customer_redirect_url IS NOT DISTINCT FROM v_dispatch.customer_redirect_url)
  THEN
    result := jsonb_build_object('_tag', 'UNCHANGED', 'record', payment.psp_dispatch_json(v_dispatch));
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_to_state NOT IN ('ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN', 'TARGET_UNRESOLVED')
    OR NOT (
      (v_dispatch.state = 'AWAITING_TARGET' AND p_to_state = 'TARGET_UNRESOLVED')
      OR (v_dispatch.state = 'PREPARED' AND p_to_state IN ('ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN'))
      OR (v_dispatch.state = 'OUTCOME_UNKNOWN' AND p_to_state IN ('ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT'))
    )
    OR (p_to_state <> 'ACKNOWLEDGED' AND (p_provider_refund_ref IS NOT NULL OR p_customer_redirect_url IS NOT NULL))
    OR (v_dispatch.provider_payment_ref IS NOT NULL AND p_provider_payment_ref IS NOT NULL AND p_provider_payment_ref <> v_dispatch.provider_payment_ref)
  THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'illegal_transition', 'record', payment.psp_dispatch_json(v_dispatch));
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE payment.psp_provider_dispatches AS dispatch
  SET state = p_to_state,
    provider_payment_ref = coalesce(dispatch.provider_payment_ref, p_provider_payment_ref),
    provider_refund_ref = coalesce(dispatch.provider_refund_ref, p_provider_refund_ref),
    customer_redirect_url = coalesce(dispatch.customer_redirect_url, p_customer_redirect_url),
    responded_at = CASE WHEN p_to_state = 'TARGET_UNRESOLVED' THEN NULL ELSE now() END,
    transition_delivery_id = p_delivery_id,
    transitioned_at = now()
  WHERE dispatch.dispatch_id = v_dispatch.dispatch_id
  RETURNING * INTO v_dispatch;
  result := jsonb_build_object('_tag', 'RECORDED', 'record', payment.psp_dispatch_json(v_dispatch));
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Shared body of the two "never sent" records: inserts the terminal row, or moves a registered cancel there.
CREATE FUNCTION payment.psp_record_unsent(
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
  RETURN jsonb_build_object('_tag', 'RECORDED', 'record', payment.psp_dispatch_json(v_dispatch));
END;
$$;
--> statement-breakpoint
-- Routine: an operation that was never sent (withheld, target withheld/not effected, prepare unavailable).
CREATE FUNCTION payment.psp_record_not_sent(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_material_hash text,
  p_not_sent_reason text,
  p_origin_action_invocation_id uuid,
  p_origin_composition_revision text,
  p_worker_key text,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  result := payment.psp_record_unsent(
    p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, p_material_hash, 'NOT_SENT', p_not_sent_reason,
    p_origin_action_invocation_id, p_origin_composition_revision, p_worker_key, p_delivery_id
  );
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Routine: the provider family cannot perform this operation (for example a GoPay cancel, N8). No fallback.
CREATE FUNCTION payment.psp_record_unsupported(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_material_hash text,
  p_origin_action_invocation_id uuid,
  p_origin_composition_revision text,
  p_worker_key text,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  result := payment.psp_record_unsent(
    p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, p_material_hash, 'UNSUPPORTED', NULL,
    p_origin_action_invocation_id, p_origin_composition_revision, p_worker_key, p_delivery_id
  );
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Routine: a lookup-verified order reference proves that a dispatch whose response was lost reached the
-- provider (#1157 "Create response lost then notification arrives"). Only inside the exact binding.
CREATE FUNCTION payment.psp_correlate_unknown_dispatch(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_order_reference text,
  p_provider_payment_ref text,
  p_provider_refund_ref text,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_dispatch payment.psp_provider_dispatches%ROWTYPE;
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  SELECT dispatch.* INTO v_dispatch FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.binding_id = p_binding_id AND dispatch.order_reference = p_order_reference;
  IF NOT FOUND THEN
    result := jsonb_build_object('_tag', 'NOT_FOUND');
    RETURN NEXT;
    RETURN;
  END IF;
  PERFORM payment.psp_lock_operation(p_tenant_id, coalesce(v_dispatch.target_operation_id, v_dispatch.operation_id));
  SELECT dispatch.* INTO v_dispatch FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.dispatch_id = v_dispatch.dispatch_id
  FOR UPDATE;
  IF (p_provider_payment_ref IS NULL AND p_provider_refund_ref IS NULL)
    OR (v_dispatch.provider_payment_ref IS NOT NULL AND p_provider_payment_ref IS NOT NULL AND v_dispatch.provider_payment_ref <> p_provider_payment_ref)
    OR (v_dispatch.provider_refund_ref IS NOT NULL AND p_provider_refund_ref IS NOT NULL AND v_dispatch.provider_refund_ref <> p_provider_refund_ref)
    OR v_dispatch.state NOT IN ('PREPARED', 'OUTCOME_UNKNOWN', 'ACKNOWLEDGED')
  THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'correlation_mismatch', 'record', payment.psp_dispatch_json(v_dispatch));
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_dispatch.state = 'ACKNOWLEDGED'
    AND (p_provider_payment_ref IS NULL OR v_dispatch.provider_payment_ref IS NOT NULL)
    AND (p_provider_refund_ref IS NULL OR v_dispatch.provider_refund_ref IS NOT NULL)
  THEN
    result := jsonb_build_object('_tag', 'ALREADY_CORRELATED', 'record', payment.psp_dispatch_json(v_dispatch));
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_dispatch.state = 'ACKNOWLEDGED' THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'correlation_mismatch', 'record', payment.psp_dispatch_json(v_dispatch));
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE payment.psp_provider_dispatches AS dispatch
  SET state = 'ACKNOWLEDGED',
    provider_payment_ref = coalesce(dispatch.provider_payment_ref, p_provider_payment_ref),
    provider_refund_ref = coalesce(dispatch.provider_refund_ref, p_provider_refund_ref),
    responded_at = now(),
    transition_delivery_id = p_delivery_id,
    transitioned_at = now()
  WHERE dispatch.dispatch_id = v_dispatch.dispatch_id
  RETURNING * INTO v_dispatch;
  result := jsonb_build_object('_tag', 'CORRELATED', 'record', payment.psp_dispatch_json(v_dispatch));
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_read_dispatch(p_tenant_id uuid, p_legal_entity_id uuid, p_operation_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT payment.psp_dispatch_json(dispatch) FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.operation_id = p_operation_id;
END;
$$;
--> statement-breakpoint
-- Routine: every dispatch of one binding that names this provider payment or refund object.
CREATE FUNCTION payment.psp_read_dispatch_by_provider_ref(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_provider_ref text
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT payment.psp_dispatch_json(dispatch) FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.binding_id = p_binding_id
    AND (dispatch.provider_payment_ref = p_provider_ref OR dispatch.provider_refund_ref = p_provider_ref)
  ORDER BY dispatch.recorded_at, dispatch.operation_id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_read_dispatch_by_order_reference(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_order_reference text
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT payment.psp_dispatch_json(dispatch) FROM payment.psp_provider_dispatches AS dispatch
  WHERE dispatch.tenant_id = p_tenant_id AND dispatch.legal_entity_id = p_legal_entity_id
    AND dispatch.binding_id = p_binding_id AND dispatch.order_reference = p_order_reference;
END;
$$;
--> statement-breakpoint
-- Routine: refunds per provider payment are serialized (GoPay/Comgate); see psp_unresolved_refund_ids.
CREATE FUNCTION payment.psp_has_unresolved_refund(
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
  result := jsonb_build_object('operationIds', to_jsonb(v_unresolved), 'unresolved', cardinality(v_unresolved) > 0);
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Routine: appends provider evidence idempotently on its source occurrence; a different operation or statement
-- under the same occurrence and revision is a CONFLICT and is never overwritten. received_at is the captured
-- notification's receipt (the notification must belong to the same binding) or, without one, the observation
-- instant; verified_at is the observation instant. A repeat keeps the first row's instants and notification.
CREATE FUNCTION payment.psp_append_evidence(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_operation_id uuid,
  p_binding_id uuid,
  p_evidence_origin text,
  p_fact_kind text,
  p_fact_family text,
  p_provider_refs jsonb,
  p_observed_amount_minor bigint,
  p_observed_currency text,
  p_source_occurrence_id text,
  p_source_revision bigint,
  p_provider_occurred_at timestamptz,
  p_observed_at timestamptz,
  p_economic_effect_key text,
  p_discrepancy jsonb,
  p_reason text,
  p_notification_id uuid,
  p_origin_action_invocation_id uuid,
  p_origin_composition_revision text,
  p_worker_key text,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_conflict text;
  v_received_at timestamptz := p_observed_at;
  v_evidence payment.psp_provider_evidence%ROWTYPE;
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  v_conflict := payment.psp_dispatch_identity_conflict(p_tenant_id, p_legal_entity_id, p_operation_id, p_binding_id, NULL);
  IF v_conflict IS NULL AND p_notification_id IS NOT NULL THEN
    SELECT notification.received_at INTO v_received_at FROM payment.psp_provider_notifications AS notification
    WHERE notification.tenant_id = p_tenant_id AND notification.legal_entity_id = p_legal_entity_id
      AND notification.binding_id = p_binding_id AND notification.notification_id = p_notification_id;
    IF NOT FOUND THEN
      v_conflict := 'notification_unknown';
    END IF;
  END IF;
  IF v_conflict IS NOT NULL THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', v_conflict);
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO payment.psp_provider_evidence (
    tenant_id, legal_entity_id, delivery_id, origin_action_invocation_id, origin_composition_revision, worker_key,
    binding_id, discrepancy, economic_effect_key, environment, evidence_origin, fact_family, fact_kind,
    notification_id, observed_amount_minor, observed_currency, operation_id, payment_id, provider_account_ref,
    provider_family, provider_occurred_at, provider_refs, reason, received_at, source_occurrence_id, source_revision,
    submission_state, verified_at
  )
  SELECT p_tenant_id, p_legal_entity_id, p_delivery_id, p_origin_action_invocation_id, p_origin_composition_revision,
    p_worker_key, binding.binding_id, p_discrepancy, p_economic_effect_key, binding.environment, p_evidence_origin,
    p_fact_family, p_fact_kind, p_notification_id, p_observed_amount_minor, p_observed_currency,
    operation.operation_id, operation.payment_id, binding.provider_account_ref, binding.provider_family,
    p_provider_occurred_at, p_provider_refs, p_reason, v_received_at, p_source_occurrence_id, p_source_revision,
    'PENDING_SUBMISSION', p_observed_at
  FROM payment.payment_operations AS operation
  JOIN payment.psp_provider_account_bindings AS binding
    ON binding.tenant_id = operation.tenant_id AND binding.legal_entity_id = operation.legal_entity_id
  WHERE operation.tenant_id = p_tenant_id AND operation.legal_entity_id = p_legal_entity_id
    AND operation.operation_id = p_operation_id AND binding.binding_id = p_binding_id
  ON CONFLICT ON CONSTRAINT payment_psp_evidence_occurrence_uk DO NOTHING
  RETURNING * INTO v_evidence;
  IF v_evidence.evidence_id IS NOT NULL THEN
    result := jsonb_build_object('_tag', 'APPENDED', 'record', payment.psp_evidence_json(v_evidence));
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT evidence.* INTO v_evidence FROM payment.psp_provider_evidence AS evidence
  WHERE evidence.tenant_id = p_tenant_id AND evidence.legal_entity_id = p_legal_entity_id
    AND evidence.binding_id = p_binding_id AND evidence.source_occurrence_id = p_source_occurrence_id
    AND evidence.source_revision = p_source_revision;
  IF v_evidence.operation_id IS DISTINCT FROM p_operation_id
    OR v_evidence.evidence_origin IS DISTINCT FROM p_evidence_origin
    OR v_evidence.fact_kind IS DISTINCT FROM p_fact_kind
    OR v_evidence.fact_family IS DISTINCT FROM p_fact_family
    OR v_evidence.provider_refs IS DISTINCT FROM p_provider_refs
    OR v_evidence.observed_amount_minor IS DISTINCT FROM p_observed_amount_minor
    OR v_evidence.observed_currency IS DISTINCT FROM p_observed_currency
    OR v_evidence.provider_occurred_at IS DISTINCT FROM p_provider_occurred_at
    OR v_evidence.economic_effect_key IS DISTINCT FROM p_economic_effect_key
    OR v_evidence.discrepancy IS DISTINCT FROM p_discrepancy
    OR v_evidence.reason IS DISTINCT FROM p_reason
  THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'occurrence_mismatch', 'record', payment.psp_evidence_json(v_evidence));
  ELSE
    result := jsonb_build_object('_tag', 'EXISTING', 'record', payment.psp_evidence_json(v_evidence));
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_list_pending_evidence(p_tenant_id uuid, p_legal_entity_id uuid, p_operation_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT payment.psp_evidence_json(evidence) FROM payment.psp_provider_evidence AS evidence
  WHERE evidence.tenant_id = p_tenant_id AND evidence.legal_entity_id = p_legal_entity_id
    AND evidence.operation_id = p_operation_id AND evidence.submission_state = 'PENDING_SUBMISSION'
  ORDER BY evidence.recorded_at, evidence.evidence_id;
END;
$$;
--> statement-breakpoint
-- Routine: records the one governed submission outcome of a pending evidence row. Idempotent.
CREATE FUNCTION payment.psp_mark_evidence_submission(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_evidence_id uuid,
  p_submission_state text,
  p_observation_id uuid,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_evidence payment.psp_provider_evidence%ROWTYPE;
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  SELECT evidence.* INTO v_evidence FROM payment.psp_provider_evidence AS evidence
  WHERE evidence.tenant_id = p_tenant_id AND evidence.legal_entity_id = p_legal_entity_id
    AND evidence.evidence_id = p_evidence_id
  FOR UPDATE;
  IF NOT FOUND THEN
    result := jsonb_build_object('_tag', 'NOT_FOUND');
  ELSIF v_evidence.submission_state = p_submission_state
    AND v_evidence.observation_id IS NOT DISTINCT FROM p_observation_id
  THEN
    result := jsonb_build_object('_tag', 'UNCHANGED', 'record', payment.psp_evidence_json(v_evidence));
  ELSIF v_evidence.submission_state <> 'PENDING_SUBMISSION' OR p_submission_state = 'PENDING_SUBMISSION'
    OR (p_observation_id IS NOT NULL AND p_submission_state = 'DENIED')
  THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'illegal_transition', 'record', payment.psp_evidence_json(v_evidence));
  ELSE
    UPDATE payment.psp_provider_evidence AS evidence
    SET submission_state = p_submission_state, observation_id = p_observation_id,
      submitted_delivery_id = p_delivery_id, submitted_at = now()
    WHERE evidence.evidence_id = v_evidence.evidence_id
    RETURNING * INTO v_evidence;
    result := jsonb_build_object('_tag', 'MARKED', 'record', payment.psp_evidence_json(v_evidence));
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- Routine: pins the system principal Shell chose for the first submission attempt of a pending evidence row, so
-- every retry asks Shell for exactly that executor. Write-once; another principal is CONFLICT executor_mismatch.
CREATE FUNCTION payment.psp_pin_evidence_submission_executor(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_evidence_id uuid,
  p_principal_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_evidence payment.psp_provider_evidence%ROWTYPE;
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  SELECT evidence.* INTO v_evidence FROM payment.psp_provider_evidence AS evidence
  WHERE evidence.tenant_id = p_tenant_id AND evidence.legal_entity_id = p_legal_entity_id
    AND evidence.evidence_id = p_evidence_id
  FOR UPDATE;
  IF NOT FOUND THEN
    result := jsonb_build_object('_tag', 'NOT_FOUND');
  ELSIF v_evidence.submission_executor_principal_id = p_principal_id THEN
    result := jsonb_build_object('_tag', 'UNCHANGED', 'record', payment.psp_evidence_json(v_evidence));
  ELSIF v_evidence.submission_executor_principal_id IS NOT NULL THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'executor_mismatch', 'record', payment.psp_evidence_json(v_evidence));
  ELSIF v_evidence.submission_state <> 'PENDING_SUBMISSION' OR p_principal_id IS NULL THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'illegal_transition', 'record', payment.psp_evidence_json(v_evidence));
  ELSE
    UPDATE payment.psp_provider_evidence AS evidence
    SET submission_executor_principal_id = p_principal_id
    WHERE evidence.evidence_id = v_evidence.evidence_id
    RETURNING * INTO v_evidence;
    result := jsonb_build_object('_tag', 'PINNED', 'record', payment.psp_evidence_json(v_evidence));
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION payment.psp_read_notification(p_tenant_id uuid, p_legal_entity_id uuid, p_notification_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT payment.psp_notification_json(notification) FROM payment.psp_provider_notifications AS notification
  WHERE notification.tenant_id = p_tenant_id AND notification.legal_entity_id = p_legal_entity_id
    AND notification.notification_id = p_notification_id;
END;
$$;
--> statement-breakpoint
-- Routine: advances a captured notification's processing state. Idempotent; illegal moves are CONFLICT.
CREATE FUNCTION payment.psp_transition_notification(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_notification_id uuid,
  p_to_state text,
  p_correlated_operation_id uuid,
  p_delivery_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_notification payment.psp_provider_notifications%ROWTYPE;
  v_binding_conflict text;
BEGIN
  PERFORM payment.psp_assert_worker_scope(p_tenant_id, p_legal_entity_id);
  SELECT notification.* INTO v_notification FROM payment.psp_provider_notifications AS notification
  WHERE notification.tenant_id = p_tenant_id AND notification.legal_entity_id = p_legal_entity_id
    AND notification.notification_id = p_notification_id
  FOR UPDATE;
  IF FOUND AND p_correlated_operation_id IS NOT NULL THEN
    -- The correlated operation must be executed through exactly the binding the notification was captured for.
    v_binding_conflict := payment.psp_dispatch_identity_conflict(
      p_tenant_id, p_legal_entity_id, p_correlated_operation_id, v_notification.binding_id, NULL
    );
  END IF;
  IF NOT FOUND THEN
    result := jsonb_build_object('_tag', 'NOT_FOUND');
  ELSIF v_binding_conflict IS NOT NULL THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', v_binding_conflict, 'record', payment.psp_notification_json(v_notification));
  ELSIF v_notification.state = p_to_state
    AND v_notification.correlated_operation_id IS NOT DISTINCT FROM p_correlated_operation_id
  THEN
    result := jsonb_build_object('_tag', 'UNCHANGED', 'record', payment.psp_notification_json(v_notification));
  ELSIF NOT (
      (v_notification.state = 'CAPTURED' AND p_to_state IN ('HELD_UNCORRELATED', 'SUBMITTED', 'SUBMISSION_HELD', 'SUBMISSION_DENIED'))
      OR (v_notification.state = 'HELD_UNCORRELATED' AND p_to_state IN ('SUBMITTED', 'SUBMISSION_HELD', 'SUBMISSION_DENIED'))
      OR (v_notification.state = 'SUBMISSION_HELD' AND p_to_state IN ('SUBMITTED', 'SUBMISSION_DENIED'))
    )
    OR (p_to_state = 'HELD_UNCORRELATED' AND p_correlated_operation_id IS NOT NULL)
    OR (v_notification.correlated_operation_id IS NOT NULL AND p_correlated_operation_id IS DISTINCT FROM v_notification.correlated_operation_id)
  THEN
    result := jsonb_build_object('_tag', 'CONFLICT', 'reason', 'illegal_transition', 'record', payment.psp_notification_json(v_notification));
  ELSE
    UPDATE payment.psp_provider_notifications AS notification
    SET state = p_to_state, correlated_operation_id = p_correlated_operation_id,
      processed_delivery_id = p_delivery_id, processed_at = now()
    WHERE notification.notification_id = v_notification.notification_id
    RETURNING * INTO v_notification;
    result := jsonb_build_object('_tag', 'TRANSITIONED', 'record', payment.psp_notification_json(v_notification));
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  payment.guard_psp_binding_update(),
  payment.require_psp_binding_credential(),
  payment.guard_psp_credential_update(),
  payment.guard_psp_enablement_update(),
  payment.guard_psp_dispatch_insert(),
  payment.guard_psp_dispatch_update(),
  payment.guard_psp_notification_insert(),
  payment.guard_psp_notification_update(),
  payment.guard_psp_evidence_insert(),
  payment.guard_psp_evidence_update(),
  payment.psp_assert_worker_scope(uuid, uuid),
  payment.psp_utc_text(timestamptz),
  payment.psp_lock_operation(uuid, uuid),
  payment.psp_dispatch_json(payment.psp_provider_dispatches),
  payment.psp_evidence_json(payment.psp_provider_evidence),
  payment.psp_notification_json(payment.psp_provider_notifications),
  payment.psp_target_json(payment.psp_provider_account_bindings, payment.psp_credential_revisions, text),
  payment.psp_dispatch_identity_conflict(uuid, uuid, uuid, uuid, text),
  payment.psp_insert_dispatch(uuid, uuid, uuid, uuid, text, text, uuid, text, text, uuid),
  payment.psp_record_unsent(uuid, uuid, uuid, uuid, text, text, text, uuid, text, text, uuid),
  payment.psp_unresolved_refund_ids(uuid, uuid, uuid, text, uuid)
FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  payment.psp_read_operation_for_execution(uuid, uuid, uuid),
  payment.psp_resolve_execution_target(uuid, uuid, text, text, text),
  payment.psp_resolve_notification_binding(uuid, uuid, text, text),
  payment.psp_register_cancel(uuid, uuid, uuid, uuid, text, uuid, text, text, uuid),
  payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, uuid, text, text, uuid),
  payment.psp_record_dispatch_outcome(uuid, uuid, uuid, text, text, text, text, uuid),
  payment.psp_record_not_sent(uuid, uuid, uuid, uuid, text, text, uuid, text, text, uuid),
  payment.psp_record_unsupported(uuid, uuid, uuid, uuid, text, uuid, text, text, uuid),
  payment.psp_correlate_unknown_dispatch(uuid, uuid, uuid, text, text, text, uuid),
  payment.psp_read_dispatch(uuid, uuid, uuid),
  payment.psp_read_dispatch_by_provider_ref(uuid, uuid, uuid, text),
  payment.psp_read_dispatch_by_order_reference(uuid, uuid, uuid, text),
  payment.psp_has_unresolved_refund(uuid, uuid, uuid, text, uuid),
  payment.psp_append_evidence(uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, text, text, bigint, timestamptz, timestamptz, text, jsonb, text, uuid, uuid, text, text, uuid),
  payment.psp_list_pending_evidence(uuid, uuid, uuid),
  payment.psp_mark_evidence_submission(uuid, uuid, uuid, text, uuid, uuid),
  payment.psp_pin_evidence_submission_executor(uuid, uuid, uuid, uuid),
  payment.psp_read_notification(uuid, uuid, uuid),
  payment.psp_transition_notification(uuid, uuid, uuid, text, uuid, uuid)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  payment.psp_read_operation_for_execution(uuid, uuid, uuid),
  payment.psp_resolve_execution_target(uuid, uuid, text, text, text),
  payment.psp_resolve_notification_binding(uuid, uuid, text, text),
  payment.psp_register_cancel(uuid, uuid, uuid, uuid, text, uuid, text, text, uuid),
  payment.psp_prepare_dispatch(uuid, uuid, uuid, uuid, text, integer, text, text, text, text, text, jsonb, integer, text, uuid, text, text, uuid),
  payment.psp_record_dispatch_outcome(uuid, uuid, uuid, text, text, text, text, uuid),
  payment.psp_record_not_sent(uuid, uuid, uuid, uuid, text, text, uuid, text, text, uuid),
  payment.psp_record_unsupported(uuid, uuid, uuid, uuid, text, uuid, text, text, uuid),
  payment.psp_correlate_unknown_dispatch(uuid, uuid, uuid, text, text, text, uuid),
  payment.psp_read_dispatch(uuid, uuid, uuid),
  payment.psp_read_dispatch_by_provider_ref(uuid, uuid, uuid, text),
  payment.psp_read_dispatch_by_order_reference(uuid, uuid, uuid, text),
  payment.psp_has_unresolved_refund(uuid, uuid, uuid, text, uuid),
  payment.psp_append_evidence(uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, text, text, bigint, timestamptz, timestamptz, text, jsonb, text, uuid, uuid, text, text, uuid),
  payment.psp_list_pending_evidence(uuid, uuid, uuid),
  payment.psp_mark_evidence_submission(uuid, uuid, uuid, text, uuid, uuid),
  payment.psp_pin_evidence_submission_executor(uuid, uuid, uuid, uuid),
  payment.psp_read_notification(uuid, uuid, uuid),
  payment.psp_transition_notification(uuid, uuid, uuid, text, uuid, uuid)
TO ontos_runtime;
