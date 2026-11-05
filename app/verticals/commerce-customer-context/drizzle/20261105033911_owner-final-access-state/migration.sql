-- PostgreSQL is the only access intent store (O62, O67-Q1), so every access Action writes its final
-- state in its own business transaction: a Retail Portal binding is ACTIVE or REVOKED, a
-- Counterparty grant is ACTIVE or REVOKED, and an invitation claim ends CLAIMED. The pending
-- states, the per-Permission staging journal and the routines a reconciliation worker used to
-- finish them only mirrored that intent into a second store, which no longer exists.
--
-- Rows the removed workers left unfinished settle to the intent PostgreSQL already holds.
UPDATE "commerce_customer_context"."retail_portal_profile_bindings"
   SET authorization_operation = CASE WHEN lifecycle = 'REVOKED' THEN 'revoke' ELSE 'grant' END,
       authorization_state = lifecycle,
       updated_at = clock_timestamp()
 WHERE authorization_state IS DISTINCT FROM lifecycle
    OR authorization_operation IS DISTINCT FROM CASE WHEN lifecycle = 'REVOKED' THEN 'revoke' ELSE 'grant' END;
--> statement-breakpoint
UPDATE "commerce_customer_context"."counterparty_commerce_access_grants" AS grant_row
   SET lifecycle = 'REVOKED',
       revision = grant_row.revision + 1,
       revoked_at = coalesce(grant_row.revoked_at, statement_timestamp())
 WHERE grant_row.lifecycle = 'PENDING_REVOKE'
    OR (grant_row.lifecycle = 'RECONCILIATION_REQUIRED' AND (
      SELECT journal.mutation_kind
        FROM "commerce_customer_context"."access_mutation_journal" AS journal
       WHERE journal.tenant_id = grant_row.tenant_id
         AND journal.legal_entity_id = grant_row.legal_entity_id
         AND journal.resource_id = grant_row.counterparty_commerce_access_grant_id
       ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC
       LIMIT 1
    ) = 'REVOKE');
--> statement-breakpoint
UPDATE "commerce_customer_context"."counterparty_commerce_access_grants" AS grant_row
   SET lifecycle = 'ACTIVE', revision = grant_row.revision + 1
 WHERE grant_row.lifecycle IN ('PENDING_GRANT', 'RECONCILIATION_REQUIRED');
--> statement-breakpoint
-- A claim the removed worker never finished is CLAIMED when every intended Permission already has
-- its ACTIVE grant for the claimant. Otherwise it fails closed as REVOKED, and the Counterparty
-- re-invites instead of inheriting a half-applied claim.
UPDATE "commerce_customer_context"."counterparty_access_invitations" AS invitation
   SET lifecycle = 'CLAIMED',
       claimed_at = statement_timestamp(),
       revision = invitation.revision + 1
 WHERE invitation.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
   AND invitation.claimed_by_principal_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM jsonb_array_elements_text(invitation.requested_permission_codes) AS permission(code)
      WHERE NOT EXISTS (
        SELECT 1
          FROM "commerce_customer_context"."counterparty_commerce_access_grants" AS grant_row
         WHERE grant_row.tenant_id = invitation.tenant_id
           AND grant_row.legal_entity_id = invitation.legal_entity_id
           AND grant_row.counterparty_purchasing_profile_id = invitation.counterparty_purchasing_profile_id
           AND grant_row.principal_id = invitation.claimed_by_principal_id
           AND grant_row.permission_code = permission.code
           AND grant_row.storefront_resource_id IS NOT DISTINCT FROM invitation.storefront_resource_id
           AND grant_row.lifecycle = 'ACTIVE'
      )
   );
