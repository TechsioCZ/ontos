CREATE TABLE "ticketing"."task_id_assignments" (
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"number" bigint NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"task_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_id_assignments_number_ck" CHECK ("ticketing"."task_id_assignments"."number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_id_sequences" (
	"collection_id" uuid NOT NULL,
	"next_number" bigint NOT NULL,
	"property_definition_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_id_sequences_next_number_ck" CHECK ("ticketing"."task_id_sequences"."next_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD COLUMN "prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticketing"."tasks" ADD COLUMN "creation_ordinal" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "ticketing"."task_id_assignments" ADD CONSTRAINT "task_id_assignments_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_id_assignments" ADD CONSTRAINT "task_id_assignments_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_id_sequences" ADD CONSTRAINT "task_id_sequences_collection_id_task_collections_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "ticketing"."task_collections"("collection_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_id_sequences" ADD CONSTRAINT "task_id_sequences_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_id_sequences" ADD CONSTRAINT "task_id_sequences_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_id_assignments_definition_number_uk" ON "ticketing"."task_id_assignments" USING btree ("property_definition_id","number");--> statement-breakpoint
CREATE INDEX "ticketing_task_id_assignments_tenant_definition_idx" ON "ticketing"."task_id_assignments" USING btree ("tenant_id","property_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_id_sequences_collection_uk" ON "ticketing"."task_id_sequences" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_property_definitions_schema_id_datatype_uk" ON "ticketing"."task_property_definitions" USING btree ("schema_id") WHERE "ticketing"."task_property_definitions"."datatype" = 'id';--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'created_time', 'created_by', 'email', 'id', 'number', 'phone', 'select', 'text', 'url'));--> statement-breakpoint
CREATE FUNCTION "ticketing"."reject_task_id_assignment_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'Task ID assignments are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ticketing_task_id_assignments_reject_update"
BEFORE UPDATE ON "ticketing"."task_id_assignments"
FOR EACH ROW
EXECUTE FUNCTION "ticketing"."reject_task_id_assignment_update"();
