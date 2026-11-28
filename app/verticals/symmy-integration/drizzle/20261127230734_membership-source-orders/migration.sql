-- Fail rather than queue behind live work: every lock this migration takes is held only for its own DDL.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- The history scan below runs while Symmy effect writes wait: a statement that outlasts this rolls the whole migration
-- back instead of stretching the pause.
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
CREATE TABLE "symmy_integration"."membership_source_orders" (
	"effect_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"idempotency_digest" text NOT NULL,
	"lineage_digest" text,
	"route_id" uuid NOT NULL,
	"source_order" integer,
	"tenant_id" uuid,
	"waiting_since" timestamp with time zone,
	CONSTRAINT "symmy_membership_source_orders_pk" PRIMARY KEY("tenant_id","lineage_digest","source_order"),
	CONSTRAINT "symmy_membership_source_orders_effect_uq" UNIQUE("tenant_id","effect_id"),
	CONSTRAINT "symmy_membership_source_orders_admission_ck" CHECK ("idempotency_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "symmy_membership_source_orders_lineage_ck" CHECK ("lineage_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "symmy_membership_source_orders_order_ck" CHECK ("source_order" >= 1)
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."membership_source_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."membership_source_orders" ADD CONSTRAINT "symmy_membership_source_orders_effect_fk" FOREIGN KEY ("tenant_id","effect_id") REFERENCES "symmy_integration"."job_effects"("tenant_id","effect_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "symmy_integration"."membership_source_orders" ADD CONSTRAINT "symmy_membership_source_orders_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "symmy_integration"."job_routes"("tenant_id","route_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_select" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_insert" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_update" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_delete" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- The Commerce owner keys the memberships a source manager asserts by profile, issuer and namespace, and refuses an
-- older order of that lineage whatever group it names. The ERP names a customer and states no order, so an ERP
-- membership takes its order from this ledger: an admission reserves the next order of each lineage under a lock held
-- until it commits, the job it admits binds each membership effect to its own reservation, and the worker's claim
-- delivers an effect only after every earlier order of its lineage is settled.
--
-- The ledger starts empty and imports no history. It orders only a source namespace reserved for it, which no route
-- could enroll before this migration and which only an ERP membership route may enroll after it. Every membership a
-- caller orders itself stays outside the ledger and is admitted, claimed and delivered exactly as before.
ALTER TABLE symmy_integration.membership_source_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE symmy_integration.membership_source_orders FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.symmy_membership_ledger_namespace(p_namespace text)
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
  SELECT coalesce(starts_with(p_namespace, 'erp-membership-v1:'), false)
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.symmy_membership_lineage(
  p_tenant uuid, p_legal_entity uuid, p_issuer text, p_namespace text, p_profile uuid
) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(p_tenant, p_legal_entity, p_issuer, p_namespace, p_profile)::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- Never treat an RLS-filtered subset as the whole history while the reserved namespace is proved unused.
SET LOCAL row_security = off;
--> statement-breakpoint
-- Route enrollments are rare operator writes: hold them out while the reserved namespace is proved unused and the
-- guard that keeps it reserved is installed. The ledger's foreign key above already holds a write-conflicting lock on
-- job effects, and it lasts until this migration commits: Symmy effect writes wait for the whole migration. Run it with
-- the Symmy workers drained (runbook), never beside live delivery.
LOCK TABLE symmy_integration.job_routes IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Nothing may hold the contract or its namespace before the ledger exists: abort rather than adopt unknown history.
DO $migration$ BEGIN
  IF EXISTS (
    SELECT FROM symmy_integration.job_routes r
    WHERE 'ERP_MEMBERSHIP_V1' = ANY(r.fixture_ids)
      OR EXISTS (
        SELECT FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.fixture_plan -> 'items') = 'array' THEN r.fixture_plan -> 'items' ELSE '[]'::jsonb END
        ) i
        WHERE symmy_integration.symmy_membership_ledger_namespace(i #>> '{source,sourceNamespace}')
      )
  ) OR EXISTS (
    SELECT FROM symmy_integration.job_effects e
    WHERE symmy_integration.symmy_membership_ledger_namespace(e.effect #>> '{intent,payload,manager,sourceNamespace}')
  ) THEN
    RAISE EXCEPTION 'The ERP membership contract or its reserved source namespace is already in use' USING ERRCODE = '55000';
  END IF;
END; $migration$;
--> statement-breakpoint
-- An ERP membership route enrolls that contract alone, for one company, on the customers of one group, and asserts
-- memberships as exactly one source of the reserved namespace. No other route may enroll a source of that namespace,
-- so no caller-ordered membership ever shares a lineage with the ledger.
CREATE FUNCTION symmy_integration.guard_symmy_membership_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_sources integer; v_ledger integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE symmy_integration.symmy_membership_ledger_namespace(m.namespace))
  INTO v_sources, v_ledger
  FROM (
    SELECT DISTINCT i #>> '{source,issuerId}' AS issuer, i #>> '{source,sourceNamespace}' AS namespace
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(NEW.fixture_plan -> 'items') = 'array' THEN NEW.fixture_plan -> 'items' ELSE '[]'::jsonb END
    ) i
  ) m;
  IF 'ERP_MEMBERSHIP_V1' = ANY(NEW.fixture_ids) THEN
    IF cardinality(NEW.fixture_ids) <> 1 OR NEW.route_key <> 'customerGroupCustomersBatch'
      OR NEW.legal_entity_id IS NULL OR v_sources <> 1 OR v_ledger <> 1 THEN
      RAISE EXCEPTION 'an ERP membership route enrolls that contract alone, for one company and one ledger-ordered source'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_ledger <> 0 THEN
    RAISE EXCEPTION 'only an ERP membership route enrolls a ledger-ordered membership source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.guard_symmy_membership_route() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER symmy_job_routes_membership_contract
