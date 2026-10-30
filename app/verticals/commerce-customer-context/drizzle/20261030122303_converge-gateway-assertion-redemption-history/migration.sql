-- Demo kept replay evidence in its own schema (20261013151347); the canonical table is created by
-- 20261019110421_gateway_assertion_redemption. Rows are short-lived replay evidence.
DROP TABLE IF EXISTS "commerce_customer_context_gateway"."gateway_assertion_redemptions";--> statement-breakpoint
DROP SCHEMA IF EXISTS "commerce_customer_context_gateway";
