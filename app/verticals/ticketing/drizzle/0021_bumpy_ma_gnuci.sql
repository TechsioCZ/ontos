ALTER TABLE "ticketing"."task_multi_select_values" DROP CONSTRAINT "task_multi_select_values_property_definition_id_task_property_definitions_property_definition_id_fk";
--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" DROP CONSTRAINT "task_multi_select_values_task_id_tasks_task_id_fk";
--> statement-breakpoint
ALTER TABLE "ticketing"."multi_select_options" ADD COLUMN "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD COLUMN "collection_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD COLUMN "schema_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD COLUMN "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_property_definitions_tenant_schema_definition_uk" ON "ticketing"."task_property_definitions" USING btree ("tenant_id","schema_id","property_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_schemas_tenant_collection_schema_uk" ON "ticketing"."task_schemas" USING btree ("tenant_id","collection_id","schema_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_tasks_tenant_collection_task_uk" ON "ticketing"."tasks" USING btree ("tenant_id","collection_id","task_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD CONSTRAINT "ticketing_task_multi_select_values_task_fk" FOREIGN KEY ("tenant_id","collection_id","task_id") REFERENCES "ticketing"."tasks"("tenant_id","collection_id","task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD CONSTRAINT "ticketing_task_multi_select_values_schema_fk" FOREIGN KEY ("tenant_id","collection_id","schema_id") REFERENCES "ticketing"."task_schemas"("tenant_id","collection_id","schema_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD CONSTRAINT "ticketing_task_multi_select_values_definition_fk" FOREIGN KEY ("tenant_id","schema_id","property_definition_id") REFERENCES "ticketing"."task_property_definitions"("tenant_id","schema_id","property_definition_id") ON DELETE restrict ON UPDATE no action;
