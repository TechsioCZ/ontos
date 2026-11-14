CREATE TABLE "commerce_customer_context"."customer_consent_receipts" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid PRIMARY KEY,
	"receipt" jsonb NOT NULL,
	CONSTRAINT "ccc_consent_receipt_scope_identity_uk" UNIQUE("tenant_id","legal_entity_id","receipt_id"),
	CONSTRAINT "ccc_consent_receipt_object_ck" CHECK (jsonb_typeof("receipt") = 'object' and length("receipt"::text) <= 12000 and "receipt"->>'requestId' = "receipt_id"::text)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_consent_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ccc_consent_receipt_scope_select" ON "commerce_customer_context"."customer_consent_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_consent_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_consent_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_consent_receipt_scope_insert" ON "commerce_customer_context"."customer_consent_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_consent_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_consent_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_consent_receipt_scope_update" ON "commerce_customer_context"."customer_consent_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_consent_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_consent_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_consent_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_consent_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_consent_receipt_scope_delete" ON "commerce_customer_context"."customer_consent_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_consent_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_consent_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_consent_receipt_scope_owner_routine" ON "commerce_customer_context"."customer_consent_receipts" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_consent_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_consent_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_consent_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_consent_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE commerce_customer_context.customer_consent_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE commerce_customer_context.customer_consent_receipts FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER ccc_consent_receipts_append_only
BEFORE UPDATE OR DELETE ON commerce_customer_context.customer_consent_receipts
FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.reject_append_only_mutation();
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_customer_consent_receipt(
  p_tenant_id uuid, p_legal_entity_id uuid, p_receipt_id uuid
) RETURNS TABLE(receipt jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified consent scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT item.receipt FROM commerce_customer_context.customer_consent_receipts item
    WHERE item.tenant_id = p_tenant_id AND item.legal_entity_id = p_legal_entity_id AND item.receipt_id = p_receipt_id;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.write_customer_consent_receipt(
  p_tenant_id uuid, p_legal_entity_id uuid, p_receipt_id uuid, p_receipt text
) RETURNS TABLE(receipt jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified consent scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_receipt::jsonb->'scope'->'privacySubjectRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_receipt::jsonb->'scope'->>'controllerRef' IS DISTINCT FROM p_legal_entity_id::text THEN
    RAISE EXCEPTION 'consent receipt scope mismatch' USING ERRCODE = '42501';
  END IF;
  INSERT INTO commerce_customer_context.customer_consent_receipts(tenant_id, legal_entity_id, receipt_id, receipt)
    VALUES (p_tenant_id, p_legal_entity_id, p_receipt_id, p_receipt::jsonb)
    ON CONFLICT (receipt_id) DO NOTHING;
  RETURN QUERY SELECT item.receipt FROM commerce_customer_context.customer_consent_receipts item
    WHERE item.tenant_id = p_tenant_id AND item.legal_entity_id = p_legal_entity_id AND item.receipt_id = p_receipt_id;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_consent_receipt(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_customer_context.write_customer_consent_receipt(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_consent_receipt(uuid, uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION commerce_customer_context.write_customer_consent_receipt(uuid, uuid, uuid, text) TO ontos_runtime;
