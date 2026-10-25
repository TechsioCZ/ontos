ALTER POLICY "contacts_organization_engagement_profiles_tenant_select" ON "contacts"."organization_engagement_profiles" TO "party_registry_runtime" USING ("contacts"."organization_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
ALTER POLICY "contacts_organization_engagement_profiles_tenant_insert" ON "contacts"."organization_engagement_profiles" TO "party_registry_runtime" WITH CHECK ("contacts"."organization_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
ALTER POLICY "contacts_organization_engagement_profiles_tenant_update" ON "contacts"."organization_engagement_profiles" TO "party_registry_runtime" USING ("contacts"."organization_engagement_profiles"."tenant_id" = (select trust.current_tenant_id())) WITH CHECK ("contacts"."organization_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
ALTER POLICY "contacts_organization_engagement_profiles_tenant_delete" ON "contacts"."organization_engagement_profiles" TO "party_registry_runtime" USING ("contacts"."organization_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
ALTER POLICY "contacts_person_engagement_profiles_tenant_select" ON "contacts"."person_engagement_profiles" TO "party_registry_runtime" USING ("contacts"."person_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
ALTER POLICY "contacts_person_engagement_profiles_tenant_insert" ON "contacts"."person_engagement_profiles" TO "party_registry_runtime" WITH CHECK ("contacts"."person_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
ALTER POLICY "contacts_person_engagement_profiles_tenant_update" ON "contacts"."person_engagement_profiles" TO "party_registry_runtime" USING ("contacts"."person_engagement_profiles"."tenant_id" = (select trust.current_tenant_id())) WITH CHECK ("contacts"."person_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
ALTER POLICY "contacts_person_engagement_profiles_tenant_delete" ON "contacts"."person_engagement_profiles" TO "party_registry_runtime" USING ("contacts"."person_engagement_profiles"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
-- The Party request role prunes replay evidence only through this routine; it holds no DELETE on the table.
-- The cutoff is clamped to the database clock minus GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS (30), so a caller
-- can never delete evidence of an assertion that is still inside its accepted window.
CREATE FUNCTION "contacts"."prune_expired_gateway_assertion_redemptions"("expired_before" timestamp with time zone) RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  delete from contacts.gateway_assertion_redemptions
  where expires_at < least(expired_before, pg_catalog.now() - interval '30 seconds')
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "contacts"."prune_expired_gateway_assertion_redemptions"(timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "contacts"."prune_expired_gateway_assertion_redemptions"(timestamp with time zone) TO "party_registry_runtime";
