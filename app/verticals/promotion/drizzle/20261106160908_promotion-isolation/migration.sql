-- Forced Tenant isolation and immutable runtime ledgers. Business changes still require Core Actions.
--> statement-breakpoint
ALTER TABLE "promotion"."basis_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."issued_proofs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."lifecycle_facts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."promotion_drafts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."published_promotions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."selection_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."tenant_generations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."voucher_disable_facts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotion"."vouchers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "promotion" FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "promotion" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."published_promotions" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "promotion"."published_promotions" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."lifecycle_facts" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "promotion"."lifecycle_facts" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."vouchers" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "promotion"."vouchers" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."voucher_disable_facts" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "promotion"."voucher_disable_facts" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."issued_proofs" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "promotion"."issued_proofs" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."promotion_drafts" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "promotion"."promotion_drafts" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."tenant_generations" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "promotion"."tenant_generations" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."selection_policies" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "promotion"."selection_policies" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."basis_policies" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "promotion"."basis_policies" TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."gateway_assertion_redemptions" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "promotion"."gateway_assertion_redemptions" TO "ontos_runtime";
