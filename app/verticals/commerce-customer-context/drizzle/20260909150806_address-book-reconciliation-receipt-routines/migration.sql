-- Replace the provisional verifier with a transaction-bound Address Book receipt.
DROP FUNCTION IF EXISTS "commerce_customer_context"."verify_address_book_reconciliation"(
  uuid, uuid, text, text, integer, bigint
);
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_case_resource_id text,
  p_survivor_profile_resource_id text,
  p_expected_case_revision integer,
  p_expected_event_version bigint,
  p_effective_at timestamptz,
  p_resulting_state text,
  p_reason text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid,
  p_policy_version text
)
RETURNS TABLE (
  outcome text,
  status text,
  evidence_ref text,
  correlation_ref text,
  receipt_id text,
  before_facts_sha256 text,
  after_facts_sha256 text,
  postcondition_sha256 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_case commerce_customer_context.profile_reconciliation_cases%ROWTYPE;
  v_existing commerce_customer_context.address_book_reconciliation_receipts%ROWTYPE;
  v_explicit commerce_customer_context.address_book_reconciliation_receipts%ROWTYPE;
  v_member_profile_ids uuid[];
  v_member_count integer;
  v_address_count integer;
  v_active_address_count integer;
  v_default_count integer;
  v_active_default_count integer;
  v_survivor_address_count integer;
  v_survivor_default_count integer;
  v_losing_address_facts text;
  v_losing_default_facts text;
  v_survivor_address_facts text;
  v_survivor_default_facts text;
  v_before_facts text;
  v_after_facts text;
  v_postcondition text;
  v_before_facts_sha256 text;
  v_after_facts_sha256 text;
  v_postcondition_sha256 text;
  v_disposition text;
  v_status text;
  v_owner_decision_ref text;
  v_evidence_ref text;
  v_correlation_ref text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_expected_case_revision IS NULL
    OR p_expected_case_revision < 1
    OR p_expected_event_version IS NULL
    OR p_expected_event_version < 0
    OR p_survivor_profile_resource_id IS NULL
    OR p_survivor_profile_resource_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_effective_at IS NULL
    OR p_resulting_state IS NULL
    OR p_resulting_state NOT IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')
    OR p_reason IS NULL
    OR p_reason IS DISTINCT FROM nullif(btrim(p_reason), '')
    OR length(p_reason) > 500
    OR p_actor_principal_id IS NULL
    OR p_action_invocation_id IS NULL
    OR p_policy_version IS DISTINCT FROM 'address-book-reconciliation.v2'
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT reconciliation.*
    INTO v_case
    FROM commerce_customer_context.profile_reconciliation_cases AS reconciliation
   WHERE reconciliation.tenant_id = p_tenant_id
     AND reconciliation.legal_entity_id = p_legal_entity_id
     AND reconciliation.profile_reconciliation_case_id::text = p_case_resource_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF p_expected_case_revision IS DISTINCT FROM v_case.revision
    OR p_expected_event_version IS DISTINCT FROM v_case.last_processed_event_version
    OR v_case.lifecycle NOT IN ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE')
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT
    coalesce(array_agg(member.customer_profile_id ORDER BY member.member_position), ARRAY[]::uuid[]),
    count(*)::integer
    INTO v_member_profile_ids, v_member_count
    FROM commerce_customer_context.profile_reconciliation_case_members AS member
   WHERE member.tenant_id = p_tenant_id
     AND member.legal_entity_id = p_legal_entity_id
     AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id;
  IF v_member_count < 2
    OR NOT EXISTS (
      SELECT 1
        FROM unnest(v_member_profile_ids) AS member(member_id)
       WHERE member.member_id::text = p_survivor_profile_resource_id
    )
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Lock all member profiles before reading Address Book state. This keeps the proof stable
  -- until the enclosing Resolve Action records its durable owner outcome.
  PERFORM profile.customer_profile_id
    FROM commerce_customer_context.profile_reconciliation_case_members AS member
    JOIN commerce_customer_context.customer_profiles AS profile
      ON profile.tenant_id = member.tenant_id
     AND profile.legal_entity_id = member.legal_entity_id
     AND profile.customer_profile_id = member.customer_profile_id
   WHERE member.tenant_id = p_tenant_id
     AND member.legal_entity_id = p_legal_entity_id
     AND member.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
   ORDER BY member.member_position
   FOR UPDATE OF profile;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE address.lifecycle = 'ACTIVE')::integer
    INTO v_address_count, v_active_address_count
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
    count(*)::integer,
    count(*) FILTER (
      WHERE default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL
    )::integer
    INTO v_default_count, v_active_default_count
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
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO v_survivor_address_count
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id::text = p_survivor_profile_resource_id;
  SELECT count(*) FILTER (
      WHERE default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL
    )::integer
    INTO v_survivor_default_count
    FROM commerce_customer_context.customer_address_defaults AS default_record
   WHERE default_record.tenant_id = p_tenant_id
     AND default_record.legal_entity_id = p_legal_entity_id
     AND default_record.customer_profile_id::text = p_survivor_profile_resource_id;

  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      address.saved_address_id, address.customer_profile_id, address.source_kind,
      address.party_resource_id, address.party_contact_point_resource_id,
      address.party_contact_point_revision, address.label, address.purposes,
      address.address_line_1, address.address_line_2, address.locality,
      address.administrative_area, address.postal_code, address.country_code,
      address.lifecycle, address.revision
    ), '|' ORDER BY address.saved_address_id), 'NO_ADDRESSES')
    INTO v_losing_address_facts
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id IN (SELECT unnest(v_member_profile_ids))
     AND address.customer_profile_id <> p_survivor_profile_resource_id::uuid;
  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      defaults.customer_address_default_id, defaults.customer_profile_id,
      defaults.default_kind, defaults.saved_address_id, defaults.effective_from,
      defaults.effective_to, defaults.lifecycle, defaults.revision,
      defaults.action_invocation_id, defaults.actor_principal_id, defaults.reason
    ), '|' ORDER BY defaults.customer_address_default_id), 'NO_DEFAULTS')
    INTO v_losing_default_facts
    FROM commerce_customer_context.customer_address_defaults AS defaults
   WHERE defaults.tenant_id = p_tenant_id
     AND defaults.legal_entity_id = p_legal_entity_id
     AND defaults.customer_profile_id IN (SELECT unnest(v_member_profile_ids))
     AND defaults.customer_profile_id <> p_survivor_profile_resource_id::uuid;
  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      address.saved_address_id, address.customer_profile_id, address.source_kind,
      address.party_resource_id, address.party_contact_point_resource_id,
      address.party_contact_point_revision, address.label, address.purposes,
      address.address_line_1, address.address_line_2, address.locality,
      address.administrative_area, address.postal_code, address.country_code,
      address.lifecycle, address.revision
    ), '|' ORDER BY address.saved_address_id), 'NO_ADDRESSES')
    INTO v_survivor_address_facts
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = p_survivor_profile_resource_id::uuid;
  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      defaults.customer_address_default_id, defaults.customer_profile_id,
      defaults.default_kind, defaults.saved_address_id, defaults.effective_from,
      defaults.effective_to, defaults.lifecycle, defaults.revision,
      defaults.action_invocation_id, defaults.actor_principal_id, defaults.reason
    ), '|' ORDER BY defaults.customer_address_default_id), 'NO_DEFAULTS')
    INTO v_survivor_default_facts
    FROM commerce_customer_context.customer_address_defaults AS defaults
   WHERE defaults.tenant_id = p_tenant_id
     AND defaults.legal_entity_id = p_legal_entity_id
     AND defaults.customer_profile_id = p_survivor_profile_resource_id::uuid;

  v_before_facts := format(
    'address-book-before:v3|case=%s|members=%s|losing-address-facts=%s|losing-default-facts=%s|losing-addresses=%s|losing-active-addresses=%s|losing-defaults=%s|losing-active-defaults=%s',
    v_case.profile_reconciliation_case_id,
    array_to_string(v_member_profile_ids, ','),
    v_losing_address_facts,
    v_losing_default_facts,
    v_address_count,
    v_active_address_count,
    v_default_count,
    v_active_default_count
  );
  v_disposition := CASE
    WHEN v_address_count = 0 AND v_default_count = 0 THEN 'NOT_APPLICABLE'
    ELSE 'ALREADY_SATISFIED'
  END;
  v_status := CASE WHEN v_disposition = 'NOT_APPLICABLE' THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END;
  v_after_facts := format(
    'address-book-after:v3|case=%s|survivor=%s|survivor-address-facts=%s|survivor-default-facts=%s|survivor-addresses=%s|survivor-active-defaults=%s|case-revision=%s|event-version=%s|resulting-state=%s',
    v_case.profile_reconciliation_case_id,
    p_survivor_profile_resource_id,
    v_survivor_address_facts,
    v_survivor_default_facts,
    v_survivor_address_count,
    v_survivor_default_count,
    v_case.revision,
    p_expected_event_version,
    p_resulting_state
  );
  v_postcondition := format(
    'address-book-postcondition:v3|before=%s|after=%s|policy-version=%s|effective-at=%s|resulting-state=%s|reason=%s',
    v_before_facts, v_after_facts, p_policy_version, p_effective_at, p_resulting_state, p_reason
  );
  v_before_facts_sha256 := encode(sha256(convert_to(v_before_facts, 'UTF8')), 'hex');
  v_after_facts_sha256 := encode(sha256(convert_to(v_after_facts, 'UTF8')), 'hex');
  v_postcondition_sha256 := encode(sha256(convert_to(v_postcondition, 'UTF8')), 'hex');

  -- Inactive historical facts are not self-proving. They require an earlier explicit owner
  -- reconciliation receipt; this Resolve verifier is allowed to append only the terminal
  -- ALREADY_SATISFIED receipt for the current action.
  IF v_address_count > 0 OR v_default_count > 0 THEN
    SELECT receipt.*
      INTO v_explicit
      FROM commerce_customer_context.address_book_reconciliation_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id
       AND receipt.legal_entity_id = p_legal_entity_id
       AND receipt.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
       AND receipt.disposition = 'EXPLICIT_RECONCILIATION'
     ORDER BY receipt.recorded_at DESC, receipt.address_book_reconciliation_receipt_id DESC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND
      OR v_explicit.terminal_status IS DISTINCT FROM 'RESOLVED'
      OR v_explicit.survivor_profile_id IS DISTINCT FROM p_survivor_profile_resource_id::uuid
      OR v_explicit.member_profile_ids IS DISTINCT FROM v_member_profile_ids
      OR v_explicit.case_revision_at_receipt IS DISTINCT FROM p_expected_case_revision
      OR v_explicit.event_version IS DISTINCT FROM p_expected_event_version
      OR v_explicit.policy_version IS DISTINCT FROM p_policy_version
      OR v_explicit.resulting_state IS DISTINCT FROM p_resulting_state
      OR v_explicit.before_facts_sha256 IS DISTINCT FROM v_before_facts_sha256
      OR v_explicit.after_facts_sha256 IS DISTINCT FROM v_after_facts_sha256
    THEN
      RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
        NULL::text, v_before_facts_sha256, v_after_facts_sha256, v_postcondition_sha256;
      RETURN;
    END IF;
  END IF;

  -- A previously recorded receipt is usable only when its stored hashes still agree
  -- with this exact locked state and request. Replaying a stale receipt is a conflict.
  SELECT receipt.*
    INTO v_existing
    FROM commerce_customer_context.address_book_reconciliation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.profile_reconciliation_case_id = v_case.profile_reconciliation_case_id
     AND receipt.action_invocation_id = p_action_invocation_id
     AND receipt.survivor_profile_id = p_survivor_profile_resource_id::uuid
     AND receipt.case_revision_at_receipt = p_expected_case_revision
     AND receipt.event_version = p_expected_event_version
     AND receipt.policy_version = p_policy_version
     AND receipt.resulting_state = p_resulting_state
   ORDER BY receipt.recorded_at DESC, receipt.address_book_reconciliation_receipt_id DESC
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.disposition NOT IN ('NOT_APPLICABLE', 'ALREADY_SATISFIED')
      OR v_existing.member_profile_ids IS DISTINCT FROM v_member_profile_ids
      OR v_existing.effective_at IS DISTINCT FROM p_effective_at
      OR v_existing.reason IS DISTINCT FROM p_reason
      OR v_existing.actor_principal_id IS DISTINCT FROM p_actor_principal_id
      OR v_existing.before_facts_sha256 IS DISTINCT FROM v_before_facts_sha256
      OR v_existing.after_facts_sha256 IS DISTINCT FROM v_after_facts_sha256
      OR v_existing.postcondition_sha256 IS DISTINCT FROM v_postcondition_sha256
    THEN
      RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
        NULL::text, v_existing.before_facts_sha256, v_after_facts_sha256, v_postcondition_sha256;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'VERIFIED'::text, v_existing.terminal_status, v_existing.evidence_ref,
      v_existing.correlation_ref, v_existing.address_book_reconciliation_receipt_id::text,
      v_existing.before_facts_sha256, v_existing.after_facts_sha256, v_existing.postcondition_sha256;
    RETURN;
  END IF;

  v_owner_decision_ref := CASE
    WHEN v_disposition = 'EXPLICIT_RECONCILIATION'
      THEN format('address-book-decision:%s:%s', v_case.profile_reconciliation_case_id, p_action_invocation_id)
    ELSE NULL
  END;
  v_evidence_ref := format(
    'address-book-reconciliation:%s:%s', v_case.profile_reconciliation_case_id, v_postcondition_sha256
  );
  v_correlation_ref := format(
    'address-book-owner:%s:%s:%s', v_case.profile_reconciliation_case_id, v_case.revision, v_postcondition_sha256
  );

  INSERT INTO commerce_customer_context.address_book_reconciliation_receipts (
    tenant_id, legal_entity_id, profile_reconciliation_case_id, survivor_profile_id,
    disposition, terminal_status, member_profile_ids, case_revision_at_receipt, event_version,
    effective_at, policy_version, resulting_state, before_facts_sha256, after_facts_sha256,
    postcondition_sha256, owner_decision_ref, evidence_ref, correlation_ref,
    action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_case.profile_reconciliation_case_id,
    p_survivor_profile_resource_id::uuid, v_disposition, v_status, v_member_profile_ids,
    v_case.revision, p_expected_event_version, p_effective_at, p_policy_version,
    p_resulting_state, v_before_facts_sha256, v_after_facts_sha256, v_postcondition_sha256,
    v_owner_decision_ref, v_evidence_ref, v_correlation_ref,
    p_action_invocation_id, p_actor_principal_id, p_reason
  ) RETURNING address_book_reconciliation_receipt_id
    INTO v_existing.address_book_reconciliation_receipt_id;
  RETURN QUERY SELECT 'VERIFIED'::text, v_status, v_evidence_ref, v_correlation_ref,
    v_existing.address_book_reconciliation_receipt_id::text, v_before_facts_sha256,
    v_after_facts_sha256, v_postcondition_sha256;
