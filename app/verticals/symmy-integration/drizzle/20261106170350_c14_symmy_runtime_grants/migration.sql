GRANT USAGE ON SCHEMA "symmy_integration" TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "symmy_integration"."job_routes" TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "symmy_integration"."import_jobs" TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "symmy_integration"."gateway_assertion_redemptions" TO "ontos_runtime";
