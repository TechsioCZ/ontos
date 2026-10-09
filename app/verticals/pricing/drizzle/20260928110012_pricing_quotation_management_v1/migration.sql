-- #797: one immutable, exact pre-Tax Quotation per successful Action invocation.
-- The principal columns also bind management receipts to the original actor for safe lookup.
-- Historical receipts predate the principal column. Backfill only from immutable rows that
-- authoritatively recorded the actor; leave receipts without such evidence unattributed.
ALTER TABLE "pricing"."contractual_discount_action_invocation_receipts"
  ADD COLUMN "acting_principal_id" uuid;
--> statement-breakpoint
UPDATE "pricing"."contractual_discount_action_invocation_receipts" AS receipt
   SET "acting_principal_id" = revision."acting_principal_id"
  FROM "pricing"."contractual_discount_revisions" AS revision
 WHERE revision."tenant_id" = receipt."tenant_id"
   AND revision."legal_entity_id" = receipt."legal_entity_id"
   AND revision."action_invocation_id" = receipt."action_invocation_id"
   AND revision."command_fingerprint" = receipt."command_fingerprint";
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_action_invocation_receipts"
  ADD CONSTRAINT "pricing_contractual_discount_receipts_principal_ck"
  CHECK ("acting_principal_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_action_invocation_receipts"
  ADD COLUMN "acting_principal_id" text;
--> statement-breakpoint
WITH "principal_candidates" AS (
  SELECT
    revision."tenant_id",
    revision."legal_entity_id",
    revision."action_invocation_id",
    revision."acting_principal_id"
  FROM "pricing"."zero_floor_authorization_revisions" AS revision
  JOIN "pricing"."zero_floor_action_invocation_receipts" AS receipt
    ON receipt."tenant_id" = revision."tenant_id"
   AND receipt."legal_entity_id" = revision."legal_entity_id"
   AND receipt."action_invocation_id" = revision."action_invocation_id"
   AND receipt."command_fingerprint" = revision."command_fingerprint"
  UNION ALL
  SELECT
    approval."tenant_id",
    approval."legal_entity_id",
    approval."action_invocation_id",
    approval."approved_by_principal_id"
  FROM "pricing"."zero_floor_governance_approvals" AS approval
), "authoritative_principals" AS (
  SELECT
    candidate."tenant_id",
    candidate."legal_entity_id",
    candidate."action_invocation_id",
    min(candidate."acting_principal_id") AS "acting_principal_id"
  FROM "principal_candidates" AS candidate
  GROUP BY candidate."tenant_id", candidate."legal_entity_id", candidate."action_invocation_id"
  HAVING count(DISTINCT candidate."acting_principal_id") = 1
)
UPDATE "pricing"."zero_floor_action_invocation_receipts" AS receipt
   SET "acting_principal_id" = principal."acting_principal_id"
  FROM "authoritative_principals" AS principal
 WHERE principal."tenant_id" = receipt."tenant_id"
   AND principal."legal_entity_id" = receipt."legal_entity_id"
   AND principal."action_invocation_id" = receipt."action_invocation_id";
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_action_invocation_receipts"
  ADD CONSTRAINT "pricing_zero_floor_action_receipts_principal_ck"
  CHECK ("acting_principal_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
CREATE TABLE "pricing"."pricing_quotations" (
  "quotation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "legal_entity_id" uuid NOT NULL,
  "acting_principal_id" uuid NOT NULL,
  "quotation_ref" text NOT NULL,
  "action_invocation_id" uuid NOT NULL,
  "command_fingerprint" text NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_until" timestamp with time zone NOT NULL,
  "quotation" jsonb NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pricing_quotations_scope_ref_uk" UNIQUE("tenant_id", "legal_entity_id", "quotation_ref"),
  CONSTRAINT "pricing_quotations_invocation_uk" UNIQUE("tenant_id", "action_invocation_id"),
  CONSTRAINT "pricing_quotations_ref_ck" CHECK (length("quotation_ref") BETWEEN 1 AND 300 AND "quotation_ref" = btrim("quotation_ref")),
  CONSTRAINT "pricing_quotations_fingerprint_ck" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pricing_quotations_payload_ck" CHECK (jsonb_typeof("quotation") = 'object'),
  CONSTRAINT "pricing_quotations_interval_ck" CHECK ("valid_from" = "issued_at" AND "valid_until" > "valid_from")
);
--> statement-breakpoint
CREATE INDEX "pricing_quotations_valid_until_idx" ON "pricing"."pricing_quotations" ("tenant_id", "legal_entity_id", "valid_until");
--> statement-breakpoint
ALTER TABLE "pricing"."pricing_quotations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pricing_quotations_scope_select" ON "pricing"."pricing_quotations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING (
  "pricing_quotations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
  AND "pricing_quotations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
);
--> statement-breakpoint
CREATE POLICY "pricing_quotations_scope_insert" ON "pricing"."pricing_quotations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK (
  "pricing_quotations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
  AND "pricing_quotations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
);
--> statement-breakpoint
CREATE POLICY "pricing_quotations_scope_update" ON "pricing"."pricing_quotations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "pricing_quotations_scope_delete" ON "pricing"."pricing_quotations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
--> statement-breakpoint
ALTER TABLE "pricing"."pricing_quotations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "pricing"."pricing_quotations" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT INSERT, SELECT ON TABLE "pricing"."pricing_quotations" TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION pricing.persist_pricing_quotation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_acting_principal_id uuid,
  p_action_invocation_id uuid,
  p_command_fingerprint text,
  p_quotation jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_quotation_ref text := p_quotation ->> 'quotationRef';
  v_issued_at timestamptz;
  v_valid_from timestamptz;
  v_valid_until timestamptz;
  v_maximum_duration numeric;
  v_record pricing.pricing_quotations%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quotation scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_acting_principal_id IS NULL OR p_action_invocation_id IS NULL
    OR p_command_fingerprint IS NULL OR p_command_fingerprint !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_quotation) IS DISTINCT FROM 'object'
    OR p_quotation ->> 'kind' IS DISTINCT FROM 'PRICING_QUOTATION'
    OR p_quotation #>> '{binding,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_quotation #>> '{binding,commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR p_quotation #>> '{binding,monetaryBoundary}' IS DISTINCT FROM 'PRE_TAX'
    OR p_quotation #>> '{binding,currencyCode}' IS DISTINCT FROM 'CZK'
    OR v_quotation_ref IS NULL OR length(v_quotation_ref) NOT BETWEEN 1 AND 300
    OR v_quotation_ref <> btrim(v_quotation_ref)
  THEN
    RAISE EXCEPTION 'Pricing Quotation identity is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_issued_at := (p_quotation ->> 'issuedAt')::timestamptz;
    v_valid_from := (p_quotation #>> '{validity,validFrom}')::timestamptz;
    v_valid_until := (p_quotation #>> '{validity,validUntil}')::timestamptz;
    v_maximum_duration := (p_quotation #>> '{validity,policyEvidence,maximumValidityDurationMilliseconds}')::numeric;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Quotation validity is invalid' USING ERRCODE = '22023';
  END;
  IF v_issued_at IS NULL OR v_valid_from IS NULL OR v_valid_until IS NULL
    OR v_issued_at <> v_valid_from OR v_valid_until <= v_valid_from
    OR v_maximum_duration IS NULL OR v_maximum_duration <= 0
    OR extract(epoch FROM (v_valid_until - v_valid_from)) * 1000 > v_maximum_duration
    OR nullif(p_quotation #>> '{validity,policyEvidence,policyRef}', '') IS NULL
    OR nullif(p_quotation #>> '{validity,policyEvidence,policyVersion}', '') IS NULL
    OR jsonb_typeof(p_quotation -> 'quotedResult') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_quotation -> 'materialEvidence') IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'Pricing Quotation validity or guarantee is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO pricing.pricing_quotations (
    tenant_id, legal_entity_id, acting_principal_id, quotation_ref,
    action_invocation_id, command_fingerprint, issued_at, valid_from, valid_until, quotation
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_acting_principal_id, v_quotation_ref,
    p_action_invocation_id, p_command_fingerprint, v_issued_at, v_valid_from, v_valid_until, p_quotation
  ) ON CONFLICT DO NOTHING
  RETURNING * INTO v_record;

  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STORED', 'quotation', v_record.quotation);
    RETURN;
  END IF;

  -- A lost response may only replay the original canonical command and exact immutable payload.
  SELECT stored.* INTO v_record
    FROM pricing.pricing_quotations AS stored
   WHERE stored.tenant_id = p_tenant_id
     AND stored.action_invocation_id = p_action_invocation_id;
  IF FOUND AND v_record.legal_entity_id = p_legal_entity_id
    AND v_record.acting_principal_id = p_acting_principal_id
    AND v_record.command_fingerprint = p_command_fingerprint
    AND v_record.quotation = p_quotation
  THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'REUSED', 'quotation', v_record.quotation);
    RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'IDENTITY_CONFLICT');
END;
$function$;
--> statement-breakpoint

CREATE FUNCTION pricing.read_pricing_quotation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_acting_principal_id uuid,
  p_quotation_ref text
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_record pricing.pricing_quotations%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quotation scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_acting_principal_id IS NULL OR p_quotation_ref IS NULL
    OR length(p_quotation_ref) NOT BETWEEN 1 AND 300 OR p_quotation_ref <> btrim(p_quotation_ref)
  THEN
    RAISE EXCEPTION 'Pricing Quotation read identity is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT stored.* INTO v_record
    FROM pricing.pricing_quotations AS stored
   WHERE stored.tenant_id = p_tenant_id
     AND stored.legal_entity_id = p_legal_entity_id
     AND stored.acting_principal_id = p_acting_principal_id
     AND stored.quotation_ref = p_quotation_ref;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'FOUND', 'quotation', v_record.quotation);
  ELSE
    RETURN QUERY SELECT jsonb_build_object('outcome', 'NOT_FOUND', 'quotationRef', p_quotation_ref);
  END IF;
