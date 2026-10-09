CREATE SCHEMA "commerce_auth";
--> statement-breakpoint
CREATE TABLE "commerce_auth"."account" (
	"id" text PRIMARY KEY,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_auth"."rate_limit" (
	"key" text PRIMARY KEY,
	"count" bigint NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_auth"."session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_auth"."user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commerce_auth"."verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_auth_account_issuer_account_id_uk" ON "commerce_auth"."account" ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "commerce_auth_account_user_id_idx" ON "commerce_auth"."account" ("user_id");--> statement-breakpoint
CREATE INDEX "commerce_auth_session_user_id_idx" ON "commerce_auth"."session" ("user_id");--> statement-breakpoint
CREATE INDEX "commerce_auth_verification_identifier_idx" ON "commerce_auth"."verification" ("identifier");--> statement-breakpoint
ALTER TABLE "commerce_auth"."account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "commerce_auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "commerce_auth"."session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "commerce_auth"."user"("id") ON DELETE CASCADE;