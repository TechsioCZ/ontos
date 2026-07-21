CREATE TABLE "core"."principal_directory_entries" (
	"membership_kind" text NOT NULL,
	"membership_status" text NOT NULL,
	"principal_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "core_principal_directory_entries_membership_kind_ck" CHECK ("core"."principal_directory_entries"."membership_kind" in ('member', 'guest')),
	CONSTRAINT "core_principal_directory_entries_membership_status_ck" CHECK ("core"."principal_directory_entries"."membership_status" in ('active', 'departed'))
);
--> statement-breakpoint
ALTER TABLE "core"."principal_directory_entries" ADD CONSTRAINT "principal_directory_entries_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."principal_directory_entries" ADD CONSTRAINT "principal_directory_entries_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_principal_directory_entries_tenant_membership_idx" ON "core"."principal_directory_entries" USING btree ("tenant_id","membership_status","membership_kind");