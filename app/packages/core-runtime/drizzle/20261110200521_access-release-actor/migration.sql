-- Release activation (src/access/release/activation.ts): "Plný přístup" follows every new catalog release through a
-- successor revision the platform writes as the tenant's release actor, a `system` principal that is never a person,
-- holds no Role and is never a v2 subject. Every other role revision keeps a human author. The database accepts a
-- system author for exactly what a release follow writes, and checks it on its own: a `template` successor of an
-- untouched `template` revision of the same template that keeps every cell its source held, so a platform-written
-- revision can only ever add.
CREATE FUNCTION core.require_role_revision_author() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_kind text;
  v_follows boolean;
BEGIN
  -- The guard reads the tables of the schema the written row lives in, as core.require_access_principal_kinds does.
  EXECUTE format('SELECT p.kind FROM %I.principals p WHERE p.tenant_id = $1 AND p.principal_id = $2',
                 TG_TABLE_SCHEMA)
    INTO v_kind USING NEW.tenant_id, NEW.created_by;
  IF v_kind = 'human' THEN
    RETURN NEW;
  END IF;
  IF v_kind = 'system' AND NEW.provenance = 'template' AND NEW.revision > 1 THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.access_role_revisions s
          WHERE s.tenant_id = $1 AND s.role_id = $2 AND s.revision = $3 - 1
            AND s.provenance = ''template'' AND s.template_key = $4 AND $5 @> s.cells_json)',
      TG_TABLE_SCHEMA)
      INTO v_follows USING NEW.tenant_id, NEW.role_id, NEW.revision, NEW.template_key, NEW.cells_json;
    IF v_follows THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Core access subject %.created_by must be a human principal, or the release actor extending an untouched template', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.require_role_revision_author() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER core_access_role_revisions_subject_kind ON core.access_role_revisions;
--> statement-breakpoint
CREATE TRIGGER core_access_role_revisions_subject_kind
BEFORE INSERT OR UPDATE ON core.access_role_revisions
FOR EACH ROW EXECUTE FUNCTION core.require_role_revision_author();
