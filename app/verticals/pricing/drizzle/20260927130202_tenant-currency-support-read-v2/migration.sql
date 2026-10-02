-- Temporary read-only compatibility bridge for #753. Remove this routine when #759 migrates
-- Currency Support to one canonical Tenant-owned support root. It deliberately does not change
-- the legacy write model or select one legacy Selling Legal Entity partition over another.
DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pricing_currency_support_bridge_reader'
  ) THEN
    CREATE ROLE pricing_currency_support_bridge_reader
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE pricing_currency_support_bridge_reader
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$role$;

GRANT USAGE ON SCHEMA "pricing" TO "pricing_currency_support_bridge_reader";
GRANT SELECT ON TABLE "pricing"."currency_support_revisions" TO "pricing_currency_support_bridge_reader";

CREATE FUNCTION "pricing"."read_tenant_supported_currencies_v2"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_effective_at timestamptz;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing currency-support read scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing currency-support read input is invalid' USING ERRCODE = '22023';
  END IF;

  IF NOT (p_input ? 'effectiveAt') OR EXISTS (
      SELECT 1
      FROM jsonb_object_keys(p_input) AS supplied_key
      WHERE supplied_key <> 'effectiveAt'
    )
  THEN
    RAISE EXCEPTION 'Pricing currency-support read input is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing currency-support effective instant is invalid' USING ERRCODE = '22023';
  END;
  IF v_effective_at IS NULL THEN
    RAISE EXCEPTION 'Pricing currency-support effective instant is required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH active_revisions AS MATERIALIZED (
    SELECT
      revision.effective_to,
      revision.generation,
      revision.pricing_revision,
      revision.recorded_at,
      revision.supported_currencies
    FROM pricing.currency_support_revisions AS revision
    WHERE revision.tenant_id = p_tenant_id
      AND revision.effective_from <= v_effective_at
      AND (revision.effective_to IS NULL OR v_effective_at < revision.effective_to)
    LIMIT 2
  ),
  cardinality AS (
    SELECT count(*)::integer AS active_revision_count
    FROM active_revisions
  )
  SELECT jsonb_build_object(
    'activeRevisionCount', cardinality.active_revision_count,
    'observedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'outcome', CASE cardinality.active_revision_count
      WHEN 0 THEN 'ABSENT'
      WHEN 1 THEN 'UNAMBIGUOUS'
      ELSE 'AMBIGUOUS'
    END,
    'revision', CASE WHEN cardinality.active_revision_count = 1 THEN (
      SELECT jsonb_build_object(
        'generation', revision.generation,
        'nextApplicabilityBoundary', CASE
          WHEN revision.effective_to IS NULL THEN NULL
          ELSE to_char(revision.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END,
        'pricingRevision', revision.pricing_revision,
        'recordedAt', to_char(revision.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'supportedCurrencies', revision.supported_currencies
      )
      FROM active_revisions AS revision
    ) ELSE NULL END
  )
  FROM cardinality;
END;
$function$;

-- PostgreSQL requires the future owner to have CREATE on the containing schema while ownership is
-- transferred. Revoke it in the same migration so the steady-state bridge role retains only USAGE
-- on Pricing and SELECT on the one legacy source table.
REVOKE ALL ON FUNCTION "pricing"."read_tenant_supported_currencies_v2"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "pricing"."read_tenant_supported_currencies_v2"(uuid, uuid, jsonb) TO "ontos_runtime";

GRANT CREATE ON SCHEMA "pricing" TO "pricing_currency_support_bridge_reader";
ALTER FUNCTION "pricing"."read_tenant_supported_currencies_v2"(uuid, uuid, jsonb)
  OWNER TO "pricing_currency_support_bridge_reader";
REVOKE CREATE ON SCHEMA "pricing" FROM "pricing_currency_support_bridge_reader";
