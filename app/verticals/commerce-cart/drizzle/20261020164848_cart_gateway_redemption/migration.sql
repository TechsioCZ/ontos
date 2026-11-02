CREATE TABLE "commerce_cart"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_gateway_assertion_redemptions_identity_uk" UNIQUE("issuer","audience","jti"),
	CONSTRAINT "cart_gateway_assertion_redemptions_audience_ck" CHECK ("audience" = 'commerce-cart')
);
--> statement-breakpoint
CREATE INDEX "cart_gateway_assertion_redemptions_expiry_idx" ON "commerce_cart"."gateway_assertion_redemptions" ("expires_at");
--> statement-breakpoint
-- Pre-scope technical ingress may atomically consume and observe only the returned JTI.
GRANT INSERT ON TABLE commerce_cart.gateway_assertion_redemptions TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT (jti) ON TABLE commerce_cart.gateway_assertion_redemptions TO ontos_runtime;
