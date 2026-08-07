ALTER TABLE "core"."audit_events" DROP CONSTRAINT "audit_events_action_invocation_id_action_invocations_action_invocation_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."data_access_events" DROP CONSTRAINT "data_access_events_action_invocation_id_action_invocations_action_invocation_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."domain_events" DROP CONSTRAINT "domain_events_action_invocation_id_action_invocations_action_invocation_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."evidence_references" DROP CONSTRAINT "evidence_references_action_invocation_id_action_invocations_action_invocation_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."media_links" DROP CONSTRAINT "media_links_action_invocation_id_action_invocations_action_invocation_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."tenant_module_state_changes" DROP CONSTRAINT "tenant_module_state_changes_action_invocation_id_action_invocations_action_invocation_id_fk";
