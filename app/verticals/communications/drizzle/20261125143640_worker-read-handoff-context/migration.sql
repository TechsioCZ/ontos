-- The last stoppable handoff decides ONE Message Intent, but two of its facts live beside it, not in it (#1395 BR-07, #1396 BR-09,
-- BR-10): an approved indivisible audience is complete only when every Message Intent of the same request and type is ready, and
-- a provider-side block is evidence about the ORIGINAL ENDPOINT, which an earlier message to the same contact may have produced.
-- This read answers both from the stored facts and decides nothing: for every Message Intent of the request and type (the
-- worker's own included) it names the intent, its audience slot and, when the LATEST conclusive provider evidence for the same original endpoint
-- (same channel, contact reference and contact revision) is a permanent bounce, the observation that evidences it. A later proven
-- delivery to that endpoint replaces the bounce as the latest conclusive fact, so a stale bounce never blocks a working endpoint.
-- Forward only: a new routine with the same scope assertion and grants as its siblings; no table, row or other routine changes.
CREATE FUNCTION "communications"."worker_read_handoff_context"(p_tenant_id uuid, p_intent_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  RETURN QUERY
  SELECT jsonb_build_object('intents', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'intentId', member."intent_id",
    'slotKey', member."slot_key",
    'providerBlockRef', (
      SELECT latest."observation_id"
      FROM (
        SELECT observation."observation_id", observation."kind"
        FROM "communications"."provider_observations" AS observation
        JOIN "communications"."message_intents" AS earlier
          ON earlier."tenant_id" = observation."tenant_id" AND earlier."intent_id" = observation."intent_id"
        WHERE observation."tenant_id" = member."tenant_id"
          AND member."endpoint_pin" IS NOT NULL
          AND earlier."endpoint_pin" IS NOT NULL
          AND (earlier."endpoint_pin" -> 'contactRef') = (member."endpoint_pin" -> 'contactRef')
          AND (earlier."endpoint_pin" ->> 'channel') = (member."endpoint_pin" ->> 'channel')
          AND (earlier."endpoint_pin" ->> 'contactRevision') IS NOT DISTINCT FROM (member."endpoint_pin" ->> 'contactRevision')
          AND (observation."kind" = 'DELIVERY_PROVEN'
            OR (observation."kind" = 'DELIVERY_FAILED' AND (observation."evidence" ->> 'failureClass') = 'BOUNCED_PERMANENT'))
        ORDER BY observation."recorded_seq" DESC
        LIMIT 1) AS latest
      WHERE latest."kind" = 'DELIVERY_FAILED')))
    ORDER BY member."intent_id"), '[]'::jsonb))
  FROM "communications"."message_intents" AS member
  JOIN "communications"."message_intents" AS self
    ON self."tenant_id" = member."tenant_id" AND self."request_id" = member."request_id" AND self."type_id" = member."type_id"
  WHERE self."tenant_id" = p_tenant_id AND self."intent_id" = p_intent_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."worker_read_handoff_context"(uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "communications"."worker_read_handoff_context"(uuid, uuid) TO "ontos_runtime";
