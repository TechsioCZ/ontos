CREATE FUNCTION "commerce_customer_context"."verify_invitation_claim_authority"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_proof_reference text, p_counterparty_resource_id text,
  p_storefront_resource_id text, p_claimant_principal_id uuid
)
RETURNS TABLE (
  counterparty_resource_id text,
  inviter_principal_id uuid,
  operation_outcome text,
  storefront_resource_id text,
  intended_permission_codes jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_proof commerce_customer_context.counterparty_invitation_claim_proofs%ROWTYPE;
  v_counterparty_resource_id text;
  v_outcome text := 'INVALID';
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_claimant_principal_id IS NULL THEN
    RAISE EXCEPTION 'invalid scoped invitation claim preflight' USING ERRCODE = '42501';
  END IF;

  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id
    AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::uuid, 'INVALID'::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT profile.counterparty_resource_id INTO v_counterparty_resource_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = v_invitation.tenant_id
    AND profile.legal_entity_id = v_invitation.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::uuid, 'INVALID'::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT proof.* INTO v_proof
  FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id
    AND proof.legal_entity_id = p_legal_entity_id
    AND proof.invitation_id = p_invitation_id
    AND proof.proof_reference = p_proof_reference;

  IF v_invitation.lifecycle = 'REVOKED' THEN
    v_outcome := 'REVOKED';
  ELSIF v_invitation.lifecycle = 'EXPIRED' OR v_invitation.expires_at <= statement_timestamp() THEN
    v_outcome := 'EXPIRED';
  ELSIF NOT FOUND THEN
    v_outcome := 'INVALID';
  ELSIF v_proof.lifecycle = 'CONSUMED' THEN
    v_outcome := 'CONSUMED';
  ELSIF v_proof.lifecycle IN ('REVOKED', 'EXPIRED') THEN
    v_outcome := v_proof.lifecycle;
  ELSIF v_proof.expires_at <= statement_timestamp() THEN
    v_outcome := 'EXPIRED';
  ELSIF v_invitation.lifecycle <> 'PENDING'
    OR v_proof.lifecycle <> 'VERIFIED'
    OR v_proof.delivery_state <> 'STAGED'
    OR v_proof.claimant_principal_id IS DISTINCT FROM p_claimant_principal_id
    OR v_counterparty_resource_id IS DISTINCT FROM p_counterparty_resource_id
    OR v_invitation.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id
    OR v_invitation.actor_principal_id IS DISTINCT FROM v_proof.inviter_principal_id
    OR v_proof.counterparty_resource_id IS DISTINCT FROM p_counterparty_resource_id
    OR v_proof.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id
    OR v_proof.intended_permission_codes IS DISTINCT FROM v_invitation.requested_permission_codes
    OR v_proof.inviter_principal_id IS DISTINCT FROM v_invitation.actor_principal_id THEN
    v_outcome := 'INVALID';
  ELSE
    v_outcome := 'VERIFIED';
  END IF;

  RETURN QUERY SELECT
    v_counterparty_resource_id,
    v_invitation.actor_principal_id,
    v_outcome,
    v_invitation.storefront_resource_id,
    v_invitation.requested_permission_codes;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."verify_invitation_claim_authority"(uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."verify_invitation_claim_authority"(uuid, uuid, uuid, text, text, text, uuid) TO "ontos_runtime";
