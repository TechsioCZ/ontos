ALTER TABLE "core"."access_mandates" ADD COLUMN "action_authority_json" jsonb;--> statement-breakpoint
ALTER TABLE "core"."access_proposals" ADD COLUMN "requester_action_authority_json" jsonb;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ALTER COLUMN "approver_assignment_incarnation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ALTER COLUMN "execution_assignment_incarnation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ADD CONSTRAINT "access_mandates_authority_format_ck" CHECK (("action_authority_json" is null and "approver_assignment_incarnation_id" is not null and "execution_assignment_incarnation_id" is not null)
          or ("action_authority_json" is not null and "approver_assignment_incarnation_id" is null and "execution_assignment_incarnation_id" is null
            and "action_authority_json"->>'format' is not distinct from 'core.action-authority/2'
            and "action_authority_json"->>'phase' is not distinct from 'approver'
            and "action_authority_json"->>'principalId' is not distinct from "approver_id"::text
            and "action_authority_json"->>'scopeId' is not distinct from "scope_id"::text
            and "action_authority_json"->>'commandDigest' is not distinct from "command_digest"));--> statement-breakpoint
ALTER TABLE "core"."access_proposals" DROP CONSTRAINT "access_proposals_requester_ck", ADD CONSTRAINT "access_proposals_requester_ck" CHECK (jsonb_typeof("requester_json") = 'object' and "requester_json"->>'principalId' is not distinct from "requester_principal_id"::text and jsonb_typeof("requester_authority_json") = 'array' and (
          ("requester_action_authority_json" is null and jsonb_array_length("requester_authority_json") > 0)
          or ("requester_action_authority_json" is not null and jsonb_array_length("requester_authority_json") = 0 and "target" is null
            and "requester_action_authority_json"->>'format' is not distinct from 'core.action-authority/2'
            and "requester_action_authority_json"->>'phase' is not distinct from 'requester'
            and "requester_action_authority_json"->>'principalId' is not distinct from "requester_principal_id"::text
            and "requester_action_authority_json"->>'scopeId' is not distinct from "scope_id"::text
            and "requester_action_authority_json"->>'commandDigest' is not distinct from "command_digest")));
--> statement-breakpoint
-- Forward storage only. Do not backfill or reinterpret historical scalar commands or RUN witnesses.
-- Before source activation, pending scalar requests and approved-unexecuted scalar mandates must
-- terminally drain under the prior release. Historical records remain readable and immutable.
CREATE TRIGGER core_access_proposals_action_authority_immutable
BEFORE UPDATE ON core.access_proposals
FOR EACH ROW
WHEN (NEW.requester_action_authority_json IS DISTINCT FROM OLD.requester_action_authority_json)
EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
-- The original trigger functions retain their original scalar proof semantics. Only explicit
-- forward records use the new constraints; an old record can never acquire a forward proof.
DROP TRIGGER core_access_mandates_authority ON core.access_mandates;
--> statement-breakpoint
CREATE TRIGGER core_access_mandates_authority
BEFORE INSERT ON core.access_mandates
FOR EACH ROW WHEN (NEW.action_authority_json IS NULL)
EXECUTE FUNCTION core.check_access_mandate();
--> statement-breakpoint
DROP TRIGGER core_access_proposals_approval ON core.access_proposals;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER core_access_proposals_approval
AFTER INSERT OR UPDATE ON core.access_proposals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.requester_action_authority_json IS NULL)
EXECUTE FUNCTION core.require_access_proposal_approval();
--> statement-breakpoint
DROP TRIGGER core_access_mandates_proposal ON core.access_mandates;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER core_access_mandates_proposal
AFTER INSERT OR UPDATE ON core.access_mandates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.action_authority_json IS NULL)
EXECUTE FUNCTION core.require_access_proposal_approval();
--> statement-breakpoint
CREATE FUNCTION core.check_access_action_authority_v2() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  p record;
  m record;
  f record;
  c jsonb;
  proof jsonb;
  q jsonb;
  w jsonb;
  parent_key text;
  primary_key text;
  expected_mode text;
  expected_purpose text;
  phase text;
  person uuid;
  authority_at timestamptz;
  authority_until timestamptz;
  target_count integer;
  expected_count integer;
  actual_count integer;
  unique_count integer;
  matching_count integer;
