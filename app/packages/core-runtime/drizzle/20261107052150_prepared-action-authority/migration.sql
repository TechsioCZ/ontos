ALTER TABLE "core"."action_invocations" DROP CONSTRAINT "core_action_invocations_status_ck", ADD CONSTRAINT "core_action_invocations_status_ck" CHECK ("status" in ('received', 'proposed', 'rejected', 'running', 'succeeded', 'failed', 'indeterminate', 'replayed'));--> statement-breakpoint
CREATE POLICY "access_scope_fences_gateway_request_select" ON "core"."access_scope_fences" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_scope_fences"."tenant_id" = (select trust.current_tenant_id()));
--> statement-breakpoint
-- Exact read-only revision metadata. Fence locking remains the existing security-definer routine.
GRANT SELECT (revision, scope_id, state, tenant_id) ON core.access_scope_fences TO party_registry_runtime;
