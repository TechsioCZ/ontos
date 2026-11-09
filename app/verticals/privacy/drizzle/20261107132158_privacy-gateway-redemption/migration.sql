CREATE TABLE "privacy"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_gateway_redemptions_identity_uk" UNIQUE("issuer","audience","jti"),
	CONSTRAINT "privacy_gateway_redemptions_audience_ck" CHECK ("audience" = 'privacy')
);
--> statement-breakpoint
CREATE INDEX "privacy_gateway_redemptions_expiry_idx" ON "privacy"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
-- Ingress replay evidence exists before a Tenant context can be trusted. Its exact audience
-- is constrained to this owner; it contains no Bearer, Principal or business payload.
REVOKE ALL ON TABLE "privacy"."gateway_assertion_redemptions" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "privacy"."gateway_assertion_redemptions" FROM "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "privacy"."gateway_assertion_redemptions" TO "ontos_runtime";
