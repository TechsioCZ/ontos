ALTER TABLE "ticketing"."multi_select_options" DROP CONSTRAINT "multi_select_options_property_definition_id_task_property_definitions_property_definition_id_fk";
--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_selections" DROP CONSTRAINT "ticketing_task_multi_select_selections_value_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_multi_select_values_ownership_uk" ON "ticketing"."task_multi_select_values" USING btree ("tenant_id","task_id","property_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_property_definitions_tenant_definition_uk" ON "ticketing"."task_property_definitions" USING btree ("tenant_id","property_definition_id");--> statement-breakpoint
ALTER TABLE "ticketing"."multi_select_options" ADD CONSTRAINT "ticketing_multi_select_options_definition_fk" FOREIGN KEY ("tenant_id","property_definition_id") REFERENCES "ticketing"."task_property_definitions"("tenant_id","property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_selections" ADD CONSTRAINT "ticketing_task_multi_select_selections_value_fk" FOREIGN KEY ("tenant_id","task_id","property_definition_id") REFERENCES "ticketing"."task_multi_select_values"("tenant_id","task_id","property_definition_id") ON DELETE cascade ON UPDATE no action;