BEFORE INSERT OR UPDATE ON symmy_integration.job_routes
FOR EACH ROW EXECUTE FUNCTION symmy_integration.guard_symmy_membership_route();
--> statement-breakpoint
CREATE FUNCTION symmy_integration.reserve_symmy_membership_order(
  p_tenant uuid, p_legal_entity uuid, p_route uuid, p_idempotency_digest text, p_issuer text, p_namespace text,
  p_profile uuid
) RETURNS TABLE(effective_at text, source_order integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_lineage text; v_effective_at timestamptz; v_order integer;
BEGIN
  -- The company is the one the admission transaction is scoped to, never another one of the tenant.
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid OR p_legal_entity IS NULL
    OR p_legal_entity IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_route IS NULL OR nullif(btrim(p_issuer), '') IS NULL OR p_profile IS NULL
    OR NOT symmy_integration.symmy_membership_ledger_namespace(p_namespace) THEN
    RAISE EXCEPTION 'invalid membership order scope' USING ERRCODE = '42501';
  END IF;
  -- Only the active ERP membership route of this company that enrolls exactly this source reserves its orders.
  PERFORM 1 FROM symmy_integration.job_routes r
  WHERE r.tenant_id = p_tenant AND r.route_id = p_route AND r.active AND r.legal_entity_id = p_legal_entity
    AND r.fixture_ids = ARRAY['ERP_MEMBERSHIP_V1']::text[]
    AND EXISTS (
      SELECT FROM jsonb_array_elements(r.fixture_plan -> 'items') i
      WHERE i #>> '{source,issuerId}' = p_issuer AND i #>> '{source,sourceNamespace}' = p_namespace
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership order route does not enroll this ledger-ordered source' USING ERRCODE = '42501';
  END IF;
  v_lineage := symmy_integration.symmy_membership_lineage(p_tenant, p_legal_entity, p_issuer, p_namespace, p_profile);
  -- Held until the admission commits: no other admission reads this lineage before its reservation commits or rolls back.
  IF p_idempotency_digest IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('symmy-membership-order:' || v_lineage, 0));
  END IF;
  -- The ledger is the lineage's only issuer, so its own last order and time are the whole floor.
  SELECT o.effective_at, o.source_order + 1 INTO v_effective_at, v_order
  FROM symmy_integration.membership_source_orders o
  WHERE o.tenant_id = p_tenant AND o.lineage_digest = v_lineage ORDER BY o.source_order DESC LIMIT 1;
  v_order := coalesce(v_order,1);
  v_effective_at := greatest(date_trunc('milliseconds', clock_timestamp()), v_effective_at);
  -- The reservation belongs to the admission's route and idempotency digest: only the job admitted under both binds it.
  -- Preflight projects the same customer identities but commits no order or intent.
  IF p_idempotency_digest IS NOT NULL THEN
  INSERT INTO symmy_integration.membership_source_orders
    (tenant_id, lineage_digest, source_order, effective_at, route_id, idempotency_digest)
  VALUES (p_tenant, v_lineage, v_order, v_effective_at, p_route, p_idempotency_digest);
  END IF;
  RETURN QUERY SELECT to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), v_order;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.record_symmy_membership_orders(p_tenant uuid, p_job uuid)
