-- Custom SQL migration file, put your code below! --
-- Typed Drizzle owns the table, its unique identity and the expiry index in the preceding generated migration.
-- Schema and table privileges cannot be expressed by that typed DDL API and are this migration's only job.
-- The replay ledger carries no Tenant scope, so it has no RLS; the runtime role may only read, insert and expire rows.
REVOKE ALL ON SCHEMA "communications" FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "communications" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."gateway_assertion_redemptions" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "communications"."gateway_assertion_redemptions" TO "ontos_runtime";
