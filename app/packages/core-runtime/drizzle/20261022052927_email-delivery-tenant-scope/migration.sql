ALTER TABLE "demo_email"."deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "demo_email_deliveries_scope_select" ON "demo_email"."deliveries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_email_deliveries_scope_insert" ON "demo_email"."deliveries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_email_deliveries_scope_update" ON "demo_email"."deliveries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "demo_email"."deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The dispatcher runs as ontos_runtime without a tenant until it knows which scopes have work. This is its only
-- cross-tenant read: (tenant, legal entity, delivery id) of pending e-mails, never recipients or content. The scoped
-- transaction that follows reads the content under RLS. Absent source tables (module not migrated) are skipped.
CREATE OR REPLACE FUNCTION "demo_email"."pending_deliveries"(
  p_limit integer,
  p_storefront_tenant_id uuid,
  p_storefront_legal_entity_id uuid
) RETURNS TABLE (tenant_id uuid, legal_entity_id uuid, delivery_id text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_since timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 100);
BEGIN
  IF NOT (SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'demo_email.pending_deliveries must be owned by a role that bypasses row level security';
  END IF;
  SELECT s.value::timestamptz INTO v_since FROM demo_email.settings s WHERE s.key = 'enabled_since';
  IF v_since IS NULL THEN
    RAISE EXCEPTION 'demo_email.settings enabled_since is missing';
  END IF;

  -- A submission left in SENDING by a dead request: its scope is visited so it settles as UNKNOWN (never resent).
  RETURN QUERY
    SELECT d.tenant_id, d.legal_entity_id, d.dedupe_key FROM demo_email.deliveries d
    WHERE d.status = 'SENDING' AND d.updated_at < now() - interval '5 minutes'
    ORDER BY d.updated_at, d.dedupe_key LIMIT v_limit;

  IF to_regclass('finance_billing.finance_states') IS NOT NULL THEN
    RETURN QUERY
      SELECT c.tenant_id, c.legal_entity_id, c.key FROM (
        SELECT s.tenant_id, s.legal_entity_id, 'rent-reminder:' || (r->>'id') AS key, (r->>'createdAt')::timestamptz AS at
        FROM finance_billing.finance_states s, jsonb_array_elements(coalesce(s.state->'reminders', '[]'::jsonb)) r
        WHERE r->>'deliveryMode' = 'EMAIL' AND (r->>'createdAt')::timestamptz >= v_since
          AND coalesce(trim(r->>'recipient'), '') <> ''
      ) c
      WHERE NOT EXISTS (SELECT 1 FROM demo_email.deliveries d WHERE d.dedupe_key = c.key
        AND (d.status <> 'RETRY' OR d.updated_at >= now() - make_interval(secs => least(60, 10 * power(2, least(d.attempts - 1, 3))))))
      ORDER BY c.at, c.key LIMIT v_limit;
  END IF;

  IF to_regclass('demo_merchandise.orders') IS NOT NULL THEN
    RETURN QUERY
      SELECT c.tenant_id, c.legal_entity_id, c.key FROM (
        SELECT o.tenant_id, o.legal_entity_id, o.created_at, 'akros-order:' || o.id || ':' || e.event AS key
        FROM demo_merchandise.orders o
        CROSS JOIN LATERAL (
          SELECT v.event, v.at FROM (VALUES ('ORDER_CREATED', o.document->>'createdAt'),
            (CASE WHEN o.document->>'status' IN ('CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED')
              THEN o.document->>'status' END, o.document->>'updatedAt')) v(event, at)
          UNION ALL
          SELECT CASE
            WHEN h->>'after' LIKE 'Zpracovává se%' OR h->>'after' LIKE 'Potvrzen%' THEN 'CONFIRMED'
            WHEN h->>'after' LIKE 'Předáno dopravci%' THEN 'SHIPPED'
            WHEN h->>'after' LIKE 'Dokončen%' THEN 'DELIVERED'
            WHEN h->>'after' LIKE 'Stornovan%' OR h->>'after' LIKE 'Zrušen%' THEN 'CANCELLED'
          END, h->>'at' FROM jsonb_array_elements(coalesce(o.document->'history', '[]'::jsonb)) h WHERE h->>'kind' = 'STATUS'
        ) e
        WHERE o.tenant_id = p_storefront_tenant_id AND o.legal_entity_id = p_storefront_legal_entity_id
          AND o.channel = 'STOREFRONT' AND o.created_at >= v_since
          AND coalesce(trim(o.document->'contact'->>'email'), '') <> '' AND e.event IS NOT NULL
          AND (o.document->'demoCleanup'->>'at' IS NULL OR e.at::timestamptz < (o.document->'demoCleanup'->>'at')::timestamptz)
        GROUP BY o.tenant_id, o.legal_entity_id, o.created_at, o.id, e.event
      ) c
      WHERE NOT EXISTS (SELECT 1 FROM demo_email.deliveries d WHERE d.dedupe_key = c.key
        AND (d.status <> 'RETRY' OR d.updated_at >= now() - make_interval(secs => least(60, 10 * power(2, least(d.attempts - 1, 3))))))
      ORDER BY c.created_at, c.key LIMIT v_limit;
  END IF;

  IF to_regclass('facility_operations.agenda_states') IS NOT NULL THEN
    -- At most one pending batch per person: only after e-mail opt-in, mandatory categories always, optional ones when chosen
    -- (AGENDA_MANDATORY_EMAIL_CATEGORIES / AGENDA_OPTIONAL_EMAIL_CATEGORIES in @app/email-delivery/contract).
    RETURN QUERY
      SELECT s.tenant_id, s.legal_entity_id, 'facility-agenda:' || (p->'principal'->>'principalId') || ':' || batch.at
      FROM facility_operations.agenda_states s
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.state->'preferences', '[]'::jsonb)) p
      CROSS JOIN LATERAL (
        SELECT n->>'createdAt' AS at FROM jsonb_array_elements(coalesce(s.state->'notifications', '[]'::jsonb)) n
        WHERE n->'recipient'->>'principalId' = p->'principal'->>'principalId'
          AND (n->>'createdAt')::timestamptz >= greatest(v_since, coalesce(p->>'emailSince', p->>'updatedAt')::timestamptz)
          AND ('["ASSIGNED","OVERDUE"]'::jsonb ? (n->>'category')
            OR coalesce(p->'emailCategories', '["DEADLINE","CHANGE"]'::jsonb) ? (n->>'category'))
          AND NOT EXISTS (SELECT 1 FROM demo_email.deliveries d
            WHERE d.dedupe_key = 'facility-agenda:' || (p->'principal'->>'principalId') || ':' || (n->>'createdAt')
              AND (d.status <> 'RETRY' OR d.updated_at >= now() - make_interval(secs => least(60, 10 * power(2, least(d.attempts - 1, 3))))))
        GROUP BY n->>'createdAt' ORDER BY n->>'createdAt' LIMIT 1
      ) batch
      WHERE s.agenda = 'agenda' AND (p->>'emailOptIn')::boolean IS TRUE
        AND coalesce(trim((SELECT u.email FROM core.principal_auth_bindings b JOIN auth."user" u ON u.id = b.provider_subject_id
          WHERE b.principal_id::text = p->'principal'->>'principalId' AND b.tenant_id = s.tenant_id
            AND b.status = 'active' ORDER BY b.created_at LIMIT 1)), '') <> ''
      ORDER BY batch.at, p->'principal'->>'principalId' LIMIT v_limit;
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "demo_email"."pending_deliveries"(integer, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontos_runtime') THEN
    GRANT EXECUTE ON FUNCTION "demo_email"."pending_deliveries"(integer, uuid, uuid) TO ontos_runtime;
  END IF;
END $$;
