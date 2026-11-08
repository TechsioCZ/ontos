-- Every principal that redeemed a claim proof of one invitation, with the proof it redeemed. Core's
-- invitee portal assignment is named by that pair, so the owner can end each one when the invitation is
-- claimed, resent or revoked. The read exposes no secret material and changes nothing.
CREATE FUNCTION "commerce_customer_context"."read_invitation_claim_redemptions"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid
)
RETURNS TABLE (claimant_principal_id uuid, proof_reference text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation redemption read' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT proof.claimant_principal_id, proof.proof_reference
  FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id
    AND proof.legal_entity_id = p_legal_entity_id
    AND proof.invitation_id = p_invitation_id
    AND proof.claimant_principal_id IS NOT NULL
  ORDER BY proof.redeemed_at, proof.proof_reference;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_invitation_claim_redemptions"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_invitation_claim_redemptions"(uuid, uuid, uuid) TO "ontos_runtime";
