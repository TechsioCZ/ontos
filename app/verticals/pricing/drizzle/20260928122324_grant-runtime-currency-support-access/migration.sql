-- Pricing's governed routines are SECURITY INVOKER under forced RLS, so ontos_runtime needs schema
-- USAGE plus exactly the table rights those routines use. History stays append-only: no DELETE.
GRANT USAGE ON SCHEMA "pricing" TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "pricing"."currency_support_revisions" TO "ontos_runtime";
