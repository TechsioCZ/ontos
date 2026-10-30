-- Proof work may settle FAILED with Pricing's authenticated expiry of the exact Quotation
-- (reference and validity interval) retained by its Bundle, so it no longer stays pending.
CREATE OR REPLACE FUNCTION commerce_order.guard_finalization_intent_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_order, pg_temp AS $$
DECLARE
  instant_pattern constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$';
  quotation_valid_until timestamptz;
  quotation_evaluated_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.result IS NOT NULL OR NEW.proof_ref IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_transition_ck', MESSAGE = 'Finalization intent must start pending';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.intent_id, NEW.buyer_principal_id,
         NEW.stage, NEW.business_key, NEW.input_hash, NEW.attempt_id, NEW.data)
      IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.intent_id, OLD.buyer_principal_id,
         OLD.stage, OLD.business_key, OLD.input_hash, OLD.attempt_id, OLD.data)
    OR OLD.status <> 'PENDING' OR NEW.status NOT IN ('COMPLETE', 'FAILED') OR NEW.result IS NULL
    OR (NEW.status = 'FAILED' AND NEW.proof_ref IS NOT NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_transition_ck', MESSAGE = 'Invalid finalization intent transition';
  END IF;

  IF NEW.stage = 'PREPARE' AND NEW.status = 'FAILED' THEN
    -- Owner completion obtains Pricing's authenticated expiry of the exact retained
    -- Quotation. It closes preparation only before any Attempt exists for the intent.
    quotation_valid_until := CASE WHEN NEW.result#>>'{pricing,validity,validUntil}' ~ instant_pattern
      THEN (NEW.result#>>'{pricing,validity,validUntil}')::timestamptz END;
    quotation_evaluated_at := CASE WHEN NEW.result#>>'{pricing,evaluatedAt}' ~ instant_pattern
      THEN (NEW.result#>>'{pricing,evaluatedAt}')::timestamptz END;
    IF NEW.result->>'kind' IS DISTINCT FROM 'PREPARATION_QUOTATION_EXPIRED'
      OR NEW.result->>'quotationRef' IS NULL
      OR NEW.result->>'quotationRef' IS DISTINCT FROM NEW.data#>>'{input,quotationRef}'
      OR NEW.result#>>'{pricing,_tag}' IS DISTINCT FROM 'EXPIRED'
      OR NEW.result#>>'{pricing,quotationRef}' IS DISTINCT FROM NEW.result->>'quotationRef'
      OR NEW.result#>>'{authenticityEvidence,quotationRef}' IS DISTINCT FROM NEW.result->>'quotationRef'
      OR NEW.result#>>'{authenticityEvidence,verifiedAt}' IS DISTINCT FROM NEW.result#>>'{pricing,evaluatedAt}'
      OR quotation_valid_until IS NULL OR quotation_evaluated_at IS NULL
      OR quotation_evaluated_at < quotation_valid_until
      OR quotation_valid_until > clock_timestamp()
      OR EXISTS (
        SELECT 1 FROM commerce_order.commitment_attempts a
        WHERE a.tenant_id = NEW.tenant_id AND a.legal_entity_id = NEW.legal_entity_id
          AND a.buyer_principal_id = NEW.buyer_principal_id
          AND a.commitment_correlation_id = NEW.data#>>'{input,commitmentCorrelationId}'
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_failure_ck', MESSAGE = 'Preparation expiry witness does not match its original Quotation';
    END IF;
  ELSIF NEW.stage = 'PREPARE' THEN
    IF NEW.result->>'status' IS DISTINCT FROM 'PREPARED'
      OR NEW.result#>>'{intentRef,moduleId}' IS DISTINCT FROM 'commerce.order'
      OR NEW.result#>>'{intentRef,resourceType}' IS DISTINCT FROM 'commerce.order.finalization-intent'
      OR NEW.result#>>'{intentRef,resourceId}' IS DISTINCT FROM NEW.intent_id
      OR (NEW.result#>>'{intentRef,tenantId}')::uuid IS DISTINCT FROM NEW.tenant_id
      OR NEW.result#>>'{binding,bundleVersion}' IS DISTINCT FROM 'order-acceptance-bundle.v1'
      OR NEW.result#>>'{binding,attemptRef,moduleId}' IS DISTINCT FROM 'commerce.order'
      OR NEW.result#>>'{binding,attemptRef,resourceType}' IS DISTINCT FROM 'commerce.order.commitment-attempt'
      OR NEW.result#>>'{binding,bundleRef,moduleId}' IS DISTINCT FROM 'commerce.order'
      OR NEW.result#>>'{binding,bundleRef,resourceType}' IS DISTINCT FROM 'commerce.order.acceptance-bundle'
      OR (NEW.result#>>'{binding,attemptRef,tenantId}')::uuid IS DISTINCT FROM NEW.tenant_id
      OR (NEW.result#>>'{binding,bundleRef,tenantId}')::uuid IS DISTINCT FROM NEW.tenant_id
      OR NOT EXISTS (
        SELECT 1 FROM commerce_order.commitment_attempts a
        WHERE a.tenant_id = NEW.tenant_id AND a.legal_entity_id = NEW.legal_entity_id
          AND a.buyer_principal_id = NEW.buyer_principal_id
          AND a.attempt_id = NEW.result#>>'{binding,attemptRef,resourceId}'
          AND a.bundle_id = NEW.result#>>'{binding,bundleRef,resourceId}'
          AND a.bundle_hash = NEW.result#>>'{binding,bundleHash}'
          AND a.status = 'READY' AND a.order_id IS NULL
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_preparation_ck', MESSAGE = 'Finalization completion does not match its prepared Attempt';
    END IF;
  ELSIF NEW.status = 'COMPLETE' THEN
    IF NEW.proof_ref IS NULL
      OR NEW.result#>>'{approvalEvidence,proof,revalidationRef,resourceId}' IS DISTINCT FROM NEW.proof_ref
      OR NEW.result#>'{approvalEvidence,proof,evidence,finalBindingEvidence,binding}' IS DISTINCT FROM NEW.data->'binding'
      OR NOT EXISTS (
        SELECT 1 FROM commerce_order.commitment_attempts a
        WHERE a.tenant_id = NEW.tenant_id AND a.legal_entity_id = NEW.legal_entity_id
          AND a.buyer_principal_id = NEW.buyer_principal_id
          AND a.attempt_id = NEW.attempt_id
          AND a.attempt_id = NEW.data#>>'{binding,attemptRef,resourceId}'
          AND a.bundle_id = NEW.data#>>'{binding,bundleRef,resourceId}'
          AND a.bundle_hash = NEW.data#>>'{binding,bundleHash}'
          AND a.revision = (NEW.data->>'expectedRevision')::integer
          AND a.status IN ('READY', 'PRECOMMIT_FAILED') AND a.order_id IS NULL
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_proof_ck', MESSAGE = 'Proof completion does not match its original Attempt';
    END IF;
  ELSE
    -- Owner completion independently obtains these public terminal facts. Native
    -- authority binds their retained projection to this exact still-uncommitted
    -- Attempt; neither missing responses nor worker-supplied reasons inhabit it.
    IF NOT EXISTS (
      SELECT 1 FROM commerce_order.commitment_attempts a
      WHERE a.tenant_id = NEW.tenant_id AND a.legal_entity_id = NEW.legal_entity_id
        AND a.buyer_principal_id = NEW.buyer_principal_id AND a.attempt_id = NEW.attempt_id
        AND a.attempt_id = NEW.data#>>'{binding,attemptRef,resourceId}'
        AND a.bundle_id = NEW.data#>>'{binding,bundleRef,resourceId}'
        AND a.bundle_hash = NEW.data#>>'{binding,bundleHash}'
        AND a.revision = (NEW.data->>'expectedRevision')::integer
        AND a.status IN ('READY', 'PRECOMMIT_FAILED') AND a.order_id IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_failure_ck', MESSAGE = 'Terminal proof work does not match its original Attempt';
    END IF;
    IF NEW.result->>'kind' = 'APPROVAL_REQUEST_TERMINAL' THEN
      IF NEW.result#>'{witness,finalBinding}' IS DISTINCT FROM NEW.data->'binding'
        OR NEW.result#>>'{witness,idempotencyKey}' IS DISTINCT FROM NEW.data->>'idempotencyKey'
        OR NEW.result#>>'{witness,terminalStatus}' IS NULL
        OR NEW.result#>>'{witness,terminalStatus}' NOT IN ('CANCELLED', 'EXPIRED', 'SUPERSEDED', 'REJECTED', 'RETURNED')
        OR NOT EXISTS (
          SELECT 1 FROM commerce_order.commitment_attempts a
          JOIN commerce_order.acceptance_bundles b
            ON b.tenant_id = a.tenant_id AND b.legal_entity_id = a.legal_entity_id
              AND b.bundle_id = a.bundle_id AND b.bundle_hash = a.bundle_hash
          WHERE a.tenant_id = NEW.tenant_id AND a.legal_entity_id = NEW.legal_entity_id
            AND a.attempt_id = NEW.attempt_id
            AND NEW.result#>'{witness,requestRef}' = b.snapshot->'approvalRequestRef'
            AND NEW.result#>'{witness,candidateRef}' = b.snapshot#>'{finalization,cart,candidateRef}'
            AND NEW.result#>>'{witness,candidateHash}' = b.snapshot#>>'{finalization,cart,candidateHash}'
            AND NEW.result#>>'{witness,commitmentCorrelationId}' = a.commitment_correlation_id
        )
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_failure_ck', MESSAGE = 'Approval terminal witness does not match its original request';
      END IF;
    ELSIF NEW.result->>'kind' = 'PRICING_PROOF_EXPIRED' THEN
      IF NEW.result#>>'{pricing,_tag}' IS DISTINCT FROM 'EXPIRED'
        OR NEW.result#>>'{pricing,confirmationRef}' IS DISTINCT FROM NEW.result->>'confirmationRef'
        OR NEW.result->>'confirmationRef' IS NULL
        OR NEW.result->'revalidationRef' IS NULL
        OR NEW.result->'revalidationRef' IS DISTINCT FROM NEW.result#>'{approvalEvidence,proof,revalidationRef}'
        OR NEW.result#>'{approvalEvidence,proof,evidence,finalBindingEvidence,binding}' IS DISTINCT FROM NEW.data->'binding'
        OR NEW.result#>>'{requestedBinding,attemptRef}' IS DISTINCT FROM NEW.attempt_id
        OR NEW.result#>>'{requestedBinding,decisionBundleRef}' IS DISTINCT FROM NEW.data#>>'{binding,bundleRef,resourceId}'
        OR NEW.result#>>'{requestedBinding,decisionBundleHash}' IS DISTINCT FROM NEW.data#>>'{binding,bundleHash}'
        OR NEW.result#>>'{requestedBinding,decisionBundleVersion}' IS DISTINCT FROM NEW.data#>>'{binding,bundleVersion}'
        OR NOT EXISTS (
          SELECT 1 FROM commerce_order.commitment_attempts a
          JOIN commerce_order.acceptance_bundles b
            ON b.tenant_id = a.tenant_id AND b.legal_entity_id = a.legal_entity_id
              AND b.bundle_id = a.bundle_id AND b.bundle_hash = a.bundle_hash
          WHERE a.tenant_id = NEW.tenant_id AND a.legal_entity_id = NEW.legal_entity_id
            AND a.attempt_id = NEW.attempt_id
            AND NEW.result->>'quotationRef' = b.snapshot#>>'{finalization,pricing,quotation,quotationRef}'
        )
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_failure_ck', MESSAGE = 'Pricing expiry witness does not match its original proof set';
      END IF;
    ELSIF NEW.result->>'kind' = 'PRICING_QUOTATION_EXPIRED' THEN
      quotation_valid_until := CASE WHEN NEW.result#>>'{pricing,validity,validUntil}' ~ instant_pattern
        THEN (NEW.result#>>'{pricing,validity,validUntil}')::timestamptz END;
      quotation_evaluated_at := CASE WHEN NEW.result#>>'{pricing,evaluatedAt}' ~ instant_pattern
        THEN (NEW.result#>>'{pricing,evaluatedAt}')::timestamptz END;
      IF NEW.result#>>'{pricing,_tag}' IS DISTINCT FROM 'EXPIRED'
        OR NEW.result->>'quotationRef' IS NULL
        OR NEW.result#>>'{pricing,quotationRef}' IS DISTINCT FROM NEW.result->>'quotationRef'
        OR NEW.result#>>'{authenticityEvidence,quotationRef}' IS DISTINCT FROM NEW.result->>'quotationRef'
        OR NEW.result#>>'{authenticityEvidence,verifiedAt}' IS DISTINCT FROM NEW.result#>>'{pricing,evaluatedAt}'
        OR quotation_valid_until IS NULL OR quotation_evaluated_at IS NULL
        OR quotation_evaluated_at < quotation_valid_until
        OR quotation_valid_until > clock_timestamp()
        OR NOT EXISTS (
          SELECT 1 FROM commerce_order.commitment_attempts a
          JOIN commerce_order.acceptance_bundles b
            ON b.tenant_id = a.tenant_id AND b.legal_entity_id = a.legal_entity_id
              AND b.bundle_id = a.bundle_id AND b.bundle_hash = a.bundle_hash
          WHERE a.tenant_id = NEW.tenant_id AND a.legal_entity_id = NEW.legal_entity_id
            AND a.attempt_id = NEW.attempt_id
            AND NEW.result->>'quotationRef' = b.snapshot#>>'{finalization,pricing,quotation,quotationRef}'
            AND NEW.result#>'{pricing,validity}' = b.snapshot#>'{finalization,pricing,quotation,validity}'
        )
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_failure_ck', MESSAGE = 'Quotation expiry witness does not match the original Bundle';
      END IF;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_finalization_failure_ck', MESSAGE = 'Unknown terminal proof work outcome';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