BEGIN
  SELECT * INTO p FROM core.access_proposals
    WHERE tenant_id = NEW.tenant_id AND proposal_id = NEW.proposal_id;
  IF NOT FOUND OR p.requester_action_authority_json IS NULL THEN
    RAISE EXCEPTION 'Forward authority belongs to a forward proposal' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO m FROM core.access_mandates
    WHERE tenant_id = p.tenant_id AND proposal_id = p.proposal_id;
  IF (p.status IN ('approved', 'executed') AND m.mandate_id IS NULL)
     OR (p.status IN ('pending', 'rejected') AND m.mandate_id IS NOT NULL)
     OR (m.mandate_id IS NOT NULL AND m.action_authority_json IS NULL) THEN
    RAISE EXCEPTION 'A forward proposal and its approval keep one explicit proof format' USING ERRCODE = '23514';
  END IF;
  IF m.mandate_id IS NOT NULL AND
     (m.approved_at < p.created_at OR m.approved_at >= p.expires_at
      OR m.approval_expires_at > p.expires_at
      OR (p.status = 'executed' AND
          (p.executed_at < m.approved_at OR p.executed_at >= m.approval_expires_at))) THEN
    RAISE EXCEPTION 'Forward approval and execution retain their bounded lifetimes' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO f FROM core.access_frozen_commands
    WHERE tenant_id = p.tenant_id AND proposal_id = p.proposal_id AND scope_id = p.scope_id
      AND command_digest = p.command_digest AND capability_key = p.capability_key;
  c := f.command_json->'payload';
  IF f.proposal_id IS NULL OR c->>'format' IS DISTINCT FROM 'core.action/2'
     OR f.command_json ? 'target' OR c->>'actionKey' IS DISTINCT FROM f.action_key
     OR c->'declaration'->>'key' IS DISTINCT FROM p.capability_key
     OR c->'scope'->>'tenantId' IS DISTINCT FROM p.tenant_id::text
     OR jsonb_typeof(c->'targets') IS DISTINCT FROM 'array'
     OR jsonb_typeof(c->'fieldGroups') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Forward authority binds the exact durable complete Action command' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.access_scopes s WHERE s.tenant_id = p.tenant_id AND s.scope_id = p.scope_id
      AND CASE WHEN c->>'legalEntityScope' = 'required' AND c->'declaration'->>'kind' <> 'admin'
        THEN s.legal_entity_id::text = c->'scope'->>'legalEntityId'
        ELSE s.legal_entity_id IS NULL END
  ) OR EXISTS (SELECT 1 FROM jsonb_array_elements(c->'targets') t
      WHERE t->>'moduleKey' IS DISTINCT FROM c->>'owningModuleKey')
    OR (jsonb_array_length(c->'targets') > 0 AND
        (c->'governingRead'->'declaration'->>'kind' IS DISTINCT FROM 'read'
         OR jsonb_typeof(c->'governingRead'->'fieldGroups') IS DISTINCT FROM 'array')) THEN
    RAISE EXCEPTION 'The command retains its exact tenant/company, owned targets and independent Read' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'access_proposals' THEN
    proof := p.requester_action_authority_json;
    phase := 'requester';
    person := p.requester_principal_id;
    authority_at := p.created_at;
    authority_until := p.expires_at;
  ELSE
    proof := m.action_authority_json;
    phase := 'approver';
    person := m.approver_id;
    authority_at := m.approved_at;
    authority_until := m.approval_expires_at;
  END IF;
  IF proof->>'format' IS DISTINCT FROM 'core.action-authority/2'
     OR proof->>'phase' IS DISTINCT FROM phase
     OR proof->>'principalId' IS DISTINCT FROM person::text
     OR proof->>'scopeId' IS DISTINCT FROM p.scope_id::text
     OR proof->>'commandDigest' IS DISTINCT FROM p.command_digest
     OR proof->>'targetSetHash' IS DISTINCT FROM c->>'targetSetHash'
     OR jsonb_typeof(proof->'questions') IS DISTINCT FROM 'array'
     OR (proof ? 'admissionDeadline' AND
         (jsonb_typeof(proof->'admissionDeadline') IS DISTINCT FROM 'number'
          OR extract(epoch FROM authority_until) * 1000 > (proof->>'admissionDeadline')::numeric)) THEN
    RAISE EXCEPTION 'Forward proof metadata and deadline must match its immutable command' USING ERRCODE = '23514';
  END IF;
  target_count := greatest(1, jsonb_array_length(c->'targets'));
  expected_count := target_count * (1 + jsonb_array_length(c->'fieldGroups'));
  IF phase = 'approver' AND c ? 'governingRead' THEN
    expected_count := expected_count + target_count * (1 + jsonb_array_length(c->'governingRead'->'fieldGroups'));
  END IF;
  SELECT count(*), count(DISTINCT value->>'questionHash'),
         count(DISTINCT jsonb_build_array(value->>'purpose', value->>'capabilityKey', value->'target'))
    INTO actual_count, unique_count, matching_count FROM jsonb_array_elements(proof->'questions');
  IF actual_count <> expected_count OR unique_count <> actual_count OR matching_count <> actual_count THEN
    RAISE EXCEPTION 'Every exact target and field question occurs once' USING ERRCODE = '23514';
  END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(proof->'questions') LOOP
    primary_key := q->>'capabilityKey';
    parent_key := NULL;
    expected_mode := CASE phase WHEN 'requester' THEN 'propose' ELSE 'approve' END;
    expected_purpose := CASE phase WHEN 'requester' THEN 'request_write' ELSE 'approve_write' END;
    IF primary_key = c->'declaration'->>'key' THEN
      NULL;
    ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(c->'fieldGroups') g WHERE g->>'key' = primary_key) THEN
      parent_key := c->'declaration'->>'key';
    ELSIF phase = 'approver' AND primary_key = c->'governingRead'->'declaration'->>'key' THEN
      expected_mode := 'run';
      expected_purpose := 'governing_read';
    ELSIF phase = 'approver' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(c->'governingRead'->'fieldGroups') g WHERE g->>'key' = primary_key
    ) THEN
      parent_key := c->'governingRead'->'declaration'->>'key';
      expected_mode := 'run';
      expected_purpose := 'governing_read';
    ELSE
      RAISE EXCEPTION 'A question names its actual Action, field or governing Read' USING ERRCODE = '23514';
    END IF;
    IF q->>'mode' IS DISTINCT FROM expected_mode OR q->>'purpose' IS DISTINCT FROM expected_purpose
       OR (q->>'questionHash') IS NULL OR (q->>'questionHash') !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(q->'witnesses') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'A question retains its own purpose and effective mode' USING ERRCODE = '23514';
    END IF;
    IF jsonb_array_length(c->'targets') = 0 THEN
      IF q ? 'target' THEN
        RAISE EXCEPTION 'A scope command cannot acquire a record question' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c->'targets') t WHERE t = q->'target') THEN
      RAISE EXCEPTION 'Every record question belongs to the exact complete target set' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), count(DISTINCT value) INTO actual_count, unique_count
      FROM jsonb_array_elements(q->'witnesses');
    IF actual_count = 0 OR actual_count <> unique_count
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q->'witnesses') v WHERE v->>'capabilityKey' = primary_key)
       OR (parent_key IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(q->'witnesses') v WHERE v->>'capabilityKey' = parent_key)) THEN
      RAISE EXCEPTION 'Every question retains its own primary and applicable parent witnesses' USING ERRCODE = '23514';
    END IF;
    FOR w IN SELECT value FROM jsonb_array_elements(q->'witnesses') LOOP
      IF w->>'capabilityKey' IS DISTINCT FROM primary_key
         AND (parent_key IS NULL OR w->>'capabilityKey' IS DISTINCT FROM parent_key) THEN
        RAISE EXCEPTION 'A witness cannot authorize an unrelated question' USING ERRCODE = '23514';
      END IF;
      -- Structural incarnation constraints, not an authorization engine. Core still executes its
      -- canonical planner over current joined intent and exact prepared remote evidence.
      IF TG_OP = 'INSERT' AND NOT EXISTS (
        SELECT 1 FROM core.access_assignments a JOIN core.access_grant_incarnations g
          ON g.tenant_id = a.tenant_id AND g.scope_id = a.scope_id AND g.role_id = a.role_id
        WHERE a.tenant_id = p.tenant_id AND a.scope_id = p.scope_id
          AND a.incarnation_id::text = w->>'assignmentIncarnationId'
          AND g.grant_incarnation_id::text = w->>'grantIncarnationId'
          AND a.principal_id = person AND a.agent_id IS NULL
          AND a.status = 'active' AND g.status = 'active'
          AND a.valid_from <= authority_at AND (a.valid_until IS NULL OR authority_at < a.valid_until)
          AND g.capability_key = w->>'capabilityKey' AND g.mode = expected_mode
      ) THEN
        RAISE EXCEPTION 'A forward witness names its own live assignment and exact grant cell' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.check_access_action_authority_v2() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER core_access_proposals_action_authority_v2
