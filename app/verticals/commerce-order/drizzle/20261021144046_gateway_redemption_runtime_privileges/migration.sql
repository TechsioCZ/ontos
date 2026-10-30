-- Custom SQL migration file, put your code below! --
-- Pre-authentication replay infrastructure has no trusted tenant scope yet.
-- Typed Drizzle owns the preceding table/identity/index DDL. Privileges are
-- intentionally narrower than business mutation privileges and cannot be typed DDL.
REVOKE ALL ON TABLE commerce_order.gateway_assertion_redemptions FROM PUBLIC;
REVOKE ALL ON TABLE commerce_order.gateway_assertion_redemptions FROM ontos_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE commerce_order.gateway_assertion_redemptions TO ontos_runtime;
