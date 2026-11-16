-- Replay evidence for another audience can never be redeemed by this owner; drop it before the constraint.
DELETE FROM "inventory"."gateway_assertion_redemptions" WHERE "audience" <> 'inventory';
--> statement-breakpoint
ALTER TABLE "inventory"."gateway_assertion_redemptions" ADD CONSTRAINT "inventory_gateway_redemptions_audience_ck" CHECK ("audience" = 'inventory');
