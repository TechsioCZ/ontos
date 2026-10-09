CREATE TABLE "pricing"."pricing_commitment_confirmations" (
	"confirmation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"confirmation_ref" text NOT NULL,
	"attempt_ref" text NOT NULL,
	"decision_bundle_ref" text NOT NULL,
	"decision_bundle_hash" text NOT NULL,
	"decision_bundle_version" text NOT NULL,
	"source_kind" text NOT NULL,
	"quotation_ref" text,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmation" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"proof_ref" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_commitment_confirmations_scope_ref_uk" UNIQUE("tenant_id","legal_entity_id","confirmation_ref"),
	CONSTRAINT "pricing_commitment_confirmations_scope_proof_uk" UNIQUE("tenant_id","legal_entity_id","proof_ref"),
	CONSTRAINT "pricing_commitment_confirmations_source_kind_ck" CHECK ("pricing"."pricing_commitment_confirmations"."source_kind" in ('CURRENT_BACKED', 'QUOTATION_BACKED')),
	CONSTRAINT "pricing_commitment_confirmations_source_reference_ck" CHECK (("pricing"."pricing_commitment_confirmations"."source_kind" = 'CURRENT_BACKED' and "pricing"."pricing_commitment_confirmations"."quotation_ref" is null) or ("pricing"."pricing_commitment_confirmations"."source_kind" = 'QUOTATION_BACKED' and "pricing"."pricing_commitment_confirmations"."quotation_ref" is not null)),
	CONSTRAINT "pricing_commitment_confirmations_interval_ck" CHECK ("pricing"."pricing_commitment_confirmations"."expires_at" > "pricing"."pricing_commitment_confirmations"."issued_at" and "pricing"."pricing_commitment_confirmations"."expires_at" <= "pricing"."pricing_commitment_confirmations"."issued_at" + interval '30 seconds'),
	CONSTRAINT "pricing_commitment_confirmations_payload_ck" CHECK (jsonb_typeof("pricing"."pricing_commitment_confirmations"."confirmation") = 'object')
);
--> statement-breakpoint
CREATE INDEX "pricing_commitment_confirmations_attempt_bundle_idx" ON "pricing"."pricing_commitment_confirmations" ("tenant_id","legal_entity_id","attempt_ref","decision_bundle_hash","issued_at");
--> statement-breakpoint
CREATE INDEX "pricing_commitment_confirmations_expiry_idx" ON "pricing"."pricing_commitment_confirmations" ("expires_at");
--> statement-breakpoint
ALTER TABLE "pricing"."pricing_commitment_confirmations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pricing_commitment_confirmations_scope_select" ON "pricing"."pricing_commitment_confirmations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing_commitment_confirmations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing_commitment_confirmations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "pricing_commitment_confirmations_scope_insert" ON "pricing"."pricing_commitment_confirmations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing_commitment_confirmations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing_commitment_confirmations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "pricing_commitment_confirmations_scope_update" ON "pricing"."pricing_commitment_confirmations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "pricing_commitment_confirmations_scope_delete" ON "pricing"."pricing_commitment_confirmations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
--> statement-breakpoint
ALTER TABLE "pricing"."pricing_commitment_confirmations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "pricing"."pricing_commitment_confirmations" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT INSERT, SELECT ON TABLE "pricing"."pricing_commitment_confirmations" TO "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pricing.persist_pricing_commitment_confirmation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_confirmation_ref text := p_input ->> 'confirmationRef';
  v_attempt_ref text := p_input #>> '{binding,attemptRef}';
  v_bundle_ref text := p_input #>> '{binding,decisionBundleRef}';
  v_bundle_hash text := p_input #>> '{binding,decisionBundleHash}';
  v_bundle_version text := p_input #>> '{binding,decisionBundleVersion}';
  v_source_kind text := p_input #>> '{source,kind}';
  v_quotation_ref text := p_input #>> '{source,quotationRevalidation,quotation,quotationRef}';
  v_payload_digest text := p_input #>> '{authenticity,payloadDigest}';
  v_proof_ref text := p_input #>> '{authenticity,proofRef}';
  v_issued_at timestamptz;
  v_expires_at timestamptz;
  v_inserted boolean := false;
  v_existing jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commitment Confirmation scope mismatch' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_issued_at := (p_input ->> 'issuedAt')::timestamptz;
    v_expires_at := (p_input ->> 'expiresAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commitment Confirmation timestamps are invalid' USING ERRCODE = '22023';
  END;

  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR p_input ->> 'kind' IS DISTINCT FROM 'PRICING_COMMITMENT_CONFIRMATION'
    OR p_input #>> '{binding,purchase,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_input #>> '{binding,purchase,commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_confirmation_ref IS NULL OR v_confirmation_ref <> btrim(v_confirmation_ref) OR length(v_confirmation_ref) NOT BETWEEN 1 AND 1000
    OR v_attempt_ref IS NULL OR v_attempt_ref <> btrim(v_attempt_ref) OR length(v_attempt_ref) NOT BETWEEN 1 AND 1000
    OR v_bundle_ref IS NULL OR v_bundle_ref <> btrim(v_bundle_ref) OR length(v_bundle_ref) NOT BETWEEN 1 AND 1000
    OR v_bundle_hash IS NULL OR v_bundle_hash <> btrim(v_bundle_hash) OR length(v_bundle_hash) NOT BETWEEN 1 AND 1000
    OR v_bundle_version IS NULL OR v_bundle_version <> btrim(v_bundle_version) OR length(v_bundle_version) NOT BETWEEN 1 AND 1000
    OR v_payload_digest IS NULL OR v_payload_digest <> btrim(v_payload_digest) OR length(v_payload_digest) NOT BETWEEN 1 AND 1000
    OR v_proof_ref IS NULL OR v_proof_ref <> btrim(v_proof_ref) OR length(v_proof_ref) NOT BETWEEN 1 AND 1000
    OR v_source_kind NOT IN ('CURRENT_BACKED', 'QUOTATION_BACKED')
    OR (v_source_kind = 'CURRENT_BACKED' AND v_quotation_ref IS NOT NULL)
    OR (v_source_kind = 'QUOTATION_BACKED' AND (v_quotation_ref IS NULL OR v_quotation_ref <> btrim(v_quotation_ref)))
    OR v_issued_at IS NULL OR v_expires_at IS NULL
    OR v_expires_at <= v_issued_at OR v_expires_at > v_issued_at + interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Pricing Commitment Confirmation input is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO pricing.pricing_commitment_confirmations (
    tenant_id,
    legal_entity_id,
    confirmation_ref,
    attempt_ref,
    decision_bundle_ref,
    decision_bundle_hash,
    decision_bundle_version,
    source_kind,
    quotation_ref,
    issued_at,
    expires_at,
    confirmation,
    payload_digest,
    proof_ref
  ) VALUES (
    p_tenant_id,
    p_legal_entity_id,
    v_confirmation_ref,
    v_attempt_ref,
    v_bundle_ref,
    v_bundle_hash,
    v_bundle_version,
    v_source_kind,
    v_quotation_ref,
    v_issued_at,
    v_expires_at,
    p_input,
    v_payload_digest,
    v_proof_ref
  )
  ON CONFLICT DO NOTHING
  RETURNING true INTO v_inserted;

  IF v_inserted THEN
    RETURN QUERY SELECT jsonb_build_object('confirmation', p_input, 'outcome', 'STORED');
    RETURN;
  END IF;

  SELECT stored.confirmation INTO v_existing
    FROM pricing.pricing_commitment_confirmations AS stored
   WHERE stored.tenant_id = p_tenant_id
     AND stored.legal_entity_id = p_legal_entity_id
     AND stored.confirmation_ref = v_confirmation_ref;

  IF v_existing = p_input THEN
    RETURN QUERY SELECT jsonb_build_object('confirmation', v_existing, 'outcome', 'REUSED');
  ELSE
    RETURN QUERY SELECT jsonb_build_object(
      'confirmationRef', v_confirmation_ref,
      'outcome', 'IDENTITY_CONFLICT',
      'reason', 'CONFIRMATION_OR_PROOF_IDENTITY_ALREADY_BOUND'
    );
  END IF;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pricing.read_pricing_commitment_confirmation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_confirmation_ref text
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_record record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commitment Confirmation scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_confirmation_ref IS NULL OR p_confirmation_ref <> btrim(p_confirmation_ref)
    OR length(p_confirmation_ref) NOT BETWEEN 1 AND 1000
  THEN
    RAISE EXCEPTION 'Pricing Commitment Confirmation reference is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT stored.* INTO v_record
    FROM pricing.pricing_commitment_confirmations AS stored
   WHERE stored.tenant_id = p_tenant_id
     AND stored.legal_entity_id = p_legal_entity_id
     AND stored.confirmation_ref = p_confirmation_ref;

  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('confirmationRef', p_confirmation_ref, 'outcome', 'ABSENT');
    RETURN;
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    'attemptRef', v_record.attempt_ref,
    'confirmation', v_record.confirmation,
    'confirmationRef', v_record.confirmation_ref,
    'decisionBundleHash', v_record.decision_bundle_hash,
    'decisionBundleRef', v_record.decision_bundle_ref,
    'decisionBundleVersion', v_record.decision_bundle_version,
    'expiresAt', to_char(v_record.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'issuedAt', to_char(v_record.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'outcome', 'FOUND',
    'payloadDigest', v_record.payload_digest,
    'proofRef', v_record.proof_ref,
    'quotationRef', v_record.quotation_ref,
    'sourceKind', v_record.source_kind
  );
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.persist_pricing_commitment_confirmation_v1(uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.read_pricing_commitment_confirmation_v1(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.persist_pricing_commitment_confirmation_v1(uuid, uuid, jsonb) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.read_pricing_commitment_confirmation_v1(uuid, uuid, text) TO ontos_runtime;
