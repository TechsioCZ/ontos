CREATE TABLE "communications"."communication_decisions" (
	"decided_at" timestamp with time zone NOT NULL,
	"decision_id" uuid PRIMARY KEY,
	"language_policy" jsonb,
	"no_message_reason" text,
	"outcome" text NOT NULL,
	"request_id" uuid NOT NULL,
	"requiredness" text,
	"rule_key" text,
	"tenant_id" uuid NOT NULL,
	"type_id" text,
	"type_revision" integer,
	"unresolved_slots" jsonb NOT NULL,
	CONSTRAINT "communications_decisions_tenant_identity_uk" UNIQUE("tenant_id","decision_id"),
	CONSTRAINT "communications_decisions_request_uk" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "communications_decisions_outcome_ck" CHECK ("outcome" in ('MESSAGE_INTENTS', 'NO_MESSAGE')),
	CONSTRAINT "communications_decisions_shape_ck" CHECK (("outcome" = 'NO_MESSAGE' and "no_message_reason" is not null) or ("outcome" = 'MESSAGE_INTENTS' and "no_message_reason" is null and "type_id" is not null and "type_revision" is not null))
);
--> statement-breakpoint
ALTER TABLE "communications"."communication_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."communication_request_conflicts" (
	"action_invocation_id" uuid NOT NULL,
	"conflict_id" uuid PRIMARY KEY,
	"detected_at" timestamp with time zone NOT NULL,
	"fingerprint" text NOT NULL,
	"request_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_request_conflicts_fingerprint_uk" UNIQUE("tenant_id","request_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "communications"."communication_request_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."communication_requests" (
	"action_invocation_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"identity_key" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"occurrence_revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"purpose" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"request_id" uuid PRIMARY KEY,
	"scope_key" text NOT NULL,
	"source_module" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_requests_tenant_identity_uk" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "communications_requests_identity_key_uk" UNIQUE("tenant_id","identity_key"),
	CONSTRAINT "communications_requests_revision_ck" CHECK ("occurrence_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "communications"."communication_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."delivery_attempts" (
	"attempt_id" uuid PRIMARY KEY,
	"attempt_number" integer NOT NULL,
	"evidence" jsonb,
	"finished_at" timestamp with time zone,
	"intent_id" uuid NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_attempts_number_uk" UNIQUE("tenant_id","intent_id","attempt_number"),
	CONSTRAINT "communications_attempts_number_ck" CHECK ("attempt_number" > 0),
	CONSTRAINT "communications_attempts_state_ck" CHECK ("state" in ('ACCEPTED', 'INDETERMINATE', 'PREPARED', 'REJECTED', 'UNAVAILABLE'))
);
--> statement-breakpoint
ALTER TABLE "communications"."delivery_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."intent_handoff_stops" (
	"intent_id" uuid NOT NULL,
	"reasons" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_handoff_stops_intent_uk" UNIQUE("tenant_id","intent_id")
);
--> statement-breakpoint
ALTER TABLE "communications"."intent_handoff_stops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."message_intents" (
	"created_at" timestamp with time zone NOT NULL,
	"decision_id" uuid NOT NULL,
	"endpoint_pin" jsonb,
	"handoff_pin" jsonb NOT NULL,
	"intent_id" uuid PRIMARY KEY,
	"intent_key" text NOT NULL,
	"language" text,
	"language_decision" jsonb,
	"original_binding" jsonb NOT NULL,
	"policy_ref" jsonb,
	"processing_scope" jsonb,
	"purpose" text NOT NULL,
	"reason" text,
	"recipient_id" text NOT NULL,
	"recipient_module" text NOT NULL,
	"recipient_role" text NOT NULL,
	"recipient_type" text NOT NULL,
	"request_id" uuid NOT NULL,
	"slot_key" text NOT NULL,
	"status" text NOT NULL,
	"template_revision_id" uuid,
	"template_revision_number" integer,
	"tenant_id" uuid NOT NULL,
	"tenant_mode" text,
	"type_id" text NOT NULL,
	"type_revision" integer NOT NULL,
	CONSTRAINT "communications_intents_tenant_identity_uk" UNIQUE("tenant_id","intent_id"),
	CONSTRAINT "communications_intents_key_uk" UNIQUE("tenant_id","intent_key"),
	CONSTRAINT "communications_intents_status_ck" CHECK ("status" in ('NOT_SENT', 'PENDING_HANDOFF', 'SUPPRESSED')),
	CONSTRAINT "communications_intents_pending_pins_ck" CHECK ("status" <> 'PENDING_HANDOFF' or ("endpoint_pin" is not null and "processing_scope" is not null and "language_decision" is not null and "language" is not null and "template_revision_id" is not null and "template_revision_number" is not null and "tenant_mode" is not null and "policy_ref" is not null)),
	CONSTRAINT "communications_intents_reason_ck" CHECK ("status" = 'PENDING_HANDOFF' or "reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "communications"."message_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "communications_intents_request_idx" ON "communications"."message_intents" ("tenant_id","request_id");--> statement-breakpoint
ALTER TABLE "communications"."communication_decisions" ADD CONSTRAINT "communications_decisions_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "communications"."communication_requests"("tenant_id","request_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."communication_request_conflicts" ADD CONSTRAINT "communications_request_conflicts_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "communications"."communication_requests"("tenant_id","request_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."delivery_attempts" ADD CONSTRAINT "communications_attempts_intent_fk" FOREIGN KEY ("tenant_id","intent_id") REFERENCES "communications"."message_intents"("tenant_id","intent_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."intent_handoff_stops" ADD CONSTRAINT "communications_handoff_stops_intent_fk" FOREIGN KEY ("tenant_id","intent_id") REFERENCES "communications"."message_intents"("tenant_id","intent_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."message_intents" ADD CONSTRAINT "communications_intents_decision_fk" FOREIGN KEY ("tenant_id","decision_id") REFERENCES "communications"."communication_decisions"("tenant_id","decision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "communication_decisions_select" ON "communications"."communication_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."communication_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_decisions_insert" ON "communications"."communication_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."communication_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_decisions_update" ON "communications"."communication_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."communication_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."communication_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_decisions_delete" ON "communications"."communication_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."communication_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_request_conflicts_select" ON "communications"."communication_request_conflicts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."communication_request_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_request_conflicts_insert" ON "communications"."communication_request_conflicts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."communication_request_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_request_conflicts_update" ON "communications"."communication_request_conflicts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."communication_request_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."communication_request_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_request_conflicts_delete" ON "communications"."communication_request_conflicts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."communication_request_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_requests_select" ON "communications"."communication_requests" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."communication_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_requests_insert" ON "communications"."communication_requests" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."communication_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_requests_update" ON "communications"."communication_requests" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."communication_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."communication_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communication_requests_delete" ON "communications"."communication_requests" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."communication_requests"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "delivery_attempts_select" ON "communications"."delivery_attempts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."delivery_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "delivery_attempts_insert" ON "communications"."delivery_attempts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."delivery_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "delivery_attempts_update" ON "communications"."delivery_attempts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."delivery_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."delivery_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "delivery_attempts_delete" ON "communications"."delivery_attempts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."delivery_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_handoff_stops_select" ON "communications"."intent_handoff_stops" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."intent_handoff_stops"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_handoff_stops_insert" ON "communications"."intent_handoff_stops" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."intent_handoff_stops"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_handoff_stops_update" ON "communications"."intent_handoff_stops" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."intent_handoff_stops"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."intent_handoff_stops"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_handoff_stops_delete" ON "communications"."intent_handoff_stops" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."intent_handoff_stops"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_intents_select" ON "communications"."message_intents" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."message_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_intents_insert" ON "communications"."message_intents" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."message_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_intents_update" ON "communications"."message_intents" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."message_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."message_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_intents_delete" ON "communications"."message_intents" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."message_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);