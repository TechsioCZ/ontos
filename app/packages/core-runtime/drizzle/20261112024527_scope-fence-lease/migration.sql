-- The access fence table is locked by every protected Action (FOR SHARE) of the release still serving. This
-- migration's ALTERs need its exclusive lock: waiting for it would queue every later Action behind them for as long
-- as the wait lasts. Fail the deploy fast instead; the old release keeps serving and the deploy is run again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "core"."access_scope_fences" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."access_scope_fences" ADD CONSTRAINT "access_scope_fences_lease_ck" CHECK ("state" <> 'Ready' or "lease_expires_at" is null);--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
