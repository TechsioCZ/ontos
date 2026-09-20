-- The COUNTERPARTY_INVITATION journey names an `invitationId` before any Attempt exists, and no
-- existing read is keyed by invitation id alone: `read_access_invitation` needs the counterparty
-- resource id and storefront key, `verify_invitation_claim_authority` needs a presented proof
-- reference. This routine answers only "can this invitation still be claimed" so enrollment-start
-- can refuse an unknown, consumed, revoked or expired invitation before it spends any budget or
-- creates an Attempt and provider account nothing can ever complete.
--
-- Mirrors the PENDING/expiry and proof ISSUED-or-VERIFIED+STAGED/expiry predicates
-- `verify_invitation_claim_authority` uses, without a claimant, proof reference or counterparty
-- resource id: it exists to gate the start of a claim, not to authorize one.
CREATE FUNCTION "commerce_customer_context"."read_counterparty_invitation_claimability"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_invitation_id uuid
)
RETURNS TABLE (
  claimable boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_proof commerce_customer_context.counterparty_invitation_claim_proofs%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation claimability read' USING ERRCODE = '42501';
  END IF;

  IF p_invitation_id IS NULL THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id
    AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id;
  IF NOT FOUND OR v_invitation.lifecycle <> 'PENDING' OR v_invitation.expires_at <= statement_timestamp() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  SELECT proof.* INTO v_proof
  FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id
    AND proof.legal_entity_id = p_legal_entity_id
    AND proof.invitation_id = p_invitation_id
    AND proof.lifecycle IN ('ISSUED', 'VERIFIED')
    AND proof.delivery_state = 'STAGED';
  IF NOT FOUND OR v_proof.expires_at <= statement_timestamp() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  RETURN QUERY SELECT true;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_counterparty_invitation_claimability"(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_counterparty_invitation_claimability"(uuid, uuid, uuid) TO "ontos_runtime";
