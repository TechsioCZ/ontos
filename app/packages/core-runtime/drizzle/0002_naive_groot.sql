CREATE TABLE "core"."principal_directory_field_visibility" (
	"email_visible" boolean DEFAULT false NOT NULL,
	"login_visible" boolean DEFAULT false NOT NULL,
	"subject_principal_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"viewer_principal_id" uuid NOT NULL,
	CONSTRAINT "core_principal_directory_field_visibility_pk" PRIMARY KEY("viewer_principal_id","subject_principal_id")
);
--> statement-breakpoint
ALTER TABLE "core"."principal_directory_entries" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "core"."principal_directory_entries" ADD COLUMN "login" text;--> statement-breakpoint
ALTER TABLE "core"."principal_directory_field_visibility" ADD CONSTRAINT "principal_directory_field_visibility_subject_principal_id_principals_principal_id_fk" FOREIGN KEY ("subject_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."principal_directory_field_visibility" ADD CONSTRAINT "principal_directory_field_visibility_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."principal_directory_field_visibility" ADD CONSTRAINT "principal_directory_field_visibility_viewer_principal_id_principals_principal_id_fk" FOREIGN KEY ("viewer_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_principal_directory_field_visibility_tenant_idx" ON "core"."principal_directory_field_visibility" USING btree ("tenant_id","viewer_principal_id");