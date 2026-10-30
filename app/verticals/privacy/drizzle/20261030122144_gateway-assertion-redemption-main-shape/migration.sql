-- Replay evidence that cannot become main's uuid identity is unusable; drop it before the type change.
DELETE FROM "privacy"."gateway_assertion_redemptions" WHERE "jti" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';--> statement-breakpoint
DROP INDEX "privacy"."privacy_redemption_expiry";--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" DROP CONSTRAINT "gateway_assertion_redemptions_pkey";--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" ADD COLUMN "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" ALTER COLUMN "jti" SET DATA TYPE uuid USING "jti"::uuid;--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" ADD CONSTRAINT "privacy_gateway_redemptions_identity_uk" UNIQUE("issuer","audience","jti");--> statement-breakpoint
CREATE INDEX "privacy_gateway_redemptions_expiry_idx" ON "privacy"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" ALTER COLUMN "audience" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" ALTER COLUMN "jti" SET NOT NULL;--> statement-breakpoint
REVOKE ALL ON TABLE "privacy"."gateway_assertion_redemptions" FROM PUBLIC, ontos_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "privacy"."gateway_assertion_redemptions" TO ontos_runtime;
