-- Claim rejection and expiry are durable owner transitions.  The historical claim journal is
-- retained for provenance, while this marker records the reset/expiry outcome and makes a
-- retry auditable without retaining a live claimant or proof reference.
ALTER TABLE "commerce_customer_context"."access_mutation_journal"
  DROP CONSTRAINT IF EXISTS "ccc_access_journal_kind_ck";
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."access_mutation_journal"
  ADD CONSTRAINT "ccc_access_journal_kind_ck"
  CHECK ("mutation_kind" in ('BOOTSTRAP_ADMIN', 'GRANT', 'REVOKE', 'INVITE', 'RESEND_INVITE', 'CLAIM_INVITE', 'CLAIM_REJECTED', 'CLAIM_EXPIRED', 'REVOKE_INVITE'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."record_claim_reset_marker"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  v_kind text;
BEGIN
  -- Every unclaimed row must be projection-safe, including rows that became expired while
  -- BEGIN_CLAIM was racing the clock. The assignment also makes the invariant hold for rows
  -- written by older routines that did not clear the claimant fields themselves.
  IF NEW.lifecycle IN ('PENDING', 'EXPIRED') THEN
    NEW.claimed_by_principal_id := NULL;
    NEW.claimed_at := NULL;
    NEW.claim_proof_reference := NULL;
    NEW.claim_origin_principal_id := NULL;
    NEW.claim_origin_action_invocation_id := NULL;
    NEW.claim_origin_proof_reference := NULL;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
     AND NEW.lifecycle IN ('PENDING', 'EXPIRED') THEN
    v_kind := CASE WHEN NEW.lifecycle = 'EXPIRED' THEN 'CLAIM_EXPIRED' ELSE 'CLAIM_REJECTED' END;
    INSERT INTO "commerce_customer_context"."access_mutation_journal" (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
      mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
      action_invocation_id, reason
    ) VALUES (
      NEW.tenant_id, NEW.legal_entity_id, NEW.counterparty_purchasing_profile_id,
      OLD.claimed_by_principal_id, v_kind, NEW.counterparty_access_invitation_id, NEW.revision,
      jsonb_build_object(
        'operation', CASE WHEN NEW.lifecycle = 'EXPIRED' THEN 'EXPIRE_CLAIM' ELSE 'REJECT_CLAIM' END,
        'requestedState', NEW.lifecycle,
        'invitationRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', NEW.counterparty_access_invitation_id::text,
          'resourceType', 'commerce.customer-context.counterparty-access-invitation',
          'tenantId', NEW.tenant_id::text
        )
      ),
      NEW.actor_principal_id, NEW.action_invocation_id,
      COALESCE(NEW.reason, 'Claim reset/expiry recorded')
    ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ccc_access_invitations_claim_reset_marker" ON "commerce_customer_context"."counterparty_access_invitations";
--> statement-breakpoint
CREATE TRIGGER "ccc_access_invitations_claim_reset_marker"
  BEFORE UPDATE ON "commerce_customer_context"."counterparty_access_invitations"
  FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."record_claim_reset_marker"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."record_claim_reset_marker"() FROM PUBLIC;
--> statement-breakpoint

-- The original invitation mutation routine cleared all claim evidence on REVOKE and had no
-- replay marker for a reset.  Keep the active projection private, but retain an immutable claim
-- origin so a revoke racing a partially-applied claim can still compensate the exact GRANT rows.
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
              revision = revision + 1,
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
          SET lifecycle = 'EXPIRED', revision = revision + 1
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'EXPIRED';
      ELSIF v_invitation.lifecycle <> 'PENDING' THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN
        v_outcome := 'REVISION_CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET revision = revision + 1
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
          SET lifecycle = 'REVOKED', revoked_at = statement_timestamp(), revision = revision + 1,
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
          SET lifecycle = 'EXPIRED', revision = revision + 1,
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
          SET lifecycle = 'CLAIMING', revision = revision + 1,
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
          SET lifecycle = 'RECONCILIATION_REQUIRED', revision = revision + 1,
              claim_proof_reference = p_claim_proof_reference,
              claim_origin_proof_reference = p_claim_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'RECONCILIATION_REQUIRED';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'CLAIMED', claimed_by_principal_id = p_claimant_principal_id,
              claimed_at = statement_timestamp(), revision = revision + 1,
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
--> statement-breakpoint

DROP FUNCTION IF EXISTS "commerce_customer_context"."read_access_invitation_claim_reconciliation"(uuid, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."read_access_invitation_claim_reconciliation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_claim_mutation_id uuid
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
    RAISE EXCEPTION 'invalid scoped invitation reconciliation request' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT invitation.claimed_at,
    invitation.claimed_by_principal_id,
    invitation.counterparty_resource_id,
    invitation.created_at,
    invitation.delivery_method,
    invitation.delivery_reference,
    invitation.expires_at,
    invitation.grant_progress,
    invitation.invitation_id,
    invitation.invited_by,
    invitation.operation_outcome,
    invitation.reason,
    invitation.requested_permission_codes,
    invitation.revision,
    invitation.state,
    invitation.storefront_resource_id,
    coalesce(stored.claimed_by_principal_id, stored.claim_origin_principal_id),
    proof.attestation_reference,
    claim.access_mutation_id,
    claim.action_invocation_id,
    proof.consumed_at
  FROM commerce_customer_context.access_mutation_journal AS claim
  JOIN commerce_customer_context.counterparty_access_invitations AS stored
    ON stored.tenant_id = claim.tenant_id AND stored.legal_entity_id = claim.legal_entity_id
    AND stored.counterparty_access_invitation_id = claim.resource_id
    AND stored.counterparty_purchasing_profile_id = claim.counterparty_purchasing_profile_id
    AND coalesce(stored.claimed_by_principal_id, stored.claim_origin_principal_id)
      = claim.subject_principal_id
  JOIN commerce_customer_context.counterparty_purchasing_profiles AS profile
    ON profile.tenant_id = stored.tenant_id AND profile.legal_entity_id = stored.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = stored.counterparty_purchasing_profile_id
  JOIN commerce_customer_context.counterparty_invitation_claim_proofs AS proof
    ON proof.tenant_id = stored.tenant_id AND proof.legal_entity_id = stored.legal_entity_id
    AND proof.invitation_id = stored.counterparty_access_invitation_id
    AND proof.claimant_principal_id = claim.subject_principal_id
    AND proof.consume_action_invocation_id = coalesce(
      stored.claim_origin_action_invocation_id, claim.action_invocation_id
    )
    AND proof.lifecycle = 'CONSUMED'
    AND (
      proof.attestation_reference = coalesce(
        stored.claim_proof_reference, stored.claim_origin_proof_reference
      )
      OR proof.proof_reference = coalesce(
        stored.claim_proof_reference, stored.claim_origin_proof_reference
      )
    )
  CROSS JOIN LATERAL commerce_customer_context.read_access_invitation(
    p_tenant_id, p_legal_entity_id, stored.counterparty_access_invitation_id,
    profile.counterparty_resource_id, stored.storefront_resource_id
  ) AS invitation
  WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
    AND claim.access_mutation_id = p_claim_mutation_id AND claim.mutation_kind = 'CLAIM_INVITE';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_access_invitation_claim_reconciliation"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_access_invitation_claim_reconciliation"(uuid, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_claim_mutation_id uuid,
  p_compensate boolean
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text, action_invocation_id uuid, mutation_id uuid,
  recovery_operation text, mutation_staged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  v_claim commerce_customer_context.access_mutation_journal%ROWTYPE;
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_counterparty_resource_id text;
  v_permission text;
  v_begin record;
  v_current_grant_id uuid;
  v_current_mutation_id uuid;
  v_current_operation text;
  v_compensation_mutation_id uuid;
  v_compensation_staged boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation reconciliation request' USING ERRCODE = '42501';
  END IF;
  SELECT claim.* INTO v_claim
  FROM commerce_customer_context.access_mutation_journal AS claim
  WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
    AND claim.access_mutation_id = p_claim_mutation_id AND claim.mutation_kind = 'CLAIM_INVITE'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT stored.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS stored
  WHERE stored.tenant_id = p_tenant_id AND stored.legal_entity_id = p_legal_entity_id
    AND stored.counterparty_access_invitation_id = v_claim.resource_id
    AND stored.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
    AND coalesce(stored.claimed_by_principal_id, stored.claim_origin_principal_id)
      = v_claim.subject_principal_id
    AND stored.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED', 'CLAIMED', 'REVOKED')
  FOR UPDATE;
  -- CLAIMED is terminal and must never be mutated; REVOKED remains readable only for the
  -- compensation branch so a revoke/claim race cannot strand its claim-created tuples.
  IF NOT FOUND OR v_invitation.lifecycle = 'CLAIMED'
     OR (v_invitation.lifecycle = 'REVOKED' AND NOT p_compensate) THEN
    RETURN;
  END IF;
  SELECT profile.counterparty_resource_id INTO v_counterparty_resource_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id;

  IF p_compensate THEN
    FOR v_current_grant_id IN
      SELECT claim_grant.counterparty_commerce_access_grant_id
      FROM commerce_customer_context.counterparty_commerce_access_grants AS claim_grant
      WHERE claim_grant.tenant_id = p_tenant_id
        AND claim_grant.legal_entity_id = p_legal_entity_id
        AND claim_grant.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
        AND claim_grant.principal_id = v_claim.subject_principal_id
        AND claim_grant.storefront_resource_id IS NOT DISTINCT FROM v_invitation.storefront_resource_id
        AND claim_grant.permission_code IN (
          SELECT permission.value
          FROM jsonb_array_elements_text(v_invitation.requested_permission_codes) AS permission(value)
        )
        AND claim_grant.lifecycle <> 'REVOKED'
        AND EXISTS (
          SELECT 1 FROM commerce_customer_context.access_mutation_journal AS origin
          WHERE origin.tenant_id = p_tenant_id AND origin.legal_entity_id = p_legal_entity_id
            AND origin.resource_id = claim_grant.counterparty_commerce_access_grant_id
            AND origin.mutation_kind = 'GRANT'
            AND origin.action_invocation_id = v_claim.action_invocation_id
        )
      FOR UPDATE OF claim_grant
    LOOP
      v_compensation_mutation_id := NULL;
      INSERT INTO commerce_customer_context.access_mutation_journal (
        tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
        mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
        action_invocation_id, reason
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_claim.counterparty_purchasing_profile_id,
        v_claim.subject_principal_id, 'REVOKE', v_current_grant_id, v_claim.revision,
        jsonb_build_object('requestedState', 'PENDING_REVOKE',
          'compensatesClaimMutationId', p_claim_mutation_id::text),
        v_claim.actor_principal_id, v_claim.action_invocation_id,
        'Compensate invitation claim after inviter authority was lost'
      ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING
      RETURNING access_mutation_id INTO v_compensation_mutation_id;
      v_compensation_staged := v_compensation_mutation_id IS NOT NULL;
      IF v_compensation_mutation_id IS NULL THEN
        SELECT compensation.access_mutation_id INTO v_compensation_mutation_id
        FROM commerce_customer_context.access_mutation_journal AS compensation
        WHERE compensation.tenant_id = p_tenant_id
          AND compensation.legal_entity_id = p_legal_entity_id
          AND compensation.resource_id = v_current_grant_id
          AND compensation.mutation_kind = 'REVOKE'
          AND compensation.action_invocation_id = v_claim.action_invocation_id;
      END IF;
      UPDATE commerce_customer_context.counterparty_commerce_access_grants
        SET lifecycle = 'PENDING_REVOKE', revision = revision + 1
      WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
        AND counterparty_commerce_access_grant_id = v_current_grant_id
        AND lifecycle <> 'PENDING_REVOKE';
      PERFORM * FROM commerce_customer_context.transition_access_grant(
        p_tenant_id, p_legal_entity_id, v_current_grant_id, v_compensation_mutation_id,
        'revoke', 'RECONCILIATION_REQUIRED'
      );
      RETURN QUERY
      SELECT pending.*, v_compensation_staged
      FROM commerce_customer_context.read_access_reconciliation(
        p_tenant_id, p_legal_entity_id, v_compensation_mutation_id
      ) AS pending;
    END LOOP;
    RETURN;
  END IF;

  FOR v_permission IN
    SELECT permission.value
    FROM jsonb_array_elements_text(v_invitation.requested_permission_codes)
      WITH ORDINALITY AS permission(value, ordinality)
    ORDER BY permission.ordinality
  LOOP
    SELECT * INTO v_begin
    FROM commerce_customer_context.begin_access_grant(
      p_tenant_id, p_legal_entity_id, v_counterparty_resource_id,
      v_claim.subject_principal_id, v_permission, v_invitation.storefront_resource_id,
      v_claim.actor_principal_id, v_claim.action_invocation_id, v_claim.reason, false
    );
    IF v_begin.operation_outcome = 'PENDING_GRANT' AND v_begin.mutation_id IS NOT NULL THEN
      PERFORM * FROM commerce_customer_context.transition_access_grant(
        p_tenant_id, p_legal_entity_id, v_begin.grant_id, v_begin.mutation_id,
        'grant', 'RECONCILIATION_REQUIRED'
      );
      RETURN QUERY
      SELECT pending.*, v_begin.mutation_staged
      FROM commerce_customer_context.read_access_reconciliation(
        p_tenant_id, p_legal_entity_id, v_begin.mutation_id
      ) AS pending;
    ELSIF v_begin.operation_outcome = 'CONFLICT' THEN
      SELECT current_grant.counterparty_commerce_access_grant_id
        INTO v_current_grant_id
      FROM commerce_customer_context.counterparty_commerce_access_grants AS current_grant
      WHERE current_grant.tenant_id = p_tenant_id
        AND current_grant.legal_entity_id = p_legal_entity_id
        AND current_grant.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
        AND current_grant.principal_id = v_claim.subject_principal_id
        AND current_grant.permission_code = v_permission
        AND current_grant.storefront_resource_id IS NOT DISTINCT FROM v_invitation.storefront_resource_id
        AND current_grant.lifecycle IN ('PENDING_REVOKE', 'RECONCILIATION_REQUIRED')
      ORDER BY current_grant.recorded_at DESC LIMIT 1;
      SELECT latest.access_mutation_id,
        CASE WHEN latest.mutation_kind = 'REVOKE' THEN 'revoke' ELSE 'grant' END
        INTO v_current_mutation_id, v_current_operation
      FROM commerce_customer_context.access_mutation_journal AS latest
      WHERE latest.tenant_id = p_tenant_id AND latest.legal_entity_id = p_legal_entity_id
        AND latest.resource_id = v_current_grant_id
      ORDER BY latest.recorded_at DESC, latest.access_mutation_id DESC LIMIT 1;
      RETURN QUERY
      SELECT pending.*, false
      FROM commerce_customer_context.read_access_reconciliation(
        p_tenant_id, p_legal_entity_id, v_current_mutation_id
      ) AS pending
      WHERE pending.recovery_operation = v_current_operation;
    END IF;
  END LOOP;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(uuid, uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(uuid, uuid, uuid, boolean) TO "ontos_runtime";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_claim_mutation_id uuid
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, reason text,
  requested_permission_codes jsonb, revision integer, state text, storefront_resource_id text,
  attestation_reference text, claim_mutation_id uuid, source_action_invocation_id uuid,
  verified_at timestamptz, operation_outcome text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  v_claim commerce_customer_context.access_mutation_journal%ROWTYPE;
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_outcome text;
  v_permission_count integer;
  v_active_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation reconciliation request' USING ERRCODE = '42501';
  END IF;
  SELECT claim.* INTO v_claim
  FROM commerce_customer_context.access_mutation_journal AS claim
  WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
    AND claim.access_mutation_id = p_claim_mutation_id AND claim.mutation_kind = 'CLAIM_INVITE'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT stored.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS stored
  WHERE stored.tenant_id = p_tenant_id AND stored.legal_entity_id = p_legal_entity_id
    AND stored.counterparty_access_invitation_id = v_claim.resource_id
    AND stored.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
    AND coalesce(stored.claimed_by_principal_id, stored.claim_origin_principal_id)
      = v_claim.subject_principal_id
  FOR UPDATE;
  IF NOT FOUND OR v_invitation.lifecycle = 'REVOKED' THEN
    -- A revoked claim is compensation-only; never promote it or turn a revoke into a claim.
    RETURN;
  END IF;
  IF v_invitation.lifecycle = 'CLAIMED' THEN
    v_outcome := 'ALREADY_CLAIMED';
  ELSE
    SELECT jsonb_array_length(v_invitation.requested_permission_codes), count(active_grant.*)
      INTO v_permission_count, v_active_count
    FROM jsonb_array_elements_text(v_invitation.requested_permission_codes) AS permission(value)
    LEFT JOIN commerce_customer_context.counterparty_commerce_access_grants AS active_grant
      ON active_grant.tenant_id = p_tenant_id
      AND active_grant.legal_entity_id = p_legal_entity_id
      AND active_grant.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id
      AND active_grant.principal_id = v_claim.subject_principal_id
      AND active_grant.permission_code = permission.value
      AND active_grant.storefront_resource_id IS NOT DISTINCT FROM v_invitation.storefront_resource_id
      AND active_grant.lifecycle = 'ACTIVE';
    IF v_invitation.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
      AND v_active_count = v_permission_count THEN
      UPDATE commerce_customer_context.counterparty_access_invitations
        SET lifecycle = 'CLAIMED', claimed_at = statement_timestamp(), revision = revision + 1
      WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
        AND counterparty_access_invitation_id = v_invitation.counterparty_access_invitation_id;
      v_outcome := 'CLAIMED';
    ELSE
      UPDATE commerce_customer_context.counterparty_access_invitations
        SET lifecycle = 'RECONCILIATION_REQUIRED',
            revision = revision + CASE WHEN lifecycle = 'RECONCILIATION_REQUIRED' THEN 0 ELSE 1 END
      WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
        AND counterparty_access_invitation_id = v_invitation.counterparty_access_invitation_id
        AND lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED');
      v_outcome := 'PENDING_AUTHORIZATION';
    END IF;
  END IF;
  RETURN QUERY
  SELECT reconciled.claimed_at, reconciled.claimed_by_principal_id,
    reconciled.counterparty_resource_id, reconciled.created_at, reconciled.delivery_method,
    reconciled.delivery_reference, reconciled.expires_at, reconciled.grant_progress,
    reconciled.invitation_id, reconciled.invited_by, reconciled.reason,
    reconciled.requested_permission_codes, reconciled.revision, reconciled.state,
    reconciled.storefront_resource_id, reconciled.attestation_reference,
    reconciled.claim_mutation_id, reconciled.source_action_invocation_id,
    reconciled.verified_at, v_outcome
  FROM commerce_customer_context.read_access_invitation_claim_reconciliation(
    p_tenant_id, p_legal_entity_id, p_claim_mutation_id
  ) AS reconciled;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(uuid, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint

-- The aggregate binding routine remains available for read models, but worker reconciliation
-- stages and finalizes one reviewed Permission intent at a time.  This gives every external
-- relationship write its own durable recovery anchor.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."stage_retail_portal_profile_binding_permission_mutations"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_principal_id uuid,
  p_action_invocation_id uuid,
  p_operation text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_pending_state text;
  v_total integer;
  v_staged integer;
  v_intent record;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_binding_id IS NULL OR p_principal_id IS NULL OR p_action_invocation_id IS NULL
     OR p_operation NOT IN ('grant', 'revoke') THEN
    RETURN QUERY SELECT 'AUTHORIZATION_UNAVAILABLE', NULL::jsonb;
    RETURN;
  END IF;
  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=p_binding_id
     AND principal_id=p_principal_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'BINDING_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  v_pending_state := CASE p_operation WHEN 'grant' THEN 'PENDING_GRANT' ELSE 'PENDING_REVOKE' END;
  IF v_binding.authorization_operation IS DISTINCT FROM p_operation
     OR v_binding.action_invocation_id IS DISTINCT FROM p_action_invocation_id
     OR (p_operation='grant' AND v_binding.lifecycle IS DISTINCT FROM 'ACTIVE')
     OR (p_operation='revoke' AND v_binding.lifecycle IS DISTINCT FROM 'REVOKED') THEN
    RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  SELECT count(*) INTO v_total
    FROM retail_portal_profile_binding_permission_mutations intent
   WHERE intent.tenant_id=p_tenant_id AND intent.legal_entity_id=p_legal_entity_id
     AND intent.retail_portal_profile_binding_id=p_binding_id
     AND intent.action_invocation_id=p_action_invocation_id
     AND intent.operation=p_operation;
  IF v_total <> 8 OR EXISTS (
    SELECT 1
      FROM retail_portal_profile_binding_permission_mutations intent
     WHERE intent.tenant_id=p_tenant_id AND intent.legal_entity_id=p_legal_entity_id
       AND intent.retail_portal_profile_binding_id=p_binding_id
       AND intent.action_invocation_id=p_action_invocation_id
       AND intent.operation=p_operation
       AND (
         intent.retail_customer_profile_id IS DISTINCT FROM v_binding.retail_customer_profile_id
         OR intent.principal_id IS DISTINCT FROM v_binding.principal_id
         OR intent.permission_code NOT IN (
           'retail.profile.read', 'retail.address_book.use', 'retail.address_book.manage',
           'retail.history.read', 'retail.repeat_order', 'retail.aftercare.read',
           'retail.claim.create', 'retail.consent.manage'
         )
       )
  ) THEN
    RETURN QUERY SELECT 'AUTHORIZATION_UNAVAILABLE', NULL::jsonb;
    RETURN;
  END IF;
  FOR v_intent IN
    SELECT intent.*
      FROM retail_portal_profile_binding_permission_mutations intent
     WHERE intent.tenant_id=p_tenant_id AND intent.legal_entity_id=p_legal_entity_id
       AND intent.retail_portal_profile_binding_id=p_binding_id
       AND intent.action_invocation_id=p_action_invocation_id
       AND intent.operation=p_operation
     ORDER BY intent.permission_code
     FOR UPDATE
  LOOP
    v_staged := CASE WHEN v_intent.state = v_pending_state THEN 1 ELSE 0 END;
    IF v_staged = 1 THEN
      UPDATE retail_portal_profile_binding_permission_mutations
         SET state='RECONCILIATION_REQUIRED', revision=revision+1
       WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
         AND retail_portal_profile_binding_permission_mutation_id=v_intent.retail_portal_profile_binding_permission_mutation_id;
      v_intent.state := 'RECONCILIATION_REQUIRED';
    END IF;
    RETURN QUERY SELECT
      'AUTHORIZATION_STAGED',
      jsonb_build_object(
        'actionInvocationId',v_intent.action_invocation_id,
        'actorPrincipalId',v_intent.actor_principal_id,
        'bindingId',v_intent.retail_portal_profile_binding_id,
        'finalizedAt',CASE WHEN v_intent.finalized_at IS NULL THEN NULL ELSE to_char(v_intent.finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'mutationId',v_intent.retail_portal_profile_binding_permission_mutation_id,
        'operation',v_intent.operation,
        'permission',v_intent.permission_code,
        'principalId',v_intent.principal_id,
        'profileId',v_intent.retail_customer_profile_id,
        'reason',v_intent.reason,
        'revision',v_intent.revision + v_staged,
        'staged',(v_staged = 1),
        'state',v_intent.state
      );
  END LOOP;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."stage_retail_portal_profile_binding_permission_mutations"(uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."stage_retail_portal_profile_binding_permission_mutations"(uuid,uuid,uuid,uuid,uuid,text) TO "ontos_runtime";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_retail_portal_profile_binding_permission_mutation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_mutation_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  v_intent retail_portal_profile_binding_permission_mutations%ROWTYPE;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  SELECT * INTO v_intent
    FROM retail_portal_profile_binding_permission_mutations
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_permission_mutation_id=p_mutation_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'AUTHORIZATION_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'AUTHORIZATION_AVAILABLE',jsonb_build_object(
    'actionInvocationId',v_intent.action_invocation_id,
    'actorPrincipalId',v_intent.actor_principal_id,
    'bindingId',v_intent.retail_portal_profile_binding_id,
    'finalizedAt',CASE WHEN v_intent.finalized_at IS NULL THEN NULL ELSE to_char(v_intent.finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'mutationId',v_intent.retail_portal_profile_binding_permission_mutation_id,
    'operation',v_intent.operation,
    'permission',v_intent.permission_code,
    'principalId',v_intent.principal_id,
    'profileId',v_intent.retail_customer_profile_id,
    'reason',v_intent.reason,
    'revision',v_intent.revision,
    'staged',false,
    'state',v_intent.state
  );
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_retail_portal_profile_binding_permission_mutation"(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_retail_portal_profile_binding_permission_mutation"(uuid,uuid,uuid) TO "ontos_runtime";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."finalize_retail_portal_profile_binding_permission_mutation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_mutation_id uuid,
  p_operation text,
  p_target_state text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  v_intent retail_portal_profile_binding_permission_mutations%ROWTYPE;
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_pending_state text;
  v_terminal_state text;
  v_total integer;
  v_terminal integer;
  v_conflict integer;
  v_outcome text;
  v_binding_authorization_state text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_mutation_id IS NULL OR p_operation NOT IN ('grant', 'revoke')
     OR p_target_state NOT IN ('ACTIVE', 'REVOKED') THEN
    RETURN QUERY SELECT 'AUTHORIZATION_UNAVAILABLE', NULL::jsonb;
    RETURN;
  END IF;
  v_pending_state := CASE p_operation WHEN 'grant' THEN 'PENDING_GRANT' ELSE 'PENDING_REVOKE' END;
  v_terminal_state := CASE p_operation WHEN 'grant' THEN 'ACTIVE' ELSE 'REVOKED' END;
  IF p_target_state IS DISTINCT FROM v_terminal_state THEN
    RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  SELECT * INTO v_intent
    FROM retail_portal_profile_binding_permission_mutations
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_permission_mutation_id=p_mutation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'AUTHORIZATION_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  IF v_intent.operation IS DISTINCT FROM p_operation THEN
    RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=v_intent.retail_portal_profile_binding_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_binding.retail_customer_profile_id IS DISTINCT FROM v_intent.retail_customer_profile_id
     OR v_binding.principal_id IS DISTINCT FROM v_intent.principal_id
     OR v_binding.action_invocation_id IS DISTINCT FROM v_intent.action_invocation_id
     OR v_binding.authorization_operation IS DISTINCT FROM p_operation
     OR (p_operation='grant' AND v_binding.lifecycle IS DISTINCT FROM 'ACTIVE')
     OR (p_operation='revoke' AND v_binding.lifecycle IS DISTINCT FROM 'REVOKED')
     OR v_binding.authorization_state NOT IN (v_pending_state, v_terminal_state, 'RECONCILIATION_REQUIRED') THEN
    RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  IF v_intent.state = v_terminal_state THEN
    v_outcome := 'AUTHORIZATION_ALREADY_FINAL';
  ELSIF v_intent.state NOT IN (v_pending_state, 'RECONCILIATION_REQUIRED') THEN
    RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT', NULL::jsonb;
    RETURN;
  ELSE
    UPDATE retail_portal_profile_binding_permission_mutations
       SET state=v_terminal_state, revision=revision+1, finalized_at=clock_timestamp()
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
       AND retail_portal_profile_binding_permission_mutation_id=p_mutation_id;
    SELECT * INTO v_intent
      FROM retail_portal_profile_binding_permission_mutations
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
       AND retail_portal_profile_binding_permission_mutation_id=p_mutation_id;
    v_outcome := 'AUTHORIZATION_FINALIZED';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE intent.state=v_terminal_state),
         count(*) FILTER (WHERE intent.state NOT IN (v_pending_state,v_terminal_state,'RECONCILIATION_REQUIRED'))
    INTO v_total,v_terminal,v_conflict
    FROM retail_portal_profile_binding_permission_mutations intent
   WHERE intent.tenant_id=p_tenant_id AND intent.legal_entity_id=p_legal_entity_id
     AND intent.retail_portal_profile_binding_id=v_intent.retail_portal_profile_binding_id
     AND intent.action_invocation_id=v_intent.action_invocation_id
     AND intent.operation=p_operation;
  v_binding_authorization_state := CASE
    WHEN v_total=8 AND v_terminal=8 THEN v_terminal_state
    WHEN v_conflict>0 THEN 'RECONCILIATION_REQUIRED'
    WHEN v_binding.authorization_operation=p_operation AND v_binding.authorization_state IN (v_pending_state,'RECONCILIATION_REQUIRED')
      THEN v_binding.authorization_state
    ELSE v_pending_state
  END;
  UPDATE retail_portal_profile_bindings
     SET authorization_state=v_binding_authorization_state,
       updated_at=CASE WHEN v_total=8 AND v_terminal=8 THEN clock_timestamp() ELSE updated_at END
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=v_intent.retail_portal_profile_binding_id;
  RETURN QUERY SELECT v_outcome,jsonb_build_object(
    'actionInvocationId',v_intent.action_invocation_id,
    'actorPrincipalId',v_intent.actor_principal_id,
    'authorizationState',v_binding_authorization_state,
    'bindingId',v_intent.retail_portal_profile_binding_id,
    'bindingRevision',v_binding.revision,
    'finalizedAt',CASE WHEN v_intent.finalized_at IS NULL THEN NULL ELSE to_char(v_intent.finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'mutationId',v_intent.retail_portal_profile_binding_permission_mutation_id,
    'operation',v_intent.operation,
    'permission',v_intent.permission_code,
    'principalId',v_intent.principal_id,
    'profileId',v_intent.retail_customer_profile_id,
    'reason',v_intent.reason,
    'revision',v_intent.revision,
    'staged',false,
    'state',v_intent.state
  );
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."finalize_retail_portal_profile_binding_permission_mutation"(uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."finalize_retail_portal_profile_binding_permission_mutation"(uuid,uuid,uuid,text,text) TO "ontos_runtime";
