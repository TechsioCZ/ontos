CREATE FUNCTION "commerce_customer_context"."list_saved_addresses"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text
)
RETURNS TABLE (
  outcome text,
  saved_address_id text,
  source_kind text,
  label text,
  purposes text[],
  party_resource_id text,
  party_contact_point_resource_id text,
  party_contact_point_revision integer,
  address_line_1 text,
  address_line_2 text,
  city text,
  administrative_area text,
  postal_code text,
  country_code text,
  lifecycle text,
  revision integer,
  cleared_purposes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT profile.customer_profile_id
    INTO v_profile_id
    FROM commerce_customer_context.customer_profiles AS profile
   WHERE profile.tenant_id = p_tenant_id
     AND profile.legal_entity_id = p_legal_entity_id
     AND profile.customer_profile_id::text = p_profile_resource_id
     AND profile.profile_kind = p_profile_kind
     AND (
       (p_profile_kind = 'RETAIL' AND p_counterparty_resource_id IS NULL AND EXISTS (
         SELECT 1
           FROM commerce_customer_context.retail_customer_profiles AS retail
          WHERE retail.tenant_id = p_tenant_id
            AND retail.legal_entity_id = p_legal_entity_id
            AND retail.retail_customer_profile_id = profile.customer_profile_id
       )) OR
       (p_profile_kind = 'COUNTERPARTY' AND EXISTS (
         SELECT 1
           FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
          WHERE counterparty.tenant_id = p_tenant_id
            AND counterparty.legal_entity_id = p_legal_entity_id
            AND counterparty.counterparty_purchasing_profile_id = profile.customer_profile_id
            AND counterparty.counterparty_resource_id = p_counterparty_resource_id
       ))
     );

  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT
      CASE WHEN p_profile_kind IN ('RETAIL', 'COUNTERPARTY') THEN 'PROFILE_NOT_FOUND' ELSE 'SUBJECT_MISMATCH' END,
      NULL::text, NULL::text, NULL::text, ARRAY[]::text[], NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'FOUND'::text,
    address.saved_address_id::text,
    address.source_kind,
    address.label,
    ARRAY(SELECT jsonb_array_elements_text(address.purposes) ORDER BY 1),
    address.party_resource_id,
    address.party_contact_point_resource_id,
    address.party_contact_point_revision,
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.administrative_area,
    address.postal_code,
    address.country_code,
    address.lifecycle,
    address.revision,
    ARRAY[]::text[]
  FROM commerce_customer_context.saved_addresses AS address
  WHERE address.tenant_id = p_tenant_id
    AND address.legal_entity_id = p_legal_entity_id
    AND address.customer_profile_id = v_profile_id
    AND address.lifecycle = 'ACTIVE'
  ORDER BY address.created_at, address.saved_address_id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."read_saved_address"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_saved_address_resource_id text
)
RETURNS TABLE (
  outcome text,
  saved_address_id text,
  source_kind text,
  label text,
  purposes text[],
  party_resource_id text,
  party_contact_point_resource_id text,
  party_contact_point_revision integer,
  address_line_1 text,
  address_line_2 text,
  city text,
  administrative_area text,
  postal_code text,
  country_code text,
  lifecycle text,
  revision integer,
  cleared_purposes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT profile.customer_profile_id
    INTO v_profile_id
    FROM commerce_customer_context.customer_profiles AS profile
   WHERE profile.tenant_id = p_tenant_id
     AND profile.legal_entity_id = p_legal_entity_id
     AND profile.customer_profile_id::text = p_profile_resource_id
     AND profile.profile_kind = p_profile_kind
     AND (
       (p_profile_kind = 'RETAIL' AND p_counterparty_resource_id IS NULL AND EXISTS (
         SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
          WHERE retail.tenant_id = p_tenant_id AND retail.legal_entity_id = p_legal_entity_id
            AND retail.retail_customer_profile_id = profile.customer_profile_id
       )) OR
       (p_profile_kind = 'COUNTERPARTY' AND EXISTS (
         SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
          WHERE counterparty.tenant_id = p_tenant_id AND counterparty.legal_entity_id = p_legal_entity_id
            AND counterparty.counterparty_purchasing_profile_id = profile.customer_profile_id
            AND counterparty.counterparty_resource_id = p_counterparty_resource_id
       ))
     );

  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'FOUND'::text,
    address.saved_address_id::text,
    address.source_kind,
    address.label,
    ARRAY(SELECT jsonb_array_elements_text(address.purposes) ORDER BY 1),
    address.party_resource_id,
    address.party_contact_point_resource_id,
    address.party_contact_point_revision,
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.administrative_area,
    address.postal_code,
    address.country_code,
    address.lifecycle,
    address.revision,
    ARRAY[]::text[]
  FROM commerce_customer_context.saved_addresses AS address
  WHERE address.tenant_id = p_tenant_id
    AND address.legal_entity_id = p_legal_entity_id
    AND address.customer_profile_id = v_profile_id
    AND address.saved_address_id::text = p_saved_address_resource_id
    AND address.lifecycle = 'ACTIVE';

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."read_address_defaults"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text
)
RETURNS TABLE (
  outcome text,
  revision integer,
  billing_saved_address_id text,
  delivery_saved_address_id text,
  cleared_saved_address_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT profile.customer_profile_id
    INTO v_profile_id
    FROM commerce_customer_context.customer_profiles AS profile
   WHERE profile.tenant_id = p_tenant_id
     AND profile.legal_entity_id = p_legal_entity_id
     AND profile.customer_profile_id::text = p_profile_resource_id
     AND profile.profile_kind = p_profile_kind
     AND (
       (p_profile_kind = 'RETAIL' AND p_counterparty_resource_id IS NULL AND EXISTS (
         SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
          WHERE retail.tenant_id = p_tenant_id AND retail.legal_entity_id = p_legal_entity_id
            AND retail.retail_customer_profile_id = profile.customer_profile_id
       )) OR
       (p_profile_kind = 'COUNTERPARTY' AND EXISTS (
         SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
          WHERE counterparty.tenant_id = p_tenant_id AND counterparty.legal_entity_id = p_legal_entity_id
            AND counterparty.counterparty_purchasing_profile_id = profile.customer_profile_id
            AND counterparty.counterparty_resource_id = p_counterparty_resource_id
       ))
     );

  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, 0, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'PRESENT'::text,
    coalesce(setting.current_revision, 0),
    billing.saved_address_id::text,
    delivery.saved_address_id::text,
    NULL::text
  FROM (SELECT v_profile_id AS customer_profile_id) AS target
  LEFT JOIN commerce_customer_context.customer_setting_revisions AS setting
    ON setting.tenant_id = p_tenant_id
   AND setting.legal_entity_id = p_legal_entity_id
   AND setting.customer_profile_id = target.customer_profile_id
   AND setting.setting_kind = 'ADDRESS_DEFAULTS'
  LEFT JOIN LATERAL (
    SELECT candidate.saved_address_id
      FROM commerce_customer_context.customer_address_defaults AS candidate
     WHERE candidate.tenant_id = p_tenant_id
       AND candidate.legal_entity_id = p_legal_entity_id
       AND candidate.customer_profile_id = target.customer_profile_id
       AND candidate.default_kind = 'BILLING'
       AND candidate.lifecycle = 'ACTIVE'
       AND candidate.effective_to IS NULL
     ORDER BY candidate.revision DESC
     LIMIT 1
  ) AS billing ON true
  LEFT JOIN LATERAL (
    SELECT candidate.saved_address_id
      FROM commerce_customer_context.customer_address_defaults AS candidate
     WHERE candidate.tenant_id = p_tenant_id
       AND candidate.legal_entity_id = p_legal_entity_id
       AND candidate.customer_profile_id = target.customer_profile_id
       AND candidate.default_kind = 'DELIVERY'
       AND candidate.lifecycle = 'ACTIVE'
       AND candidate.effective_to IS NULL
     ORDER BY candidate.revision DESC
     LIMIT 1
  ) AS delivery ON true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."add_saved_address"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_source_kind text,
  p_label text,
  p_purposes text[],
  p_party_resource_id text,
  p_party_contact_point_resource_id text,
  p_party_contact_point_revision integer,
  p_postal_address jsonb,
  p_reason text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  saved_address_id text,
  source_kind text,
  label text,
  purposes text[],
  party_resource_id text,
  party_contact_point_resource_id text,
  party_contact_point_revision integer,
  address_line_1 text,
  address_line_2 text,
  city text,
  administrative_area text,
  postal_code text,
  country_code text,
  lifecycle text,
  revision integer,
  cleared_purposes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
  v_address commerce_customer_context.saved_addresses%ROWTYPE;
  v_purposes text[];
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(purpose ORDER BY purpose)
    INTO v_purposes
    FROM (SELECT DISTINCT unnest(p_purposes) AS purpose) AS normalized;
  IF coalesce(array_length(v_purposes, 1), 0) NOT BETWEEN 1 AND 2
    OR EXISTS (SELECT 1 FROM unnest(v_purposes) AS purpose WHERE purpose NOT IN ('BILLING', 'DELIVERY'))
    OR p_label IS DISTINCT FROM nullif(btrim(p_label), '')
    OR p_reason IS NULL
    OR p_reason IS DISTINCT FROM nullif(btrim(p_reason), '')
    OR length(p_reason) > 500
    OR (
      p_source_kind = 'PARTY_BACKED' AND
      (p_party_resource_id IS NULL OR p_party_contact_point_resource_id IS NULL OR
       coalesce(p_party_contact_point_revision, 0) < 1 OR p_postal_address IS NOT NULL)
    )
    OR (
      p_source_kind = 'COMMERCE_ONLY' AND
      (p_party_resource_id IS NOT NULL OR p_party_contact_point_resource_id IS NOT NULL OR
       p_party_contact_point_revision IS NOT NULL OR p_postal_address IS NULL OR
       coalesce(p_postal_address->>'addressLine1', '') = '' OR
       coalesce(p_postal_address->>'city', '') = '' OR
       coalesce(p_postal_address->>'postalCode', '') = '' OR
       coalesce(p_postal_address->>'countryCode', '') !~ '^[A-Z]{2}$')
    )
    OR p_source_kind NOT IN ('PARTY_BACKED', 'COMMERCE_ONLY')
  THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text, NULL::text, NULL::text, ARRAY[]::text[],
      NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT profile.customer_profile_id
    INTO v_profile_id
    FROM commerce_customer_context.customer_profiles AS profile
   WHERE profile.tenant_id = p_tenant_id
     AND profile.legal_entity_id = p_legal_entity_id
     AND profile.customer_profile_id::text = p_profile_resource_id
     AND profile.profile_kind = p_profile_kind
     AND profile.lifecycle <> 'ARCHIVED'
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;
  IF (p_profile_kind = 'RETAIL' AND (p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
       WHERE retail.tenant_id = p_tenant_id AND retail.legal_entity_id = p_legal_entity_id
         AND retail.retail_customer_profile_id = v_profile_id
    ))) OR (p_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
       WHERE counterparty.tenant_id = p_tenant_id AND counterparty.legal_entity_id = p_legal_entity_id
         AND counterparty.counterparty_purchasing_profile_id = v_profile_id
         AND counterparty.counterparty_resource_id = p_counterparty_resource_id
    ))
  THEN
    RETURN QUERY SELECT 'SUBJECT_MISMATCH'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT address.*
    INTO v_address
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = v_profile_id
     AND address.lifecycle = 'ACTIVE'
     AND address.source_kind = p_source_kind
     AND address.purposes = to_jsonb(v_purposes)
     AND (
       (p_source_kind = 'PARTY_BACKED'
        AND address.party_resource_id = p_party_resource_id
        AND address.party_contact_point_resource_id = p_party_contact_point_resource_id)
       OR
       (p_source_kind = 'COMMERCE_ONLY'
        AND address.address_line_1 IS NOT DISTINCT FROM p_postal_address->>'addressLine1'
        AND address.address_line_2 IS NOT DISTINCT FROM p_postal_address->>'addressLine2'
        AND address.locality IS NOT DISTINCT FROM p_postal_address->>'city'
        AND address.administrative_area IS NOT DISTINCT FROM p_postal_address->>'region'
        AND address.postal_code IS NOT DISTINCT FROM p_postal_address->>'postalCode'
        AND address.country_code IS NOT DISTINCT FROM p_postal_address->>'countryCode')
     )
   ORDER BY address.created_at
   LIMIT 1;

  IF v_address.saved_address_id IS NOT NULL THEN
    RETURN QUERY SELECT
      CASE
        WHEN v_address.label IS NOT DISTINCT FROM p_label
          AND (p_source_kind = 'COMMERCE_ONLY'
            OR v_address.party_contact_point_revision = p_party_contact_point_revision)
          THEN 'REUSED'
        ELSE 'RECONCILIATION_REQUIRED'
      END,
      v_address.saved_address_id::text, v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT address.*
    INTO v_address
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = v_profile_id
     AND address.last_action_invocation_id = p_action_invocation_id
   ORDER BY address.updated_at DESC
   LIMIT 1;
  IF v_address.saved_address_id IS NOT NULL THEN
    RETURN QUERY SELECT
      'RECONCILIATION_REQUIRED'::text,
      v_address.saved_address_id::text, v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;

  INSERT INTO commerce_customer_context.saved_addresses (
    tenant_id, legal_entity_id, customer_profile_id, source_kind, label, purposes,
    party_resource_id, party_contact_point_resource_id, party_contact_point_revision,
    address_line_1, address_line_2, locality, administrative_area, postal_code, country_code,
    lifecycle, revision, last_action_invocation_id, last_actor_principal_id, last_reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile_id, p_source_kind, p_label, to_jsonb(v_purposes),
    p_party_resource_id, p_party_contact_point_resource_id, p_party_contact_point_revision,
    p_postal_address->>'addressLine1', p_postal_address->>'addressLine2',
    p_postal_address->>'city', p_postal_address->>'region', p_postal_address->>'postalCode',
    p_postal_address->>'countryCode', 'ACTIVE', 1, p_action_invocation_id, p_actor_principal_id,
    p_reason
  ) RETURNING * INTO v_address;

  RETURN QUERY SELECT
    'ADDED'::text, v_address.saved_address_id::text, v_address.source_kind, v_address.label,
    ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
    v_address.party_resource_id, v_address.party_contact_point_resource_id,
    v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
    v_address.locality, v_address.administrative_area, v_address.postal_code,
    v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."update_saved_address"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_saved_address_resource_id text,
  p_expected_revision integer,
  p_label_supplied boolean,
  p_label text,
  p_origin_supplied boolean,
  p_source_kind text,
  p_purposes_supplied boolean,
  p_purposes text[],
  p_party_resource_id text,
  p_party_contact_point_resource_id text,
  p_party_contact_point_revision integer,
  p_postal_address jsonb,
  p_source_transition_supplied boolean,
  p_source_transition_from_kind text,
  p_source_transition_to_kind text,
  p_reason text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  saved_address_id text,
  source_kind text,
  label text,
  purposes text[],
  party_resource_id text,
  party_contact_point_resource_id text,
  party_contact_point_revision integer,
  address_line_1 text,
  address_line_2 text,
  city text,
  administrative_area text,
  postal_code text,
  country_code text,
  lifecycle text,
  revision integer,
  cleared_purposes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
  v_address commerce_customer_context.saved_addresses%ROWTYPE;
  v_purposes text[];
  v_target_label text;
  v_target_source_kind text;
  v_target_party_id text;
  v_target_contact_id text;
  v_target_contact_revision integer;
  v_target_postal jsonb;
  v_cleared text[] := ARRAY[]::text[];
  v_now timestamptz := clock_timestamp();
  v_default_revision integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT profile.customer_profile_id INTO v_profile_id
    FROM commerce_customer_context.customer_profiles AS profile
   WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
     AND profile.customer_profile_id::text = p_profile_resource_id
     AND profile.profile_kind = p_profile_kind
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;
  IF (p_profile_kind = 'RETAIL' AND (p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
       WHERE retail.tenant_id = p_tenant_id AND retail.legal_entity_id = p_legal_entity_id
         AND retail.retail_customer_profile_id = v_profile_id
    ))) OR (p_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
       WHERE counterparty.tenant_id = p_tenant_id AND counterparty.legal_entity_id = p_legal_entity_id
         AND counterparty.counterparty_purchasing_profile_id = v_profile_id
         AND counterparty.counterparty_resource_id = p_counterparty_resource_id
    ))
  THEN
    RETURN QUERY SELECT 'SUBJECT_MISMATCH'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT address.* INTO v_address
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = v_profile_id
     AND address.saved_address_id::text = p_saved_address_resource_id
  FOR UPDATE;
  IF v_address.saved_address_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  v_target_label := CASE WHEN p_label_supplied THEN p_label ELSE v_address.label END;
  v_target_source_kind := CASE WHEN p_origin_supplied THEN p_source_kind ELSE v_address.source_kind END;
  v_target_party_id := CASE WHEN p_origin_supplied THEN p_party_resource_id ELSE v_address.party_resource_id END;
  v_target_contact_id := CASE WHEN p_origin_supplied THEN p_party_contact_point_resource_id ELSE v_address.party_contact_point_resource_id END;
  v_target_contact_revision := CASE WHEN p_origin_supplied THEN p_party_contact_point_revision ELSE v_address.party_contact_point_revision END;
  v_target_postal := CASE
    WHEN p_origin_supplied THEN p_postal_address
    WHEN v_address.source_kind = 'COMMERCE_ONLY' THEN jsonb_build_object(
      'addressLine1', v_address.address_line_1, 'addressLine2', v_address.address_line_2,
      'city', v_address.locality, 'region', v_address.administrative_area,
      'postalCode', v_address.postal_code, 'countryCode', v_address.country_code)
    ELSE NULL
  END;
  SELECT array_agg(purpose ORDER BY purpose) INTO v_purposes
    FROM (SELECT DISTINCT unnest(CASE WHEN p_purposes_supplied THEN p_purposes ELSE
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes)) END) AS purpose) AS normalized;

  IF v_address.lifecycle = 'REMOVED' THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;
  IF coalesce(array_length(v_purposes, 1), 0) NOT BETWEEN 1 AND 2
    OR p_expected_revision IS NULL
    OR p_expected_revision < 1
    OR EXISTS (SELECT 1 FROM unnest(v_purposes) AS purpose WHERE purpose NOT IN ('BILLING', 'DELIVERY'))
    OR v_target_label IS DISTINCT FROM nullif(btrim(v_target_label), '')
    OR p_reason IS NULL
    OR p_reason IS DISTINCT FROM nullif(btrim(p_reason), '')
    OR length(p_reason) > 500
    OR (p_source_transition_supplied AND (
      NOT p_origin_supplied
      OR p_source_transition_from_kind NOT IN ('PARTY_BACKED', 'COMMERCE_ONLY')
      OR p_source_transition_to_kind NOT IN ('PARTY_BACKED', 'COMMERCE_ONLY')
      OR p_source_transition_from_kind = p_source_transition_to_kind
      OR p_source_transition_to_kind IS DISTINCT FROM v_target_source_kind
    ))
    OR (NOT p_source_transition_supplied AND (
      p_source_transition_from_kind IS NOT NULL OR p_source_transition_to_kind IS NOT NULL
    ))
    OR (v_target_source_kind = 'PARTY_BACKED' AND
      (v_target_party_id IS NULL OR v_target_contact_id IS NULL OR
       coalesce(v_target_contact_revision, 0) < 1 OR v_target_postal IS NOT NULL))
    OR (v_target_source_kind = 'COMMERCE_ONLY' AND
      (v_target_party_id IS NOT NULL OR v_target_contact_id IS NOT NULL OR
       v_target_contact_revision IS NOT NULL OR v_target_postal IS NULL OR
       coalesce(v_target_postal->>'addressLine1', '') = '' OR
       coalesce(v_target_postal->>'city', '') = '' OR
       coalesce(v_target_postal->>'postalCode', '') = '' OR
       coalesce(v_target_postal->>'countryCode', '') !~ '^[A-Z]{2}$'))
    OR v_target_source_kind NOT IN ('PARTY_BACKED', 'COMMERCE_ONLY')
  THEN
    RETURN QUERY SELECT 'INVALID'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;

  IF p_origin_supplied
    AND v_target_source_kind IS DISTINCT FROM v_address.source_kind
    AND (
      NOT p_source_transition_supplied
      OR p_source_transition_from_kind IS DISTINCT FROM v_address.source_kind
      OR p_source_transition_to_kind IS DISTINCT FROM v_target_source_kind
    )
  THEN
    RETURN QUERY SELECT 'SOURCE_TRANSITION_REQUIRED'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;

  IF (
    v_address.label IS NOT DISTINCT FROM v_target_label AND
    v_address.source_kind = v_target_source_kind AND
    v_address.purposes = to_jsonb(v_purposes) AND
    v_address.party_resource_id IS NOT DISTINCT FROM v_target_party_id AND
    v_address.party_contact_point_resource_id IS NOT DISTINCT FROM v_target_contact_id AND
    v_address.party_contact_point_revision IS NOT DISTINCT FROM v_target_contact_revision AND
    v_address.address_line_1 IS NOT DISTINCT FROM v_target_postal->>'addressLine1' AND
    v_address.address_line_2 IS NOT DISTINCT FROM v_target_postal->>'addressLine2' AND
    v_address.locality IS NOT DISTINCT FROM v_target_postal->>'city' AND
    v_address.administrative_area IS NOT DISTINCT FROM v_target_postal->>'region' AND
    v_address.postal_code IS NOT DISTINCT FROM v_target_postal->>'postalCode' AND
    v_address.country_code IS NOT DISTINCT FROM v_target_postal->>'countryCode'
  ) THEN
    RETURN QUERY SELECT 'UNCHANGED'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;
  IF v_address.last_action_invocation_id = p_action_invocation_id THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;
  IF p_expected_revision <> v_address.revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT coalesce(array_agg(default_record.default_kind ORDER BY default_record.default_kind), ARRAY[]::text[])
    INTO v_cleared
    FROM commerce_customer_context.customer_address_defaults AS default_record
   WHERE default_record.tenant_id = p_tenant_id
     AND default_record.legal_entity_id = p_legal_entity_id
     AND default_record.customer_profile_id = v_profile_id
     AND default_record.saved_address_id = v_address.saved_address_id
     AND default_record.lifecycle = 'ACTIVE'
     AND default_record.effective_to IS NULL
     AND NOT (default_record.default_kind = ANY(v_purposes));
  IF array_length(v_cleared, 1) IS NOT NULL THEN
    SELECT greatest(v_now, max(default_record.effective_from) + interval '1 microsecond')
      INTO v_now
      FROM commerce_customer_context.customer_address_defaults AS default_record
     WHERE default_record.tenant_id = p_tenant_id
       AND default_record.legal_entity_id = p_legal_entity_id
       AND default_record.customer_profile_id = v_profile_id
       AND default_record.saved_address_id = v_address.saved_address_id
       AND default_record.lifecycle = 'ACTIVE'
       AND default_record.effective_to IS NULL
       AND NOT (default_record.default_kind = ANY(v_purposes));
    UPDATE commerce_customer_context.customer_address_defaults AS default_record
       SET effective_to = v_now, lifecycle = 'ENDED',
           action_invocation_id = p_action_invocation_id,
           actor_principal_id = p_actor_principal_id,
           reason = p_reason,
           recorded_at = v_now
     WHERE default_record.tenant_id = p_tenant_id
       AND default_record.legal_entity_id = p_legal_entity_id
       AND default_record.customer_profile_id = v_profile_id
       AND default_record.saved_address_id = v_address.saved_address_id
       AND default_record.lifecycle = 'ACTIVE'
       AND default_record.effective_to IS NULL
       AND NOT (default_record.default_kind = ANY(v_purposes));
    SELECT coalesce(setting.current_revision, 0) + 1 INTO v_default_revision
      FROM (SELECT 1) AS seed
      LEFT JOIN commerce_customer_context.customer_setting_revisions AS setting
        ON setting.tenant_id = p_tenant_id AND setting.legal_entity_id = p_legal_entity_id
       AND setting.customer_profile_id = v_profile_id AND setting.setting_kind = 'ADDRESS_DEFAULTS';
    INSERT INTO commerce_customer_context.customer_setting_revisions (
      tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
      last_action_invocation_id, updated_at
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, 'ADDRESS_DEFAULTS', v_default_revision,
      p_action_invocation_id, v_now
    ) ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind)
      DO UPDATE SET current_revision = excluded.current_revision,
                    last_action_invocation_id = excluded.last_action_invocation_id,
                    updated_at = excluded.updated_at;
  END IF;

  UPDATE commerce_customer_context.saved_addresses AS address
     SET label = v_target_label,
         purposes = to_jsonb(v_purposes),
         source_kind = v_target_source_kind,
         party_resource_id = v_target_party_id,
         party_contact_point_resource_id = v_target_contact_id,
         party_contact_point_revision = v_target_contact_revision,
         address_line_1 = v_target_postal->>'addressLine1',
         address_line_2 = v_target_postal->>'addressLine2',
         locality = v_target_postal->>'city',
         administrative_area = v_target_postal->>'region',
         postal_code = v_target_postal->>'postalCode',
         country_code = v_target_postal->>'countryCode',
         revision = address.revision + 1,
         updated_at = v_now,
         last_action_invocation_id = p_action_invocation_id,
         last_actor_principal_id = p_actor_principal_id,
         last_reason = p_reason
   WHERE address.saved_address_id = v_address.saved_address_id
  RETURNING * INTO v_address;

  RETURN QUERY SELECT 'UPDATED'::text, v_address.saved_address_id::text,
    v_address.source_kind, v_address.label,
    ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
    v_address.party_resource_id, v_address.party_contact_point_resource_id,
    v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
    v_address.locality, v_address.administrative_area, v_address.postal_code,
    v_address.country_code, v_address.lifecycle, v_address.revision, v_cleared;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."remove_saved_address"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_saved_address_resource_id text,
  p_expected_revision integer,
  p_reason text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  saved_address_id text,
  source_kind text,
  label text,
  purposes text[],
  party_resource_id text,
  party_contact_point_resource_id text,
  party_contact_point_revision integer,
  address_line_1 text,
  address_line_2 text,
  city text,
  administrative_area text,
  postal_code text,
  country_code text,
  lifecycle text,
  revision integer,
  cleared_purposes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
  v_address commerce_customer_context.saved_addresses%ROWTYPE;
  v_cleared text[] := ARRAY[]::text[];
  v_now timestamptz := clock_timestamp();
  v_default_revision integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL
    OR p_reason IS DISTINCT FROM nullif(btrim(p_reason), '')
    OR length(p_reason) > 500
    OR p_expected_revision IS NULL
    OR p_expected_revision < 1
  THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;
  SELECT profile.customer_profile_id INTO v_profile_id
    FROM commerce_customer_context.customer_profiles AS profile
   WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
     AND profile.customer_profile_id::text = p_profile_resource_id
     AND profile.profile_kind = p_profile_kind
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;
  IF (p_profile_kind = 'RETAIL' AND (p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
       WHERE retail.tenant_id = p_tenant_id AND retail.legal_entity_id = p_legal_entity_id
         AND retail.retail_customer_profile_id = v_profile_id
    ))) OR (p_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
       WHERE counterparty.tenant_id = p_tenant_id AND counterparty.legal_entity_id = p_legal_entity_id
         AND counterparty.counterparty_purchasing_profile_id = v_profile_id
         AND counterparty.counterparty_resource_id = p_counterparty_resource_id
    ))
  THEN
    RETURN QUERY SELECT 'SUBJECT_MISMATCH'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT address.* INTO v_address
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = v_profile_id
     AND address.saved_address_id::text = p_saved_address_resource_id
  FOR UPDATE;
  IF v_address.saved_address_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      ARRAY[]::text[], NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0, ARRAY[]::text[];
    RETURN;
  END IF;
  IF v_address.lifecycle = 'REMOVED' THEN
    RETURN QUERY SELECT 'ALREADY_REMOVED'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;
  IF p_expected_revision <> v_address.revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_address.saved_address_id::text,
      v_address.source_kind, v_address.label,
      ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
      v_address.party_resource_id, v_address.party_contact_point_resource_id,
      v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
      v_address.locality, v_address.administrative_area, v_address.postal_code,
      v_address.country_code, v_address.lifecycle, v_address.revision, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT coalesce(array_agg(default_record.default_kind ORDER BY default_record.default_kind), ARRAY[]::text[])
    INTO v_cleared
    FROM commerce_customer_context.customer_address_defaults AS default_record
   WHERE default_record.tenant_id = p_tenant_id AND default_record.legal_entity_id = p_legal_entity_id
     AND default_record.customer_profile_id = v_profile_id
     AND default_record.saved_address_id = v_address.saved_address_id
     AND default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL;
  IF array_length(v_cleared, 1) IS NOT NULL THEN
    SELECT greatest(v_now, max(default_record.effective_from) + interval '1 microsecond') INTO v_now
      FROM commerce_customer_context.customer_address_defaults AS default_record
     WHERE default_record.tenant_id = p_tenant_id AND default_record.legal_entity_id = p_legal_entity_id
       AND default_record.customer_profile_id = v_profile_id
       AND default_record.saved_address_id = v_address.saved_address_id
       AND default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL;
    UPDATE commerce_customer_context.customer_address_defaults AS default_record
       SET effective_to = v_now, lifecycle = 'ENDED',
           action_invocation_id = p_action_invocation_id,
           actor_principal_id = p_actor_principal_id,
           reason = p_reason,
           recorded_at = v_now
     WHERE default_record.tenant_id = p_tenant_id AND default_record.legal_entity_id = p_legal_entity_id
       AND default_record.customer_profile_id = v_profile_id
       AND default_record.saved_address_id = v_address.saved_address_id
       AND default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL;
    SELECT coalesce(setting.current_revision, 0) + 1 INTO v_default_revision
      FROM (SELECT 1) AS seed
      LEFT JOIN commerce_customer_context.customer_setting_revisions AS setting
        ON setting.tenant_id = p_tenant_id AND setting.legal_entity_id = p_legal_entity_id
       AND setting.customer_profile_id = v_profile_id AND setting.setting_kind = 'ADDRESS_DEFAULTS';
    INSERT INTO commerce_customer_context.customer_setting_revisions (
      tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
      last_action_invocation_id, updated_at
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, 'ADDRESS_DEFAULTS', v_default_revision,
      p_action_invocation_id, v_now
    ) ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind)
      DO UPDATE SET current_revision = excluded.current_revision,
                    last_action_invocation_id = excluded.last_action_invocation_id,
                    updated_at = excluded.updated_at;
  END IF;

  UPDATE commerce_customer_context.saved_addresses AS address
     SET lifecycle = 'REMOVED', removed_at = v_now, revision = address.revision + 1,
         updated_at = v_now, last_action_invocation_id = p_action_invocation_id,
         last_actor_principal_id = p_actor_principal_id, last_reason = p_reason
   WHERE address.saved_address_id = v_address.saved_address_id
  RETURNING * INTO v_address;
  RETURN QUERY SELECT 'REMOVED'::text, v_address.saved_address_id::text,
    v_address.source_kind, v_address.label,
    ARRAY(SELECT jsonb_array_elements_text(v_address.purposes) ORDER BY 1),
    v_address.party_resource_id, v_address.party_contact_point_resource_id,
    v_address.party_contact_point_revision, v_address.address_line_1, v_address.address_line_2,
    v_address.locality, v_address.administrative_area, v_address.postal_code,
    v_address.country_code, v_address.lifecycle, v_address.revision, v_cleared;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."change_address_default"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_change_kind text,
  p_default_kind text,
  p_saved_address_resource_id text,
  p_expected_defaults_revision integer,
  p_reason text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  revision integer,
  billing_saved_address_id text,
  delivery_saved_address_id text,
  cleared_saved_address_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
  v_address commerce_customer_context.saved_addresses%ROWTYPE;
  v_current commerce_customer_context.customer_address_defaults%ROWTYPE;
  v_current_revision integer := 0;
  v_last_action_invocation_id uuid;
  v_next_revision integer;
  v_now timestamptz := clock_timestamp();
  v_cleared_id text;
  v_billing text;
  v_delivery text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_change_kind NOT IN ('SET', 'CLEAR') OR p_default_kind NOT IN ('BILLING', 'DELIVERY')
    OR (p_change_kind = 'SET' AND p_saved_address_resource_id IS NULL)
    OR (p_change_kind = 'CLEAR' AND p_saved_address_resource_id IS NOT NULL)
    OR p_expected_defaults_revision IS NULL
    OR p_expected_defaults_revision < 0
    OR p_reason IS NULL
    OR p_reason IS DISTINCT FROM nullif(btrim(p_reason), '')
    OR length(p_reason) > 500
  THEN
    RETURN QUERY SELECT 'INVALID'::text, 0, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT profile.customer_profile_id INTO v_profile_id
    FROM commerce_customer_context.customer_profiles AS profile
   WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
     AND profile.customer_profile_id::text = p_profile_resource_id
     AND profile.profile_kind = p_profile_kind
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, 0, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF (p_profile_kind = 'RETAIL' AND (p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
       WHERE retail.tenant_id = p_tenant_id AND retail.legal_entity_id = p_legal_entity_id
         AND retail.retail_customer_profile_id = v_profile_id
    ))) OR (p_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
       WHERE counterparty.tenant_id = p_tenant_id AND counterparty.legal_entity_id = p_legal_entity_id
         AND counterparty.counterparty_purchasing_profile_id = v_profile_id
         AND counterparty.counterparty_resource_id = p_counterparty_resource_id
    ))
  THEN
    RETURN QUERY SELECT 'SUBJECT_MISMATCH'::text, 0, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT coalesce(setting.current_revision, 0), setting.last_action_invocation_id
    INTO v_current_revision, v_last_action_invocation_id
    FROM (SELECT 1) AS seed
    LEFT JOIN commerce_customer_context.customer_setting_revisions AS setting
      ON setting.tenant_id = p_tenant_id AND setting.legal_entity_id = p_legal_entity_id
     AND setting.customer_profile_id = v_profile_id AND setting.setting_kind = 'ADDRESS_DEFAULTS';
  SELECT default_record.* INTO v_current
    FROM commerce_customer_context.customer_address_defaults AS default_record
   WHERE default_record.tenant_id = p_tenant_id AND default_record.legal_entity_id = p_legal_entity_id
     AND default_record.customer_profile_id = v_profile_id
     AND default_record.default_kind = p_default_kind
     AND default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL
   ORDER BY default_record.revision DESC LIMIT 1
  FOR UPDATE;

  IF p_expected_defaults_revision <> v_current_revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_current_revision,
      NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF p_change_kind = 'SET' AND v_current.saved_address_id::text = p_saved_address_resource_id THEN
    SELECT billing.saved_address_id::text, delivery.saved_address_id::text INTO v_billing, v_delivery
      FROM (SELECT v_profile_id AS customer_profile_id) AS target
      LEFT JOIN LATERAL (SELECT d.saved_address_id FROM commerce_customer_context.customer_address_defaults d
        WHERE d.tenant_id=p_tenant_id AND d.legal_entity_id=p_legal_entity_id AND d.customer_profile_id=target.customer_profile_id
          AND d.default_kind='BILLING' AND d.lifecycle='ACTIVE' AND d.effective_to IS NULL LIMIT 1) billing ON true
      LEFT JOIN LATERAL (SELECT d.saved_address_id FROM commerce_customer_context.customer_address_defaults d
        WHERE d.tenant_id=p_tenant_id AND d.legal_entity_id=p_legal_entity_id AND d.customer_profile_id=target.customer_profile_id
          AND d.default_kind='DELIVERY' AND d.lifecycle='ACTIVE' AND d.effective_to IS NULL LIMIT 1) delivery ON true;
    RETURN QUERY SELECT 'UNCHANGED'::text, v_current_revision, v_billing, v_delivery, NULL::text;
    RETURN;
  END IF;
  IF p_change_kind = 'CLEAR' AND v_current.customer_address_default_id IS NULL THEN
    SELECT billing.saved_address_id::text, delivery.saved_address_id::text INTO v_billing, v_delivery
      FROM (SELECT v_profile_id AS customer_profile_id) AS target
      LEFT JOIN LATERAL (SELECT d.saved_address_id FROM commerce_customer_context.customer_address_defaults d
        WHERE d.tenant_id=p_tenant_id AND d.legal_entity_id=p_legal_entity_id AND d.customer_profile_id=target.customer_profile_id
          AND d.default_kind='BILLING' AND d.lifecycle='ACTIVE' AND d.effective_to IS NULL LIMIT 1) billing ON true
      LEFT JOIN LATERAL (SELECT d.saved_address_id FROM commerce_customer_context.customer_address_defaults d
        WHERE d.tenant_id=p_tenant_id AND d.legal_entity_id=p_legal_entity_id AND d.customer_profile_id=target.customer_profile_id
          AND d.default_kind='DELIVERY' AND d.lifecycle='ACTIVE' AND d.effective_to IS NULL LIMIT 1) delivery ON true;
    RETURN QUERY SELECT 'ALREADY_CLEAR'::text, v_current_revision, v_billing, v_delivery, NULL::text;
    RETURN;
  END IF;
  IF v_last_action_invocation_id = p_action_invocation_id THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_current_revision,
      NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF p_change_kind = 'SET' THEN
    SELECT address.* INTO v_address
      FROM commerce_customer_context.saved_addresses AS address
     WHERE address.tenant_id = p_tenant_id AND address.legal_entity_id = p_legal_entity_id
       AND address.customer_profile_id = v_profile_id
       AND address.saved_address_id::text = p_saved_address_resource_id
       AND address.lifecycle = 'ACTIVE'
       AND address.purposes ? p_default_kind
    FOR UPDATE;
    IF v_address.saved_address_id IS NULL THEN
      RETURN QUERY SELECT 'INVALID'::text, v_current_revision, NULL::text, NULL::text, NULL::text;
      RETURN;
    END IF;
  END IF;

  IF v_current.customer_address_default_id IS NOT NULL THEN
    v_now := greatest(v_now, v_current.effective_from + interval '1 microsecond');
    v_cleared_id := v_current.saved_address_id::text;
    UPDATE commerce_customer_context.customer_address_defaults
       SET effective_to = v_now,
           lifecycle = 'ENDED',
           action_invocation_id = p_action_invocation_id,
           actor_principal_id = p_actor_principal_id,
           reason = p_reason,
           recorded_at = v_now
     WHERE customer_address_default_id = v_current.customer_address_default_id;
  END IF;
  v_next_revision := v_current_revision + 1;
  IF p_change_kind = 'SET' THEN
    INSERT INTO commerce_customer_context.customer_address_defaults (
      tenant_id, legal_entity_id, customer_profile_id, default_kind, saved_address_id,
      effective_from, lifecycle, revision, action_invocation_id, actor_principal_id, reason,
      recorded_at
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_default_kind, v_address.saved_address_id,
      v_now, 'ACTIVE', v_next_revision, p_action_invocation_id, p_actor_principal_id, p_reason,
      v_now
    );
  END IF;
  INSERT INTO commerce_customer_context.customer_setting_revisions (
    tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
    last_action_invocation_id, updated_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile_id, 'ADDRESS_DEFAULTS', v_next_revision,
    p_action_invocation_id, v_now
  ) ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind)
    DO UPDATE SET current_revision = excluded.current_revision,
                  last_action_invocation_id = excluded.last_action_invocation_id,
                  updated_at = excluded.updated_at;

  SELECT billing.saved_address_id::text, delivery.saved_address_id::text INTO v_billing, v_delivery
    FROM (SELECT v_profile_id AS customer_profile_id) AS target
    LEFT JOIN LATERAL (SELECT d.saved_address_id FROM commerce_customer_context.customer_address_defaults d
      WHERE d.tenant_id=p_tenant_id AND d.legal_entity_id=p_legal_entity_id AND d.customer_profile_id=target.customer_profile_id
        AND d.default_kind='BILLING' AND d.lifecycle='ACTIVE' AND d.effective_to IS NULL LIMIT 1) billing ON true
    LEFT JOIN LATERAL (SELECT d.saved_address_id FROM commerce_customer_context.customer_address_defaults d
      WHERE d.tenant_id=p_tenant_id AND d.legal_entity_id=p_legal_entity_id AND d.customer_profile_id=target.customer_profile_id
        AND d.default_kind='DELIVERY' AND d.lifecycle='ACTIVE' AND d.effective_to IS NULL LIMIT 1) delivery ON true;
  RETURN QUERY SELECT CASE WHEN p_change_kind = 'SET' THEN 'SET' ELSE 'CLEARED' END,
    v_next_revision, v_billing, v_delivery, CASE WHEN p_change_kind = 'CLEAR' THEN v_cleared_id ELSE NULL END;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_case_resource_id text,
  p_survivor_profile_resource_id text,
  p_expected_case_revision integer,
  p_expected_event_version bigint
)
RETURNS TABLE (
  outcome text,
  status text,
  evidence_ref text,
  correlation_ref text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_case commerce_customer_context.profile_reconciliation_cases%ROWTYPE;
  v_active_address_count integer;
  v_active_default_count integer;
  v_address_count integer;
  v_default_count integer;
  v_fingerprint text;
  v_status text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT reconciliation.*
    INTO v_case
    FROM commerce_customer_context.profile_reconciliation_cases AS reconciliation
   WHERE reconciliation.tenant_id = p_tenant_id
     AND reconciliation.legal_entity_id = p_legal_entity_id
     AND reconciliation.profile_reconciliation_case_id::text = p_case_resource_id
   FOR UPDATE;
  IF v_case.profile_reconciliation_case_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF p_expected_case_revision IS NULL
    OR p_expected_case_revision <> v_case.revision
    OR p_expected_event_version IS NULL
    OR p_expected_event_version <> v_case.last_processed_event_version
    OR v_case.lifecycle NOT IN ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE')
    OR NOT EXISTS (
      SELECT 1
        FROM commerce_customer_context.profile_reconciliation_case_members AS member
       WHERE member.tenant_id = p_tenant_id
         AND member.legal_entity_id = p_legal_entity_id
         AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
         AND member.customer_profile_id::text = p_survivor_profile_resource_id
    )
    OR (
      SELECT count(*)
        FROM commerce_customer_context.profile_reconciliation_case_members AS member
       WHERE member.tenant_id = p_tenant_id
         AND member.legal_entity_id = p_legal_entity_id
         AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
    ) < 2
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  PERFORM profile.customer_profile_id
    FROM commerce_customer_context.profile_reconciliation_case_members AS member
    JOIN commerce_customer_context.customer_profiles AS profile
      ON profile.tenant_id = member.tenant_id
     AND profile.legal_entity_id = member.legal_entity_id
     AND profile.customer_profile_id = member.customer_profile_id
   WHERE member.tenant_id = p_tenant_id
     AND member.legal_entity_id = p_legal_entity_id
     AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
   ORDER BY profile.customer_profile_id
   FOR UPDATE OF profile;

  SELECT
    count(*) FILTER (WHERE address.lifecycle = 'ACTIVE'),
    count(*)
    INTO v_active_address_count, v_address_count
    FROM commerce_customer_context.saved_addresses AS address
    JOIN commerce_customer_context.profile_reconciliation_case_members AS member
      ON member.tenant_id = address.tenant_id
     AND member.legal_entity_id = address.legal_entity_id
     AND member.customer_profile_id = address.customer_profile_id
     AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND member.customer_profile_id::text <> p_survivor_profile_resource_id;

  SELECT
    count(*) FILTER (
      WHERE default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL
    ),
    count(*)
    INTO v_active_default_count, v_default_count
    FROM commerce_customer_context.customer_address_defaults AS default_record
    JOIN commerce_customer_context.profile_reconciliation_case_members AS member
      ON member.tenant_id = default_record.tenant_id
     AND member.legal_entity_id = default_record.legal_entity_id
     AND member.customer_profile_id = default_record.customer_profile_id
     AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
   WHERE default_record.tenant_id = p_tenant_id
     AND default_record.legal_entity_id = p_legal_entity_id
     AND member.customer_profile_id::text <> p_survivor_profile_resource_id;

  IF v_active_address_count > 0 OR v_active_default_count > 0 THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT md5(
    coalesce((
      SELECT string_agg(
        address.saved_address_id::text || ':' || address.revision::text || ':' || address.lifecycle,
        ',' ORDER BY address.saved_address_id
      )
        FROM commerce_customer_context.saved_addresses AS address
        JOIN commerce_customer_context.profile_reconciliation_case_members AS member
          ON member.tenant_id = address.tenant_id
         AND member.legal_entity_id = address.legal_entity_id
         AND member.customer_profile_id = address.customer_profile_id
         AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
       WHERE address.tenant_id = p_tenant_id
         AND address.legal_entity_id = p_legal_entity_id
         AND member.customer_profile_id::text <> p_survivor_profile_resource_id
    ), 'NO_ADDRESSES') || '|' || coalesce((
      SELECT string_agg(
        default_record.customer_address_default_id::text || ':' || default_record.revision::text || ':' || default_record.lifecycle,
        ',' ORDER BY default_record.customer_address_default_id
      )
        FROM commerce_customer_context.customer_address_defaults AS default_record
        JOIN commerce_customer_context.profile_reconciliation_case_members AS member
          ON member.tenant_id = default_record.tenant_id
         AND member.legal_entity_id = default_record.legal_entity_id
         AND member.customer_profile_id = default_record.customer_profile_id
         AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
       WHERE default_record.tenant_id = p_tenant_id
         AND default_record.legal_entity_id = p_legal_entity_id
         AND member.customer_profile_id::text <> p_survivor_profile_resource_id
    ), 'NO_DEFAULTS')
  ) INTO v_fingerprint;

  v_status := CASE
    WHEN v_address_count = 0 AND v_default_count = 0 THEN 'NOT_APPLICABLE'
    ELSE 'RESOLVED'
  END;
  RETURN QUERY SELECT
    'VERIFIED'::text,
    v_status,
    format('address-book-reconciliation:%s:%s', v_case.profile_reconciliation_case_id, v_fingerprint),
    format('address-book-owner:%s:%s:%s', v_case.profile_reconciliation_case_id, v_case.revision, v_fingerprint);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."list_saved_addresses"(uuid, uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_saved_address"(uuid, uuid, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_address_defaults"(uuid, uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."add_saved_address"(uuid, uuid, text, text, text, text, text, text[], text, text, integer, jsonb, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."update_saved_address"(uuid, uuid, text, text, text, text, integer, boolean, text, boolean, text, boolean, text[], text, text, integer, jsonb, boolean, text, text, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."remove_saved_address"(uuid, uuid, text, text, text, text, integer, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."change_address_default"(uuid, uuid, text, text, text, text, text, text, integer, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"(uuid, uuid, text, text, integer, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."list_saved_addresses"(uuid, uuid, text, text, text) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_saved_address"(uuid, uuid, text, text, text, text) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_address_defaults"(uuid, uuid, text, text, text) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."add_saved_address"(uuid, uuid, text, text, text, text, text, text[], text, text, integer, jsonb, text, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."update_saved_address"(uuid, uuid, text, text, text, text, integer, boolean, text, boolean, text, boolean, text[], text, text, integer, jsonb, boolean, text, text, text, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."remove_saved_address"(uuid, uuid, text, text, text, text, integer, text, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."change_address_default"(uuid, uuid, text, text, text, text, text, text, integer, text, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"(uuid, uuid, text, text, integer, bigint) TO "ontos_runtime";
