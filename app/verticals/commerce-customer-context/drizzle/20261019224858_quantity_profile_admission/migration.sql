-- Concrete owner identity proof for Quantity assignments. Counterparty identity is tenant-global;
-- Retail identity remains seller-bound. This does not assert Order eligibility or require ACTIVE.
CREATE FUNCTION commerce_customer_context.inspect_commerce_quantity_assignment_profile(
  p_tenant_id uuid, p_legal_entity_id uuid, p_profile_kind text, p_profile_resource_id text
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
  v_subtype_id uuid;
  v_owner record;
BEGIN
  PERFORM assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_profile_kind IS NULL OR p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY') THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_KIND_MISMATCH');
    RETURN;
  END IF;

  -- NOWAIT introduces no profile wait edge into the existing generation/lifecycle lock orders.
  -- A locked row is explicitly unavailable, never treated as absent.
  BEGIN
    SELECT * INTO v_profile FROM customer_profiles
     WHERE tenant_id = p_tenant_id AND customer_profile_id::text = p_profile_resource_id
     FOR KEY SHARE NOWAIT;
    IF NOT FOUND THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_NOT_FOUND');
      RETURN;
    END IF;
    IF v_profile.profile_kind <> p_profile_kind THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_KIND_MISMATCH');
      RETURN;
    END IF;

    IF p_profile_kind = 'RETAIL' THEN
      SELECT retail_customer_profile_id INTO v_subtype_id FROM retail_customer_profiles
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND retail_customer_profile_id = v_profile.customer_profile_id
       FOR KEY SHARE NOWAIT;
    ELSE
      SELECT counterparty_purchasing_profile_id INTO v_subtype_id FROM counterparty_purchasing_profiles
       WHERE tenant_id = p_tenant_id
         AND counterparty_purchasing_profile_id = v_profile.customer_profile_id
       FOR KEY SHARE NOWAIT;
    END IF;
    IF NOT FOUND THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_NOT_FOUND');
      RETURN;
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_UNVERIFIABLE', 'reason', 'PROFILE_BUSY');
    RETURN;
  END;

  -- Keep the owner's existing scoped alias key. Do not follow/remap the completed identity.
  IF EXISTS (
    SELECT 1 FROM customer_profile_aliases
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND alias_profile_id = v_profile.customer_profile_id
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_UNVERIFIABLE', 'reason', 'COMPLETED_ALIAS');
    RETURN;
  END IF;

  SELECT * INTO v_owner FROM read_customer_profile(
    p_tenant_id, p_legal_entity_id, v_profile.customer_profile_id, p_profile_kind);
  IF NOT FOUND OR v_owner.outcome IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_UNVERIFIABLE', 'reason', 'OWNER_RESPONSE_INVALID');
  ELSIF v_owner.outcome = 'PROFILE_RECONCILIATION_REQUIRED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_UNVERIFIABLE', 'reason', 'RECONCILIATION_REQUIRED');
  ELSIF v_owner.outcome = 'PROFILE_AVAILABLE'
    AND v_owner.payload->>'profileId' = v_profile.customer_profile_id::text
    AND v_owner.payload->>'profileKind' = p_profile_kind
    AND v_owner.payload->>'scopeLegalEntityId' = p_legal_entity_id::text
    AND v_owner.payload->'subject'->>'kind' = p_profile_kind THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'VERIFIED');
  ELSE
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROFILE_UNVERIFIABLE', 'reason', 'OWNER_RESPONSE_INVALID');
  END IF;
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.inspect_commerce_quantity_assignment_profile(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.inspect_commerce_quantity_assignment_profile(uuid, uuid, text, text) TO ontos_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."guard_commerce_quantity_rule_assignment"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_revision commerce_customer_context.commerce_quantity_rule_revisions%ROWTYPE;
  v_profile_result jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment history cannot be deleted'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_rule_assignment_history_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(NEW) - 'applicable_from' - 'applicable_to')
       IS DISTINCT FROM (to_jsonb(OLD) - 'applicable_from' - 'applicable_to') THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment meaning is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_rule_assignment_meaning_immutable';
  END IF;
  SELECT * INTO v_revision
    FROM commerce_customer_context.commerce_quantity_rule_revisions
   WHERE tenant_id = NEW.tenant_id
     AND legal_entity_id = NEW.legal_entity_id
     AND policy_revision_id = NEW.policy_revision_id;
  IF NOT FOUND OR NEW.effective_from < v_revision.effective_from
     OR (v_revision.effective_to IS NOT NULL AND
         (NEW.effective_to IS NULL OR NEW.effective_to > v_revision.effective_to)) THEN
    RAISE EXCEPTION 'Commerce Quantity Rule assignment must remain inside its revision period'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_assignment_revision_period';
  END IF;
  -- Same serialization key as the governed assignment write, including the first assignment.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.legal_entity_id::text || ':COMMERCE_QUANTITY_ASSIGNMENT', 333));
  IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.commerce_quantity_rule_assignments
       WHERE quantity_rule_assignment_id = NEW.quantity_rule_assignment_id)
     AND (v_revision.audience = 'SHARED' OR (v_revision.audience IS NULL AND NOT EXISTS (
       SELECT 1 FROM commerce_customer_context.commerce_quantity_rule_assignments
        WHERE tenant_id = NEW.tenant_id AND legal_entity_id = NEW.legal_entity_id
          AND policy_revision_id = NEW.policy_revision_id))) THEN
    RAISE EXCEPTION 'A shared quantity revision cannot acquire an implicit private audience'
      USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_rule_assignment_audience';
  END IF;
  -- Retained upserts and UNASSIGN preserve history; admission is only for a new relation.
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.commerce_quantity_rule_assignments
     WHERE quantity_rule_assignment_id = NEW.quantity_rule_assignment_id
  ) THEN
    SELECT result INTO STRICT v_profile_result
      FROM commerce_customer_context.inspect_commerce_quantity_assignment_profile(
        NEW.tenant_id, NEW.legal_entity_id, NEW.profile_kind, NEW.profile_resource_id);
    CASE v_profile_result->>'outcome'
      WHEN 'VERIFIED' THEN NULL;
      WHEN 'PROFILE_NOT_FOUND' THEN
        RAISE EXCEPTION 'Quantity assignment profile does not exist in owner scope'
          USING ERRCODE = '23503', CONSTRAINT = 'ccc_quantity_assignment_profile_not_found';
      WHEN 'PROFILE_KIND_MISMATCH' THEN
        RAISE EXCEPTION 'Quantity assignment profile kind does not match its owner'
          USING ERRCODE = '23514', CONSTRAINT = 'ccc_quantity_assignment_profile_kind_mismatch';
      WHEN 'PROFILE_UNVERIFIABLE' THEN
        CASE v_profile_result->>'reason'
          WHEN 'PROFILE_BUSY' THEN
            RAISE EXCEPTION 'Quantity assignment profile verification is busy'
              USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_assignment_profile_busy';
          WHEN 'RECONCILIATION_REQUIRED' THEN
            RAISE EXCEPTION 'Quantity assignment profile requires reconciliation'
              USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_assignment_profile_reconciliation';
          WHEN 'COMPLETED_ALIAS' THEN
            RAISE EXCEPTION 'Quantity assignment profile is a completed alias'
              USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_assignment_profile_alias';
          ELSE
            RAISE EXCEPTION 'Quantity assignment profile response cannot be verified'
              USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_assignment_profile_response';
        END CASE;
      ELSE
        RAISE EXCEPTION 'Quantity assignment profile response cannot be verified'
          USING ERRCODE = '55000', CONSTRAINT = 'ccc_quantity_assignment_profile_response';
    END CASE;
  END IF;
  IF v_revision.rule_kind = 'REPLACEABLE_ENVELOPE' AND NEW.applicable_from IS NOT NULL AND EXISTS (
    SELECT 1 FROM commerce_customer_context.commerce_quantity_rule_assignments assignment
    JOIN commerce_customer_context.commerce_quantity_rule_revisions revision
      ON revision.tenant_id = assignment.tenant_id AND revision.legal_entity_id = assignment.legal_entity_id
     AND revision.policy_revision_id = assignment.policy_revision_id
    WHERE assignment.tenant_id = NEW.tenant_id AND assignment.legal_entity_id = NEW.legal_entity_id
      AND assignment.quantity_rule_assignment_id <> NEW.quantity_rule_assignment_id
      AND assignment.profile_kind = NEW.profile_kind AND assignment.profile_resource_id = NEW.profile_resource_id
      AND assignment.applicable_from IS NOT NULL AND revision.rule_kind = 'REPLACEABLE_ENVELOPE'
      AND revision.scope_kind = v_revision.scope_kind AND revision.channel_id IS NOT DISTINCT FROM v_revision.channel_id
      AND revision.commerce_market_id IS NOT DISTINCT FROM v_revision.commerce_market_id
      AND revision.storefront_id IS NOT DISTINCT FROM v_revision.storefront_id
      AND revision.selector_kind = v_revision.selector_kind
      AND revision.selector_resource_id IS NOT DISTINCT FROM v_revision.selector_resource_id
      AND tstzrange(assignment.applicable_from, assignment.applicable_to, '[)') &&
          tstzrange(NEW.applicable_from, NEW.applicable_to, '[)')
  ) THEN
    RAISE EXCEPTION 'Profile quantity envelopes cannot conflict at the same declared rank'
      USING ERRCODE = '23P01', CONSTRAINT = 'ccc_quantity_rule_assignments_no_overlap_excl';
  END IF;
  RETURN NEW;
END;
$$;
