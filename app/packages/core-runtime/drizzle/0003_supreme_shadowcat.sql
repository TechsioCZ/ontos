CREATE TABLE IF NOT EXISTS "core"."media_asset_bytes" (
	"bytes" "bytea" NOT NULL,
	"media_asset_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "core"."media_asset_bytes" ADD CONSTRAINT "media_asset_bytes_media_asset_id_media_assets_media_asset_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "core"."media_assets"("media_asset_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "core"."media_asset_bytes" ADD CONSTRAINT "media_asset_bytes_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
