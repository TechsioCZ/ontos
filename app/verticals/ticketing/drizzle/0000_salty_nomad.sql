CREATE SCHEMA "ticketing";
--> statement-breakpoint
CREATE TABLE "ticketing"."task_collections" (
	"collection_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_property_definitions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"datatype" text NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"property_definition_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_property_definitions_name_ck" CHECK (btrim("ticketing"."task_property_definitions"."name") <> ''),
	CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title'))
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_revisions" (
	"changed_at" timestamp with time zone NOT NULL,
	"changed_by_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"revision" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_revisions_pk" PRIMARY KEY("task_id","revision"),
	CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created')),
	CONSTRAINT "ticketing_task_revisions_revision_ck" CHECK ("ticketing"."task_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_schemas" (
	"collection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticketing"."tasks" (
	"collection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"last_edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_edited_by_principal_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	CONSTRAINT "ticketing_tasks_revision_ck" CHECK ("ticketing"."tasks"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_collections" ADD CONSTRAINT "task_collections_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "task_property_definitions_schema_id_task_schemas_schema_id_fk" FOREIGN KEY ("schema_id") REFERENCES "ticketing"."task_schemas"("schema_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "task_property_definitions_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "task_revisions_changed_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("changed_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "task_revisions_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "task_revisions_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_schemas" ADD CONSTRAINT "task_schemas_collection_id_task_collections_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "ticketing"."task_collections"("collection_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_schemas" ADD CONSTRAINT "task_schemas_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."tasks" ADD CONSTRAINT "tasks_collection_id_task_collections_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "ticketing"."task_collections"("collection_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."tasks" ADD CONSTRAINT "tasks_created_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."tasks" ADD CONSTRAINT "tasks_last_edited_by_principal_id_principals_principal_id_fk" FOREIGN KEY ("last_edited_by_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_collections_tenant_collection_uk" ON "ticketing"."task_collections" USING btree ("tenant_id","collection_id");--> statement-breakpoint
CREATE INDEX "ticketing_task_collections_tenant_idx" ON "ticketing"."task_collections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_property_definitions_schema_name_uk" ON "ticketing"."task_property_definitions" USING btree ("schema_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ticketing_task_revisions_tenant_idx" ON "ticketing"."task_revisions" USING btree ("tenant_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_schemas_collection_uk" ON "ticketing"."task_schemas" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_schemas_tenant_schema_uk" ON "ticketing"."task_schemas" USING btree ("tenant_id","schema_id");--> statement-breakpoint
CREATE INDEX "ticketing_tasks_collection_idx" ON "ticketing"."tasks" USING btree ("tenant_id","collection_id");--> statement-breakpoint
CREATE INDEX "ticketing_tasks_created_by_idx" ON "ticketing"."tasks" USING btree ("tenant_id","created_by_principal_id");