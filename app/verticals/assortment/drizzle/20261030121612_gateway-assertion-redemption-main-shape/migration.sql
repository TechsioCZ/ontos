-- Replay evidence that cannot become main's uuid identity is unusable; drop it before the type change.
DELETE FROM "assortment"."gateway_assertion_redemptions" WHERE "jti" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';--> statement-breakpoint
DROP INDEX "assortment"."assortment_redemption_expiry";--> statement-breakpoint
ALTER TABLE "assortment"."gateway_assertion_redemptions" DROP CONSTRAINT "gateway_assertion_redemptions_pkey";--> statement-breakpoint
ALTER TABLE "assortment"."gateway_assertion_redemptions" ADD COLUMN "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "assortment"."gateway_assertion_redemptions" ALTER COLUMN "jti" SET DATA TYPE uuid USING "jti"::uuid;--> statement-breakpoint
ALTER TABLE "assortment"."gateway_assertion_redemptions" ADD CONSTRAINT "assortment_gateway_redemptions_identity_uk" UNIQUE("issuer","audience","jti");--> statement-breakpoint
CREATE INDEX "assortment_gateway_redemptions_expiry_idx" ON "assortment"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
ALTER TABLE "assortment"."gateway_assertion_redemptions" ALTER COLUMN "audience" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assortment"."gateway_assertion_redemptions" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assortment"."gateway_assertion_redemptions" ALTER COLUMN "jti" SET NOT NULL;--> statement-breakpoint
REVOKE ALL ON TABLE "assortment"."gateway_assertion_redemptions" FROM PUBLIC, ontos_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "assortment"."gateway_assertion_redemptions" TO ontos_runtime;
