CREATE TABLE "core"."application_composition_durable_work" (
	"owner_module_key" text,
	"original_revision" text,
	"work_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_application_composition_durable_work_pk" PRIMARY KEY("owner_module_key","original_revision","work_id"),
	CONSTRAINT "core_application_composition_durable_work_owner_ck" CHECK ("owner_module_key" ~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)*$'),
	CONSTRAINT "core_application_composition_durable_work_revision_ck" CHECK ("original_revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "core_application_composition_durable_work_id_ck" CHECK (length("work_id") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "core"."application_composition_durable_work" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "core_application_composition_durable_work_select" ON "core"."application_composition_durable_work" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "core"."application_composition_durable_work" FROM PUBLIC, "ontos_runtime";--> statement-breakpoint
GRANT SELECT ON TABLE "core"."application_composition_durable_work" TO "ontos_runtime";