RETURNS TABLE(recorded integer, commitments jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_job symmy_integration.import_jobs%ROWTYPE; v_memberships integer; v_count integer;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  -- Only a job of the company the admission transaction is scoped to; its lineages take the job's own company.
  SELECT j.* INTO v_job FROM symmy_integration.import_jobs j
  WHERE j.tenant_id = p_tenant AND j.job_id = p_job
    AND j.legal_entity_id IS NOT DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_memberships FROM symmy_integration.job_effects e
  WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect #>> '{intent,_tag}' = 'CustomerGroupMembership'
    AND symmy_integration.symmy_membership_ledger_namespace(e.effect #>> '{intent,payload,manager,sourceNamespace}');
  -- Each ledger-ordered membership effect takes the open reservation its own admission made for its lineage, order
  -- and time.
  UPDATE symmy_integration.membership_source_orders o SET effect_id = e.effect_id
  FROM symmy_integration.job_effects e
  WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect #>> '{intent,_tag}' = 'CustomerGroupMembership'
    AND symmy_integration.symmy_membership_ledger_namespace(e.effect #>> '{intent,payload,manager,sourceNamespace}')
    AND o.tenant_id = p_tenant AND o.route_id = v_job.route_id AND o.idempotency_digest = v_job.idempotency_digest
    AND o.effect_id IS NULL
    AND o.lineage_digest = symmy_integration.symmy_membership_lineage(p_tenant, v_job.legal_entity_id,
      e.effect #>> '{intent,payload,manager,issuer}', e.effect #>> '{intent,payload,manager,sourceNamespace}',
      (e.effect #>> '{intent,payload,profile,profileRef,resourceId}')::uuid)
    AND o.source_order = (e.effect #>> '{intent,payload,source,order}')::integer
    AND o.effective_at = (e.effect #>> '{intent,payload,effectiveAt}')::timestamptz;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- A membership without its own reservation, or two of them on one reservation, admits nothing.
  IF v_count <> v_memberships THEN
    RAISE EXCEPTION 'membership order was not reserved by this admission' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_count, coalesce(jsonb_agg(trust.source_effect_commitment(e.effect#>>'{ref,operation,entrypointKey}',e.effect#>'{intent,payload}') ORDER BY e.effect_id),'[]'::jsonb)
    FROM symmy_integration.membership_source_orders o JOIN symmy_integration.job_effects e ON e.tenant_id=o.tenant_id AND e.effect_id=o.effect_id
    WHERE o.tenant_id=p_tenant AND e.job_id=p_job;
END;
$$;
--> statement-breakpoint
-- A ledger-ordered membership effect commits only bound to the reservation of its own ERP admission, whichever binary
-- wrote it. A membership outside the reserved namespace is not the ledger's and is not examined.
CREATE FUNCTION symmy_integration.require_membership_order_reservation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
BEGIN
  IF NOT symmy_integration.symmy_membership_ledger_namespace(NEW.effect #>> '{intent,payload,manager,sourceNamespace}') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT FROM symmy_integration.membership_source_orders o
    JOIN symmy_integration.import_jobs j
      ON j.tenant_id = o.tenant_id AND j.route_id = o.route_id AND j.idempotency_digest = o.idempotency_digest
    WHERE o.tenant_id = NEW.tenant_id AND o.effect_id = NEW.effect_id AND j.job_id = NEW.job_id
      AND j.fixture_id = 'ERP_MEMBERSHIP_V1'
      AND o.source_order = (NEW.effect #>> '{intent,payload,source,order}')::integer
      AND o.effective_at = (NEW.effect #>> '{intent,payload,effectiveAt}')::timestamptz
      AND o.lineage_digest = symmy_integration.symmy_membership_lineage(j.tenant_id, j.legal_entity_id,
        NEW.effect #>> '{intent,payload,manager,issuer}', NEW.effect #>> '{intent,payload,manager,sourceNamespace}',
        (NEW.effect #>> '{intent,payload,profile,profileRef,resourceId}')::uuid)
  ) THEN
    RAISE EXCEPTION 'membership admission has no matching ledger reservation' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.require_membership_order_reservation() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER symmy_membership_reservation_at_commit
AFTER INSERT OR UPDATE OF effect ON symmy_integration.job_effects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.effect #>> '{intent,_tag}' = 'CustomerGroupMembership')
EXECUTE FUNCTION symmy_integration.require_membership_order_reservation();
--> statement-breakpoint
-- No reservation commits unbound, so every order the ledger holds names the effect that reaches a settled state.
CREATE FUNCTION symmy_integration.require_membership_order_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
BEGIN
  PERFORM 1 FROM symmy_integration.membership_source_orders o
  WHERE o.tenant_id = NEW.tenant_id AND o.lineage_digest = NEW.lineage_digest AND o.source_order = NEW.source_order
    AND o.effect_id IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership order reservation was not bound to an effect' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.require_membership_order_binding() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER symmy_membership_order_bound_at_commit
AFTER INSERT ON symmy_integration.membership_source_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION symmy_integration.require_membership_order_binding();
--> statement-breakpoint
-- The claim is where a ledger-ordered membership is ordered, in the transaction that hands it to a worker. A worker
-- states the membership protocol it implements; one that states none, as a binary from before the ledger does, is
-- handed no ledger-ordered effect. Every other effect is claimed exactly as before.
DROP FUNCTION symmy_integration.claim_symmy_job_effect(uuid, uuid, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION symmy_integration.claim_symmy_job_effect(
  p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid, p_membership_protocol integer DEFAULT NULL
) RETURNS TABLE(effect jsonb, mode text, version integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_mode text; v_lineage text; v_order integer; v_refusal text;
  v_waiting_since timestamptz;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid OR p_token IS NULL THEN
    RAISE EXCEPTION 'invalid execution scope' USING ERRCODE = '42501';
  END IF;
  SELECT e.* INTO v_effect FROM symmy_integration.job_effects e
    JOIN symmy_integration.import_jobs j ON j.tenant_id = e.tenant_id AND j.job_id = e.job_id
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect
      AND j.execution_plan IS NOT NULL
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.execution_plan->'items') i,
        jsonb_array_elements(i->'effects') pinned WHERE pinned = e.effect)
    FOR UPDATE OF e;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'blocked'::text, 0; RETURN; END IF;
  IF v_effect.state = 'settled' THEN
    RETURN QUERY SELECT v_effect.effect, 'settled'::text, v_effect.version; RETURN;
  END IF;
  SELECT o.lineage_digest, o.source_order INTO v_lineage, v_order
  FROM symmy_integration.membership_source_orders o
  WHERE o.tenant_id = p_tenant AND o.effect_id = p_effect;
  IF FOUND THEN
    IF p_membership_protocol IS DISTINCT FROM 1 THEN
      RETURN QUERY SELECT NULL::jsonb, 'blocked'::text, v_effect.version; RETURN;
    END IF;
    -- Planned or blocked, the effect was never handed to the owner, so refusing it discards no owner call.
    IF v_effect.state IN ('planned', 'blocked') THEN
      IF NOT symmy_integration.symmy_original_route_active(p_tenant, p_job) THEN
        -- A lineage cannot wait for a route that may or may not return: the effect is refused for good.
        v_refusal := 'denied';
      ELSIF EXISTS (
        SELECT FROM symmy_integration.membership_source_orders earlier
        JOIN symmy_integration.job_effects e ON e.tenant_id = earlier.tenant_id AND e.effect_id = earlier.effect_id
        WHERE earlier.tenant_id = p_tenant AND earlier.lineage_digest = v_lineage AND earlier.source_order < v_order
          AND e.state <> 'settled'
      ) THEN
        -- Only a settled earlier order releases this one. It waits a bounded time from the first claim that found it
        -- waiting, so a worker outage costs it nothing, and is then refused unresolved: neither it nor the delivery
        -- that carries it waits without end, and the earlier order is never skipped.
        UPDATE symmy_integration.membership_source_orders o SET waiting_since = coalesce(o.waiting_since, clock_timestamp())
          WHERE o.tenant_id = p_tenant AND o.effect_id = p_effect RETURNING o.waiting_since INTO v_waiting_since;
        IF clock_timestamp() < v_waiting_since + interval '15 minutes' THEN
          RETURN QUERY SELECT NULL::jsonb, 'waiting'::text, v_effect.version; RETURN;
        END IF;
        v_refusal := 'unresolved';
      END IF;
      IF v_refusal IS NOT NULL THEN
        UPDATE symmy_integration.job_effects e SET state = 'settled',
          outcome = jsonb_build_object('effectId', p_effect, 'owner', e.effect#>>'{ref,operation,moduleId}', 'status', v_refusal),
          claim_token = NULL, lease_until = NULL, version = e.version + 1
          WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect RETURNING e.version INTO v_effect.version;
        RETURN QUERY SELECT v_effect.effect, 'settled'::text, v_effect.version; RETURN;
      END IF;
    END IF;
  END IF;
  IF v_effect.state = 'attempting' AND v_effect.lease_until > clock_timestamp() THEN
    RETURN QUERY SELECT v_effect.effect, 'busy'::text, v_effect.version; RETURN;
  END IF;
  IF v_effect.state IN ('planned', 'blocked') THEN
    IF NOT symmy_integration.symmy_original_route_active(p_tenant, p_job) THEN
      IF v_effect.state <> 'blocked' THEN
        UPDATE symmy_integration.job_effects e SET state = 'blocked',
          outcome = jsonb_build_object('effectId', p_effect, 'owner', e.effect#>>'{ref,operation,moduleId}', 'status', 'denied'),
          version = e.version + 1
          WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect RETURNING e.version INTO v_effect.version;
      END IF;
      RETURN QUERY SELECT v_effect.effect, 'blocked'::text, v_effect.version; RETURN;
    END IF;
    v_mode := 'execute';
  ELSE
    v_mode := 'recover';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'attempting', outcome = NULL, claim_token = p_token,
    lease_until = clock_timestamp() + interval '30 seconds', version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect RETURNING e.version INTO v_effect.version;
  RETURN QUERY SELECT v_effect.effect, v_mode, v_effect.version;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.symmy_membership_ledger_namespace(text) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.symmy_membership_lineage(uuid, uuid, text, text, uuid) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.reserve_symmy_membership_order(uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_membership_orders(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.claim_symmy_job_effect(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.reserve_symmy_membership_order(uuid, uuid, uuid, text, text, text, uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_membership_orders(uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.claim_symmy_job_effect(uuid, uuid, uuid, uuid, integer) TO ontos_runtime;
--> statement-breakpoint
-- An item may now state no owner effect when it states a branch it cannot deliver: a membership of a customer the
-- owner names no profile for is refused alone and pins nothing of that customer. Everything else is unchanged.
CREATE OR REPLACE FUNCTION symmy_integration.pin_symmy_fixture_plan(
  p_plan jsonb, p_tenant uuid, p_route uuid, p_revision text, p_mapping text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_effect jsonb;
  v_items jsonb := '[]'::jsonb;
  v_effects jsonb;
  v_item_id uuid;
  v_occurrence_id text;
  v_ref jsonb;
  v_branch jsonb;
  v_branches jsonb;
BEGIN
  IF p_plan IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_plan->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_plan->'items') NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'invalid fixture plan' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_plan->'items') LOOP
    -- An item states at least one owner effect, or nothing but the branches it cannot deliver.
    IF jsonb_typeof(v_item->'effects') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_item->'effects') > 32
      OR (jsonb_array_length(v_item->'effects') = 0 AND coalesce(jsonb_array_length(
        CASE WHEN jsonb_typeof(v_item->'unsupportedBranches') = 'array' THEN v_item->'unsupportedBranches' END), 0) = 0) THEN
      RAISE EXCEPTION 'invalid fixture effects' USING ERRCODE = '22023';
    END IF;
    v_item_id := gen_random_uuid();
    v_occurrence_id := COALESCE(NULLIF(v_item->>'sourceOccurrenceId',''),gen_random_uuid()::text);
    v_effects := '[]'::jsonb;
    FOR v_effect IN SELECT value FROM jsonb_array_elements(v_item->'effects') LOOP
      v_ref := jsonb_build_object(
        'effectId', gen_random_uuid(), 'mappingVersion', COALESCE(p_plan->>'sourceMappingVersion',p_mapping), 'routeRevision', COALESCE(p_plan->>'sourceRouteRevision',p_revision),
        'operation', jsonb_build_object(
          'moduleId', v_effect#>'{operation,moduleId}',
          'entrypointKey', v_effect#>'{operation,entrypointKey}',
          'schemaVersion', v_effect#>'{operation,schemaVersion}'
        ),
        'occurrence', jsonb_build_object(
          'occurrenceId', v_occurrence_id,
          'record', jsonb_build_object(
            'entityKind', v_item#>'{source,entityKind}', 'issuerId', v_item#>'{source,issuerId}',
            'sourceNamespace', v_item#>'{source,sourceNamespace}',
            'sourceRecordId', v_item#>'{source,sourceRecordId}',
            'route', jsonb_build_object('integrationRouteId', COALESCE(p_plan->'sourceRouteId',to_jsonb(p_route)), 'tenantId', p_tenant)
          )
        )
      );
      IF v_effect ? 'originalTarget' THEN
        IF v_effect#>>'{originalTarget,tenantId}' IS DISTINCT FROM p_tenant::text
          OR v_effect#>>'{originalTarget,moduleId}' IS DISTINCT FROM v_effect#>>'{operation,moduleId}' THEN
          RAISE EXCEPTION 'invalid fixture target scope' USING ERRCODE = '22023';
        END IF;
        v_ref := v_ref || jsonb_build_object('originalTarget', jsonb_build_object(
          'tenantId', p_tenant, 'moduleId', v_effect#>'{originalTarget,moduleId}',
          'resourceType', v_effect#>'{originalTarget,resourceType}',
          'resourceId', v_effect#>'{originalTarget,resourceId}'
        ));
      END IF;
      v_effects := v_effects || jsonb_build_array(jsonb_build_object(
        'effectKey', v_effect->'effectKey', 'itemId', v_item_id, 'ref', v_ref
      ) || CASE WHEN v_effect ? 'dependsOn' THEN jsonb_build_object('dependsOn',v_effect->'dependsOn') ELSE '{}'::jsonb END
        || CASE WHEN v_effect ? 'intent' THEN jsonb_build_object('intent',v_effect->'intent') ELSE '{}'::jsonb END);
    END LOOP;
    v_branches:='[]'::jsonb;
    IF v_item ? 'unsupportedBranches' THEN
      IF jsonb_typeof(v_item->'unsupportedBranches') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'unsupportedBranches')>8 THEN
        RAISE EXCEPTION 'invalid unsupported branches' USING ERRCODE='22023'; END IF;
      FOR v_branch IN SELECT value FROM jsonb_array_elements(v_item->'unsupportedBranches') LOOP
        v_branches:=v_branches||jsonb_build_array(jsonb_build_object('branchId',gen_random_uuid(),'branchKey',v_branch->'branchKey','kind',v_branch->'kind'));
      END LOOP;
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id, 'itemKey', v_item->'itemKey', 'effects', v_effects
    ) || CASE WHEN jsonb_array_length(v_branches)>0 THEN jsonb_build_object('unsupportedBranches',v_branches) ELSE '{}'::jsonb END);
  END LOOP;
  RETURN jsonb_build_object('items', v_items,'sourceRouteId',COALESCE(p_plan->'sourceRouteId',to_jsonb(p_route)),'sourceRouteRevision',COALESCE(p_plan->>'sourceRouteRevision',p_revision),'sourceMappingVersion',COALESCE(p_plan->>'sourceMappingVersion',p_mapping)) || CASE WHEN p_plan ? 'selector' THEN jsonb_build_object('selector',p_plan->'selector') ELSE '{}'::jsonb END || CASE WHEN p_plan ? 'pricingSourceSystem' THEN jsonb_build_object('pricingSourceSystem',p_plan->'pricingSourceSystem') ELSE '{}'::jsonb END || CASE WHEN p_plan ? 'inventoryBackendId' THEN jsonb_build_object('inventoryBackendId',p_plan->'inventoryBackendId') ELSE '{}'::jsonb END;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION symmy_integration.purge_symmy_job_intents(p_tenant uuid,p_job uuid,p_policy jsonb,p_authority jsonb)
RETURNS TABLE(status text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_job symmy_integration.import_jobs%ROWTYPE; v_plan jsonb; v_tombstone symmy_integration.job_retention_tombstones%ROWTYPE;
BEGIN
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'invalid retention scope' USING ERRCODE='42501'; END IF;
 SELECT j.* INTO v_job FROM symmy_integration.import_jobs j WHERE j.tenant_id=p_tenant AND j.job_id=p_job FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 SELECT t.* INTO v_tombstone FROM symmy_integration.job_retention_tombstones t WHERE t.tenant_id=p_tenant AND t.job_id=p_job;
 IF FOUND THEN RETURN QUERY SELECT 'ALREADY_PURGED'::text; RETURN; END IF;
 IF (v_job.lifecycle_policy IS NOT NULL AND (v_job.lifecycle_policy->>'policyId' IS DISTINCT FROM p_policy->>'policyId'
  OR v_job.lifecycle_policy->>'revision' IS DISTINCT FROM p_policy->>'revision'))
  OR p_policy->>'routeId' IS DISTINCT FROM v_job.route_id::text
  OR p_policy->'targetLegalEntityId' IS DISTINCT FROM coalesce(to_jsonb(v_job.legal_entity_id),'null'::jsonb)
  OR nullif(p_policy->>'governanceLegalEntityId','') IS NULL
  OR p_policy->>'governanceLegalEntityId' IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')
  OR (v_job.legal_entity_id IS NOT NULL AND p_policy->>'governanceLegalEntityId' IS DISTINCT FROM v_job.legal_entity_id::text)
  OR nullif(p_policy->>'policyId','') IS NULL OR nullif(p_policy->>'revision','') IS NULL
  OR jsonb_typeof(p_policy->'retentionMs') IS DISTINCT FROM 'number'
  OR (p_policy->>'retentionMs')::bigint<=0
  OR v_job.admitted_at+make_interval(secs=>(p_policy->>'retentionMs')::double precision/1000)>clock_timestamp()
  OR p_authority->>'status' IS DISTINCT FROM 'CURRENT_APPROVED'
  OR p_authority->>'resourceRef' IS DISTINCT FROM 'integration.symmy.job:'||p_job::text
  OR p_authority->>'contentScopeRef' IS DISTINCT FROM 'integration.symmy.job:'||p_job::text||'#integration.symmy.job-intent'
  OR nullif(p_authority->>'authorityReceiptRef','') IS NULL OR nullif(p_authority->>'authorityRevision','') IS NULL
  OR jsonb_typeof(v_job.execution_plan->'items') IS DISTINCT FROM 'array'
  -- A job without effect rows is erasable only when its plan pins none: an ERP batch of customers the owner never named.
  OR (NOT EXISTS(SELECT 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_job.execution_plan->'items') i
    WHERE jsonb_array_length(coalesce(i->'effects','[]'::jsonb))>0)) THEN
  RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 -- Claimers lock an effect before publishing its lease. Acquire the same row locks before deciding.
 PERFORM 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job ORDER BY e.effect_id FOR UPDATE;
 -- With the effects locked, an expired ERP claim without a request pin cannot have sent. The transition below
 -- invalidates its token/version before releasing the lock. An in-flight or possibly-sent command still blocks.
 IF EXISTS(SELECT 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job
   AND e.state IN ('attempting','indeterminate') AND NOT (e.state IN ('attempting','indeterminate') AND (e.state='indeterminate' OR e.lease_until <= clock_timestamp())
     AND e.owner_request_hash IS NULL AND e.owner_auth_context_ref IS NULL AND e.owner_invocation_id IS NULL AND e.owner_receipt IS NULL
     AND EXISTS(SELECT FROM symmy_integration.membership_source_orders o WHERE o.tenant_id=e.tenant_id AND o.effect_id=e.effect_id))) THEN
  RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 v_plan:=symmy_integration.erase_symmy_plan_payload(v_job.execution_plan);
 IF v_plan IS NULL THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 -- A reserved order cannot disappear. A never-dispatched assignment is definitively denied by erasure;
 -- retaining that terminal outcome releases the next order without ever handing the erased one to Commerce.
 UPDATE symmy_integration.job_effects e SET state='settled',
  outcome=jsonb_build_object('effectId',e.effect_id,'owner',e.effect#>>'{ref,operation,moduleId}','status','denied'),
  claim_token=NULL, lease_until=NULL, version=e.version+1
 FROM symmy_integration.membership_source_orders o
 WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND (e.state IN ('planned','blocked','attempting','indeterminate'))
  AND o.tenant_id=e.tenant_id AND o.effect_id=e.effect_id;
 UPDATE symmy_integration.job_effects e SET effect=symmy_integration.erase_symmy_effect_payload(e.effect), resolved_effect=symmy_integration.erase_symmy_effect_payload(e.resolved_effect), effect_key='erased.'||e.effect_id::text WHERE e.tenant_id=p_tenant AND e.job_id=p_job;
 UPDATE symmy_integration.import_jobs j SET execution_plan=v_plan, fixture_id='ERASED', route_code=NULL,
  lifecycle_policy=coalesce(j.lifecycle_policy,jsonb_build_object('policyId',p_policy->>'policyId','revision',p_policy->>'revision')) WHERE j.tenant_id=p_tenant AND j.job_id=p_job;
 INSERT INTO symmy_integration.job_retention_tombstones(tenant_id,job_id,policy_id,policy_revision,authority_receipt_ref,authority_revision,retained_effect_ids)
 SELECT p_tenant,p_job,p_policy->>'policyId',p_policy->>'revision',p_authority->>'authorityReceiptRef',p_authority->>'authorityRevision',
  coalesce(jsonb_agg(e.effect_id ORDER BY e.effect_id),'[]'::jsonb) FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job;
 RETURN QUERY SELECT 'PURGED'::text;
END; $$;
--> statement-breakpoint
-- An erased item keeps its (possibly empty) effect list, so a plan of unsupported customers erases to a valid plan.
CREATE OR REPLACE FUNCTION symmy_integration.erase_symmy_plan_payload(p_plan jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,symmy_integration,pg_temp AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object(
  'sourceRouteId',CASE WHEN coalesce(p_plan->>'sourceRouteId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_plan->'sourceRouteId' ELSE NULL END,'sourceRouteRevision',p_plan->'sourceRouteRevision',
  'sourceMappingVersion',p_plan->'sourceMappingVersion',
  'items',jsonb_agg(jsonb_build_object(
   'itemId',item.value->'itemId','itemKey','erased.'||(item.value->>'itemId'),
   'effects',coalesce((SELECT jsonb_agg(symmy_integration.erase_symmy_effect_payload(effect.value) ORDER BY effect.ordinality)
    FROM jsonb_array_elements(item.value->'effects') WITH ORDINALITY effect(value,ordinality)),'[]'::jsonb),
   'unsupportedBranches',(SELECT jsonb_agg(jsonb_build_object('branchId',branch.value->'branchId',
      'branchKey','erased.'||(branch.value->>'branchId'),'kind',branch.value->'kind') ORDER BY branch.ordinality)
     FROM jsonb_array_elements(coalesce(item.value->'unsupportedBranches','[]'::jsonb)) WITH ORDINALITY branch(value,ordinality))
  ) ORDER BY item.ordinality)))
 FROM jsonb_array_elements(p_plan->'items') WITH ORDINALITY item(value,ordinality);
$$;
--> statement-breakpoint
RESET row_security;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
