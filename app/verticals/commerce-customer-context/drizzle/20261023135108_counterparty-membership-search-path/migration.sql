-- Pin pg_temp last so a caller's temporary objects cannot precede trusted owner relations/types.
-- Alter only the existing routine configuration; retain its identity, body, owner and grants.
ALTER FUNCTION "commerce_customer_context"."read_counterparty_customer_group_memberships"(
  uuid, uuid, text[], text[], timestamptz
)
SET search_path = pg_catalog, commerce_customer_context, pg_temp;
