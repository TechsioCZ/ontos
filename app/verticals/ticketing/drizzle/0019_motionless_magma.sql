ALTER TABLE "ticketing"."task_property_definitions" ADD COLUMN "schema_position" numeric(38, 18);--> statement-breakpoint
WITH ranked_definitions AS (
	SELECT
		"property_definition_id",
		row_number() OVER (
			PARTITION BY "schema_id"
			ORDER BY "created_at", "property_definition_id"
		)::numeric(38, 18) AS "schema_position"
	FROM "ticketing"."task_property_definitions"
)
UPDATE "ticketing"."task_property_definitions" AS "definition"
SET "schema_position" = "ranked_definitions"."schema_position"
FROM "ranked_definitions"
WHERE "definition"."property_definition_id" = "ranked_definitions"."property_definition_id";--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ALTER COLUMN "schema_position" SET DEFAULT extract(epoch from clock_timestamp());--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ALTER COLUMN "schema_position" SET NOT NULL;
