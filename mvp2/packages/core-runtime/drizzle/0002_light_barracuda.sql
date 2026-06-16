CREATE SCHEMA "properties";
--> statement-breakpoint
CREATE TABLE "properties"."unit" (
	"unit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
