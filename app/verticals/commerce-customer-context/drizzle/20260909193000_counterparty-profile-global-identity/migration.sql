-- Counterparty Purchasing Profiles are one tenant-global profile per Party-owned Counterparty.
-- The profile's first selling Legal Entity remains the storage anchor for lifecycle history, while
-- seller-owned access/settings rows retain their own (tenant, legal_entity) scope. This migration
-- only changes keys/FKs and routine predicates; it never rewrites or deletes existing profiles.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM commerce_customer_context.counterparty_purchasing_profiles
     GROUP BY tenant_id, counterparty_resource_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot establish tenant-global Counterparty profile identity: duplicate Counterparty references require explicit reconciliation';
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE commerce_customer_context.customer_profiles
  ADD CONSTRAINT ccc_profiles_tenant_id_uk UNIQUE (tenant_id, customer_profile_id);
--> statement-breakpoint
ALTER TABLE commerce_customer_context.counterparty_purchasing_profiles
  ADD CONSTRAINT ccc_counterparty_profiles_tenant_id_uk
  UNIQUE (tenant_id, counterparty_purchasing_profile_id);
--> statement-breakpoint

ALTER TABLE commerce_customer_context.access_mutation_journal
  DROP CONSTRAINT IF EXISTS ccc_access_journal_profile_fk;
ALTER TABLE commerce_customer_context.counterparty_access_invitations
  DROP CONSTRAINT IF EXISTS ccc_access_invitations_profile_fk;
ALTER TABLE commerce_customer_context.counterparty_commerce_access_grants
  DROP CONSTRAINT IF EXISTS ccc_access_grants_profile_fk;
ALTER TABLE commerce_customer_context.counterparty_purchase_limit_defaults
  DROP CONSTRAINT IF EXISTS ccc_limit_defaults_profile_fk;
ALTER TABLE commerce_customer_context.principal_purchase_limit_overrides
  DROP CONSTRAINT IF EXISTS ccc_limit_overrides_profile_fk;
ALTER TABLE commerce_customer_context.counterparty_purchasing_profiles
  DROP CONSTRAINT IF EXISTS ccc_counterparty_profiles_parent_fk;
--> statement-breakpoint

ALTER TABLE commerce_customer_context.access_mutation_journal
  ADD CONSTRAINT ccc_access_journal_profile_fk FOREIGN KEY
  (tenant_id, counterparty_purchasing_profile_id)
  REFERENCES commerce_customer_context.counterparty_purchasing_profiles
  (tenant_id, counterparty_purchasing_profile_id) ON DELETE RESTRICT;
ALTER TABLE commerce_customer_context.counterparty_access_invitations
  ADD CONSTRAINT ccc_access_invitations_profile_fk FOREIGN KEY
  (tenant_id, counterparty_purchasing_profile_id)
  REFERENCES commerce_customer_context.counterparty_purchasing_profiles
  (tenant_id, counterparty_purchasing_profile_id) ON DELETE RESTRICT;
ALTER TABLE commerce_customer_context.counterparty_commerce_access_grants
  ADD CONSTRAINT ccc_access_grants_profile_fk FOREIGN KEY
  (tenant_id, counterparty_purchasing_profile_id)
  REFERENCES commerce_customer_context.counterparty_purchasing_profiles
  (tenant_id, counterparty_purchasing_profile_id) ON DELETE RESTRICT;
ALTER TABLE commerce_customer_context.counterparty_purchase_limit_defaults
  ADD CONSTRAINT ccc_limit_defaults_profile_fk FOREIGN KEY
  (tenant_id, counterparty_purchasing_profile_id)
  REFERENCES commerce_customer_context.counterparty_purchasing_profiles
  (tenant_id, counterparty_purchasing_profile_id) ON DELETE RESTRICT;
ALTER TABLE commerce_customer_context.principal_purchase_limit_overrides
  ADD CONSTRAINT ccc_limit_overrides_profile_fk FOREIGN KEY
  (tenant_id, counterparty_purchasing_profile_id)
  REFERENCES commerce_customer_context.counterparty_purchasing_profiles
  (tenant_id, counterparty_purchasing_profile_id) ON DELETE RESTRICT;
ALTER TABLE commerce_customer_context.counterparty_purchasing_profiles
  ADD CONSTRAINT ccc_counterparty_profiles_parent_fk FOREIGN KEY
  (tenant_id, counterparty_purchasing_profile_id)
  REFERENCES commerce_customer_context.customer_profiles
  (tenant_id, customer_profile_id) ON DELETE RESTRICT;
