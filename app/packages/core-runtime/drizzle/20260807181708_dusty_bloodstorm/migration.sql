ALTER TABLE "core"."action_invocations" DROP CONSTRAINT "action_invocations_legal_entity_id_legal_entities_legal_entity_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."action_invocations" DROP CONSTRAINT "action_invocations_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."action_invocations" DROP CONSTRAINT "action_invocations_auth_binding_id_principal_auth_bindings_principal_auth_binding_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."action_invocations" DROP CONSTRAINT "action_invocations_impersonated_by_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."audit_events" DROP CONSTRAINT "audit_events_legal_entity_id_legal_entities_legal_entity_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."audit_events" DROP CONSTRAINT "audit_events_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."audit_events" DROP CONSTRAINT "audit_events_auth_binding_id_principal_auth_bindings_principal_auth_binding_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."audit_events" DROP CONSTRAINT "audit_events_impersonated_by_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."data_access_events" DROP CONSTRAINT "data_access_events_legal_entity_id_legal_entities_legal_entity_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."data_access_events" DROP CONSTRAINT "data_access_events_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."data_access_events" DROP CONSTRAINT "data_access_events_auth_binding_id_principal_auth_bindings_principal_auth_binding_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."data_access_events" DROP CONSTRAINT "data_access_events_impersonated_by_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."domain_events" DROP CONSTRAINT "domain_events_legal_entity_id_legal_entities_legal_entity_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."evidence_references" DROP CONSTRAINT "evidence_references_legal_entity_id_legal_entities_legal_entity_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."evidence_references" DROP CONSTRAINT "evidence_references_media_asset_id_media_assets_media_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."evidence_references" DROP CONSTRAINT "evidence_references_audit_event_id_audit_events_audit_event_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."evidence_references" DROP CONSTRAINT "evidence_references_data_access_event_id_data_access_events_data_access_event_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."evidence_references" DROP CONSTRAINT "evidence_references_domain_event_id_domain_events_domain_event_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."media_assets" DROP CONSTRAINT "media_assets_legal_entity_id_legal_entities_legal_entity_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."media_assets" DROP CONSTRAINT "media_assets_ingested_by_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."media_links" DROP CONSTRAINT "media_links_media_asset_id_media_assets_media_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."media_links" DROP CONSTRAINT "media_links_linked_by_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" DROP CONSTRAINT "outbox_messages_domain_event_id_domain_events_domain_event_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "principal_auth_bindings_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."search_index_entries" DROP CONSTRAINT "search_index_entries_legal_entity_id_legal_entities_legal_entity_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."tenant_module_state_changes" DROP CONSTRAINT "tenant_module_state_changes_changed_by_principal_id_principals_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "core_audit_events_tenant_auth_binding_fk" FOREIGN KEY ("tenant_id","auth_binding_id") REFERENCES "core"."principal_auth_bindings"("tenant_id","principal_auth_binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_events" ADD CONSTRAINT "core_audit_events_tenant_impersonator_fk" FOREIGN KEY ("tenant_id","impersonated_by_principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "core_data_access_events_tenant_auth_binding_fk" FOREIGN KEY ("tenant_id","auth_binding_id") REFERENCES "core"."principal_auth_bindings"("tenant_id","principal_auth_binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."data_access_events" ADD CONSTRAINT "core_data_access_events_tenant_impersonator_fk" FOREIGN KEY ("tenant_id","impersonated_by_principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;