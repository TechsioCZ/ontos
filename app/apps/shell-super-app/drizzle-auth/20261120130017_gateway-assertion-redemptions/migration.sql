CREATE TABLE "auth"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_gateway_redemptions_identity_uk" ON "auth"."gateway_assertion_redemptions" ("issuer","audience","jti");--> statement-breakpoint
CREATE INDEX "auth_gateway_redemptions_expiry_idx" ON "auth"."gateway_assertion_redemptions" ("expires_at");