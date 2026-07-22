ALTER TABLE "ticketing"."task_collections" ADD COLUMN "name" text;
--> statement-breakpoint
UPDATE "ticketing"."task_collections"
SET "name" = 'Untitled Collection';
--> statement-breakpoint
ALTER TABLE "ticketing"."task_collections" ALTER COLUMN "name" SET NOT NULL;
