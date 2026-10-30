-- Enrollment owns an idempotency key, not the generated native Action or mutation UUID.
-- Resolve the accepted claim from its immutable owner origin and then reuse the owner's exact
-- reconciliation projection. This read neither consumes a proof nor finalizes authorization.
CREATE FUNCTION "commerce_customer_context"."read_enrollment_invitation_claim"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid, p_bound_principal_id uuid
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, operation_outcome text,
  reason text, requested_permission_codes jsonb, revision integer, state text,
  storefront_resource_id text, claim_subject_principal_id uuid, attestation_reference text,
  claim_mutation_id uuid, source_action_invocation_id uuid, verified_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped enrollment claim read' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT projection.*
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  JOIN commerce_customer_context.access_mutation_journal AS claim
    ON claim.tenant_id = invitation.tenant_id
    AND claim.legal_entity_id = invitation.legal_entity_id
    AND claim.resource_id = invitation.counterparty_access_invitation_id
    AND claim.counterparty_purchasing_profile_id = invitation.counterparty_purchasing_profile_id
    AND claim.subject_principal_id = invitation.claim_origin_principal_id
    AND claim.action_invocation_id = invitation.claim_origin_action_invocation_id
    AND claim.mutation_kind = 'CLAIM_INVITE'
  CROSS JOIN LATERAL commerce_customer_context.read_access_invitation_claim_reconciliation(
    p_tenant_id, p_legal_entity_id, claim.access_mutation_id
  ) AS projection
  WHERE invitation.tenant_id = p_tenant_id
    AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id
    AND invitation.claim_origin_principal_id = p_bound_principal_id
    AND invitation.claim_origin_proof_reference IS NOT NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_enrollment_invitation_claim"(uuid, uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_enrollment_invitation_claim"(uuid, uuid, uuid, uuid) TO "ontos_runtime";
