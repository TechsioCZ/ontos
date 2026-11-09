CREATE TABLE "inventory"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_gateway_redemptions_identity_uk" UNIQUE("issuer","audience","jti"),
	CONSTRAINT "inventory_gateway_redemptions_audience_ck" CHECK ("audience" = 'inventory')
);
--> statement-breakpoint
CREATE INDEX "inventory_gateway_redemptions_expiry_idx" ON "inventory"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
-- Replay evidence is written before a Tenant can be trusted and contains no business data.
REVOKE ALL ON TABLE "inventory"."gateway_assertion_redemptions" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "inventory"."gateway_assertion_redemptions" FROM "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "inventory"."gateway_assertion_redemptions" TO "ontos_runtime";
