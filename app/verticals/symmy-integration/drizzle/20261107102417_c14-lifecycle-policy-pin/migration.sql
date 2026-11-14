ALTER TABLE "symmy_integration"."import_jobs" ADD COLUMN "lifecycle_policy" jsonb;--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" ADD COLUMN "lifecycle_policy" jsonb;