--> statement-breakpoint

-- The runtime has no direct table privileges. These owner-routine policies let SECURITY DEFINER
-- profile read/ensure/lifecycle routines lock and reuse a tenant-global row while all seller-owned
-- dependent rows remain protected by their existing Legal Entity policies and public gates.
CREATE POLICY ccc_counterparty_profiles_global_owner_routine
  ON commerce_customer_context.counterparty_purchasing_profiles
  AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
CREATE POLICY ccc_profiles_global_owner_routine
  ON commerce_customer_context.customer_profiles
  AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_profile(
  p_tenant_id uuid, p_legal_entity_id uuid, p_profile_id uuid, p_profile_kind text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
  v_subject jsonb;
  v_case_id uuid;
  v_case_target_subject jsonb;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY') THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;

  -- Retail remains seller-bound. Counterparty profile identity is tenant-global; seller scope is
  -- enforced by the governed permission target and by seller-owned dependent tables.
  SELECT * INTO v_profile
    FROM customer_profiles
   WHERE tenant_id = p_tenant_id
     AND customer_profile_id = p_profile_id
     AND profile_kind = p_profile_kind;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;

  SELECT c.profile_reconciliation_case_id, c.target_subject
    INTO v_case_id, v_case_target_subject
    FROM profile_reconciliation_case_members m
    JOIN profile_reconciliation_cases c
      USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
   WHERE m.tenant_id = p_tenant_id
     AND m.legal_entity_id = p_legal_entity_id
     AND m.customer_profile_id = p_profile_id
     AND c.lifecycle <> 'COMPLETED'
   ORDER BY c.recorded_at
   LIMIT 1;

  IF p_profile_kind = 'RETAIL' THEN
    SELECT jsonb_build_object(
      'kind', 'RETAIL',
      'partyResourceId', party_resource_id,
      'partyResourceRevision', party_resource_revision,
      'attributionKind', attribution_kind
    ) INTO v_subject
      FROM retail_customer_profiles
     WHERE tenant_id = p_tenant_id
       AND legal_entity_id = p_legal_entity_id
       AND retail_customer_profile_id = p_profile_id;
  ELSE
    SELECT jsonb_build_object(
      'kind', 'COUNTERPARTY',
      'counterpartyResourceId', counterparty_resource_id,
      'counterpartyResourceRevision', counterparty_resource_revision,
      'customerRoleResourceId', customer_role_resource_id,
      'customerRoleResourceRevision', customer_role_resource_revision
    ) INTO v_subject
      FROM counterparty_purchasing_profiles
     WHERE tenant_id = p_tenant_id
       AND counterparty_purchasing_profile_id = p_profile_id;
  END IF;
  IF v_subject IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;

  IF v_case_id IS NOT NULL THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', jsonb_build_object(
      'profileId', p_profile_id,
      'profileKind', p_profile_kind,
      'scopeLegalEntityId', p_legal_entity_id,
      'caseId', v_case_id,
      'state', v_profile.lifecycle,
      'revision', v_profile.revision,
      'createdAt', to_char(v_profile.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(v_profile.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'observedAt', to_char(v_profile.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'targetSubject', v_case_target_subject,
      'subject', v_subject
    );
    RETURN;
  END IF;

  RETURN QUERY SELECT 'PROFILE_AVAILABLE', jsonb_build_object(
    'profileId', p_profile_id,
    'profileKind', p_profile_kind,
    'scopeLegalEntityId', p_legal_entity_id,
    'state', v_profile.lifecycle,
    'revision', v_profile.revision,
    'createdAt', to_char(v_profile.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(v_profile.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'subject', v_subject
  );
END
$routine$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_customer_context.read_profile_trading_gate(
  p_tenant_id uuid, p_legal_entity_id uuid, p_profile_id uuid, p_profile_kind text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
BEGIN
  -- Lifecycle/reconciliation is authoritative here; current Party-owned Counterparty Role and
  -- purchase permission are checked by CCC's public gate adapter under the same seller scope.
  RETURN QUERY SELECT * FROM read_customer_profile(
    p_tenant_id, p_legal_entity_id, p_profile_id, p_profile_kind
  );
END
$routine$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_customer_context.ensure_counterparty_profile(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_counterparty_resource_revision text,
  p_customer_role_resource_id text,
  p_customer_role_resource_revision text,
  p_effective_at timestamptz,
  p_trigger text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_effective_at IS NULL
     OR nullif(btrim(p_counterparty_resource_id), '') IS NULL
     OR nullif(btrim(p_customer_role_resource_id), '') IS NULL
     OR nullif(btrim(p_customer_role_resource_revision), '') IS NULL
     OR p_trigger IS NULL
     OR p_trigger NOT IN ('AUTHORIZED_ONBOARDING', 'ENSURE_BEFORE_ORDER_ACCEPTANCE', 'GUEST_RETAIL_ATTRIBUTION')
  THEN
    -- Role ineligibility is an owner fact, not a persistence/key collision. The public CCC
    -- adapter normally rejects it before this routine is reached.
    RETURN QUERY SELECT 'COUNTERPARTY_ROLE_NOT_ELIGIBLE', NULL::jsonb;
    RETURN;
  END IF;

  -- The lock intentionally excludes Legal Entity: two sellers ensuring the same Counterparty
  -- serialize on one tenant-global identity and both receive the same durable profile UUID.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':counterparty:' || btrim(p_counterparty_resource_id), 0
  ));

  IF EXISTS (
    SELECT 1 FROM profile_reconciliation_cases c
     WHERE c.tenant_id = p_tenant_id
       AND c.legal_entity_id = p_legal_entity_id
       AND c.profile_kind = 'COUNTERPARTY'
       AND c.canonical_party_resource_id = btrim(p_counterparty_resource_id)
       AND c.lifecycle <> 'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
    RETURN;
  END IF;

  SELECT cp.* INTO v_profile
    FROM counterparty_purchasing_profiles pp
    JOIN customer_profiles cp
      ON cp.tenant_id = pp.tenant_id
     AND cp.customer_profile_id = pp.counterparty_purchasing_profile_id
   WHERE pp.tenant_id = p_tenant_id
     AND pp.counterparty_resource_id = btrim(p_counterparty_resource_id)
     AND cp.profile_kind = 'COUNTERPARTY'
   FOR UPDATE OF cp;

  IF FOUND THEN
    -- Refresh stored owner evidence without creating a second profile or changing lifecycle
    -- revision. Current eligibility remains authoritative at the service boundary and at gate.
    UPDATE counterparty_purchasing_profiles
       SET counterparty_resource_revision = nullif(btrim(p_counterparty_resource_revision), ''),
           customer_role_resource_id = btrim(p_customer_role_resource_id),
           customer_role_resource_revision = btrim(p_customer_role_resource_revision)
     WHERE tenant_id = p_tenant_id
       AND counterparty_purchasing_profile_id = v_profile.customer_profile_id;
    IF EXISTS (
      SELECT 1
        FROM profile_reconciliation_case_members m
        JOIN profile_reconciliation_cases c
          USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
       WHERE m.tenant_id = p_tenant_id
         AND m.legal_entity_id = p_legal_entity_id
         AND m.customer_profile_id = v_profile.customer_profile_id
         AND c.lifecycle <> 'COMPLETED'
    ) THEN
      RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
      RETURN;
    END IF;
    RETURN QUERY SELECT
      ('PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle)::text,
      jsonb_build_object(
        'outcome', 'PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle,
        'profileRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', v_profile.customer_profile_id,
          'resourceType', 'commerce.customer-context.counterparty-purchasing-profile',
          'tenantId', p_tenant_id
        ),
        'revision', v_profile.revision,
        'state', v_profile.lifecycle,
        'scopeLegalEntityId', p_legal_entity_id
      );
    RETURN;
  END IF;

  BEGIN
    INSERT INTO customer_profiles(tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
    VALUES (p_tenant_id, p_legal_entity_id, 'COUNTERPARTY', 'ACTIVE', 1)
    RETURNING * INTO v_profile;
    INSERT INTO counterparty_purchasing_profiles(
      counterparty_purchasing_profile_id, tenant_id, legal_entity_id, counterparty_resource_id,
      counterparty_resource_revision, customer_role_resource_id, customer_role_resource_revision
    ) VALUES (
      v_profile.customer_profile_id, p_tenant_id, p_legal_entity_id,
      btrim(p_counterparty_resource_id), nullif(btrim(p_counterparty_resource_revision), ''),
      btrim(p_customer_role_resource_id), btrim(p_customer_role_resource_revision)
    );
  EXCEPTION WHEN unique_violation THEN
    -- A key collision is never evidence that the owner Role became ineligible. Re-read under the
    -- same advisory lock so a retry gets the canonical profile; otherwise surface a persistence
    -- conflict that the caller can treat as indeterminate/retryable.
    SELECT cp.* INTO v_profile
      FROM counterparty_purchasing_profiles pp
      JOIN customer_profiles cp
        ON cp.tenant_id = pp.tenant_id
       AND cp.customer_profile_id = pp.counterparty_purchasing_profile_id
     WHERE pp.tenant_id = p_tenant_id
       AND pp.counterparty_resource_id = btrim(p_counterparty_resource_id)
       AND cp.profile_kind = 'COUNTERPARTY';
    IF FOUND THEN
      RETURN QUERY SELECT
        ('PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle)::text,
        jsonb_build_object(
          'outcome', 'PROFILE_ALREADY_EXISTS_' || v_profile.lifecycle,
          'profileRef', jsonb_build_object(
            'moduleId', 'commerce.customer-context',
            'resourceId', v_profile.customer_profile_id,
            'resourceType', 'commerce.customer-context.counterparty-purchasing-profile',
            'tenantId', p_tenant_id
          ),
          'revision', v_profile.revision,
          'state', v_profile.lifecycle,
          'scopeLegalEntityId', p_legal_entity_id
        );
      RETURN;
    END IF;
    RETURN QUERY SELECT 'PERSISTENCE_CONFLICT', NULL::jsonb;
    RETURN;
  END;

  INSERT INTO customer_profile_lifecycle_history(
    tenant_id, legal_entity_id, customer_profile_id, revision, from_lifecycle, to_lifecycle,
    recorded_at, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile.customer_profile_id, 1, NULL, 'ACTIVE',
    p_effective_at, p_action_invocation_id, p_actor_principal_id, 'Created by ' || p_trigger
  );
  RETURN QUERY SELECT 'PROFILE_CREATED', jsonb_build_object(
    'outcome', 'PROFILE_CREATED',
    'profileRef', jsonb_build_object(
      'moduleId', 'commerce.customer-context',
      'resourceId', v_profile.customer_profile_id,
      'resourceType', 'commerce.customer-context.counterparty-purchasing-profile',
      'tenantId', p_tenant_id
    ),
    'revision', 1,
    'state', 'ACTIVE',
    'scopeLegalEntityId', p_legal_entity_id
  );
END
$routine$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_profile(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_customer_context.read_profile_trading_gate(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_customer_context.ensure_counterparty_profile(uuid, uuid, text, text, text, text, timestamptz, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_profile(uuid, uuid, uuid, text) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_profile_trading_gate(uuid, uuid, uuid, text) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION commerce_customer_context.ensure_counterparty_profile(uuid, uuid, text, text, text, text, timestamptz, text, uuid, uuid) TO ontos_runtime;
--> statement-breakpoint

-- Later seller-scoped owner routines keep their Legal Entity predicate on the dependent row;
-- the shared profile lookup itself is tenant-global.
CREATE OR REPLACE FUNCTION commerce_customer_context.lock_access_grant_authority(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_principal_id uuid
)
RETURNS TABLE (
  counterparty_resource_id text,
  grant_id uuid,
  granted_at timestamptz,
  granted_by uuid,
  operation_outcome text,
  permission_code text,
  principal_id uuid,
  reason text,
  revision integer,
  revoked_at timestamptz,
  revoked_by uuid,
  state text,
  storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT projection.*
  FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
  JOIN commerce_customer_context.counterparty_purchasing_profiles AS profile
    ON profile.tenant_id = grant_row.tenant_id
    AND profile.counterparty_purchasing_profile_id = grant_row.counterparty_purchasing_profile_id
  CROSS JOIN LATERAL commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, grant_row.counterparty_commerce_access_grant_id, NULL
  ) AS projection
  WHERE grant_row.tenant_id = p_tenant_id
    AND grant_row.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
    AND grant_row.principal_id = p_principal_id
  ORDER BY grant_row.recorded_at, grant_row.counterparty_commerce_access_grant_id
  FOR UPDATE OF grant_row;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.lock_access_grant_authority(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.lock_access_grant_authority(uuid, uuid, text, uuid) TO ontos_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_customer_context.verify_invitation_claim_authority(
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
REVOKE ALL ON FUNCTION commerce_customer_context.verify_invitation_claim_authority(uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.verify_invitation_claim_authority(uuid, uuid, uuid, text, text, text, uuid) TO ontos_runtime;
