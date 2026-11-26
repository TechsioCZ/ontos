-- Forced Tenant isolation and least-privilege grants for the Tenant language mode history; typed Drizzle owns its DDL
-- and policies. Every version is an immutable fact: the runtime role may only read and insert it, never update or delete.
ALTER TABLE "communications"."tenant_language_mode_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."tenant_language_mode_versions" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "communications"."tenant_language_mode_versions" TO "ontos_runtime";
