CREATE SCHEMA "accounting";
--> statement-breakpoint
CREATE TABLE "accounting"."invoice" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_name" text NOT NULL,
	"due_date" date NOT NULL,
	"invoice_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL
);
