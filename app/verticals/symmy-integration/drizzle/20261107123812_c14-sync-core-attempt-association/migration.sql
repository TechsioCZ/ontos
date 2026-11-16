CREATE TABLE "symmy_integration"."sync_admission_attempts" (
	"invocation_id" uuid PRIMARY KEY,
	"admission_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."sync_admission_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."sync_admission_attempts" ADD CONSTRAINT "sync_admission_attempts_Sv43IZsUuhcP_fkey" FOREIGN KEY ("admission_id") REFERENCES "symmy_integration"."sync_admissions"("admission_id");--> statement-breakpoint
CREATE POLICY "symmy_sync_admission_attempts_tenant_select" ON "symmy_integration"."sync_admission_attempts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."sync_admission_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_sync_admission_attempts_tenant_insert" ON "symmy_integration"."sync_admission_attempts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."sync_admission_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_sync_admission_attempts_tenant_update" ON "symmy_integration"."sync_admission_attempts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."sync_admission_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."sync_admission_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_sync_admission_attempts_tenant_delete" ON "symmy_integration"."sync_admission_attempts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."sync_admission_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);