CREATE TABLE "core"."module_credential_holder_leases" (
	"boot_id" uuid PRIMARY KEY,
	"host_id" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_module_credential_holder_leases_host_ck" CHECK (length("host_id") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "core"."module_credential_holder_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "core_module_credential_holder_leases_select" ON "core"."module_credential_holder_leases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING (true);--> statement-breakpoint
-- Only the app host's administrative identity writes leases (default privileges may have granted the runtime more).
REVOKE ALL ON TABLE "core"."module_credential_holder_leases" FROM PUBLIC, "ontos_runtime";--> statement-breakpoint
GRANT SELECT ON TABLE "core"."module_credential_holder_leases" TO "ontos_runtime";
