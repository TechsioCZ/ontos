CREATE TABLE "commerce_auth"."step_up_challenge" (
	"attempts_remaining" smallint NOT NULL,
	"challenge_id_hash" text PRIMARY KEY,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"provider_subject_id" text NOT NULL,
	"session_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_auth"."step_up_challenge_attempt" (
	"challenge_id_hash" text NOT NULL,
	"provider_subject_id" text NOT NULL,
	"reservation_id" text PRIMARY KEY,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_auth"."two_factor" (
	"backup_codes" text NOT NULL,
	"failed_verification_count" integer DEFAULT 0,
	"id" text PRIMARY KEY,
	"locked_until" timestamp with time zone,
	"secret" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true
);
--> statement-breakpoint
ALTER TABLE "commerce_auth"."user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false;--> statement-breakpoint
CREATE INDEX "commerce_auth_step_up_challenge_expires_at_idx" ON "commerce_auth"."step_up_challenge" ("expires_at");--> statement-breakpoint
CREATE INDEX "commerce_auth_step_up_attempt_challenge_id_hash_idx" ON "commerce_auth"."step_up_challenge_attempt" ("challenge_id_hash");--> statement-breakpoint
CREATE INDEX "commerce_auth_two_factor_secret_idx" ON "commerce_auth"."two_factor" ("secret");--> statement-breakpoint
CREATE INDEX "commerce_auth_two_factor_user_id_idx" ON "commerce_auth"."two_factor" ("user_id");--> statement-breakpoint
ALTER TABLE "commerce_auth"."step_up_challenge_attempt" ADD CONSTRAINT "step_up_challenge_attempt_e0VhfdfqFJyp_fkey" FOREIGN KEY ("challenge_id_hash") REFERENCES "commerce_auth"."step_up_challenge"("challenge_id_hash") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "commerce_auth"."two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "commerce_auth"."user"("id") ON DELETE CASCADE;