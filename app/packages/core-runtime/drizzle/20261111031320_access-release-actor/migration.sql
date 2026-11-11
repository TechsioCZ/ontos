ALTER TABLE "core"."principals" ADD COLUMN "platform_role" text;--> statement-breakpoint
CREATE UNIQUE INDEX "core_principals_release_actor_uk" ON "core"."principals" ("tenant_id") WHERE "platform_role" = 'access_release_actor';--> statement-breakpoint
ALTER TABLE "core"."principals" ADD CONSTRAINT "core_principals_platform_role_ck" CHECK ("platform_role" is null or ("platform_role" = 'access_release_actor' and "kind" = 'system'));--> statement-breakpoint
-- Release activation (src/access/release/activation.ts): "Plný přístup" follows every new catalog release through a
-- successor revision the platform writes as the tenant's release actor — the one `system` principal of the tenant
-- whose `platform_role` is `access_release_actor`, never a person, never holding a Role, never a v2 subject. Every
-- other role revision keeps a human author. The database accepts the release actor for exactly one write and checks
-- every part of it here, independently of Core:
--   * the role is tenant-wide and every revision it ever had is the `full_access` template, and every revision after
--     the first was written by this same release actor — a person's revision after the first, whatever provenance it
--     claims, means the preset is no longer untouched (portal, editor-created, copied and manual roles never qualify);
--   * the revision follows the previous one and is pinned to the newest published release;
--   * every cell the previous revision held is kept exactly, every field equal (amount ceilings included);
--   * every added cell is exactly `{capabilityKey, mode, selector: {_tag}}` of a capability the newest release
--     declares: a declared mode; a declared selector, or `all` when the capability declares `all` or no selector at
--     all; no amount ceiling, no other key; a slot the preset did not hold yet, and no slot twice.
CREATE FUNCTION core.require_role_revision_author() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_kind text;
  v_platform_role text;
  v_untouched boolean;
  v_previous jsonb;
  v_newest uuid;
  v_invalid_added boolean;
BEGIN
  EXECUTE format('SELECT p.kind, p.platform_role FROM %I.principals p WHERE p.tenant_id = $1 AND p.principal_id = $2',
                 TG_TABLE_SCHEMA)
    INTO v_kind, v_platform_role USING NEW.tenant_id, NEW.created_by;
  IF v_kind = 'human' THEN
    RETURN NEW;
  END IF;
  IF v_platform_role IS DISTINCT FROM 'access_release_actor' THEN
    RAISE EXCEPTION 'Core access subject %.created_by must be a human principal or the tenant''s release actor',
      TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF NEW.provenance IS DISTINCT FROM 'template' OR NEW.template_key IS DISTINCT FROM 'full_access'
     OR NEW.revision <= 1 THEN
    RAISE EXCEPTION 'The release actor only extends the full-access template preset' USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %1$I.access_roles r
                     WHERE r.tenant_id = $1 AND r.role_id = $2 AND r.legal_entity_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM %1$I.access_role_revisions x
                         WHERE x.tenant_id = $1 AND x.role_id = $2
                           AND (x.provenance <> ''template'' OR x.template_key IS DISTINCT FROM ''full_access''
                                OR (x.revision > 1 AND x.created_by <> $3)))',
    TG_TABLE_SCHEMA)
    INTO v_untouched USING NEW.tenant_id, NEW.role_id, NEW.created_by;
  IF NOT v_untouched THEN
    RAISE EXCEPTION 'The release actor only extends a tenant-wide full-access preset no person has changed'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'SELECT x.cells_json FROM %I.access_role_revisions x WHERE x.tenant_id = $1 AND x.role_id = $2 AND x.revision = $3',
    TG_TABLE_SCHEMA)
    INTO v_previous USING NEW.tenant_id, NEW.role_id, NEW.revision - 1;
  IF v_previous IS NULL THEN
    RAISE EXCEPTION 'A release follow succeeds the revision before it' USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'SELECT s.catalog_snapshot_id FROM %I.access_catalog_snapshots s
      ORDER BY s.published_at DESC, s.catalog_snapshot_id DESC LIMIT 1',
    TG_TABLE_SCHEMA)
    INTO v_newest;
  IF NEW.catalog_snapshot_id IS DISTINCT FROM v_newest THEN
    RAISE EXCEPTION 'A release follow is pinned to the newest published release' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_previous) AS p(cell)
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.cells_json) AS n(cell) WHERE n.cell = p.cell)) THEN
    RAISE EXCEPTION 'A release follow keeps every cell the preset held, field for field' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.cells_json) AS n(cell)
              GROUP BY n.cell->>'capabilityKey', n.cell->>'mode', n.cell->'selector'->>'_tag'
              HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'A release follow holds every slot once' USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM jsonb_array_elements($1) AS a(cell)
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements($2) AS p(cell) WHERE p.cell = a.cell)
          AND NOT (
            jsonb_typeof(a.cell) = ''object''
            AND (a.cell - ''capabilityKey'' - ''mode'' - ''selector'') = ''{}''::jsonb
            AND jsonb_typeof(a.cell->''capabilityKey'') = ''string''
            AND jsonb_typeof(a.cell->''mode'') = ''string''
            AND jsonb_typeof(a.cell->''selector'') = ''object''
            AND ((a.cell->''selector'') - ''_tag'') = ''{}''::jsonb
            AND jsonb_typeof(a.cell->''selector''->''_tag'') = ''string''
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($2) AS p(cell)
                             WHERE p.cell->>''capabilityKey'' = a.cell->>''capabilityKey''
                               AND p.cell->>''mode'' = a.cell->>''mode''
                               AND p.cell->''selector''->>''_tag'' = a.cell->''selector''->>''_tag'')
            AND EXISTS (SELECT 1 FROM %1$I.access_catalog_entries e
                         WHERE e.catalog_snapshot_id = $3
                           AND e.capability_key = a.cell->>''capabilityKey''
                           AND jsonb_typeof(e.entry_json->''modes'') = ''array''
                           AND jsonb_typeof(e.entry_json->''selectors'') = ''array''
                           AND (e.entry_json->''modes'') ? (a.cell->>''mode'')
                           AND ((e.entry_json->''selectors'') ? (a.cell->''selector''->>''_tag'')
                                OR (a.cell->''selector''->>''_tag'' = ''all''
                                    AND jsonb_array_length(e.entry_json->''selectors'') = 0)))))',
    TG_TABLE_SCHEMA)
    INTO v_invalid_added USING NEW.cells_json, v_previous, NEW.catalog_snapshot_id;
  IF v_invalid_added THEN
    RAISE EXCEPTION 'A release follow adds only full-access cells of capabilities the newest release declares'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
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
--> statement-breakpoint
-- A `system` principal is the platform's own identity: nobody changes its kind, tenant or disabled time, and its
-- status changes only to `archived`, only once its tenant is archived — so no administrator can stop the platform's
-- work for a tenant that is active or merely suspended (the application refuses the same in `changePrincipalStatus`).
-- A tenant row the writer cannot see counts as not archived. The platform role itself is set once, when Core creates
-- the principal, and never changes. A release actor that authored a revision cannot be deleted (the revision
-- references it); one that never did is simply created again by the next activation.
CREATE FUNCTION core.keep_system_principals() RETURNS trigger
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
--> statement-breakpoint
CREATE TRIGGER core_principals_keep_system
BEFORE UPDATE ON core.principals
FOR EACH ROW EXECUTE FUNCTION core.keep_system_principals();
