CREATE TABLE "commerce_customer_context"."demo_newsletter_choices" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text NOT NULL,
	"last_request_id" uuid NOT NULL,
	"notice_version" text NOT NULL,
	"party_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ccc_demo_newsletter_choice_scope_party_pk" PRIMARY KEY("tenant_id","legal_entity_id","party_id"),
	CONSTRAINT "ccc_demo_newsletter_choice_decision_ck" CHECK ("decision" in ('GRANTED', 'WITHDRAWN')),
	CONSTRAINT "ccc_demo_newsletter_choice_revision_ck" CHECK ("revision" >= 1),
	CONSTRAINT "ccc_demo_newsletter_choice_notice_ck" CHECK ("notice_version" = 'demo-newsletter.cs.v1')
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."demo_newsletter_choices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ccc_demo_newsletter_choice_scope_select" ON "commerce_customer_context"."demo_newsletter_choices" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."demo_newsletter_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."demo_newsletter_choices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_demo_newsletter_choice_scope_insert" ON "commerce_customer_context"."demo_newsletter_choices" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."demo_newsletter_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."demo_newsletter_choices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_demo_newsletter_choice_scope_update" ON "commerce_customer_context"."demo_newsletter_choices" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."demo_newsletter_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."demo_newsletter_choices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."demo_newsletter_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."demo_newsletter_choices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_demo_newsletter_choice_scope_delete" ON "commerce_customer_context"."demo_newsletter_choices" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."demo_newsletter_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."demo_newsletter_choices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_demo_newsletter_choice_scope_owner_routine" ON "commerce_customer_context"."demo_newsletter_choices" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."demo_newsletter_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."demo_newsletter_choices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."demo_newsletter_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."demo_newsletter_choices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE commerce_customer_context.demo_newsletter_choices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE commerce_customer_context.demo_newsletter_choices FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_demo_newsletter_choice(
  p_tenant_id uuid, p_legal_entity_id uuid, p_party_id uuid
) RETURNS TABLE(choice jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
     OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified newsletter scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'decision', item.decision,
    'revision', item.revision,
    'noticeVersionId', item.notice_version,
    'requestId', item.last_request_id,
    'changedAt', to_char(item.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) FROM commerce_customer_context.demo_newsletter_choices item
    WHERE item.tenant_id = p_tenant_id AND item.legal_entity_id = p_legal_entity_id AND item.party_id = p_party_id;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.write_demo_newsletter_choice(
  p_tenant_id uuid, p_legal_entity_id uuid, p_party_id uuid,
  p_expected_revision integer, p_decision text, p_notice_version text, p_request_id uuid
) RETURNS TABLE(choice jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  stored commerce_customer_context.demo_newsletter_choices%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
     OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified newsletter scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_party_id IS NULL OR p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_decision IS NULL OR p_decision NOT IN ('GRANTED', 'WITHDRAWN')
     OR p_notice_version IS DISTINCT FROM 'demo-newsletter.cs.v1' THEN
    RETURN;
  END IF;

  IF p_expected_revision = 0 THEN
    INSERT INTO commerce_customer_context.demo_newsletter_choices(
      tenant_id, legal_entity_id, party_id, decision, revision, notice_version, changed_at, last_request_id
    ) VALUES (
      p_tenant_id, p_legal_entity_id, p_party_id, p_decision, 1, p_notice_version, clock_timestamp(), p_request_id
    ) ON CONFLICT (tenant_id, legal_entity_id, party_id) DO NOTHING
      RETURNING * INTO stored;
    IF FOUND THEN
      RETURN QUERY SELECT * FROM commerce_customer_context.read_demo_newsletter_choice(p_tenant_id, p_legal_entity_id, p_party_id);
      RETURN;
    END IF;
  END IF;

  -- The row lock serializes replay checks with writes, including a competing first insert.
  SELECT * INTO stored FROM commerce_customer_context.demo_newsletter_choices item
    WHERE item.tenant_id = p_tenant_id AND item.legal_entity_id = p_legal_entity_id AND item.party_id = p_party_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF stored.last_request_id = p_request_id THEN
    IF stored.decision = p_decision AND stored.notice_version = p_notice_version
       AND p_expected_revision = stored.revision - 1 THEN
      RETURN QUERY SELECT * FROM commerce_customer_context.read_demo_newsletter_choice(p_tenant_id, p_legal_entity_id, p_party_id);
    END IF;
    RETURN;
  END IF;

  UPDATE commerce_customer_context.demo_newsletter_choices item SET
    decision = p_decision,
    revision = item.revision + 1,
    notice_version = p_notice_version,
    changed_at = clock_timestamp(),
    last_request_id = p_request_id
    WHERE item.tenant_id = p_tenant_id AND item.legal_entity_id = p_legal_entity_id AND item.party_id = p_party_id
      AND item.revision = p_expected_revision;
  IF FOUND THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.read_demo_newsletter_choice(p_tenant_id, p_legal_entity_id, p_party_id);
  END IF;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_demo_newsletter_choice(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_customer_context.write_demo_newsletter_choice(uuid, uuid, uuid, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_demo_newsletter_choice(uuid, uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION commerce_customer_context.write_demo_newsletter_choice(uuid, uuid, uuid, integer, text, text, uuid) TO ontos_runtime;
