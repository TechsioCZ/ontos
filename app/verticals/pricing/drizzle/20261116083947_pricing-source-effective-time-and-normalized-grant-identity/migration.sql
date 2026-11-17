-- A source assertion may carry its own effective time, and a grant matches the exact canonical key.
--
-- 1. The authority lookup compared the raw identity key. Pricing stores and reads a unit quantity with nine
--    decimals, so a grant for "1" never matched the same Price read back as "1.000000000" when it was revised.
--    A grant stored for the exact key still decides alone. Only when none exists does the lookup compare the unit
--    quantity as a number and everything else exactly. Tenant, Legal Entity, authority, mapping, Price Group and
--    validity are unchanged, and a grant for another key still does not match.
CREATE OR REPLACE FUNCTION pricing.assess_external_price_source_authority_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_identity jsonb := p_input -> 'exactIdentityKey';
  v_source_authority_ref text := p_input #>> '{sourceAssertion,sourceAuthority,sourceAuthorityRef}';
  v_source_authority_version text := p_input #>> '{sourceAssertion,sourceAuthority,sourceAuthorityVersion}';
  v_mapping_contract_ref text := p_input #>> '{sourceAssertion,mapping,mappingContractRef}';
  v_mapping_contract_version text := p_input #>> '{sourceAssertion,mapping,mappingContractVersion}';
  v_effective_at_text text := p_input #>> '{sourceAssertion,timing,ownerBusinessEffectiveAt}';
  v_trusted_operation_at_text text := p_input ->> 'trustedOperationAt';
  v_effective_at timestamptz;
  v_trusted_operation_at timestamptz;
  v_grants jsonb := '[]'::jsonb;
  v_match_count integer := 0;
  v_pass integer;
BEGIN
  IF p_tenant_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')
    OR p_legal_entity_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')
  THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_input IS NULL
    OR pg_catalog.jsonb_typeof(p_input) <> 'object'
    OR p_input ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR pg_catalog.jsonb_typeof(v_identity) <> 'object'
    OR v_identity #>> '{catalogSelection,productRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{catalogSelection,variantRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{unitBasis,unitRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{unitBasis,quantity}' IS NULL
    OR v_identity #>> '{unitBasis,quantity}' !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_source_authority_ref IS NULL
    OR v_source_authority_version IS NULL
    OR v_mapping_contract_ref IS NULL
    OR v_mapping_contract_version IS NULL
    OR v_effective_at_text IS NULL
    OR v_effective_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR v_trusted_operation_at_text IS NULL
    OR v_trusted_operation_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority assessment is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_effective_at := v_effective_at_text::timestamptz;
    v_trusted_operation_at := v_trusted_operation_at_text::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority assessment is invalid' USING ERRCODE = '22023';
  END;

  -- Pass 1 is the exact stored key. Only when no grant is stored for it does pass 2 compare the unit quantity as
  -- a number: Pricing reads a quantity back with nine decimals ("1.000000000"), so a grant stored as "1" names the
  -- same key. Every other part stays exact, and a grant stored for the exact key always decides on its own.
  FOR v_pass IN 1..2 LOOP
    SELECT count(*)::integer,
           coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'authority', pg_catalog.jsonb_build_object(
                   'sourceAuthorityRef', authority.source_authority_ref,
                   'sourceAuthorityVersion', authority.source_authority_version
                 ),
                 'effectivePeriod', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                   'effectiveFrom', pg_catalog.to_char(
                     authority.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ),
                   'effectiveTo', CASE WHEN authority.effective_to IS NULL THEN NULL ELSE pg_catalog.to_char(
                     authority.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ) END
                 )),
                 'exactIdentityKey', authority.exact_identity_key,
                 'family', 'PRICE',
                 'mapping', pg_catalog.jsonb_build_object(
                   'mappingContractRef', authority.mapping_contract_ref,
                   'mappingContractVersion', authority.mapping_contract_version
                 ),
                 'ownerModuleId', 'commerce.pricing',
                 'schemaVersion', '1',
                 'verificationRef', authority.verification_ref,
                 'verifiedAt', pg_catalog.to_char(
                   authority.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 )
               ) ORDER BY authority.effective_from, authority.grant_id
             ),
             '[]'::jsonb
           )
      INTO v_match_count, v_grants
      FROM pricing.external_price_source_authority_grants AS authority
     WHERE authority.tenant_id = p_tenant_id
       AND authority.legal_entity_id = p_legal_entity_id
       AND authority.source_authority_ref = v_source_authority_ref
       AND authority.source_authority_version = v_source_authority_version
       AND authority.mapping_contract_ref = v_mapping_contract_ref
       AND authority.mapping_contract_version = v_mapping_contract_version
       AND CASE WHEN v_pass = 1
             THEN authority.exact_identity_key = v_identity
             ELSE pg_catalog.jsonb_set(
                    authority.exact_identity_key,
                    '{unitBasis,quantity}',
                    pg_catalog.to_jsonb(((authority.exact_identity_key #>> '{unitBasis,quantity}')::numeric(38,9))::text)
                  ) = pg_catalog.jsonb_set(
                    v_identity,
                    '{unitBasis,quantity}',
                    pg_catalog.to_jsonb(((v_identity #>> '{unitBasis,quantity}')::numeric(38,9))::text)
                  )
           END
       AND authority.effective_from <= v_effective_at
       AND (authority.effective_to IS NULL OR v_effective_at < authority.effective_to)
       AND authority.verified_at <= v_trusted_operation_at;
    EXIT WHEN v_match_count > 0;
  END LOOP;

  IF v_match_count = 1 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'grant', v_grants -> 0,
      'outcome', 'AUTHORITY_GRANTED'
    );
  ELSE
    -- Absence and ambiguity are held for owner resolution; neither is fabricated rejection.
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'AUTHORITY_UNRESOLVED',
      'reason', 'AUTHORITY'
    );
  END IF;
END
$function$;
--> statement-breakpoint
-- 2. A value-only revision took its effective time from the operation clock, which a source cannot know before
--    the call, while the source check requires the asserted time to be the revision's own start. The command may
--    now carry that time (`effectiveFrom`). It must not be after the operation and not before the Current Revision
--    it replaces (the existing boundary check). Without it the time stays the operation time, and retirement is
--    unchanged. Patch the deployed routine without rewriting the historical migration that owns it.
DO $migration$
DECLARE
  v_definition text;
  v_old constant text := 'v_new_from := v_trusted_at;';
  v_new constant text :=
    'v_new_from := coalesce(nullif(p_input ->> ''effectiveFrom'', '''')::timestamptz, v_trusted_at);
      IF v_new_from > v_trusted_at OR v_new_from < v_target_from THEN
        RETURN QUERY SELECT jsonb_build_object(''outcome'', ''CONFLICT'', ''reason'', ''BOUNDARY_CROSSED'');
        RETURN;
      END IF;';
  v_match_at integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
           'pricing.revise_price_v1(uuid,uuid,jsonb)'::pg_catalog.regprocedure
         )
    INTO v_definition;

  v_match_at := pg_catalog.strpos(v_definition, v_old);
  IF v_match_at = 0
    OR pg_catalog.strpos(pg_catalog.substr(v_definition, v_match_at + pg_catalog.length(v_old)), v_old) > 0
  THEN
    RAISE EXCEPTION 'Pricing revise_price_v1 effective time assignment does not match the expected deployed contract'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;
