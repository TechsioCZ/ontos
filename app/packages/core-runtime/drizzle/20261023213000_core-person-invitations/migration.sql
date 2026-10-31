CREATE TABLE "core"."person_invitations" (
	"invitation_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"provider_subject_id" text NOT NULL,
	"verification_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_person_invitations_provider_subject_ck" CHECK (length("provider_subject_id") between 1 and 500),
	CONSTRAINT "core_person_invitations_verification_ck" CHECK (length("verification_id") between 1 and 500),
	CONSTRAINT "core_person_invitations_expiry_ck" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "core"."person_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "core_person_invitations_verification_uk" ON "core"."person_invitations" ("verification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_person_invitations_principal_uk" ON "core"."person_invitations" ("tenant_id","principal_id");--> statement-breakpoint
ALTER TABLE "core"."person_invitations" ADD CONSTRAINT "person_invitations_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."person_invitations" ADD CONSTRAINT "core_person_invitations_membership_fk" FOREIGN KEY ("tenant_id","legal_entity_id","principal_id") REFERENCES "core"."principal_company_memberships"("tenant_id","legal_entity_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "core_person_invitations_select" ON "core"."person_invitations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."person_invitations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."person_invitations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "core_person_invitations_insert" ON "core"."person_invitations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."person_invitations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."person_invitations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);