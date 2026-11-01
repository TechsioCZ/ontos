CREATE TABLE "core"."media_asset_renditions" (
	"tenant_id" uuid,
	"media_asset_id" uuid,
	"rendition" text,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"content_sha256" text NOT NULL,
	"bytes" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_media_asset_renditions_pk" PRIMARY KEY("tenant_id","media_asset_id","rendition"),
	CONSTRAINT "core_media_asset_renditions_rendition_ck" CHECK ("rendition" in ('full', 'thumbnail')),
	CONSTRAINT "core_media_asset_renditions_size_ck" CHECK ("byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."media_asset_renditions" ADD CONSTRAINT "media_asset_renditions_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."media_asset_renditions" ADD CONSTRAINT "core_media_asset_renditions_tenant_asset_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "core"."media_assets"("tenant_id","media_asset_id") ON DELETE RESTRICT;