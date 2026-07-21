CREATE TABLE "core"."principal_time_zone_preferences" (
	"principal_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"time_zone" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_principal_time_zone_preferences_pk" PRIMARY KEY("tenant_id","principal_id")
);
--> statement-breakpoint
ALTER TABLE "core"."principal_time_zone_preferences" ADD CONSTRAINT "principal_time_zone_preferences_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."principal_time_zone_preferences" ADD CONSTRAINT "principal_time_zone_preferences_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;