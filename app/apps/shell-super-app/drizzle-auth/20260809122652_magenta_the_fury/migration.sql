CREATE TABLE "auth"."apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "auth"."support_impersonation_recovery" (
	"impersonation_session_id" text PRIMARY KEY NOT NULL,
	"original_auth_binding_id" uuid NOT NULL,
	"original_principal_id" uuid NOT NULL,
	"original_session_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_principal_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "impersonation_reason" text;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "impersonation_action_id" text;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "impersonation_original_auth_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "impersonation_original_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "impersonation_original_session_id" text;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "impersonation_target_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "banned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "ban_expires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_apikey_config_id_idx" ON "auth"."apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "auth_apikey_reference_id_idx" ON "auth"."apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "auth_apikey_key_idx" ON "auth"."apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "auth_support_impersonation_recovery_original_session_idx" ON "auth"."support_impersonation_recovery" USING btree ("original_session_id");