-- The tenant ledger head: the exact value `expected_catalog_revision` of the next create must equal
-- (`create_price_group_with_complete_schedule` fences on max(catalog_revision), 0 before any write).
CREATE FUNCTION price_group_catalog.read_price_group_catalog_head(p_tenant_id uuid)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  RETURN QUERY SELECT jsonb_build_object('catalogRevision', coalesce((
    SELECT max(ledger.catalog_revision) FROM price_group_catalog.price_group_catalog_ledger AS ledger
    WHERE ledger.tenant_id = p_tenant_id
  ), 0));
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION price_group_catalog.read_price_group_catalog_head(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION price_group_catalog.read_price_group_catalog_head(uuid) TO ontos_runtime;
