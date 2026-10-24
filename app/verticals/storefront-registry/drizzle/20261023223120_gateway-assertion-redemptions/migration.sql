CREATE TABLE "storefront_registry"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "storefront_registry_redemption_expiry" ON "storefront_registry"."gateway_assertion_redemptions" ("expires_at");
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "storefront_registry"."gateway_assertion_redemptions" TO ontos_runtime;