--> statement-breakpoint
UPDATE "commerce_customer_context"."counterparty_access_invitations" AS invitation
   SET lifecycle = 'REVOKED',
       revoked_at = statement_timestamp(),
       revision = invitation.revision + 1,
       claimed_by_principal_id = NULL,
       claimed_at = NULL,
       claim_proof_reference = NULL
 WHERE invitation.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED');
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" DROP CONSTRAINT "ccc_portal_bindings_authorization_state_ck", ADD CONSTRAINT "ccc_portal_bindings_authorization_state_ck" CHECK (("lifecycle" = 'ACTIVE' and "authorization_operation" = 'grant' and "authorization_state" = 'ACTIVE') or ("lifecycle" = 'REVOKED' and "authorization_operation" = 'revoke' and "authorization_state" = 'REVOKED'));
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_commerce_access_grants" DROP CONSTRAINT "ccc_access_grants_lifecycle_ck", ADD CONSTRAINT "ccc_access_grants_lifecycle_ck" CHECK (("lifecycle" = 'ACTIVE' and "revoked_at" is null) or ("lifecycle" = 'REVOKED' and "revoked_at" is not null));
--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_access_grants_current_uk";
--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_access_grants_current_uk" ON "commerce_customer_context"."counterparty_commerce_access_grants" ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","principal_id","permission_code",coalesce("storefront_resource_id", '')) WHERE "lifecycle" = 'ACTIVE';
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_lifecycle_ck", ADD CONSTRAINT "ccc_access_invitations_lifecycle_ck" CHECK ("lifecycle" in ('PENDING', 'CLAIMING', 'CLAIMED', 'REVOKED', 'EXPIRED'));
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_claim_ck", ADD CONSTRAINT "ccc_access_invitations_claim_ck" CHECK (("lifecycle" = 'CLAIMED' and "claimed_by_principal_id" is not null and "claimed_at" is not null) or ("lifecycle" = 'CLAIMING' and "claimed_by_principal_id" is not null and "claimed_at" is null) or ("lifecycle" in ('PENDING', 'EXPIRED') and "claimed_by_principal_id" is null and "claimed_at" is null) or ("lifecycle" = 'REVOKED' and "claimed_at" is null));
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."stage_retail_portal_profile_binding_permission_mutations"(uuid, uuid, uuid, uuid, uuid, text);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."read_retail_portal_profile_binding_permission_mutation"(uuid, uuid, uuid);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."finalize_retail_portal_profile_binding_permission_mutation"(uuid, uuid, uuid, text, text);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."finalize_retail_portal_binding_authorization"(uuid, uuid, uuid, text, integer, uuid, timestamptz, text, uuid);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."read_retail_portal_binding_authorization"(uuid, uuid, uuid, text);
--> statement-breakpoint
DROP TABLE "commerce_customer_context"."retail_portal_profile_binding_permission_mutations";
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."begin_access_grant"(uuid, uuid, text, uuid, text, text, uuid, uuid, text, boolean);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."begin_access_revoke"(uuid, uuid, text, uuid, uuid, text, text, uuid, uuid, text);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."transition_access_grant"(uuid, uuid, uuid, uuid, text, text);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(uuid, uuid, uuid, boolean);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(uuid, uuid, uuid);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."list_access_reconciliation"(uuid, uuid, integer);
--> statement-breakpoint
DROP FUNCTION "commerce_customer_context"."read_access_reconciliation"(uuid, uuid, uuid);
--> statement-breakpoint

