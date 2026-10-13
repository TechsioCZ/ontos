CREATE SCHEMA "commerce_customer_context_gateway";
--> statement-breakpoint
CREATE TABLE "commerce_customer_context_gateway"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "ccc_gateway_redemption_expiry" ON "commerce_customer_context_gateway"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
GRANT USAGE ON SCHEMA "commerce_customer_context_gateway" TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "commerce_customer_context_gateway"."gateway_assertion_redemptions" TO "ontos_runtime";