END;
$function$;
--> statement-breakpoint

CREATE FUNCTION pricing.lookup_pricing_quotation_invocation_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_acting_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_record pricing.pricing_quotations%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quotation scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_acting_principal_id IS NULL OR p_action_invocation_id IS NULL THEN
    RAISE EXCEPTION 'Pricing Quotation invocation lookup identity is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT stored.* INTO v_record
    FROM pricing.pricing_quotations AS stored
   WHERE stored.tenant_id = p_tenant_id
     AND stored.legal_entity_id = p_legal_entity_id
     AND stored.acting_principal_id = p_acting_principal_id
     AND stored.action_invocation_id = p_action_invocation_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actionInvocationId', p_action_invocation_id,
      'commandFingerprint', v_record.command_fingerprint,
      'outcome', 'FOUND',
      'quotation', v_record.quotation
    );
  ELSE
    RETURN QUERY SELECT jsonb_build_object('actionInvocationId', p_action_invocation_id, 'outcome', 'NOT_FOUND');
  END IF;
END;
$function$;
--> statement-breakpoint

CREATE FUNCTION pricing.read_pricing_quotation_history_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_acting_principal_id uuid,
  p_limit integer
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quotation scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_acting_principal_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Pricing Quotation history query is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT jsonb_build_object(
      'actionInvocationId', stored.action_invocation_id,
      'issuedAt', stored.quotation -> 'issuedAt',
      'outcome', 'FOUND',
      'quotation', stored.quotation,
      'quotationRef', stored.quotation_ref,
      'validUntil', stored.quotation #> '{validity,validUntil}'
    )
      FROM pricing.pricing_quotations AS stored
     WHERE stored.tenant_id = p_tenant_id
       AND stored.legal_entity_id = p_legal_entity_id
       AND stored.acting_principal_id = p_acting_principal_id
     ORDER BY stored.issued_at DESC, stored.quotation_ref DESC
     LIMIT p_limit;
END;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION pricing.persist_pricing_quotation_v1(uuid, uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.read_pricing_quotation_v1(uuid, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.lookup_pricing_quotation_invocation_v1(uuid, uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.read_pricing_quotation_history_v1(uuid, uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.persist_pricing_quotation_v1(uuid, uuid, uuid, uuid, text, jsonb) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.read_pricing_quotation_v1(uuid, uuid, uuid, text) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.lookup_pricing_quotation_invocation_v1(uuid, uuid, uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.read_pricing_quotation_history_v1(uuid, uuid, uuid, integer) TO ontos_runtime;
