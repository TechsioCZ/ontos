CREATE SCHEMA "communications";
--> statement-breakpoint
CREATE TABLE "communications"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communications_gateway_assertion_redemptions_identity_uk" UNIQUE("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "communications_gateway_assertion_redemptions_expiry_idx" ON "communications"."gateway_assertion_redemptions" ("expires_at");