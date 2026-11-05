ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts" ADD COLUMN "storefront_origin" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts" ADD CONSTRAINT "ccc_portal_enrollment_attempts_storefront_origin_ck" CHECK ("storefront_origin" is null or (length("storefront_origin") <= 300 and "storefront_origin" ~ '^https?://[^/?#@[:space:]]+$'));--> statement-breakpoint
-- The storefront origin is written once, right after the Attempt is created, by the start route that admitted it.
CREATE FUNCTION commerce_customer_context.write_portal_enrollment_storefront_origin(
  p_tenant_id uuid, p_attempt_id uuid, p_storefront_origin text
) RETURNS TABLE(written boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE current_origin text; found_attempt boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT attempt.storefront_origin, true INTO current_origin, found_attempt
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
      AND (nullif(current_setting('ontos.legal_entity_id', true), '') IS NULL
        OR attempt.target_legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid)
    FOR UPDATE;
  IF found_attempt IS NOT TRUE THEN
    RAISE EXCEPTION 'portal enrollment not found' USING ERRCODE = '23514';
  END IF;
  IF current_origin IS NOT NULL THEN
    -- Immutable: the first admitted storefront stays the Attempt's storefront.
    RETURN QUERY SELECT current_origin = p_storefront_origin;
    RETURN;
  END IF;
  UPDATE commerce_customer_context.portal_enrollment_attempts SET storefront_origin = p_storefront_origin
    WHERE tenant_id = p_tenant_id AND portal_enrollment_attempt_id = p_attempt_id;
  RETURN QUERY SELECT true;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_portal_enrollment_storefront_origin(p_tenant_id uuid, p_attempt_id uuid)
RETURNS TABLE(storefront_origin text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT attempt.storefront_origin
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
      AND attempt.storefront_origin IS NOT NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.write_portal_enrollment_storefront_origin(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.write_portal_enrollment_storefront_origin(uuid, uuid, text) TO ontos_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_portal_enrollment_storefront_origin(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_portal_enrollment_storefront_origin(uuid, uuid) TO ontos_runtime;
