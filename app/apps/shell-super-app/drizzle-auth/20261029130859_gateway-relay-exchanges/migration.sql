CREATE TABLE "auth"."gateway_relay_exchanges" (
	"source_jti" uuid NOT NULL,
	"exchange_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_gateway_relay_source_exchange_uk" ON "auth"."gateway_relay_exchanges" ("source_jti","exchange_id");--> statement-breakpoint
CREATE INDEX "auth_gateway_relay_expires_at_idx" ON "auth"."gateway_relay_exchanges" ("expires_at");