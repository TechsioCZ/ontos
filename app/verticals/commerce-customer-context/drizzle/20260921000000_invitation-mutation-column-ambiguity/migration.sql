-- `mutate_access_invitation` returns a table whose `revision` output column is also a PL/pgSQL
-- variable, so the unqualified `revision + 1` in every mutation branch was ambiguous (42702) and
-- each branch failed the first time it ran. Qualifying the read with the updated table keeps the
-- same arithmetic and leaves the routine's scope guard and outcomes untouched.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."mutate_access_invitation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_counterparty_resource_id text, p_storefront_resource_id text,
  p_expected_revision integer, p_operation text, p_actor_principal_id uuid,
  p_action_invocation_id uuid, p_reason text, p_claimant_principal_id uuid,
  p_claim_proof_reference text
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, operation_outcome text,
  reason text, requested_permission_codes jsonb, revision integer, state text,
  storefront_resource_id text, mutation_id uuid, mutation_staged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_mutation_id uuid;
  v_profile_counterparty text;
  v_mutation_kind text;
  v_marker_kind text;
  v_mutation_staged boolean := false;
  v_outcome text;
  v_origin_principal_id uuid;
  v_origin_action_invocation_id uuid;
  v_origin_proof_reference text;
  v_claim_mutation_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_operation NOT IN (
      'RESEND', 'REVOKE', 'BEGIN_CLAIM', 'REJECT_CLAIM', 'EXPIRE_CLAIM',
      'FINISH_CLAIM', 'FINISH_RECONCILIATION'
    ) THEN
    RAISE EXCEPTION 'invalid scoped invitation mutation' USING ERRCODE = '42501';
  END IF;

  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    v_outcome := 'INVALID';
  ELSE
    SELECT profile.counterparty_resource_id INTO v_profile_counterparty
    FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
    WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
      AND profile.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id;
    IF v_profile_counterparty IS DISTINCT FROM p_counterparty_resource_id
      OR v_invitation.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id THEN
      v_outcome := 'INVALID';

    -- Reset/expiry is itself an idempotent owner mutation. A replay must succeed even after the
    -- claimant/proof projection has been cleared by the first attempt.
    ELSIF p_operation IN ('REJECT_CLAIM', 'EXPIRE_CLAIM') THEN
      v_marker_kind := CASE WHEN p_operation = 'EXPIRE_CLAIM'
        THEN 'CLAIM_EXPIRED' ELSE 'CLAIM_REJECTED' END;
      SELECT journal.access_mutation_id INTO v_mutation_id
      FROM commerce_customer_context.access_mutation_journal AS journal
      WHERE journal.tenant_id = p_tenant_id AND journal.legal_entity_id = p_legal_entity_id
        AND journal.action_invocation_id = p_action_invocation_id
        AND journal.mutation_kind = v_marker_kind
        AND journal.resource_id = p_invitation_id
      ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC LIMIT 1;
      IF v_mutation_id IS NOT NULL THEN
        v_outcome := CASE WHEN p_operation = 'EXPIRE_CLAIM'
          THEN 'EXPIRED' ELSE 'CLAIM_REJECTED' END;
        v_mutation_staged := false;
      ELSE
        v_origin_principal_id := coalesce(
          v_invitation.claimed_by_principal_id,
          v_invitation.claim_origin_principal_id
        );
        v_origin_proof_reference := coalesce(
          v_invitation.claim_proof_reference,
          v_invitation.claim_origin_proof_reference
        );
        IF v_invitation.lifecycle NOT IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
          OR p_claimant_principal_id IS NULL
          OR p_claim_proof_reference IS NULL
          OR v_origin_principal_id IS DISTINCT FROM p_claimant_principal_id
          OR (
            v_origin_proof_reference IS DISTINCT FROM p_claim_proof_reference
            AND NOT EXISTS (
              SELECT 1
              FROM commerce_customer_context.counterparty_invitation_claim_proofs AS proof
              WHERE proof.tenant_id = p_tenant_id AND proof.legal_entity_id = p_legal_entity_id
                AND proof.invitation_id = p_invitation_id
                AND proof.claimant_principal_id = p_claimant_principal_id
                AND proof.lifecycle = 'CONSUMED'
                AND proof.attestation_reference = p_claim_proof_reference
            )
          )
          OR NOT EXISTS (
            SELECT 1
            FROM commerce_customer_context.access_mutation_journal AS claim
            WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
              AND claim.action_invocation_id = coalesce(
                v_invitation.claim_origin_action_invocation_id,
                p_action_invocation_id
              )
              AND claim.mutation_kind = 'CLAIM_INVITE'
              AND claim.resource_id = p_invitation_id
              AND claim.subject_principal_id = p_claimant_principal_id
          ) THEN
          v_outcome := 'INVALID';
        ELSE
          UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = CASE WHEN p_operation = 'EXPIRE_CLAIM' THEN 'EXPIRED' ELSE 'PENDING' END,
              revision = counterparty_access_invitations.revision + 1,
              claimed_by_principal_id = NULL,
              claimed_at = NULL,
              claim_proof_reference = NULL,
              claim_origin_principal_id = NULL,
              claim_origin_action_invocation_id = NULL,
              claim_origin_proof_reference = NULL
          WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
            AND counterparty_access_invitation_id = p_invitation_id;
          v_outcome := CASE WHEN p_operation = 'EXPIRE_CLAIM'
            THEN 'EXPIRED' ELSE 'CLAIM_REJECTED' END;
          -- The trigger records this marker for current rows. The explicit insert also covers
          -- old rows whose trigger was not installed when the reset was first attempted.
          INSERT INTO commerce_customer_context.access_mutation_journal (
            tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
            mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
            action_invocation_id, reason
          ) VALUES (
            p_tenant_id, p_legal_entity_id, v_invitation.counterparty_purchasing_profile_id,
            v_origin_principal_id, v_marker_kind, p_invitation_id, v_invitation.revision + 1,
            jsonb_build_object(
              'operation', p_operation,
              'requestedState', CASE WHEN p_operation = 'EXPIRE_CLAIM' THEN 'EXPIRED' ELSE 'PENDING' END,
              'claimMutationId', (
                SELECT claim.access_mutation_id::text
                FROM commerce_customer_context.access_mutation_journal AS claim
                WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
                  AND claim.resource_id = p_invitation_id
                  AND claim.mutation_kind = 'CLAIM_INVITE'
                  AND claim.subject_principal_id = v_origin_principal_id
                ORDER BY claim.recorded_at DESC, claim.access_mutation_id DESC LIMIT 1
              )
            ),
            p_actor_principal_id, p_action_invocation_id,
            coalesce(p_reason, 'Claim reset/expiry recorded')
          ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING;
          SELECT journal.access_mutation_id INTO v_mutation_id
          FROM commerce_customer_context.access_mutation_journal AS journal
          WHERE journal.tenant_id = p_tenant_id AND journal.legal_entity_id = p_legal_entity_id
            AND journal.action_invocation_id = p_action_invocation_id
            AND journal.mutation_kind = v_marker_kind
            AND journal.resource_id = p_invitation_id;
          v_mutation_staged := false;
        END IF;
      END IF;

    ELSIF p_operation = 'RESEND' THEN
      v_mutation_kind := 'RESEND_INVITE';
      IF EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
      ) THEN
        v_outcome := 'ALREADY_SENT';
      ELSIF v_invitation.expires_at <= statement_timestamp() THEN
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'EXPIRED', revision = counterparty_access_invitations.revision + 1
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'EXPIRED';
      ELSIF v_invitation.lifecycle <> 'PENDING' THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN
        v_outcome := 'REVISION_CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET revision = counterparty_access_invitations.revision + 1
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'RESENT';
      END IF;

    ELSIF p_operation = 'REVOKE' THEN
      v_mutation_kind := 'REVOKE_INVITE';
      IF v_invitation.lifecycle = 'REVOKED' OR EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
      ) THEN
        v_outcome := 'ALREADY_REVOKED';
      ELSIF v_invitation.lifecycle NOT IN ('PENDING', 'CLAIMING', 'RECONCILIATION_REQUIRED') THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN
        v_outcome := 'REVISION_CONFLICT';
      ELSE
        v_origin_principal_id := coalesce(
          v_invitation.claimed_by_principal_id,
          v_invitation.claim_origin_principal_id
        );
        v_origin_action_invocation_id := v_invitation.claim_origin_action_invocation_id;
        v_origin_proof_reference := coalesce(
          v_invitation.claim_proof_reference,
          v_invitation.claim_origin_proof_reference
        );
        SELECT claim.action_invocation_id, claim.access_mutation_id
          INTO v_origin_action_invocation_id, v_claim_mutation_id
        FROM commerce_customer_context.access_mutation_journal AS claim
        WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
          AND claim.resource_id = p_invitation_id AND claim.mutation_kind = 'CLAIM_INVITE'
          AND claim.subject_principal_id = v_origin_principal_id
        ORDER BY claim.recorded_at DESC, claim.access_mutation_id DESC LIMIT 1;
        IF v_invitation.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
          AND v_origin_principal_id IS NOT NULL
          AND v_origin_action_invocation_id IS NOT NULL THEN
          -- This deny marker is the durable hand-off to the claim worker. It is keyed by the
          -- original claim action, so retries can stage/revoke only that claim's tuples.
          INSERT INTO commerce_customer_context.access_mutation_journal (
            tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
            mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
            action_invocation_id, reason
          ) VALUES (
            p_tenant_id, p_legal_entity_id, v_invitation.counterparty_purchasing_profile_id,
            v_origin_principal_id, 'CLAIM_REJECTED', p_invitation_id, v_invitation.revision + 1,
            jsonb_build_object(
              'operation', 'REVOKE', 'requestedState', 'REVOKED',
              'compensatesClaimMutationId', v_claim_mutation_id::text
            ), p_actor_principal_id, v_origin_action_invocation_id,
            coalesce(p_reason, 'Revoke claim and compensate claim-created access')
          ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING;
        END IF;
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'REVOKED', revoked_at = statement_timestamp(), revision = counterparty_access_invitations.revision + 1,
              claimed_by_principal_id = NULL, claimed_at = NULL, claim_proof_reference = NULL,
              claim_origin_principal_id = v_origin_principal_id,
              claim_origin_action_invocation_id = v_origin_action_invocation_id,
              claim_origin_proof_reference = v_origin_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'REVOKED';
      END IF;

    ELSIF p_operation = 'BEGIN_CLAIM' THEN
      v_mutation_kind := 'CLAIM_INVITE';
      IF v_invitation.lifecycle = 'CLAIMED' THEN
        v_outcome := 'ALREADY_CLAIMED';
      ELSIF v_invitation.expires_at <= statement_timestamp() THEN
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'EXPIRED', revision = counterparty_access_invitations.revision + 1,
              claimed_by_principal_id = NULL, claimed_at = NULL, claim_proof_reference = NULL,
              claim_origin_principal_id = NULL, claim_origin_action_invocation_id = NULL,
              claim_origin_proof_reference = NULL
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'EXPIRED';
        v_marker_kind := 'CLAIM_EXPIRED';
        INSERT INTO commerce_customer_context.access_mutation_journal (
          tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
          mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
          action_invocation_id, reason
        ) VALUES (
          p_tenant_id, p_legal_entity_id, v_invitation.counterparty_purchasing_profile_id,
          p_claimant_principal_id, v_marker_kind, p_invitation_id, v_invitation.revision + 1,
          jsonb_build_object('operation', 'EXPIRE_CLAIM', 'requestedState', 'EXPIRED'),
          p_actor_principal_id, p_action_invocation_id,
          coalesce(p_reason, 'Claim expired before it could begin')
        ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING
        RETURNING access_mutation_id INTO v_mutation_id;
        v_mutation_staged := v_mutation_id IS NOT NULL;
      ELSIF EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
          AND journal.subject_principal_id = p_claimant_principal_id
      ) AND v_invitation.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED') THEN
        v_outcome := 'CLAIMING';
      ELSIF v_invitation.lifecycle <> 'PENDING' OR p_claimant_principal_id IS NULL
        OR p_claim_proof_reference IS NULL THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN
        v_outcome := 'REVISION_CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'CLAIMING', revision = counterparty_access_invitations.revision + 1,
              claimed_by_principal_id = p_claimant_principal_id,
              claim_proof_reference = p_claim_proof_reference,
              claim_origin_principal_id = p_claimant_principal_id,
              claim_origin_action_invocation_id = p_action_invocation_id,
              claim_origin_proof_reference = p_claim_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'CLAIMING';
      END IF;

    ELSE
      v_mutation_kind := 'CLAIM_INVITE';
      IF v_invitation.lifecycle = 'CLAIMED' THEN
        v_outcome := 'ALREADY_CLAIMED';
      ELSIF v_invitation.lifecycle NOT IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
        OR p_claimant_principal_id IS NULL OR p_claim_proof_reference IS NULL THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN
        v_outcome := 'REVISION_CONFLICT';
      ELSIF p_operation = 'FINISH_RECONCILIATION' THEN
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'RECONCILIATION_REQUIRED', revision = counterparty_access_invitations.revision + 1,
              claim_proof_reference = p_claim_proof_reference,
              claim_origin_proof_reference = p_claim_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'RECONCILIATION_REQUIRED';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'CLAIMED', claimed_by_principal_id = p_claimant_principal_id,
              claimed_at = statement_timestamp(), revision = counterparty_access_invitations.revision + 1,
              claim_proof_reference = p_claim_proof_reference,
              claim_origin_principal_id = p_claimant_principal_id,
              claim_origin_action_invocation_id = coalesce(
                v_invitation.claim_origin_action_invocation_id, p_action_invocation_id
              ),
              claim_origin_proof_reference = p_claim_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'CLAIMING';
      END IF;
    END IF;

    IF v_mutation_kind IS NOT NULL
      AND v_outcome IN ('RESENT', 'REVOKED', 'CLAIMING', 'RECONCILIATION_REQUIRED') THEN
      INSERT INTO commerce_customer_context.access_mutation_journal (
        tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
        mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
        action_invocation_id, reason
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_invitation.counterparty_purchasing_profile_id,
        p_claimant_principal_id, v_mutation_kind, p_invitation_id, v_invitation.revision,
        jsonb_build_object(
          'operation', p_operation,
          'requestedState', CASE p_operation
            WHEN 'RESEND' THEN 'PENDING'
            WHEN 'REVOKE' THEN 'REVOKED'
            WHEN 'FINISH_CLAIM' THEN 'CLAIMED'
            WHEN 'FINISH_RECONCILIATION' THEN 'RECONCILIATION_REQUIRED'
            ELSE 'CLAIMING' END,
          'invitationRef', jsonb_build_object(
            'moduleId', 'commerce.customer-context',
            'resourceId', p_invitation_id::text,
            'resourceType', 'commerce.customer-context.counterparty-access-invitation',
            'tenantId', p_tenant_id::text
          )
        ), p_actor_principal_id, p_action_invocation_id, p_reason
      ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING
      RETURNING access_mutation_id INTO v_mutation_id;
      v_mutation_staged := v_mutation_id IS NOT NULL;
    END IF;
    IF v_mutation_kind IS NOT NULL AND v_mutation_id IS NULL THEN
      SELECT journal.access_mutation_id INTO v_mutation_id
      FROM commerce_customer_context.access_mutation_journal AS journal
      WHERE journal.tenant_id = p_tenant_id AND journal.legal_entity_id = p_legal_entity_id
        AND journal.action_invocation_id = p_action_invocation_id
        AND journal.mutation_kind = v_mutation_kind
        AND journal.resource_id = p_invitation_id;
    END IF;
  END IF;

  IF v_outcome = 'INVALID' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT invitation.claimed_at, invitation.claimed_by_principal_id,
    invitation.counterparty_resource_id, invitation.created_at, invitation.delivery_method,
    invitation.delivery_reference, invitation.expires_at, invitation.grant_progress,
    invitation.invitation_id, invitation.invited_by, v_outcome, invitation.reason,
    invitation.requested_permission_codes, invitation.revision, invitation.state,
    invitation.storefront_resource_id, v_mutation_id,
    CASE WHEN v_mutation_id IS NULL THEN NULL::boolean ELSE v_mutation_staged END
  FROM commerce_customer_context.read_access_invitation(
    p_tenant_id, p_legal_entity_id, p_invitation_id,
    p_counterparty_resource_id, p_storefront_resource_id
  ) AS invitation;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."mutate_access_invitation"(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."mutate_access_invitation"(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, text, uuid, text) TO "ontos_runtime";
