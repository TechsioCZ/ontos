ALTER POLICY "pricing_price_revisions_scope_update" ON "pricing"."price_revisions" TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER POLICY "pricing_price_revisions_scope_delete" ON "pricing"."price_revisions" TO "ontos_runtime" USING (false);--> statement-breakpoint
ALTER POLICY "pricing_prices_scope_update" ON "pricing"."prices" TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
ALTER POLICY "pricing_prices_scope_delete" ON "pricing"."prices" TO "ontos_runtime" USING (false);