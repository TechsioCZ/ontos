-- Forced Tenant isolation and least-privilege grants for the template tables; typed Drizzle owns their DDL and policies.
-- Template types, revisions and invalidations are immutable facts: the runtime role may only read and insert them.
-- An activation row may only be closed, so UPDATE is granted on its closing columns alone.
ALTER TABLE "communications"."template_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."template_activations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."template_revision_invalidations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."template_types" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "communications"."template_types" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."template_revisions" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "communications"."template_revisions" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."template_revision_invalidations" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "communications"."template_revision_invalidations" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."template_activations" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "communications"."template_activations" TO "ontos_runtime";
--> statement-breakpoint
GRANT UPDATE ("ended_at", "ended_kind", "ended_by_principal_id", "end_reason", "end_invocation_id") ON TABLE "communications"."template_activations" TO "ontos_runtime";
