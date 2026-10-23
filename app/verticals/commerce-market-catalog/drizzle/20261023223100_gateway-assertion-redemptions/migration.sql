CREATE TABLE "commerce_market_catalog"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "commerce_market_catalog_redemption_expiry" ON "commerce_market_catalog"."gateway_assertion_redemptions" ("expires_at");
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "commerce_market_catalog"."gateway_assertion_redemptions" TO ontos_runtime;
