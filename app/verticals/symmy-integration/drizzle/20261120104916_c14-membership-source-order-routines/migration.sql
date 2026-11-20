-- The Commerce owner keys membership receipts by profile, source issuer and namespace and refuses an older source
-- order of that lineage even when it names another group. An admission reserves the next order of a lineage under a
-- lock that lasts until it commits, the job it admits binds each of its membership effects to its own reservation,
-- and the worker delivers an effect only once every earlier order of its lineage that can still reach the owner has
-- settled.
-- Precondition: no membership effect exists before this migration (no route could enroll one), so the ledger starts empty.
ALTER TABLE symmy_integration.membership_source_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE symmy_integration.membership_source_orders FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.symmy_membership_lineage(
  p_tenant uuid, p_legal_entity uuid, p_issuer text, p_namespace text, p_profile uuid
) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(p_tenant, p_legal_entity, p_issuer, p_namespace, p_profile)::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.reserve_symmy_membership_order(
  p_tenant uuid, p_legal_entity uuid, p_route uuid, p_idempotency_digest text, p_issuer text, p_namespace text,
  p_profile uuid, p_dated boolean
) RETURNS TABLE(effective_at text, source_order integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_lineage text; v_effective_at timestamptz; v_order integer;
BEGIN
  -- The company is the one the admission transaction is scoped to, never another one of the tenant.
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid OR p_legal_entity IS NULL
    OR p_legal_entity IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_route IS NULL OR p_idempotency_digest IS NULL OR p_dated IS NULL
    OR nullif(btrim(p_issuer), '') IS NULL OR nullif(btrim(p_namespace), '') IS NULL OR p_profile IS NULL THEN
    RAISE EXCEPTION 'invalid membership order scope' USING ERRCODE = '42501';
  END IF;
  v_lineage := symmy_integration.symmy_membership_lineage(p_tenant, p_legal_entity, p_issuer, p_namespace, p_profile);
  -- Held until the admission commits: no other admission reads this lineage before its reservation commits or rolls back.
  PERFORM pg_advisory_xact_lock(hashtextextended('symmy-membership-order:' || v_lineage, 0));
  -- Only a time this ledger issued to a membership that states it is a floor.
  SELECT greatest(date_trunc('milliseconds', clock_timestamp()), max(o.effective_at)), coalesce(max(o.source_order), 0) + 1
  INTO v_effective_at, v_order
  FROM symmy_integration.membership_source_orders o
  WHERE o.tenant_id = p_tenant AND o.lineage_digest = v_lineage;
  -- The reservation belongs to the admission's route and idempotency digest: only the job admitted under both binds it.
  INSERT INTO symmy_integration.membership_source_orders
    (tenant_id, lineage_digest, source_order, effective_at, route_id, idempotency_digest)
  VALUES (p_tenant, v_lineage, v_order, CASE WHEN p_dated THEN v_effective_at END, p_route, p_idempotency_digest);
  RETURN QUERY SELECT to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), v_order;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.record_symmy_membership_orders(p_tenant uuid, p_job uuid)
RETURNS TABLE(recorded integer) LANGUAGE plpgsql SECURITY DEFINER
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
  WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect #>> '{intent,_tag}' = 'CustomerGroupMembership';
  -- Each membership effect takes the open reservation its own admission made for its lineage and order, and only one
  -- whose issued time it states when the reservation kept one. The time stays the reservation's.
  UPDATE symmy_integration.membership_source_orders o SET effect_id = e.effect_id
  FROM symmy_integration.job_effects e
  WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect #>> '{intent,_tag}' = 'CustomerGroupMembership'
    AND o.tenant_id = p_tenant AND o.route_id = v_job.route_id AND o.idempotency_digest = v_job.idempotency_digest
    AND o.effect_id IS NULL
    AND o.lineage_digest = symmy_integration.symmy_membership_lineage(p_tenant, v_job.legal_entity_id,
      e.effect #>> '{intent,payload,manager,issuer}', e.effect #>> '{intent,payload,manager,sourceNamespace}',
      (e.effect #>> '{intent,payload,profile,profileRef,resourceId}')::uuid)
    AND o.source_order = (e.effect #>> '{intent,payload,source,order}')::integer
    AND (o.effective_at IS NULL OR o.effective_at = (e.effect #>> '{intent,payload,effectiveAt}')::timestamptz);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- A membership without its own reservation, or two of them on one reservation, admits nothing.
  IF v_count <> v_memberships THEN
    RAISE EXCEPTION 'membership order was not reserved by this admission' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_count;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.symmy_membership_order_ready(p_tenant uuid, p_effect uuid)
RETURNS TABLE(ready boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_membership boolean; v_lineage text; v_order integer;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  -- A transaction scoped to a company reads only that company's effects; the tenant-wide worker reads every one.
  SELECT e.effect #>> '{intent,_tag}' = 'CustomerGroupMembership' INTO v_membership
  FROM symmy_integration.job_effects e
  JOIN symmy_integration.import_jobs j ON j.tenant_id = e.tenant_id AND j.job_id = e.job_id
  WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect
    AND (nullif(current_setting('ontos.legal_entity_id', true), '') IS NULL
      OR j.legal_entity_id IS NOT DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'effect scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_membership IS NOT TRUE THEN
    RETURN QUERY SELECT true;
    RETURN;
  END IF;
  -- A membership is delivered only in its lineage's order; one the ledger holds no order for is never delivered.
  SELECT o.lineage_digest, o.source_order INTO v_lineage, v_order
  FROM symmy_integration.membership_source_orders o WHERE o.tenant_id = p_tenant AND o.effect_id = p_effect;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership effect has no lineage order' USING ERRCODE = '55000';
  END IF;
  -- The claim executes an earlier effect only while its original route is active (symmy_original_route_active), so
  -- only such an earlier effect is waited for. Should its route return after a later order was applied, the owner
  -- refuses it as stale.
  RETURN QUERY SELECT NOT EXISTS (
    SELECT 1 FROM symmy_integration.membership_source_orders earlier
    JOIN symmy_integration.job_effects e ON e.tenant_id = earlier.tenant_id AND e.effect_id = earlier.effect_id
    WHERE earlier.tenant_id = p_tenant AND earlier.lineage_digest = v_lineage AND earlier.source_order < v_order
      AND e.state <> 'settled' AND symmy_integration.symmy_original_route_active(e.tenant_id, e.job_id));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.symmy_membership_lineage(uuid, uuid, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.reserve_symmy_membership_order(uuid, uuid, uuid, text, text, text, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_membership_orders(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.symmy_membership_order_ready(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.reserve_symmy_membership_order(uuid, uuid, uuid, text, text, text, uuid, boolean) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_membership_orders(uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.symmy_membership_order_ready(uuid, uuid) TO ontos_runtime;
