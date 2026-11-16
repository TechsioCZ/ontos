CREATE FUNCTION commerce_customer_context.project_membership_source_result(p_result jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_set(p_result, '{items}', COALESCE((
    SELECT jsonb_agg(
      CASE WHEN item->>'outcome' = 'ALREADY_MANAGED' THEN jsonb_build_object(
        'groupRef', COALESCE(item->'groupRef', item #> '{membership,groupRef}'),
        'outcome', 'ALREADY_MANAGED'
      ) ELSE item END ORDER BY position
    )
    FROM jsonb_array_elements(p_result->'items') WITH ORDINALITY AS entry(item, position)
  ), '[]'::jsonb));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.project_membership_source_result(jsonb) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.project_membership_source_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.result := commerce_customer_context.project_membership_source_result(NEW.result);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.project_membership_source_receipt() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER ccc_membership_source_receipt_projection
BEFORE INSERT ON commerce_customer_context.customer_group_membership_source_receipts
FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.project_membership_source_receipt();
--> statement-breakpoint
UPDATE commerce_customer_context.customer_group_membership_source_receipts AS receipt
SET result = commerce_customer_context.project_membership_source_result(receipt.result)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(receipt.result->'items') AS entry(item)
  WHERE item->>'outcome' = 'ALREADY_MANAGED' AND item ? 'membership'
);
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  RENAME TO apply_membership_source_admitted;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_membership_source_admitted(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.apply_customer_group_membership_source(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_actor_principal_id uuid,
  p_invocation_id uuid,
  p_recorded_at timestamptz,
  p_payload jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
  SELECT admitted.outcome, commerce_customer_context.project_membership_source_result(admitted.result)
  FROM commerce_customer_context.apply_membership_source_admitted(
    p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, p_payload
  ) AS admitted;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  TO ontos_runtime;