END;
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "commerce_customer_context"."record_address_book_reconciliation_receipt"(
  uuid, uuid, uuid, uuid, integer, bigint, uuid[], timestamptz, text, text, text, text,
  text, text, text, uuid, uuid
);
CREATE FUNCTION "commerce_customer_context"."record_address_book_reconciliation_receipt"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_reconciliation_case_id uuid,
  p_survivor_profile_id uuid,
  p_case_revision_at_receipt integer,
  p_event_version bigint,
  p_member_profile_ids uuid[],
  p_effective_at timestamptz,
  p_policy_version text,
  p_resulting_state text,
  p_before_facts_sha256 text,
  p_after_facts_sha256 text,
  p_postcondition_sha256 text,
  p_owner_decision_ref text,
  p_reason text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  status text,
  evidence_ref text,
  correlation_ref text,
  receipt_id text,
  before_facts_sha256 text,
  after_facts_sha256 text,
  postcondition_sha256 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_case commerce_customer_context.profile_reconciliation_cases%ROWTYPE;
  v_existing commerce_customer_context.address_book_reconciliation_receipts%ROWTYPE;
  v_expected_member_profile_ids uuid[];
  v_member_count integer;
  v_address_count integer;
  v_active_address_count integer;
  v_default_count integer;
  v_active_default_count integer;
  v_survivor_address_count integer;
  v_survivor_default_count integer;
  v_losing_address_facts text;
  v_losing_default_facts text;
  v_survivor_address_facts text;
  v_survivor_default_facts text;
  v_before_facts text;
  v_after_facts text;
  v_postcondition text;
  v_before_facts_sha256 text;
  v_after_facts_sha256 text;
  v_postcondition_sha256 text;
  v_owner_decision_ref text;
  v_evidence_ref text;
  v_correlation_ref text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_profile_reconciliation_case_id IS NULL OR p_survivor_profile_id IS NULL
    OR p_case_revision_at_receipt IS NULL OR p_case_revision_at_receipt < 1
    OR p_event_version IS NULL OR p_event_version < 0 OR p_member_profile_ids IS NULL
    OR cardinality(p_member_profile_ids) < 2
    OR array_position(p_member_profile_ids, NULL::uuid) IS NOT NULL
    OR NOT (p_survivor_profile_id = ANY(p_member_profile_ids))
    OR p_effective_at IS NULL
    OR p_policy_version IS DISTINCT FROM 'address-book-reconciliation.v2'
    OR p_resulting_state IS NULL OR p_resulting_state NOT IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')
    OR p_before_facts_sha256 IS NULL OR p_before_facts_sha256 !~ '^[0-9a-f]{64}$'
    OR p_after_facts_sha256 IS NULL OR p_after_facts_sha256 !~ '^[0-9a-f]{64}$'
    OR p_postcondition_sha256 IS NULL OR p_postcondition_sha256 !~ '^[0-9a-f]{64}$'
    OR p_owner_decision_ref IS DISTINCT FROM nullif(btrim(p_owner_decision_ref), '')
    OR p_owner_decision_ref IS NULL
    OR p_reason IS NULL
    OR p_reason IS DISTINCT FROM nullif(btrim(p_reason), '')
    OR length(p_reason) > 500
    OR p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT reconciliation.* INTO v_case
    FROM commerce_customer_context.profile_reconciliation_cases AS reconciliation
   WHERE reconciliation.tenant_id = p_tenant_id
     AND reconciliation.legal_entity_id = p_legal_entity_id
     AND reconciliation.profile_reconciliation_case_id = p_profile_reconciliation_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF p_case_revision_at_receipt IS DISTINCT FROM v_case.revision
    OR p_event_version IS DISTINCT FROM v_case.last_processed_event_version
    OR v_case.lifecycle NOT IN ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE')
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT coalesce(array_agg(member.customer_profile_id ORDER BY member.member_position), ARRAY[]::uuid[]), count(*)::integer
    INTO v_expected_member_profile_ids, v_member_count
    FROM commerce_customer_context.profile_reconciliation_case_members AS member
   WHERE member.tenant_id = p_tenant_id AND member.legal_entity_id = p_legal_entity_id
     AND member.profile_reconciliation_case_id = p_profile_reconciliation_case_id;
  IF v_member_count < 2 OR v_expected_member_profile_ids IS DISTINCT FROM p_member_profile_ids THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Serialize every member before deriving the receipt. The hashes below are an observation
  -- of this transaction's exact owner state, never caller-supplied proof.
  PERFORM profile.customer_profile_id
    FROM commerce_customer_context.profile_reconciliation_case_members AS member
    JOIN commerce_customer_context.customer_profiles AS profile
      ON profile.tenant_id = member.tenant_id
     AND profile.legal_entity_id = member.legal_entity_id
     AND profile.customer_profile_id = member.customer_profile_id
   WHERE member.tenant_id = p_tenant_id
     AND member.legal_entity_id = p_legal_entity_id
     AND member.profile_reconciliation_case_id = p_profile_reconciliation_case_id
   ORDER BY member.member_position
   FOR UPDATE OF profile;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE address.lifecycle = 'ACTIVE')::integer
    INTO v_address_count, v_active_address_count
    FROM commerce_customer_context.saved_addresses AS address
    JOIN commerce_customer_context.profile_reconciliation_case_members AS member
      ON member.tenant_id = address.tenant_id
     AND member.legal_entity_id = address.legal_entity_id
     AND member.customer_profile_id = address.customer_profile_id
     AND member.profile_reconciliation_case_id = p_profile_reconciliation_case_id
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND member.customer_profile_id <> p_survivor_profile_id;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL
    )::integer
    INTO v_default_count, v_active_default_count
    FROM commerce_customer_context.customer_address_defaults AS default_record
    JOIN commerce_customer_context.profile_reconciliation_case_members AS member
      ON member.tenant_id = default_record.tenant_id
     AND member.legal_entity_id = default_record.legal_entity_id
     AND member.customer_profile_id = default_record.customer_profile_id
     AND member.profile_reconciliation_case_id = p_profile_reconciliation_case_id
   WHERE default_record.tenant_id = p_tenant_id
     AND default_record.legal_entity_id = p_legal_entity_id
     AND member.customer_profile_id <> p_survivor_profile_id;

  IF v_active_address_count > 0 OR v_active_default_count > 0 THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO v_survivor_address_count
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = p_survivor_profile_id;
  SELECT count(*) FILTER (
      WHERE default_record.lifecycle = 'ACTIVE' AND default_record.effective_to IS NULL
    )::integer
    INTO v_survivor_default_count
    FROM commerce_customer_context.customer_address_defaults AS default_record
   WHERE default_record.tenant_id = p_tenant_id
     AND default_record.legal_entity_id = p_legal_entity_id
     AND default_record.customer_profile_id = p_survivor_profile_id;

  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      address.saved_address_id, address.customer_profile_id, address.source_kind,
      address.party_resource_id, address.party_contact_point_resource_id,
      address.party_contact_point_revision, address.label, address.purposes,
      address.address_line_1, address.address_line_2, address.locality,
      address.administrative_area, address.postal_code, address.country_code,
      address.lifecycle, address.revision
    ), '|' ORDER BY address.saved_address_id), 'NO_ADDRESSES')
    INTO v_losing_address_facts
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = ANY(p_member_profile_ids)
     AND address.customer_profile_id <> p_survivor_profile_id;
  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      defaults.customer_address_default_id, defaults.customer_profile_id,
      defaults.default_kind, defaults.saved_address_id, defaults.effective_from,
      defaults.effective_to, defaults.lifecycle, defaults.revision,
      defaults.action_invocation_id, defaults.actor_principal_id, defaults.reason
    ), '|' ORDER BY defaults.customer_address_default_id), 'NO_DEFAULTS')
    INTO v_losing_default_facts
    FROM commerce_customer_context.customer_address_defaults AS defaults
   WHERE defaults.tenant_id = p_tenant_id
     AND defaults.legal_entity_id = p_legal_entity_id
     AND defaults.customer_profile_id = ANY(p_member_profile_ids)
     AND defaults.customer_profile_id <> p_survivor_profile_id;
  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      address.saved_address_id, address.customer_profile_id, address.source_kind,
      address.party_resource_id, address.party_contact_point_resource_id,
      address.party_contact_point_revision, address.label, address.purposes,
      address.address_line_1, address.address_line_2, address.locality,
      address.administrative_area, address.postal_code, address.country_code,
      address.lifecycle, address.revision
    ), '|' ORDER BY address.saved_address_id), 'NO_ADDRESSES')
    INTO v_survivor_address_facts
    FROM commerce_customer_context.saved_addresses AS address
   WHERE address.tenant_id = p_tenant_id
     AND address.legal_entity_id = p_legal_entity_id
     AND address.customer_profile_id = p_survivor_profile_id;
  SELECT coalesce(string_agg(format(
      '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
      defaults.customer_address_default_id, defaults.customer_profile_id,
      defaults.default_kind, defaults.saved_address_id, defaults.effective_from,
      defaults.effective_to, defaults.lifecycle, defaults.revision,
      defaults.action_invocation_id, defaults.actor_principal_id, defaults.reason
    ), '|' ORDER BY defaults.customer_address_default_id), 'NO_DEFAULTS')
    INTO v_survivor_default_facts
    FROM commerce_customer_context.customer_address_defaults AS defaults
   WHERE defaults.tenant_id = p_tenant_id
     AND defaults.legal_entity_id = p_legal_entity_id
     AND defaults.customer_profile_id = p_survivor_profile_id;

  v_before_facts := format(
    'address-book-before:v3|case=%s|members=%s|losing-address-facts=%s|losing-default-facts=%s|losing-addresses=%s|losing-active-addresses=%s|losing-defaults=%s|losing-active-defaults=%s',
    p_profile_reconciliation_case_id,
    array_to_string(p_member_profile_ids, ','),
    v_losing_address_facts,
    v_losing_default_facts,
    v_address_count,
    v_active_address_count,
    v_default_count,
    v_active_default_count
  );
  v_after_facts := format(
    'address-book-after:v3|case=%s|survivor=%s|survivor-address-facts=%s|survivor-default-facts=%s|survivor-addresses=%s|survivor-active-defaults=%s|case-revision=%s|event-version=%s|resulting-state=%s',
    p_profile_reconciliation_case_id,
    p_survivor_profile_id,
    v_survivor_address_facts,
    v_survivor_default_facts,
    v_survivor_address_count,
    v_survivor_default_count,
    p_case_revision_at_receipt,
    p_event_version,
    p_resulting_state
  );
  v_postcondition := format(
    'address-book-postcondition:v3|before=%s|after=%s|policy-version=%s|effective-at=%s|resulting-state=%s|reason=%s',
    v_before_facts, v_after_facts, p_policy_version, p_effective_at, p_resulting_state, p_reason
  );
  v_before_facts_sha256 := encode(sha256(convert_to(v_before_facts, 'UTF8')), 'hex');
  v_after_facts_sha256 := encode(sha256(convert_to(v_after_facts, 'UTF8')), 'hex');
  v_postcondition_sha256 := encode(sha256(convert_to(v_postcondition, 'UTF8')), 'hex');
  IF p_before_facts_sha256 IS DISTINCT FROM v_before_facts_sha256
    OR p_after_facts_sha256 IS DISTINCT FROM v_after_facts_sha256
    OR p_postcondition_sha256 IS DISTINCT FROM v_postcondition_sha256
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, p_before_facts_sha256, v_after_facts_sha256, v_postcondition_sha256;
    RETURN;
  END IF;

  v_owner_decision_ref := format(
    'address-book-decision:%s:%s',
    p_profile_reconciliation_case_id,
    p_action_invocation_id
  );
  IF p_owner_decision_ref IS DISTINCT FROM v_owner_decision_ref THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
      NULL::text, v_before_facts_sha256, v_after_facts_sha256, v_postcondition_sha256;
    RETURN;
  END IF;

  SELECT receipt.* INTO v_existing
    FROM commerce_customer_context.address_book_reconciliation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.profile_reconciliation_case_id = p_profile_reconciliation_case_id
     AND receipt.action_invocation_id = p_action_invocation_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.survivor_profile_id IS DISTINCT FROM p_survivor_profile_id
      OR v_existing.disposition IS DISTINCT FROM 'EXPLICIT_RECONCILIATION'
      OR v_existing.terminal_status IS DISTINCT FROM 'RESOLVED'
      OR v_existing.member_profile_ids IS DISTINCT FROM p_member_profile_ids
      OR v_existing.case_revision_at_receipt IS DISTINCT FROM p_case_revision_at_receipt
      OR v_existing.event_version IS DISTINCT FROM p_event_version
      OR v_existing.effective_at IS DISTINCT FROM p_effective_at
      OR v_existing.policy_version IS DISTINCT FROM p_policy_version
      OR v_existing.resulting_state IS DISTINCT FROM p_resulting_state
      OR v_existing.before_facts_sha256 IS DISTINCT FROM v_before_facts_sha256
      OR v_existing.after_facts_sha256 IS DISTINCT FROM v_after_facts_sha256
      OR v_existing.postcondition_sha256 IS DISTINCT FROM v_postcondition_sha256
      OR v_existing.owner_decision_ref IS DISTINCT FROM p_owner_decision_ref
      OR v_existing.reason IS DISTINCT FROM p_reason
      OR v_existing.actor_principal_id IS DISTINCT FROM p_actor_principal_id
    THEN
      RETURN QUERY SELECT 'CONFLICT'::text, NULL::text, NULL::text, NULL::text,
        NULL::text, NULL::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'VERIFIED'::text, v_existing.terminal_status, v_existing.evidence_ref,
      v_existing.correlation_ref, v_existing.address_book_reconciliation_receipt_id::text,
      v_existing.before_facts_sha256, v_existing.after_facts_sha256, v_existing.postcondition_sha256;
    RETURN;
  END IF;

  v_evidence_ref := format('address-book-reconciliation:%s:%s', p_profile_reconciliation_case_id, v_postcondition_sha256);
  v_correlation_ref := format('address-book-owner:%s:%s:%s', p_profile_reconciliation_case_id, p_case_revision_at_receipt, v_postcondition_sha256);
  INSERT INTO commerce_customer_context.address_book_reconciliation_receipts (
    tenant_id, legal_entity_id, profile_reconciliation_case_id, survivor_profile_id,
    disposition, terminal_status, member_profile_ids, case_revision_at_receipt, event_version,
    effective_at, policy_version, resulting_state, before_facts_sha256, after_facts_sha256,
    postcondition_sha256, owner_decision_ref, evidence_ref, correlation_ref,
    action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_profile_reconciliation_case_id, p_survivor_profile_id,
    'EXPLICIT_RECONCILIATION', 'RESOLVED', p_member_profile_ids, p_case_revision_at_receipt,
    p_event_version, p_effective_at, p_policy_version, p_resulting_state,
    v_before_facts_sha256, v_after_facts_sha256, v_postcondition_sha256,
    v_owner_decision_ref, v_evidence_ref, v_correlation_ref,
    p_action_invocation_id, p_actor_principal_id, p_reason
  ) RETURNING address_book_reconciliation_receipt_id
    INTO v_existing.address_book_reconciliation_receipt_id;
  RETURN QUERY SELECT 'VERIFIED'::text, 'RESOLVED'::text, v_evidence_ref, v_correlation_ref,
    v_existing.address_book_reconciliation_receipt_id::text, v_before_facts_sha256,
    v_after_facts_sha256, v_postcondition_sha256;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."reject_address_book_reconciliation_receipt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Address Book reconciliation receipts are append-only' USING ERRCODE = '55006';
END;
$$;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."address_book_reconciliation_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."address_book_reconciliation_receipts" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "commerce_customer_context"."address_book_reconciliation_receipts" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "ccc_address_reconciliation_receipts_append_only_trg"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."address_book_reconciliation_receipts"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_address_book_reconciliation_receipt_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."record_address_book_reconciliation_receipt"(
  uuid, uuid, uuid, uuid, integer, bigint, uuid[], timestamptz, text, text, text, text,
  text, text, text, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."record_address_book_reconciliation_receipt"(
  uuid, uuid, uuid, uuid, integer, bigint, uuid[], timestamptz, text, text, text, text,
  text, text, text, uuid, uuid
) TO "ontos_runtime";
REVOKE ALL ON FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"(
  uuid, uuid, text, text, integer, bigint, timestamptz, text, text, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"(
  uuid, uuid, text, text, integer, bigint, timestamptz, text, text, uuid, uuid, text
) TO "ontos_runtime";
REVOKE ALL ON FUNCTION "commerce_customer_context"."reject_address_book_reconciliation_receipt_mutation"() FROM PUBLIC, "ontos_runtime";