-- BIND/RECOVER/REVOKE writes the binding and its final authorization state together. A retried
-- Action still has to reuse the exact owner transition: the idempotency key is not a substitute
-- for the target tuple.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."mutate_retail_portal_binding"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id uuid,
  p_principal_id uuid,
  p_auth_binding_id uuid,
  p_enrollment_evidence_ref text,
  p_expected_state text,
  p_expected_revision integer,
  p_operation text,
  p_effective_at timestamptz,
  p_reason text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_profile_state text;
  v_next_state text;
  v_next_revision integer;
  v_existing boolean := false;
  v_effective_at timestamptz;
  v_previous_state text;
  v_idempotent boolean := false;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_auth_binding_id IS NULL
     OR p_profile_id IS NULL OR p_principal_id IS NULL OR p_effective_at IS NULL
     OR nullif(btrim(p_enrollment_evidence_ref), '') IS NULL OR nullif(btrim(p_reason), '') IS NULL
     OR p_operation IS NULL OR p_operation NOT IN ('BIND','RECOVER','REVOKE') THEN
    RETURN QUERY SELECT 'ENROLLMENT_EVIDENCE_INSUFFICIENT', NULL::jsonb;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':binding:' ||
    p_profile_id::text || ':' || p_principal_id::text, 0));

  SELECT cp.lifecycle INTO v_profile_state
    FROM retail_customer_profiles rp
    JOIN customer_profiles cp
      ON cp.tenant_id=rp.tenant_id AND cp.legal_entity_id=rp.legal_entity_id
     AND cp.customer_profile_id=rp.retail_customer_profile_id
   WHERE rp.tenant_id=p_tenant_id AND rp.legal_entity_id=p_legal_entity_id
     AND rp.retail_customer_profile_id=p_profile_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM profile_reconciliation_case_members member
      JOIN profile_reconciliation_cases reconciliation
        USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.customer_profile_id=p_profile_id AND reconciliation.lifecycle<>'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  IF p_operation IN ('BIND','RECOVER') AND v_profile_state <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'PROFILE_NOT_ACTIVE', NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_customer_profile_id=p_profile_id AND principal_id=p_principal_id
  ORDER BY revision DESC, created_at DESC
  LIMIT 1
  FOR UPDATE;
  v_existing := FOUND;

  IF v_existing
     AND p_operation <> 'BIND'
     AND v_binding.action_invocation_id = p_action_invocation_id
     AND v_binding.auth_binding_id = p_auth_binding_id
     AND v_binding.enrollment_evidence_ref = btrim(p_enrollment_evidence_ref)
     AND ((p_operation='RECOVER' AND v_binding.lifecycle='ACTIVE')
       OR (p_operation='REVOKE' AND v_binding.lifecycle='REVOKED')) THEN
    v_idempotent := true;
    v_next_state := v_binding.lifecycle;
    v_next_revision := v_binding.revision;
    SELECT history.effective_at INTO v_effective_at
      FROM retail_portal_profile_binding_history history
     WHERE history.tenant_id=p_tenant_id AND history.legal_entity_id=p_legal_entity_id
       AND history.retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
       AND history.revision=v_binding.revision;
    v_effective_at := coalesce(v_effective_at, p_effective_at);
  END IF;

  IF p_operation = 'BIND' THEN
    IF p_expected_state IS NOT NULL OR p_expected_revision IS NOT NULL THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
      RETURN;
    END IF;
    IF v_existing THEN
      IF v_binding.lifecycle='ACTIVE'
         AND v_binding.auth_binding_id=p_auth_binding_id
         AND v_binding.enrollment_evidence_ref=btrim(p_enrollment_evidence_ref)
         AND v_binding.action_invocation_id=p_action_invocation_id THEN
        v_next_state := 'ACTIVE';
        v_next_revision := v_binding.revision;
        SELECT history.effective_at INTO v_effective_at
          FROM retail_portal_profile_binding_history history
         WHERE history.tenant_id=p_tenant_id AND history.legal_entity_id=p_legal_entity_id
           AND history.retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
           AND history.revision=v_binding.revision;
        v_effective_at := coalesce(v_effective_at, p_effective_at);
      ELSE
        RETURN QUERY SELECT 'BINDING_CONFLICT', NULL::jsonb;
        RETURN;
      END IF;
    ELSE
      INSERT INTO retail_portal_profile_bindings(
        tenant_id, legal_entity_id, retail_customer_profile_id, principal_id, auth_binding_id,
        enrollment_evidence_ref, lifecycle, authorization_operation, authorization_state,
        revision, revoked_at, action_invocation_id, actor_principal_id, reason
      ) VALUES (
        p_tenant_id,p_legal_entity_id,p_profile_id,p_principal_id,p_auth_binding_id,
        btrim(p_enrollment_evidence_ref),'ACTIVE','grant','ACTIVE',
        1,NULL,p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
      ) RETURNING * INTO v_binding;
      v_next_state := 'ACTIVE';
      v_next_revision := 1;
      INSERT INTO retail_portal_profile_binding_history(
        tenant_id,legal_entity_id,retail_portal_profile_binding_id,revision,from_lifecycle,
        to_lifecycle,effective_at,enrollment_evidence_ref,action_invocation_id,actor_principal_id,reason
      ) VALUES (
        p_tenant_id,p_legal_entity_id,v_binding.retail_portal_profile_binding_id,1,NULL,'ACTIVE',
        p_effective_at,btrim(p_enrollment_evidence_ref),p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
      );
    END IF;
  ELSE
    IF NOT v_existing THEN
      RETURN QUERY SELECT 'BINDING_NOT_FOUND', NULL::jsonb;
      RETURN;
    END IF;
    IF NOT v_idempotent THEN
      IF v_binding.auth_binding_id IS DISTINCT FROM p_auth_binding_id
         OR v_binding.lifecycle IS DISTINCT FROM p_expected_state
         OR v_binding.revision IS DISTINCT FROM p_expected_revision THEN
        RETURN QUERY SELECT CASE
          WHEN v_binding.auth_binding_id IS DISTINCT FROM p_auth_binding_id THEN 'BINDING_CONFLICT'
          ELSE 'CURRENT_STATE_CONFLICT' END, NULL::jsonb;
        RETURN;
      END IF;
      IF (p_operation='RECOVER' AND p_expected_state<>'REVOKED')
         OR (p_operation='REVOKE' AND p_expected_state<>'ACTIVE') THEN
        RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
        RETURN;
      END IF;
      v_previous_state := v_binding.lifecycle;
      v_next_state := CASE p_operation WHEN 'RECOVER' THEN 'ACTIVE' ELSE 'REVOKED' END;
      v_next_revision := v_binding.revision + 1;
      UPDATE retail_portal_profile_bindings
         SET lifecycle=v_next_state,
             authorization_operation=CASE WHEN p_operation='REVOKE' THEN 'revoke' ELSE 'grant' END,
             authorization_state=v_next_state,
             revision=v_next_revision,
             revoked_at=CASE WHEN v_next_state='REVOKED' THEN p_effective_at ELSE NULL END,
             enrollment_evidence_ref=btrim(p_enrollment_evidence_ref),
             action_invocation_id=p_action_invocation_id,
             actor_principal_id=p_actor_principal_id,
             reason=btrim(p_reason),
             updated_at=clock_timestamp()
       WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
         AND retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
       RETURNING * INTO v_binding;
      v_effective_at := p_effective_at;
      INSERT INTO retail_portal_profile_binding_history(
        tenant_id,legal_entity_id,retail_portal_profile_binding_id,revision,from_lifecycle,
        to_lifecycle,effective_at,enrollment_evidence_ref,action_invocation_id,actor_principal_id,reason
      ) VALUES (
        p_tenant_id,p_legal_entity_id,v_binding.retail_portal_profile_binding_id,v_next_revision,
        v_previous_state,v_next_state,p_effective_at,btrim(p_enrollment_evidence_ref),
        p_action_invocation_id,p_actor_principal_id,btrim(p_reason));
    END IF;
  END IF;

  v_effective_at := coalesce(v_effective_at, p_effective_at);

  RETURN QUERY SELECT
    CASE p_operation WHEN 'BIND' THEN 'BINDING_ACTIVATED'
                    WHEN 'RECOVER' THEN 'BINDING_RECOVERED'
                    ELSE 'BINDING_REVOKED' END,
    jsonb_build_object(
      'bindingRef',jsonb_build_object(
        'moduleId','commerce.customer-context',
        'resourceId',v_binding.retail_portal_profile_binding_id,
        'resourceType','commerce.customer-context.retail-portal-profile-binding',
        'tenantId',p_tenant_id),
      'effectiveAt',to_char(v_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome',CASE p_operation WHEN 'BIND' THEN 'BINDING_ACTIVATED'
                                 WHEN 'RECOVER' THEN 'BINDING_RECOVERED'
                                 ELSE 'BINDING_REVOKED' END,
      'revision',v_next_revision,
      'state',v_binding.lifecycle,
      'authorizationOperation',v_binding.authorization_operation,
      'authorizationState',v_binding.authorization_state
    );
END
$routine$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_retail_portal_binding"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_requesting_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_case_id uuid;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=p_binding_id
     AND principal_id=p_requesting_principal_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'BINDING_NOT_FOUND',NULL::jsonb;
    RETURN;
  END IF;
  SELECT reconciliation.profile_reconciliation_case_id INTO v_case_id
    FROM profile_reconciliation_case_members member
    JOIN profile_reconciliation_cases reconciliation
      USING (tenant_id,legal_entity_id,profile_reconciliation_case_id)
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.customer_profile_id=v_binding.retail_customer_profile_id
     AND reconciliation.lifecycle<>'COMPLETED'
   ORDER BY reconciliation.recorded_at
   LIMIT 1;
  IF v_case_id IS NOT NULL THEN
    RETURN QUERY SELECT 'BINDING_RECONCILIATION_REQUIRED',jsonb_build_object(
      'bindingId',p_binding_id,'profileId',v_binding.retail_customer_profile_id,'caseId',v_case_id,
      'observedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revision',v_binding.revision);
    RETURN;
  END IF;
  RETURN QUERY SELECT 'BINDING_AVAILABLE',jsonb_build_object(
    'actorPrincipalId',v_binding.actor_principal_id,
    'actionInvocationId',v_binding.action_invocation_id,
    'authorizationOperation',v_binding.authorization_operation,
    'authorizationState',v_binding.authorization_state,
    'bindingId',v_binding.retail_portal_profile_binding_id,
    'profileId',v_binding.retail_customer_profile_id,
    'principalId',v_binding.principal_id,
    'enrollmentEvidenceRef',v_binding.enrollment_evidence_ref,
    'state',v_binding.lifecycle,
    'revision',v_binding.revision,
    'revokedAt',CASE WHEN v_binding.revoked_at IS NULL THEN NULL ELSE to_char(v_binding.revoked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'createdAt',to_char(v_binding.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'reason',coalesce(v_binding.reason,'Binding transition recorded'));
END
$routine$;
--> statement-breakpoint

-- One grant Action: the grant row is ACTIVE when the routine returns, and the journal records it.
CREATE FUNCTION "commerce_customer_context"."grant_access"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_principal_id uuid,
  p_permission_code text,
  p_storefront_resource_id text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid,
  p_reason text,
  p_bootstrap boolean
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
#variable_conflict use_column
DECLARE
  v_profile_id uuid;
  v_grant_id uuid;
  v_outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT profile.counterparty_purchasing_profile_id INTO v_profile_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'counterparty profile is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;

  IF p_bootstrap AND EXISTS (
    SELECT 1 FROM commerce_customer_context.counterparty_commerce_access_grants AS administrator
    WHERE administrator.tenant_id = p_tenant_id
      AND administrator.legal_entity_id = p_legal_entity_id
      AND administrator.counterparty_purchasing_profile_id = v_profile_id
      AND administrator.permission_code = 'counterparty.access.manage'
      AND administrator.lifecycle = 'ACTIVE'
      AND administrator.principal_id <> p_principal_id
  ) THEN
    SELECT administrator.counterparty_commerce_access_grant_id INTO v_grant_id
    FROM commerce_customer_context.counterparty_commerce_access_grants AS administrator
    WHERE administrator.tenant_id = p_tenant_id
      AND administrator.legal_entity_id = p_legal_entity_id
      AND administrator.counterparty_purchasing_profile_id = v_profile_id
      AND administrator.permission_code = 'counterparty.access.manage'
      AND administrator.lifecycle = 'ACTIVE'
    ORDER BY administrator.recorded_at LIMIT 1;
    RETURN QUERY SELECT projection.*
    FROM commerce_customer_context.access_grant_row(
      p_tenant_id, p_legal_entity_id, v_grant_id, 'CONFLICT'
    ) AS projection;
    RETURN;
  END IF;

  SELECT grant_row.counterparty_commerce_access_grant_id INTO v_grant_id
  FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
  WHERE grant_row.tenant_id = p_tenant_id
    AND grant_row.legal_entity_id = p_legal_entity_id
    AND grant_row.counterparty_purchasing_profile_id = v_profile_id
    AND grant_row.principal_id = p_principal_id
    AND grant_row.permission_code = p_permission_code
    AND grant_row.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id
    AND grant_row.lifecycle = 'ACTIVE'
  FOR UPDATE;

  IF v_grant_id IS NOT NULL THEN
    v_outcome := 'ALREADY_ACTIVE';
  ELSE
    INSERT INTO commerce_customer_context.counterparty_commerce_access_grants (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, principal_id,
      permission_code, storefront_resource_id, lifecycle, revision, actor_principal_id,
      action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_principal_id,
      p_permission_code, p_storefront_resource_id, 'ACTIVE', 1,
      p_actor_principal_id, p_action_invocation_id, p_reason
    ) RETURNING counterparty_commerce_access_grant_id INTO v_grant_id;
    INSERT INTO commerce_customer_context.access_mutation_journal (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
      mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
      action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_principal_id,
      CASE WHEN p_bootstrap THEN 'BOOTSTRAP_ADMIN' ELSE 'GRANT' END,
      v_grant_id, 1,
      jsonb_build_object('state', 'ACTIVE', 'permissionCode', p_permission_code,
        'storefrontScoped', p_storefront_resource_id IS NOT NULL),
      p_actor_principal_id, p_action_invocation_id, p_reason
    ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING;
    v_outcome := 'APPLIED';
  END IF;
  RETURN QUERY SELECT projection.*
  FROM commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, v_grant_id, v_outcome
  ) AS projection;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."grant_access"(uuid, uuid, text, uuid, text, text, uuid, uuid, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."grant_access"(uuid, uuid, text, uuid, text, text, uuid, uuid, text, boolean) TO "ontos_runtime";
--> statement-breakpoint

-- One revoke Action: the grant row is REVOKED when the routine returns, and the journal records
-- who revoked it.
CREATE FUNCTION "commerce_customer_context"."revoke_access"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_counterparty_resource_id text,
  p_grant_id uuid, p_principal_id uuid, p_permission_code text,
  p_storefront_resource_id text, p_actor_principal_id uuid,
  p_action_invocation_id uuid, p_reason text
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
#variable_conflict use_column
DECLARE
  v_profile_id uuid;
  v_grant_id uuid;
  v_state text;
  v_outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT profile.counterparty_purchasing_profile_id INTO v_profile_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'counterparty profile is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;

  IF p_grant_id IS NOT NULL THEN
    SELECT grant_row.counterparty_commerce_access_grant_id, grant_row.lifecycle
      INTO v_grant_id, v_state
    FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
    WHERE grant_row.tenant_id = p_tenant_id AND grant_row.legal_entity_id = p_legal_entity_id
      AND grant_row.counterparty_commerce_access_grant_id = p_grant_id
      AND grant_row.counterparty_purchasing_profile_id = v_profile_id
    FOR UPDATE;
  ELSE
    SELECT grant_row.counterparty_commerce_access_grant_id, grant_row.lifecycle
      INTO v_grant_id, v_state
    FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
    WHERE grant_row.tenant_id = p_tenant_id AND grant_row.legal_entity_id = p_legal_entity_id
      AND grant_row.counterparty_purchasing_profile_id = v_profile_id
      AND grant_row.principal_id = p_principal_id
      AND grant_row.permission_code = p_permission_code
      AND grant_row.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id
    ORDER BY (grant_row.lifecycle = 'REVOKED'), grant_row.recorded_at DESC
    LIMIT 1 FOR UPDATE;
  END IF;
  IF v_grant_id IS NULL THEN
    RAISE EXCEPTION 'access grant is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.counterparty_commerce_access_grants AS exact_grant
    WHERE exact_grant.tenant_id = p_tenant_id
      AND exact_grant.legal_entity_id = p_legal_entity_id
      AND exact_grant.counterparty_commerce_access_grant_id = v_grant_id
      AND exact_grant.counterparty_purchasing_profile_id = v_profile_id
      AND exact_grant.principal_id = p_principal_id
      AND exact_grant.permission_code = p_permission_code
      AND exact_grant.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id
  ) THEN
    v_outcome := 'SCOPE_MISMATCH';
  ELSIF v_state = 'REVOKED' THEN
    v_outcome := 'ALREADY_REVOKED';
  ELSIF p_permission_code = 'counterparty.access.manage' AND NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.counterparty_commerce_access_grants AS other_admin
    WHERE other_admin.tenant_id = p_tenant_id
      AND other_admin.legal_entity_id = p_legal_entity_id
      AND other_admin.counterparty_purchasing_profile_id = v_profile_id
      AND other_admin.counterparty_commerce_access_grant_id <> v_grant_id
      AND other_admin.permission_code = 'counterparty.access.manage'
      AND other_admin.lifecycle = 'ACTIVE'
  ) THEN
    v_outcome := 'LAST_ADMIN_PROTECTED';
  ELSE
    UPDATE commerce_customer_context.counterparty_commerce_access_grants
      SET lifecycle = 'REVOKED', revision = revision + 1, revoked_at = statement_timestamp()
    WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
      AND counterparty_commerce_access_grant_id = v_grant_id;
    INSERT INTO commerce_customer_context.access_mutation_journal (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
      mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
      action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_principal_id, 'REVOKE', v_grant_id, 1,
      jsonb_build_object('state', 'REVOKED', 'permissionCode', p_permission_code,
        'storefrontScoped', p_storefront_resource_id IS NOT NULL),
      p_actor_principal_id, p_action_invocation_id, p_reason
    ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING;
    v_outcome := 'REVOKED';
  END IF;
  RETURN QUERY SELECT projection.*
  FROM commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, v_grant_id, v_outcome
  ) AS projection;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."revoke_access"(uuid, uuid, text, uuid, uuid, text, text, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."revoke_access"(uuid, uuid, text, uuid, uuid, text, text, uuid, uuid, text) TO "ontos_runtime";
--> statement-breakpoint

-- Every intended Permission of a claim is either ACTIVE for the claimant or not granted yet.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."invitation_grant_progress"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
  SELECT coalesce(jsonb_agg(
    CASE WHEN grant_row.counterparty_commerce_access_grant_id IS NOT NULL THEN
      jsonb_build_object(
        'permission', permission.value,
        'state', 'ACTIVE',
        'grantRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', grant_row.counterparty_commerce_access_grant_id::text,
          'resourceType', 'commerce.customer-context.counterparty-commerce-access-grant',
          'tenantId', p_tenant_id::text
        )
      )
    ELSE jsonb_build_object('permission', permission.value, 'state', 'PENDING_GRANT') END
    ORDER BY permission.ordinality
  ), '[]'::jsonb)
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  CROSS JOIN LATERAL jsonb_array_elements_text(invitation.requested_permission_codes)
    WITH ORDINALITY AS permission(value, ordinality)
  LEFT JOIN LATERAL (
    SELECT access_grant.counterparty_commerce_access_grant_id
    FROM commerce_customer_context.counterparty_commerce_access_grants AS access_grant
    WHERE access_grant.tenant_id = invitation.tenant_id
      AND access_grant.legal_entity_id = invitation.legal_entity_id
      AND access_grant.counterparty_purchasing_profile_id = invitation.counterparty_purchasing_profile_id
      AND access_grant.principal_id = coalesce(
        invitation.claimed_by_principal_id,
        (SELECT journal.subject_principal_id
         FROM commerce_customer_context.access_mutation_journal AS journal
         WHERE journal.tenant_id = invitation.tenant_id
           AND journal.legal_entity_id = invitation.legal_entity_id
           AND journal.resource_id = invitation.counterparty_access_invitation_id
           AND journal.mutation_kind = 'CLAIM_INVITE'
         ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC LIMIT 1)
      )
      AND access_grant.permission_code = permission.value
      AND access_grant.storefront_resource_id IS NOT DISTINCT FROM invitation.storefront_resource_id
      AND access_grant.lifecycle = 'ACTIVE'
    ORDER BY access_grant.recorded_at DESC LIMIT 1
  ) AS grant_row ON true
  WHERE invitation.tenant_id = p_tenant_id
    AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id;
$function$;
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
  -- BEGIN_CLAIM was racing the clock.
  IF NEW.lifecycle IN ('PENDING', 'EXPIRED') THEN
    NEW.claimed_by_principal_id := NULL;
    NEW.claimed_at := NULL;
    NEW.claim_proof_reference := NULL;
    NEW.claim_origin_principal_id := NULL;
    NEW.claim_origin_action_invocation_id := NULL;
    NEW.claim_origin_proof_reference := NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.lifecycle = 'CLAIMING' AND NEW.lifecycle IN ('PENDING', 'EXPIRED') THEN
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
DROP FUNCTION "commerce_customer_context"."mutate_access_invitation"(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, text, uuid, text);
--> statement-breakpoint
-- CLAIMING is the claim Action's own in-transaction lock: BEGIN_CLAIM records the claimant and
-- proof, the Action verifies and consumes the proof and grants every intended Permission, and
-- FINISH_CLAIM closes the invitation as CLAIMED, or REJECT_CLAIM/EXPIRE_CLAIM durably resets it.
CREATE FUNCTION "commerce_customer_context"."mutate_access_invitation"(
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
  storefront_resource_id text, mutation_id uuid
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
  v_outcome text;
  v_origin_principal_id uuid;
  v_origin_proof_reference text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_operation NOT IN ('RESEND', 'REVOKE', 'BEGIN_CLAIM', 'REJECT_CLAIM', 'EXPIRE_CLAIM', 'FINISH_CLAIM') THEN
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
      ELSE
        v_origin_principal_id := coalesce(
          v_invitation.claimed_by_principal_id,
          v_invitation.claim_origin_principal_id
        );
        v_origin_proof_reference := coalesce(
          v_invitation.claim_proof_reference,
          v_invitation.claim_origin_proof_reference
        );
        IF v_invitation.lifecycle <> 'CLAIMING'
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
      -- A claim runs in one owner transaction, so a revoke only ever meets an unclaimed invitation:
      -- there is no half-applied claim left to compensate.
      v_mutation_kind := 'REVOKE_INVITE';
      IF v_invitation.lifecycle = 'REVOKED' OR EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
      ) THEN
        v_outcome := 'ALREADY_REVOKED';
      ELSIF v_invitation.lifecycle <> 'PENDING' THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN
        v_outcome := 'REVISION_CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'REVOKED', revoked_at = statement_timestamp(),
              revision = counterparty_access_invitations.revision + 1
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
      ELSIF EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
          AND journal.subject_principal_id = p_claimant_principal_id
      ) AND v_invitation.lifecycle = 'CLAIMING' THEN
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
      ELSIF v_invitation.lifecycle <> 'CLAIMING'
        OR p_claimant_principal_id IS NULL OR p_claim_proof_reference IS NULL THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN
        v_outcome := 'REVISION_CONFLICT';
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

    IF v_mutation_kind IS NOT NULL AND v_outcome IN ('RESENT', 'REVOKED', 'CLAIMING') THEN
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
    invitation.storefront_resource_id, v_mutation_id
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
