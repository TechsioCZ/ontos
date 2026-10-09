CREATE TABLE "price_group_catalog"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_group_catalog_gateway_assertion_redemptions_identity_uk" UNIQUE("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "price_group_catalog_gateway_assertion_redemptions_expiry_idx" ON "price_group_catalog"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
REVOKE ALL ON TABLE "price_group_catalog"."gateway_assertion_redemptions" FROM PUBLIC, "ontos_runtime";--> statement-breakpoint
GRANT DELETE, INSERT, SELECT ON TABLE "price_group_catalog"."gateway_assertion_redemptions" TO "ontos_runtime";
