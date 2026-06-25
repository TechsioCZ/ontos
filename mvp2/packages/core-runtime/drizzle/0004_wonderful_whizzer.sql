CREATE TABLE "core"."outbox_deliveries" (
	"outbox_delivery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_message_id" uuid NOT NULL,
	"worker_key" text NOT NULL,
	"executing_module_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_outbox_deliveries_status_ck" CHECK ("core"."outbox_deliveries"."status" in ('pending', 'processing', 'done', 'dead')),
	CONSTRAINT "core_outbox_deliveries_attempts_count_ck" CHECK ("core"."outbox_deliveries"."attempts_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" DROP CONSTRAINT "core_outbox_messages_status_ck";--> statement-breakpoint
ALTER TABLE "core"."outbox_attempts" DROP CONSTRAINT "outbox_attempts_outbox_message_id_outbox_messages_outbox_message_id_fk";
--> statement-breakpoint
DROP INDEX "core"."core_outbox_messages_pending_idx";--> statement-breakpoint
ALTER TABLE "core"."outbox_attempts" ADD COLUMN "outbox_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" ADD COLUMN "matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_outbox_message_id_outbox_messages_outbox_message_id_fk" FOREIGN KEY ("outbox_message_id") REFERENCES "core"."outbox_messages"("outbox_message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_outbox_deliveries_message_worker_uk" ON "core"."outbox_deliveries" USING btree ("outbox_message_id","worker_key");--> statement-breakpoint
CREATE INDEX "core_outbox_deliveries_pending_idx" ON "core"."outbox_deliveries" USING btree ("available_at") WHERE "core"."outbox_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "core_outbox_deliveries_message_idx" ON "core"."outbox_deliveries" USING btree ("outbox_message_id");--> statement-breakpoint
CREATE INDEX "core_outbox_deliveries_worker_status_idx" ON "core"."outbox_deliveries" USING btree ("worker_key","status");--> statement-breakpoint
INSERT INTO "core"."outbox_deliveries" (
	"outbox_message_id",
	"worker_key",
	"executing_module_key",
	"status",
	"attempts_count",
	"available_at",
	"created_at",
	"updated_at"
)
SELECT
	"core"."outbox_attempts"."outbox_message_id",
	"core"."outbox_attempts"."worker_id",
	"core"."outbox_attempts"."worker_id",
	"core"."outbox_messages"."status",
	count(*)::integer,
	"core"."outbox_messages"."available_at",
	min("core"."outbox_messages"."created_at"),
	now()
FROM "core"."outbox_attempts"
JOIN "core"."outbox_messages"
	ON "core"."outbox_messages"."outbox_message_id" = "core"."outbox_attempts"."outbox_message_id"
GROUP BY
	"core"."outbox_attempts"."outbox_message_id",
	"core"."outbox_attempts"."worker_id",
	"core"."outbox_messages"."status",
	"core"."outbox_messages"."available_at";--> statement-breakpoint
UPDATE "core"."outbox_attempts"
SET "outbox_delivery_id" = "core"."outbox_deliveries"."outbox_delivery_id"
FROM "core"."outbox_deliveries"
WHERE
	"core"."outbox_deliveries"."outbox_message_id" = "core"."outbox_attempts"."outbox_message_id"
	AND "core"."outbox_deliveries"."worker_key" = "core"."outbox_attempts"."worker_id";--> statement-breakpoint
ALTER TABLE "core"."outbox_attempts" ALTER COLUMN "outbox_delivery_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."outbox_attempts" ADD CONSTRAINT "outbox_attempts_outbox_delivery_id_outbox_deliveries_outbox_delivery_id_fk" FOREIGN KEY ("outbox_delivery_id") REFERENCES "core"."outbox_deliveries"("outbox_delivery_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_outbox_attempts_delivery_started_idx" ON "core"."outbox_attempts" USING btree ("outbox_delivery_id","started_at");--> statement-breakpoint
CREATE INDEX "core_outbox_messages_unmatched_idx" ON "core"."outbox_messages" USING btree ("created_at") WHERE "core"."outbox_messages"."matched_at" is null;--> statement-breakpoint
ALTER TABLE "core"."outbox_attempts" DROP COLUMN "outbox_message_id";--> statement-breakpoint
ALTER TABLE "core"."outbox_attempts" DROP COLUMN "worker_id";--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" DROP COLUMN "attempts_count";--> statement-breakpoint
ALTER TABLE "core"."outbox_messages" DROP COLUMN "available_at";