AFTER INSERT OR UPDATE ON core.access_proposals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.requester_action_authority_json IS NOT NULL)
EXECUTE FUNCTION core.check_access_action_authority_v2();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER core_access_mandates_action_authority_v2
AFTER INSERT ON core.access_mandates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.action_authority_json IS NOT NULL)
EXECUTE FUNCTION core.check_access_action_authority_v2();
--> statement-breakpoint
CREATE FUNCTION core.check_access_approval_format_v2() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  forward_proposal boolean;
  forward_approval boolean;
BEGIN
  IF TG_TABLE_NAME = 'access_mandates' THEN
    SELECT requester_action_authority_json IS NOT NULL INTO forward_proposal
      FROM core.access_proposals WHERE tenant_id = NEW.tenant_id AND proposal_id = NEW.proposal_id;
    IF forward_proposal IS DISTINCT FROM (NEW.action_authority_json IS NOT NULL) THEN
      RAISE EXCEPTION 'A proposal never changes its historical or forward authority format' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT action_authority_json IS NOT NULL INTO forward_approval FROM core.access_mandates
      WHERE tenant_id = NEW.tenant_id AND mandate_id = NEW.mandate_id;
    IF forward_approval THEN
      RAISE EXCEPTION 'A forward approval never acquires historical scalar witnesses' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.check_access_approval_format_v2() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER core_access_mandates_format_v2
BEFORE INSERT ON core.access_mandates
FOR EACH ROW EXECUTE FUNCTION core.check_access_approval_format_v2();
--> statement-breakpoint
CREATE TRIGGER core_access_mandate_grants_format_v2
BEFORE INSERT ON core.access_mandate_grants
FOR EACH ROW EXECUTE FUNCTION core.check_access_approval_format_v2();
