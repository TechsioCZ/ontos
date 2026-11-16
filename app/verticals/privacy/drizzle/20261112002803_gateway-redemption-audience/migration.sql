-- Replay evidence for another audience can never be redeemed by this owner; drop it before the constraint.
DELETE FROM "privacy"."gateway_assertion_redemptions" WHERE "audience" <> 'privacy';
--> statement-breakpoint
ALTER TABLE "privacy"."gateway_assertion_redemptions" ADD CONSTRAINT "privacy_gateway_redemptions_audience_ck" CHECK ("audience" = 'privacy');
