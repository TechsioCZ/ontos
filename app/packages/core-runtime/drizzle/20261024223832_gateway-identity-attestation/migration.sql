-- Exposes only an agent binding's successful issuing-company attestation. The dedicated
-- Party request role still cannot read Core identity audit evidence or its JSON payload.
CREATE FUNCTION trust.auth_binding_issuing_legal_entity(p_binding_id uuid, p_principal_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
PARALLEL RESTRICTED
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN pg_catalog.count(*) = pg_catalog.count(evidence.legal_entity_id)
      AND pg_catalog.count(DISTINCT evidence.legal_entity_id) = 1
      AND pg_catalog.min(evidence.legal_entity_id::text)::uuid = trust.current_legal_entity_id()
    THEN pg_catalog.min(evidence.legal_entity_id::text)::uuid
    ELSE NULL
  END
  FROM core.principal_auth_bindings AS binding
  JOIN core.principals AS principal
    ON principal.tenant_id = binding.tenant_id
   AND principal.principal_id = binding.principal_id
  JOIN core.audit_events AS evidence
    ON evidence.tenant_id = binding.tenant_id
   AND evidence.action_invocation_id = binding.created_by_invocation_id
  JOIN core.action_invocations AS invocation
    ON invocation.tenant_id = evidence.tenant_id
   AND invocation.action_invocation_id = evidence.action_invocation_id
  WHERE binding.principal_auth_binding_id = p_binding_id
    AND binding.principal_id = p_principal_id
    AND binding.tenant_id = trust.current_tenant_id()
    AND binding.subject_type = 'api_key'
    AND principal.kind = 'agent'
    AND evidence.event_type = 'action.executed'
    AND evidence.outcome = 'succeeded'
    AND evidence.evidence_json->>'actionKey' = 'core.identity.bind-managed-api-key'
    AND invocation.action_key = 'core.identity.bind-managed-api-key'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trust.auth_binding_issuing_legal_entity(uuid, uuid) FROM PUBLIC;
