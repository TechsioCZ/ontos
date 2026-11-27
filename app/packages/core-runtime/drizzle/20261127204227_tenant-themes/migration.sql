CREATE TABLE "core"."tenant_theme_attachments" (
	"tenant_id" uuid PRIMARY KEY,
	"theme_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."tenant_theme_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."tenant_themes" (
	"tenant_id" uuid,
	"theme_key" text,
	"label" text NOT NULL,
	"modes" text[] NOT NULL,
	"tokens" jsonb NOT NULL,
	"defaults" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_tenant_themes_pk" PRIMARY KEY("tenant_id","theme_key"),
	CONSTRAINT "core_tenant_themes_key_ck" CHECK (length("theme_key") <= 64 and "theme_key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
	CONSTRAINT "core_tenant_themes_label_ck" CHECK (length("label") between 1 and 120),
	CONSTRAINT "core_tenant_themes_modes_ck" CHECK (array_ndims("modes") = 1 and "modes" <@ array['light', 'dark']::text[] and (cardinality("modes") = 1 or (cardinality("modes") = 2 and "modes" @> array['light', 'dark']::text[])))
);
--> statement-breakpoint
ALTER TABLE "core"."tenant_themes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."tenant_theme_attachments" ADD CONSTRAINT "tenant_theme_attachments_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."tenant_theme_attachments" ADD CONSTRAINT "core_tenant_theme_attachments_theme_fk" FOREIGN KEY ("tenant_id","theme_key") REFERENCES "core"."tenant_themes"("tenant_id","theme_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."tenant_themes" ADD CONSTRAINT "tenant_themes_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "core_tenant_theme_attachments_shared_runtime_all" ON "core"."tenant_theme_attachments" AS PERMISSIVE FOR ALL TO "ontos_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "core_tenant_themes_shared_runtime_all" ON "core"."tenant_themes" AS PERMISSIVE FOR ALL TO "ontos_runtime" USING (true) WITH CHECK (true);