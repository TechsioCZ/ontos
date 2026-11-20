-- The Commerce owner keys membership receipts by profile, source issuer and namespace and refuses an older source
-- order of that lineage even when it names another group. The admission reserves the next order of a lineage under a
-- lock that lasts until it commits, records the order with the admitted effect, and the worker delivers an effect only
-- once every earlier order of its lineage has settled.
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
  p_tenant uuid, p_legal_entity uuid, p_issuer text, p_namespace text, p_profile uuid
) RETURNS TABLE(effective_at text, source_order integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_lineage text;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid OR p_legal_entity IS NULL
    OR nullif(btrim(p_issuer), '') IS NULL OR nullif(btrim(p_namespace), '') IS NULL OR p_profile IS NULL THEN
    RAISE EXCEPTION 'invalid membership order scope' USING ERRCODE = '42501';
  END IF;
  v_lineage := symmy_integration.symmy_membership_lineage(p_tenant, p_legal_entity, p_issuer, p_namespace, p_profile);
  -- Held until the admission commits: no other admission reads this lineage before the reserved order is recorded.
  PERFORM pg_advisory_xact_lock(hashtextextended('symmy-membership-order:' || v_lineage, 0));
  RETURN QUERY SELECT
    to_char(greatest(date_trunc('milliseconds', clock_timestamp()), max(o.effective_at)) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    coalesce(max(o.source_order), 0) + 1
  FROM symmy_integration.membership_source_orders o
  WHERE o.tenant_id = p_tenant AND o.lineage_digest = v_lineage;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.record_symmy_membership_orders(p_tenant uuid, p_job uuid)
RETURNS TABLE(recorded integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_count integer;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  -- Every membership effect the job pinned takes its lineage order. A second effect with the same order of a lineage
  -- violates the key, so the admission fails instead of admitting an order the owner would refuse.
  INSERT INTO symmy_integration.membership_source_orders (tenant_id, lineage_digest, source_order, effective_at, effect_id)
  SELECT e.tenant_id,
    symmy_integration.symmy_membership_lineage(e.tenant_id, j.legal_entity_id,
      e.effect #>> '{intent,payload,manager,issuer}', e.effect #>> '{intent,payload,manager,sourceNamespace}',
      (e.effect #>> '{intent,payload,profile,profileRef,resourceId}')::uuid),
    (e.effect #>> '{intent,payload,source,order}')::integer,
    (e.effect #>> '{intent,payload,effectiveAt}')::timestamptz,
    e.effect_id
  FROM symmy_integration.job_effects e
  JOIN symmy_integration.import_jobs j ON j.tenant_id = e.tenant_id AND j.job_id = e.job_id
  WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect #>> '{intent,_tag}' = 'CustomerGroupMembership';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT v_count;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.symmy_membership_order_ready(p_tenant uuid, p_effect uuid)
RETURNS TABLE(ready boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  -- An effect without a recorded order has no lineage to wait for.
  RETURN QUERY SELECT NOT EXISTS (
    SELECT 1 FROM symmy_integration.membership_source_orders mine
    JOIN symmy_integration.membership_source_orders earlier
      ON earlier.tenant_id = mine.tenant_id AND earlier.lineage_digest = mine.lineage_digest
      AND earlier.source_order < mine.source_order
    JOIN symmy_integration.job_effects e ON e.tenant_id = earlier.tenant_id AND e.effect_id = earlier.effect_id
    WHERE mine.tenant_id = p_tenant AND mine.effect_id = p_effect AND e.state <> 'settled');
END;
$$;
--> statement-breakpoint
-- Memberships admitted before this migration keep their lineage order: the first reservation of a lineage continues
-- above them, and a later effect still waits for an unsettled earlier one. An erased payload has no lineage left.
INSERT INTO symmy_integration.membership_source_orders (tenant_id, lineage_digest, source_order, effective_at, effect_id)
SELECT e.tenant_id,
  symmy_integration.symmy_membership_lineage(e.tenant_id, j.legal_entity_id,
    e.effect #>> '{intent,payload,manager,issuer}', e.effect #>> '{intent,payload,manager,sourceNamespace}',
    (e.effect #>> '{intent,payload,profile,profileRef,resourceId}')::uuid),
  (e.effect #>> '{intent,payload,source,order}')::integer,
  (e.effect #>> '{intent,payload,effectiveAt}')::timestamptz,
  e.effect_id
FROM symmy_integration.job_effects e
JOIN symmy_integration.import_jobs j ON j.tenant_id = e.tenant_id AND j.job_id = e.job_id
WHERE e.effect #>> '{intent,_tag}' = 'CustomerGroupMembership'
  AND e.effect #>> '{intent,payload,profile,profileRef,resourceId}'
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND e.effect #>> '{intent,payload,source,order}' ~ '^[1-9][0-9]{0,8}$'
  AND e.effect #>> '{intent,payload,effectiveAt}' IS NOT NULL
  AND e.effect #>> '{intent,payload,manager,issuer}' IS NOT NULL
  AND e.effect #>> '{intent,payload,manager,sourceNamespace}' IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.symmy_membership_lineage(uuid, uuid, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.reserve_symmy_membership_order(uuid, uuid, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_membership_orders(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.symmy_membership_order_ready(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.reserve_symmy_membership_order(uuid, uuid, text, text, uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_membership_orders(uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.symmy_membership_order_ready(uuid, uuid) TO ontos_runtime;
