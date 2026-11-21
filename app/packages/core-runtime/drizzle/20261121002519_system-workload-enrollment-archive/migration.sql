-- A Tenant's system Principal for a system workload is ended by `core.identity.change-system-workload-enrollment`,
-- which archives it (archived is final, so a later enrollment creates a new Principal). Such a Principal carries no
-- platform role. The platform's own system principal (the access release actor, `platform_role` set) keeps the
-- guard unchanged: archived only, and only with its archived tenant. Kind, tenant and disabled time stay fixed for
-- every system principal.
CREATE OR REPLACE FUNCTION core.keep_system_principals() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_tenant_status text;
BEGIN
  IF NEW.platform_role IS DISTINCT FROM OLD.platform_role THEN
    RAISE EXCEPTION 'A principal''s platform role is set when Core creates it and never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.kind IS DISTINCT FROM 'system' THEN
    RETURN NEW;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
    RAISE EXCEPTION 'A platform system principal keeps its kind, tenant and disabled time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.platform_role IS NULL AND NEW.status = 'archived' THEN
    RETURN NEW;
  END IF;
  IF OLD.tenant_id IS NOT NULL THEN
    EXECUTE format('SELECT t.status FROM %I.tenants t WHERE t.tenant_id = $1', TG_TABLE_SCHEMA)
      INTO v_tenant_status USING OLD.tenant_id;
  END IF;
  IF NEW.status IS DISTINCT FROM 'archived' OR v_tenant_status IS DISTINCT FROM 'archived' THEN
    RAISE EXCEPTION 'A platform system principal is only archived, and only with its archived tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_system_principals() FROM PUBLIC;
