-- Exact recovery lookup for a RESERVE Action Invocation whose stable idempotency key already committed.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_market_retirement_reservation"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_market_resource_id text,
  p_action_invocation_id uuid
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
BEGIN
  PERFORM assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT jsonb_build_object(
    'assessmentDigest', reservation.assessment_digest,
    'lifecycle', reservation.lifecycle,
    'marketRef', jsonb_build_object(
      'moduleId', 'commerce.market-catalog',
      'resourceId', reservation.market_resource_id,
      'resourceType', 'commerce.market-catalog.market',
      'tenantId', reservation.tenant_id::text
    ),
    'marketRevision', reservation.market_revision,
    'reservationToken', reservation.market_retirement_reservation_id::text,
    'reservationVersion', reservation.reservation_version,
    'tenantId', reservation.tenant_id::text
  )
  FROM market_retirement_reservations AS reservation
  WHERE reservation.tenant_id = p_tenant_id
    AND reservation.legal_entity_id = p_legal_entity_id
    AND reservation.action_invocation_id = p_action_invocation_id
    AND reservation.market_resource_id = p_market_resource_id;
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_market_retirement_reservation"(uuid, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_market_retirement_reservation"(uuid, uuid, text, uuid) TO "ontos_runtime";
