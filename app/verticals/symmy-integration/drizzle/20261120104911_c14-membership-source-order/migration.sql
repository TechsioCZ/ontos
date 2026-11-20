CREATE TABLE "symmy_integration"."membership_source_orders" (
	"effect_id" uuid,
	"effective_at" timestamp with time zone,
	"idempotency_digest" text NOT NULL,
	"lineage_digest" text,
	"route_id" uuid NOT NULL,
	"source_order" integer,
	"tenant_id" uuid,
	CONSTRAINT "symmy_membership_source_orders_pk" PRIMARY KEY("tenant_id","lineage_digest","source_order"),
	CONSTRAINT "symmy_membership_source_orders_effect_uq" UNIQUE("tenant_id","effect_id"),
	CONSTRAINT "symmy_membership_source_orders_admission_ck" CHECK ("idempotency_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "symmy_membership_source_orders_lineage_ck" CHECK ("lineage_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "symmy_membership_source_orders_order_ck" CHECK ("source_order" >= 1)
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."membership_source_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."membership_source_orders" ADD CONSTRAINT "symmy_membership_source_orders_effect_fk" FOREIGN KEY ("tenant_id","effect_id") REFERENCES "symmy_integration"."job_effects"("tenant_id","effect_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "symmy_integration"."membership_source_orders" ADD CONSTRAINT "symmy_membership_source_orders_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "symmy_integration"."job_routes"("tenant_id","route_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_select" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_insert" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_update" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_membership_source_orders_tenant_delete" ON "symmy_integration"."membership_source_orders" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."membership_source_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);