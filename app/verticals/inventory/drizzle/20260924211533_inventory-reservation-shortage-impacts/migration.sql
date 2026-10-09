CREATE TABLE "inventory"."reservation_shortage_impact_decisions" (
	"tenant_id" uuid,
	"change_kind" text,
	"change_id" uuid,
	"confirmation_id" uuid,
	"priority_ordinal" integer,
	"decision" text NOT NULL,
	"affected_amount" numeric(38,9),
	"health_before" text NOT NULL,
	"health_after" text NOT NULL,
	"confirmation_revision_before" integer NOT NULL,
	"confirmation_revision_after" integer NOT NULL,
	"rank_issued_at" timestamp with time zone NOT NULL,
	"rank_owner_evidence_ref" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservation_shortage_impact_decisions_pk" PRIMARY KEY("tenant_id","change_kind","change_id","confirmation_id"),
	CONSTRAINT "inventory_reservation_shortage_impact_decisions_meaning_ck" CHECK ("decision" in ('HONORABLE', 'SHORTAGE', 'ORDER_UNRESOLVABLE') and "health_before" in ('VALID', 'AT_RISK', 'UNVERIFIABLE') and "health_after" in ('VALID', 'AT_RISK', 'UNVERIFIABLE') and "confirmation_revision_before" >= 1 and "confirmation_revision_after" >= "confirmation_revision_before" and char_length(btrim("rank_owner_evidence_ref")) between 1 and 300 and (("decision" = 'ORDER_UNRESOLVABLE' and "priority_ordinal" is null and "affected_amount" is null) or ("decision" in ('HONORABLE', 'SHORTAGE') and "priority_ordinal" >= 1 and "affected_amount" > 0)))
);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impact_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."reservation_shortage_impacts" (
	"tenant_id" uuid,
	"change_kind" text,
	"change_id" uuid,
	"physical_effect_id" uuid,
	"stock_correction_id" uuid,
	"position_id" uuid NOT NULL,
	"position_revision" integer NOT NULL,
	"available_amount" numeric(38,9) NOT NULL,
	"fenced_amount" numeric(38,9) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"reconciliation_required" boolean NOT NULL,
	"reason" text,
	"decision_count" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservation_shortage_impacts_pk" PRIMARY KEY("tenant_id","change_kind","change_id"),
	CONSTRAINT "inventory_reservation_shortage_impacts_source_ck" CHECK (("change_kind" in ('RECEIPT', 'ISSUE') and "physical_effect_id" = "change_id" and "stock_correction_id" is null) or ("change_kind" = 'CORRECTION' and "stock_correction_id" = "change_id" and "physical_effect_id" is null)),
	CONSTRAINT "inventory_reservation_shortage_impacts_outcome_ck" CHECK (("status" = 'DETERMINATE' and "reconciliation_required" = false and "reason" is null) or ("status" = 'INDETERMINATE' and "reconciliation_required" = true and "reason" = 'AUTHORITATIVE_ISSUANCE_ORDER_UNRESOLVABLE')),
	CONSTRAINT "inventory_reservation_shortage_impacts_quantity_ck" CHECK ("position_revision" >= 1 and "available_amount" >= 0 and "fenced_amount" >= 0 and "decision_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_shortage_impact_decisions_priority_uk" ON "inventory"."reservation_shortage_impact_decisions" ("tenant_id","change_kind","change_id","priority_ordinal") WHERE "priority_ordinal" is not null;--> statement-breakpoint
CREATE INDEX "inventory_reservation_shortage_impact_decisions_confirmation_idx" ON "inventory"."reservation_shortage_impact_decisions" ("tenant_id","confirmation_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_shortage_impacts_effect_uk" ON "inventory"."reservation_shortage_impacts" ("tenant_id","physical_effect_id") WHERE "physical_effect_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_shortage_impacts_correction_uk" ON "inventory"."reservation_shortage_impacts" ("tenant_id","stock_correction_id") WHERE "stock_correction_id" is not null;--> statement-breakpoint
CREATE INDEX "inventory_reservation_shortage_impacts_position_time_idx" ON "inventory"."reservation_shortage_impacts" ("tenant_id","position_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_reservation_shortage_impacts_unresolved_idx" ON "inventory"."reservation_shortage_impacts" ("tenant_id","position_id") WHERE "status" = 'INDETERMINATE';--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impact_decisions" ADD CONSTRAINT "inventory_reservation_shortage_impact_decisions_impact_fk" FOREIGN KEY ("tenant_id","change_kind","change_id") REFERENCES "inventory"."reservation_shortage_impacts"("tenant_id","change_kind","change_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impact_decisions" ADD CONSTRAINT "inventory_reservation_shortage_impact_decisions_confirmation_fk" FOREIGN KEY ("tenant_id","confirmation_id") REFERENCES "inventory"."reservation_confirmations"("tenant_id","confirmation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impacts" ADD CONSTRAINT "inventory_reservation_shortage_impacts_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impacts" ADD CONSTRAINT "inventory_reservation_shortage_impacts_effect_fk" FOREIGN KEY ("tenant_id","physical_effect_id") REFERENCES "inventory"."physical_stock_effects"("tenant_id","effect_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impacts" ADD CONSTRAINT "inventory_reservation_shortage_impacts_correction_fk" FOREIGN KEY ("tenant_id","stock_correction_id") REFERENCES "inventory"."stock_corrections"("tenant_id","correction_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impact_decisions_tenant_select" ON "inventory"."reservation_shortage_impact_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."reservation_shortage_impact_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impact_decisions_tenant_insert" ON "inventory"."reservation_shortage_impact_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."reservation_shortage_impact_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impact_decisions_tenant_update" ON "inventory"."reservation_shortage_impact_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."reservation_shortage_impact_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."reservation_shortage_impact_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impact_decisions_tenant_delete" ON "inventory"."reservation_shortage_impact_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."reservation_shortage_impact_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impacts_tenant_select" ON "inventory"."reservation_shortage_impacts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."reservation_shortage_impacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impacts_tenant_insert" ON "inventory"."reservation_shortage_impacts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."reservation_shortage_impacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impacts_tenant_update" ON "inventory"."reservation_shortage_impacts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."reservation_shortage_impacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."reservation_shortage_impacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_shortage_impacts_tenant_delete" ON "inventory"."reservation_shortage_impacts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."reservation_shortage_impacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impact_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_shortage_impacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_reservation_shortage_impact_source"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  expected_affected_amount numeric(38, 9);
  expected_fenced_amount numeric(38, 9);
  position_matches boolean;
BEGIN
  IF TG_TABLE_NAME = 'reservation_shortage_impacts' THEN
    PERFORM 1
    FROM "inventory"."stock_positions" AS position
    WHERE position.tenant_id = NEW.tenant_id
      AND position.stock_position_id = NEW.position_id
      AND position.lifecycle_state = 'CURRENT'
      AND position.on_hand_state = 'CURRENT'
      AND position.revision = NEW.position_revision
      AND position.on_hand_amount = NEW.available_amount
    FOR UPDATE;

    position_matches := FOUND;

    SELECT coalesce(pg_catalog.sum(allocation.allocated_amount), 0)
    INTO expected_fenced_amount
    FROM "inventory"."obligation_allocations" AS allocation
    JOIN "inventory"."obligations" AS obligation
      ON obligation.tenant_id = allocation.tenant_id
      AND obligation.obligation_id = allocation.obligation_id
    WHERE allocation.tenant_id = NEW.tenant_id
      AND allocation.stock_position_id = NEW.position_id
      AND (
        obligation.lifecycle_meaning = 'COMMITTED_OBLIGATION'
        OR EXISTS (
          SELECT 1
          FROM "inventory"."reservation_confirmations" AS confirmation
          WHERE confirmation.tenant_id = allocation.tenant_id
            AND confirmation.reservation_id = allocation.obligation_id
            AND confirmation.current_health_state IN ('EXPIRED', 'REVOKED')
        )
      );

    IF NOT position_matches
      OR NEW.fenced_amount IS DISTINCT FROM expected_fenced_amount
      OR (
        NEW.change_kind IN ('RECEIPT', 'ISSUE')
        AND NOT EXISTS (
          SELECT 1
          FROM "inventory"."physical_stock_effects" AS effect
          WHERE effect.tenant_id = NEW.tenant_id
            AND effect.effect_id = NEW.physical_effect_id
            AND effect.effect_id = NEW.change_id
            AND effect.kind = NEW.change_kind
            AND effect.position_id = NEW.position_id
            AND effect.state = 'APPLIED'
            AND effect.evidence_json ->> 'effectId' = NEW.change_id::text
            AND effect.evidence_json ->> 'kind' = NEW.change_kind
            AND effect.evidence_json #>> '{positionRef,tenantId}' = NEW.tenant_id::text
            AND effect.evidence_json #>> '{positionRef,resourceId}' = NEW.position_id::text
            AND (effect.evidence_json ->> 'appliedAt')::timestamptz = NEW.occurred_at
            AND EXISTS (
              SELECT 1
              FROM "inventory"."stock_positions" AS current_position
              WHERE current_position.tenant_id = NEW.tenant_id
                AND current_position.stock_position_id = NEW.position_id
                AND current_position.on_hand_observed_at
                  = (effect.evidence_json ->> 'appliedAt')::timestamptz
                AND current_position.on_hand_evidence_ref
                  = effect.evidence_json ->> 'backendEvidenceRef'
            )
        )
      )
      OR (
        NEW.change_kind = 'CORRECTION'
        AND NOT EXISTS (
          SELECT 1
          FROM "inventory"."stock_corrections" AS correction
          WHERE correction.tenant_id = NEW.tenant_id
            AND correction.correction_id = NEW.stock_correction_id
            AND correction.correction_id = NEW.change_id
            AND correction.position_id = NEW.position_id
            AND correction.state = 'APPLIED'
            AND correction.position_revision_after = NEW.position_revision
            AND correction.corrected_quantity_amount = NEW.available_amount
            AND correction.applied_at = NEW.occurred_at
            AND correction.record_json ->> 'correctionId' = NEW.change_id::text
            AND correction.record_json #>> '{positionRef,tenantId}' = NEW.tenant_id::text
            AND correction.record_json #>> '{positionRef,resourceId}' = NEW.position_id::text
            AND (correction.record_json ->> 'positionRevisionAfter')::integer = NEW.position_revision
            AND (correction.record_json #>> '{correctedQuantity,amount}')::numeric = NEW.available_amount
            AND (correction.record_json ->> 'appliedAt')::timestamptz = NEW.occurred_at
            AND EXISTS (
              SELECT 1
              FROM "inventory"."stock_positions" AS current_position
              WHERE current_position.tenant_id = NEW.tenant_id
                AND current_position.stock_position_id = NEW.position_id
                AND current_position.on_hand_observed_at = correction.business_observed_at
                AND current_position.on_hand_evidence_ref = correction.owner_evidence_ref
            )
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_shortage_impacts_exact_source_ck',
        MESSAGE = 'Reservation shortage impact must reference the exact applied source and Current Position revision';
    END IF;

    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "inventory"."reservation_shortage_impacts" AS impact
  WHERE impact.tenant_id = NEW.tenant_id
    AND impact.change_kind = NEW.change_kind
    AND impact.change_id = NEW.change_id
  FOR KEY SHARE;

  IF NOT FOUND
    OR NOT EXISTS (
      SELECT 1
      FROM "inventory"."reservation_confirmations" AS confirmation
      JOIN "inventory"."reservation_shortage_impacts" AS impact
        ON impact.tenant_id = NEW.tenant_id
        AND impact.change_kind = NEW.change_kind
        AND impact.change_id = NEW.change_id
      WHERE confirmation.tenant_id = NEW.tenant_id
        AND confirmation.confirmation_id = NEW.confirmation_id
        AND confirmation.current_health_state = NEW.health_after
        AND confirmation.current_revision = NEW.confirmation_revision_after
        AND (confirmation.snapshot #>> '{issuanceRank,issuedAt}')::timestamptz = NEW.rank_issued_at
        AND confirmation.snapshot #>> '{issuanceRank,ownerEvidenceRef}' = NEW.rank_owner_evidence_ref
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            confirmation.snapshot #> '{reservation,requirements}'
          ) AS requirement(entry)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            requirement.entry -> 'allocations'
          ) AS allocation(entry)
          WHERE allocation.entry #>> '{positionRef,tenantId}' = NEW.tenant_id::text
            AND allocation.entry #>> '{positionRef,resourceId}' = impact.position_id::text
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "inventory"."reservation_confirmation_history" AS before_history
      WHERE before_history.tenant_id = NEW.tenant_id
        AND before_history.confirmation_id = NEW.confirmation_id
        AND before_history.revision = NEW.confirmation_revision_before
        AND before_history.health_state = NEW.health_before
        AND (before_history.snapshot #>> '{issuanceRank,issuedAt}')::timestamptz = NEW.rank_issued_at
        AND before_history.snapshot #>> '{issuanceRank,ownerEvidenceRef}' = NEW.rank_owner_evidence_ref
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "inventory"."reservation_confirmation_history" AS after_history
      WHERE after_history.tenant_id = NEW.tenant_id
        AND after_history.confirmation_id = NEW.confirmation_id
        AND after_history.revision = NEW.confirmation_revision_after
        AND after_history.health_state = NEW.health_after
        AND (after_history.snapshot #>> '{issuanceRank,issuedAt}')::timestamptz = NEW.rank_issued_at
        AND after_history.snapshot #>> '{issuanceRank,ownerEvidenceRef}' = NEW.rank_owner_evidence_ref
    )
    OR (
      NEW.decision IN ('HONORABLE', 'ORDER_UNRESOLVABLE')
      AND (
        NEW.health_after IS DISTINCT FROM NEW.health_before
        OR NEW.confirmation_revision_after IS DISTINCT FROM NEW.confirmation_revision_before
      )
    )
    OR (
      NEW.decision = 'SHORTAGE'
      AND (
        (
          NEW.health_before = 'VALID'
          AND (
            NEW.health_after IS DISTINCT FROM 'AT_RISK'
            OR NEW.confirmation_revision_after IS DISTINCT FROM NEW.confirmation_revision_before + 1
          )
        )
        OR (
          NEW.health_before IN ('AT_RISK', 'UNVERIFIABLE')
          AND (
            NEW.health_after IS DISTINCT FROM NEW.health_before
            OR NEW.confirmation_revision_after IS DISTINCT FROM NEW.confirmation_revision_before
          )
        )
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impact_decisions_exact_scope_ck',
      MESSAGE = 'Reservation shortage decision must preserve the exact Confirmation scope, rank, and health transition';
  END IF;

  IF NEW.decision IN ('HONORABLE', 'SHORTAGE') THEN
    SELECT pg_catalog.sum((allocation.entry #>> '{quantity,amount}')::numeric)
    INTO expected_affected_amount
    FROM "inventory"."reservation_confirmations" AS confirmation
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      confirmation.snapshot #> '{reservation,requirements}'
    ) AS requirement(entry)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      requirement.entry -> 'allocations'
    ) AS allocation(entry)
    JOIN "inventory"."reservation_shortage_impacts" AS impact
      ON impact.tenant_id = NEW.tenant_id
      AND impact.change_kind = NEW.change_kind
      AND impact.change_id = NEW.change_id
    WHERE confirmation.tenant_id = NEW.tenant_id
      AND confirmation.confirmation_id = NEW.confirmation_id
      AND allocation.entry #>> '{positionRef,tenantId}' = NEW.tenant_id::text
      AND allocation.entry #>> '{positionRef,resourceId}' = impact.position_id::text;

    IF expected_affected_amount IS NULL
      OR NEW.affected_amount IS DISTINCT FROM expected_affected_amount
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_shortage_impact_decisions_exact_scope_ck',
        MESSAGE = 'Reservation shortage decision affected amount must equal the exact Position allocation total';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."verify_reservation_shortage_impact_decisions"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  impact "inventory"."reservation_shortage_impacts"%ROWTYPE;
  stored_count integer;
BEGIN
  SELECT stored.*
  INTO impact
  FROM "inventory"."reservation_shortage_impacts" AS stored
  WHERE stored.tenant_id = NEW.tenant_id
    AND stored.change_kind = NEW.change_kind
    AND stored.change_id = NEW.change_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_exact_decisions_ck',
      MESSAGE = 'Reservation shortage decisions require one exact parent impact';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO stored_count
  FROM "inventory"."reservation_shortage_impact_decisions" AS decision
  WHERE decision.tenant_id = impact.tenant_id
    AND decision.change_kind = impact.change_kind
    AND decision.change_id = impact.change_id;

  IF stored_count IS DISTINCT FROM impact.decision_count
    OR (
      impact.status = 'DETERMINATE'
      AND (
        EXISTS (
          SELECT 1
          FROM "inventory"."reservation_shortage_impact_decisions" AS decision
          WHERE decision.tenant_id = impact.tenant_id
            AND decision.change_kind = impact.change_kind
            AND decision.change_id = impact.change_id
            AND (
              decision.decision NOT IN ('HONORABLE', 'SHORTAGE')
              OR decision.priority_ordinal IS NULL
              OR decision.affected_amount IS NULL
            )
        )
        OR (
          SELECT pg_catalog.count(DISTINCT decision.priority_ordinal)
          FROM "inventory"."reservation_shortage_impact_decisions" AS decision
          WHERE decision.tenant_id = impact.tenant_id
            AND decision.change_kind = impact.change_kind
            AND decision.change_id = impact.change_id
        ) IS DISTINCT FROM impact.decision_count
        OR (
          SELECT coalesce(pg_catalog.min(decision.priority_ordinal), 1)
          FROM "inventory"."reservation_shortage_impact_decisions" AS decision
          WHERE decision.tenant_id = impact.tenant_id
            AND decision.change_kind = impact.change_kind
            AND decision.change_id = impact.change_id
        ) IS DISTINCT FROM 1
        OR (
          SELECT coalesce(pg_catalog.max(decision.priority_ordinal), 0)
          FROM "inventory"."reservation_shortage_impact_decisions" AS decision
          WHERE decision.tenant_id = impact.tenant_id
            AND decision.change_kind = impact.change_kind
            AND decision.change_id = impact.change_id
        ) IS DISTINCT FROM impact.decision_count
        OR (
          SELECT pg_catalog.count(DISTINCT decision.rank_issued_at)
          FROM "inventory"."reservation_shortage_impact_decisions" AS decision
          WHERE decision.tenant_id = impact.tenant_id
            AND decision.change_kind = impact.change_kind
            AND decision.change_id = impact.change_id
        ) IS DISTINCT FROM impact.decision_count
        OR EXISTS (
          SELECT 1
          FROM (
            SELECT
              decision.decision,
              decision.priority_ordinal,
              pg_catalog.row_number() OVER (
                ORDER BY decision.rank_issued_at, decision.confirmation_id
              ) AS expected_ordinal,
              pg_catalog.sum(decision.affected_amount) OVER (
                ORDER BY decision.priority_ordinal
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS cumulative_amount
            FROM "inventory"."reservation_shortage_impact_decisions" AS decision
            WHERE decision.tenant_id = impact.tenant_id
              AND decision.change_kind = impact.change_kind
              AND decision.change_id = impact.change_id
          ) AS ordered
          WHERE ordered.priority_ordinal IS DISTINCT FROM ordered.expected_ordinal
            OR ordered.decision IS DISTINCT FROM CASE
              WHEN ordered.cumulative_amount
                <= pg_catalog.greatest(impact.available_amount - impact.fenced_amount, 0)
              THEN 'HONORABLE'
              ELSE 'SHORTAGE'
            END
        )
      )
    )
    OR (
      impact.status = 'INDETERMINATE'
      AND (
        impact.decision_count < 2
        OR EXISTS (
          SELECT 1
          FROM "inventory"."reservation_shortage_impact_decisions" AS decision
          WHERE decision.tenant_id = impact.tenant_id
            AND decision.change_kind = impact.change_kind
            AND decision.change_id = impact.change_id
            AND (
              decision.decision IS DISTINCT FROM 'ORDER_UNRESOLVABLE'
              OR decision.priority_ordinal IS NOT NULL
              OR decision.affected_amount IS NOT NULL
            )
        )
        OR (
          SELECT pg_catalog.count(DISTINCT decision.rank_issued_at)
          FROM "inventory"."reservation_shortage_impact_decisions" AS decision
          WHERE decision.tenant_id = impact.tenant_id
            AND decision.change_kind = impact.change_kind
            AND decision.change_id = impact.change_id
        ) >= impact.decision_count
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_exact_decisions_ck',
      MESSAGE = 'Reservation shortage decisions must exactly cover the authoritative rank without gaps or skips';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_reservation_shortage_impact_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_reservation_shortage_impacts_append_only_ck',
    MESSAGE = 'Reservation shortage impact evidence is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_shortage_impacts_source_trg"
BEFORE INSERT ON "inventory"."reservation_shortage_impacts"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_reservation_shortage_impact_source"();
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_shortage_impact_decisions_exact_scope_trg"
BEFORE INSERT ON "inventory"."reservation_shortage_impact_decisions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_reservation_shortage_impact_source"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inventory_reservation_shortage_impacts_decision_set_trg"
AFTER INSERT ON "inventory"."reservation_shortage_impacts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "inventory"."verify_reservation_shortage_impact_decisions"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inventory_reservation_shortage_impact_decisions_decision_set_trg"
AFTER INSERT ON "inventory"."reservation_shortage_impact_decisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "inventory"."verify_reservation_shortage_impact_decisions"();
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_shortage_impacts_no_mutation_trg"
BEFORE UPDATE OR DELETE ON "inventory"."reservation_shortage_impacts"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_reservation_shortage_impact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_shortage_impact_decisions_no_mutation_trg"
BEFORE UPDATE OR DELETE ON "inventory"."reservation_shortage_impact_decisions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_reservation_shortage_impact_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_reservation_shortage_impact_source"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."verify_reservation_shortage_impact_decisions"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_reservation_shortage_impact_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "inventory"."find_reservation_shortage_impact_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_change_kind text,
  p_change_id uuid
) RETURNS TABLE(found boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation shortage impact worker scope mismatch';
  END IF;

  IF p_change_kind NOT IN ('RECEIPT', 'ISSUE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_worker_source_ck',
      MESSAGE = 'Only physical stock effects may be evaluated by the shortage impact worker';
  END IF;

  RETURN QUERY
  SELECT EXISTS (
    SELECT 1
    FROM "inventory"."reservation_shortage_impacts" AS impact
    JOIN "inventory"."physical_stock_effects" AS effect
      ON effect.tenant_id = impact.tenant_id
      AND effect.effect_id = impact.physical_effect_id
      AND effect.legal_entity_id = p_legal_entity_id
    WHERE impact.tenant_id = p_tenant_id
      AND impact.change_kind = p_change_kind
      AND impact.change_id = p_change_id
      AND effect.kind = p_change_kind
      AND effect.position_id = impact.position_id
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."read_reservation_shortage_impact_context_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_change_kind text,
  p_change_id uuid,
  p_position_id uuid,
  p_occurred_at timestamptz
) RETURNS TABLE(context jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  candidate_set jsonb;
  evidence_ref text;
  fenced_amount numeric(38, 9);
  position "inventory"."stock_positions"%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation shortage impact worker scope mismatch';
  END IF;

  IF p_change_kind NOT IN ('RECEIPT', 'ISSUE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_exact_source_ck',
      MESSAGE = 'Reservation shortage impact worker source kind is invalid';
  END IF;

  SELECT stored.*
  INTO position
  FROM "inventory"."stock_positions" AS stored
  WHERE stored.tenant_id = p_tenant_id
    AND stored.stock_position_id = p_position_id
    AND stored.lifecycle_state = 'CURRENT'
    AND stored.on_hand_state = 'CURRENT'
    AND stored.on_hand_amount IS NOT NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT effect.evidence_json ->> 'backendEvidenceRef'
  INTO evidence_ref
  FROM "inventory"."physical_stock_effects" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_change_id
    AND effect.position_id = p_position_id
    AND effect.kind = p_change_kind
    AND effect.state = 'APPLIED'
    AND (effect.evidence_json ->> 'appliedAt')::timestamptz = p_occurred_at
    AND position.on_hand_observed_at = (effect.evidence_json ->> 'appliedAt')::timestamptz
    AND position.on_hand_evidence_ref = effect.evidence_json ->> 'backendEvidenceRef'
  FOR UPDATE;

  IF evidence_ref IS NULL THEN
    RETURN;
  END IF;

  WITH candidate_rows AS (
    SELECT DISTINCT
      confirmation.confirmation_id,
      confirmation.snapshot,
      reservation.lifecycle_meaning
    FROM "inventory"."reservation_confirmations" AS confirmation
    JOIN "inventory"."obligations" AS reservation
      ON reservation.tenant_id = confirmation.tenant_id
      AND reservation.obligation_id = confirmation.reservation_id
    JOIN "inventory"."obligation_allocations" AS allocation
      ON allocation.tenant_id = confirmation.tenant_id
      AND allocation.obligation_id = confirmation.reservation_id
      AND allocation.stock_position_id = p_position_id
    WHERE confirmation.tenant_id = p_tenant_id
  )
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'allocations', (
          SELECT coalesce(pg_catalog.jsonb_agg(stored_allocation.entry), '[]'::jsonb)
          FROM pg_catalog.jsonb_array_elements(
            candidate.snapshot #> '{reservation,requirements}'
          ) AS requirement(entry)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            requirement.entry -> 'allocations'
          ) AS stored_allocation(entry)
        ),
        'confirmation', candidate.snapshot,
        'poolBoundary', CASE candidate.lifecycle_meaning
          WHEN 'COMMITTED_OBLIGATION' THEN 'COMMITTED_OBLIGATION'
          ELSE 'NONE'
        END
      ) ORDER BY
        (candidate.snapshot #>> '{issuanceRank,issuedAt}')::timestamptz,
        candidate.confirmation_id
    ),
    '[]'::jsonb
  )
  INTO candidate_set
  FROM candidate_rows AS candidate;

  SELECT coalesce(pg_catalog.sum((allocation.entry #>> '{quantity,amount}')::numeric), 0)
  INTO fenced_amount
  FROM pg_catalog.jsonb_array_elements(candidate_set) AS fenced(entry)
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(fenced.entry -> 'allocations') AS allocation(entry)
  WHERE (
      fenced.entry ->> 'poolBoundary' = 'COMMITTED_OBLIGATION'
      OR (
        fenced.entry ->> 'poolBoundary' = 'NONE'
        AND fenced.entry #>> '{confirmation,health,state}' IN ('EXPIRED', 'REVOKED')
      )
    )
    AND allocation.entry #>> '{positionRef,tenantId}' = p_tenant_id::text
    AND allocation.entry #>> '{positionRef,resourceId}' = p_position_id::text;

  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'causeEvidenceRef', evidence_ref,
    'evaluationInput', pg_catalog.jsonb_build_object(
      'affectedPositionRef', pg_catalog.jsonb_build_object(
        'moduleId', 'commerce.inventory',
        'resourceId', position.stock_position_id,
        'resourceType', 'commerce.inventory.stock-position',
        'tenantId', position.tenant_id
      ),
      'availableQuantity', pg_catalog.jsonb_build_object(
        'amount', pg_catalog.trim_scale(position.on_hand_amount)::text,
        'unitRef', pg_catalog.jsonb_build_object(
          'moduleId', position.stock_unit_module_id,
          'resourceId', position.stock_unit_resource_id,
          'resourceType', position.stock_unit_resource_type,
          'tenantId', position.stock_unit_tenant_id
        )
      ),
      'candidates', candidate_set
    ),
    'fencedAmount', pg_catalog.trim_scale(fenced_amount)::text,
    'positionRevision', position.revision
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."apply_reservation_shortage_impact_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_change_kind text,
  p_change_id uuid,
  p_position_id uuid,
  p_occurred_at timestamptz,
  p_evaluation jsonb
) RETURNS TABLE(applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  after_snapshot jsonb;
  candidate jsonb;
  candidate_count integer;
  cause_evidence_ref text;
  context_record jsonb;
  current_confirmation "inventory"."reservation_confirmations"%ROWTYPE;
  decision jsonb;
  decision_count integer;
  decision_index integer := 0;
  evaluation_tag text;
  expected_amount numeric(38, 9);
  expected_fenced_amount numeric(38, 9);
  existing_impact "inventory"."reservation_shortage_impacts"%ROWTYPE;
  owner_evidence_ref text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation shortage impact worker scope mismatch';
  END IF;

  IF p_change_kind NOT IN ('RECEIPT', 'ISSUE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_worker_source_ck',
      MESSAGE = 'Only physical stock effects may be applied by the shortage impact worker';
  END IF;

  SELECT impact.*
  INTO existing_impact
  FROM "inventory"."reservation_shortage_impacts" AS impact
  JOIN "inventory"."physical_stock_effects" AS effect
    ON effect.tenant_id = impact.tenant_id
    AND effect.effect_id = impact.physical_effect_id
    AND effect.legal_entity_id = p_legal_entity_id
  WHERE impact.tenant_id = p_tenant_id
    AND impact.change_kind = p_change_kind
    AND impact.change_id = p_change_id
    AND effect.kind = p_change_kind
    AND effect.position_id = impact.position_id
  FOR KEY SHARE;

  evaluation_tag := p_evaluation ->> '_tag';
  IF FOUND THEN
    IF existing_impact.position_id IS DISTINCT FROM p_position_id
      OR existing_impact.occurred_at IS DISTINCT FROM p_occurred_at
      OR evaluation_tag IS DISTINCT FROM existing_impact.status
      OR (p_evaluation ->> 'fencedAmount')::numeric IS DISTINCT FROM existing_impact.fenced_amount
      OR p_evaluation #>> '{affectedPositionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
      OR p_evaluation #>> '{affectedPositionRef,resourceType}'
        IS DISTINCT FROM 'commerce.inventory.stock-position'
      OR p_evaluation #>> '{affectedPositionRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
      OR p_evaluation #>> '{affectedPositionRef,resourceId}' IS DISTINCT FROM p_position_id::text
      OR (
        evaluation_tag = 'DETERMINATE'
        AND (
          (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_evaluation)) <> 4
          OR
          pg_catalog.jsonb_typeof(p_evaluation -> 'decisions') IS DISTINCT FROM 'array'
          OR pg_catalog.jsonb_array_length(p_evaluation -> 'decisions') IS DISTINCT FROM existing_impact.decision_count
          OR (
            SELECT pg_catalog.count(DISTINCT replay.entry #>> '{confirmationRef,resourceId}')
            FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'decisions') AS replay(entry)
          ) IS DISTINCT FROM existing_impact.decision_count
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'decisions')
              WITH ORDINALITY AS replay(entry, ordinal)
            WHERE NOT EXISTS (
              SELECT 1
              FROM "inventory"."reservation_shortage_impact_decisions" AS stored
              JOIN "inventory"."stock_positions" AS position
                ON position.tenant_id = stored.tenant_id
                AND position.stock_position_id = existing_impact.position_id
              WHERE stored.tenant_id = p_tenant_id
                AND stored.change_kind = p_change_kind
                AND stored.change_id = p_change_id
                AND stored.priority_ordinal = replay.ordinal::integer
                AND stored.confirmation_id = (replay.entry #>> '{confirmationRef,resourceId}')::uuid
                AND stored.decision = replay.entry ->> 'capacity'
                AND stored.affected_amount = (replay.entry #>> '{affectedQuantity,amount}')::numeric
                AND stored.health_before = replay.entry ->> 'currentHealth'
                AND stored.rank_issued_at = (replay.entry #>> '{issuanceRank,issuedAt}')::timestamptz
                AND stored.rank_owner_evidence_ref = replay.entry #>> '{issuanceRank,ownerEvidenceRef}'
                AND replay.entry #>> '{confirmationRef,moduleId}' = 'commerce.inventory'
                AND replay.entry #>> '{confirmationRef,resourceType}'
                  = 'commerce.inventory.reservation-confirmation'
                AND replay.entry #>> '{confirmationRef,tenantId}' = p_tenant_id::text
                AND replay.entry #>> '{affectedQuantity,unitRef,moduleId}' = position.stock_unit_module_id
                AND (replay.entry #>> '{affectedQuantity,unitRef,resourceId}')::uuid
                  = position.stock_unit_resource_id
                AND replay.entry #>> '{affectedQuantity,unitRef,resourceType}'
                  = position.stock_unit_resource_type
                AND (replay.entry #>> '{affectedQuantity,unitRef,tenantId}')::uuid
                  = position.stock_unit_tenant_id
            )
          )
        )
      )
      OR (
        evaluation_tag = 'INDETERMINATE'
        AND (
          (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_evaluation)) <> 6
          OR p_evaluation ->> 'reason' IS DISTINCT FROM existing_impact.reason
          OR p_evaluation -> 'reconciliationRequired' IS DISTINCT FROM 'true'::jsonb
          OR pg_catalog.jsonb_typeof(p_evaluation -> 'candidateRefs') IS DISTINCT FROM 'array'
          OR pg_catalog.jsonb_array_length(p_evaluation -> 'candidateRefs') IS DISTINCT FROM existing_impact.decision_count
          OR (
            SELECT pg_catalog.count(DISTINCT replay.entry ->> 'resourceId')
            FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'candidateRefs') AS replay(entry)
          ) IS DISTINCT FROM existing_impact.decision_count
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'candidateRefs')
              WITH ORDINALITY AS replay(entry, ordinal)
            WHERE NOT EXISTS (
              SELECT 1
              FROM (
                SELECT
                  decision.*,
                  pg_catalog.row_number() OVER (
                    ORDER BY decision.rank_issued_at, decision.confirmation_id
                  ) AS expected_ordinal
                FROM "inventory"."reservation_shortage_impact_decisions" AS decision
                WHERE decision.tenant_id = p_tenant_id
                  AND decision.change_kind = p_change_kind
                  AND decision.change_id = p_change_id
              ) AS stored
              WHERE stored.tenant_id = p_tenant_id
                AND stored.change_kind = p_change_kind
                AND stored.change_id = p_change_id
                AND stored.expected_ordinal = replay.ordinal
                AND stored.confirmation_id = (replay.entry ->> 'resourceId')::uuid
                AND stored.decision = 'ORDER_UNRESOLVABLE'
                AND replay.entry ->> 'moduleId' = 'commerce.inventory'
                AND replay.entry ->> 'resourceType' = 'commerce.inventory.reservation-confirmation'
                AND replay.entry ->> 'tenantId' = p_tenant_id::text
            )
          )
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_shortage_impacts_replay_ck',
        MESSAGE = 'Reservation shortage impact replay must exactly match persisted evidence';
    END IF;

    RETURN QUERY SELECT true;
    RETURN;
  END IF;

  SELECT result.context
  INTO context_record
  FROM "inventory"."read_reservation_shortage_impact_context_for_worker"(
    p_tenant_id,
    p_legal_entity_id,
    p_change_kind,
    p_change_id,
    p_position_id,
    p_occurred_at
  ) AS result;

  IF context_record IS NULL
    OR evaluation_tag NOT IN ('DETERMINATE', 'INDETERMINATE')
    OR p_evaluation #>> '{affectedPositionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR p_evaluation #>> '{affectedPositionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
    OR p_evaluation #>> '{affectedPositionRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_evaluation #>> '{affectedPositionRef,resourceId}' IS DISTINCT FROM p_position_id::text
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_evaluation_ck',
      MESSAGE = 'Reservation shortage impact evaluation must match the locked source context';
  END IF;

  cause_evidence_ref := context_record ->> 'causeEvidenceRef';
  SELECT pg_catalog.count(*)::integer
  INTO candidate_count
  FROM pg_catalog.jsonb_array_elements(context_record #> '{evaluationInput,candidates}') AS eligible(entry)
  WHERE eligible.entry ->> 'poolBoundary' = 'NONE'
    AND eligible.entry #>> '{confirmation,health,state}' IN ('VALID', 'AT_RISK', 'UNVERIFIABLE');

  SELECT coalesce(pg_catalog.sum((allocation.entry #>> '{quantity,amount}')::numeric), 0)
  INTO expected_fenced_amount
  FROM pg_catalog.jsonb_array_elements(context_record #> '{evaluationInput,candidates}') AS fenced(entry)
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(fenced.entry -> 'allocations') AS allocation(entry)
  WHERE (
      fenced.entry ->> 'poolBoundary' = 'COMMITTED_OBLIGATION'
      OR (
        fenced.entry ->> 'poolBoundary' = 'NONE'
        AND fenced.entry #>> '{confirmation,health,state}' IN ('EXPIRED', 'REVOKED')
      )
    )
    AND allocation.entry #>> '{positionRef,tenantId}' = p_tenant_id::text
    AND allocation.entry #>> '{positionRef,resourceId}' = p_position_id::text;

  IF (p_evaluation ->> 'fencedAmount')::numeric IS DISTINCT FROM expected_fenced_amount THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_fenced_amount_ck',
      MESSAGE = 'Reservation shortage fenced amount must equal exact non-reusable allocation evidence';
  END IF;

  IF evaluation_tag = 'DETERMINATE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_evaluation)) <> 4
      OR pg_catalog.jsonb_typeof(p_evaluation -> 'decisions') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_evaluation -> 'decisions') IS DISTINCT FROM candidate_count
      OR (
        SELECT pg_catalog.count(DISTINCT evaluated.entry #>> '{confirmationRef,resourceId}')
        FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'decisions') AS evaluated(entry)
      ) IS DISTINCT FROM candidate_count
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_shortage_impacts_evaluation_ck',
        MESSAGE = 'Determinate shortage decisions must exactly cover eligible Confirmations';
    END IF;
    decision_count := pg_catalog.jsonb_array_length(p_evaluation -> 'decisions');
  ELSE
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_evaluation)) <> 6
      OR p_evaluation ->> 'reason' IS DISTINCT FROM 'AUTHORITATIVE_ISSUANCE_ORDER_UNRESOLVABLE'
      OR p_evaluation -> 'reconciliationRequired' IS DISTINCT FROM 'true'::jsonb
      OR pg_catalog.jsonb_typeof(p_evaluation -> 'candidateRefs') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_evaluation -> 'candidateRefs') IS DISTINCT FROM candidate_count
      OR (
        SELECT pg_catalog.count(DISTINCT evaluated.entry ->> 'resourceId')
        FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'candidateRefs') AS evaluated(entry)
      ) IS DISTINCT FROM candidate_count
      OR candidate_count < 2
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_shortage_impacts_evaluation_ck',
        MESSAGE = 'Indeterminate shortage evidence must exactly cover the unresolved authoritative rank';
    END IF;
    decision_count := candidate_count;
  END IF;

  INSERT INTO "inventory"."reservation_shortage_impacts" (
    tenant_id,
    change_kind,
    change_id,
    physical_effect_id,
    stock_correction_id,
    position_id,
    position_revision,
    available_amount,
    fenced_amount,
    occurred_at,
    status,
    reconciliation_required,
    reason,
    decision_count
  ) VALUES (
    p_tenant_id,
    p_change_kind,
    p_change_id,
    CASE WHEN p_change_kind IN ('RECEIPT', 'ISSUE') THEN p_change_id END,
    CASE WHEN p_change_kind = 'CORRECTION' THEN p_change_id END,
    p_position_id,
    (context_record ->> 'positionRevision')::integer,
    (context_record #>> '{evaluationInput,availableQuantity,amount}')::numeric,
    expected_fenced_amount,
    p_occurred_at,
    evaluation_tag,
    evaluation_tag = 'INDETERMINATE',
    CASE WHEN evaluation_tag = 'INDETERMINATE' THEN p_evaluation ->> 'reason' END,
    decision_count
  );

  IF evaluation_tag = 'DETERMINATE' THEN
    FOR decision IN
      SELECT entry
      FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'decisions') AS evaluated(entry)
    LOOP
      decision_index := decision_index + 1;
      SELECT eligible.entry
      INTO candidate
      FROM pg_catalog.jsonb_array_elements(context_record #> '{evaluationInput,candidates}') AS eligible(entry)
      WHERE eligible.entry ->> 'poolBoundary' = 'NONE'
        AND eligible.entry #>> '{confirmation,health,state}' IN ('VALID', 'AT_RISK', 'UNVERIFIABLE')
        AND eligible.entry #>> '{confirmation,ref,resourceId}' = decision #>> '{confirmationRef,resourceId}';

      SELECT pg_catalog.sum((allocation.entry #>> '{quantity,amount}')::numeric)
      INTO expected_amount
      FROM pg_catalog.jsonb_array_elements(candidate -> 'allocations') AS allocation(entry)
      WHERE allocation.entry #>> '{positionRef,tenantId}' = p_tenant_id::text
        AND allocation.entry #>> '{positionRef,resourceId}' = p_position_id::text;

      IF candidate IS NULL
        OR decision ->> 'capacity' NOT IN ('HONORABLE', 'SHORTAGE')
        OR decision #>> '{confirmationRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
        OR decision #>> '{confirmationRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.reservation-confirmation'
        OR decision #>> '{confirmationRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
        OR decision ->> 'currentHealth' IS DISTINCT FROM candidate #>> '{confirmation,health,state}'
        OR decision -> 'issuanceRank' IS DISTINCT FROM candidate #> '{confirmation,issuanceRank}'
        OR (decision #>> '{affectedQuantity,amount}')::numeric IS DISTINCT FROM expected_amount
        OR decision #> '{affectedQuantity,unitRef}'
          IS DISTINCT FROM context_record #> '{evaluationInput,availableQuantity,unitRef}'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_reservation_shortage_impacts_evaluation_ck',
          MESSAGE = 'Shortage decision must exactly match one eligible Confirmation allocation';
      END IF;

      SELECT confirmation.*
      INTO current_confirmation
      FROM "inventory"."reservation_confirmations" AS confirmation
      WHERE confirmation.tenant_id = p_tenant_id
        AND confirmation.confirmation_id = (decision #>> '{confirmationRef,resourceId}')::uuid
      FOR UPDATE;

      IF current_confirmation.snapshot IS DISTINCT FROM candidate -> 'confirmation' THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'Reservation Confirmation changed while applying shortage impact';
      END IF;

      IF decision ->> 'capacity' = 'SHORTAGE' AND current_confirmation.current_health_state = 'VALID' THEN
        owner_evidence_ref := pg_catalog.left(
          'stock-change:' || pg_catalog.lower(p_change_kind) || ':' || cause_evidence_ref,
          300
        );
        after_snapshot := pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            current_confirmation.snapshot,
            '{health}',
            pg_catalog.jsonb_build_object(
              'state', 'AT_RISK',
              'observation', pg_catalog.jsonb_build_object(
                '_tag', 'MATERIAL_IMPAIRMENT',
                'effectiveAt', p_occurred_at,
                'ownerEvidenceRef', owner_evidence_ref
              )
            )
          ),
          '{revision}',
          pg_catalog.to_jsonb(current_confirmation.current_revision + 1)
        );

        UPDATE "inventory"."reservation_confirmations"
        SET current_health_state = 'AT_RISK',
          current_revision = current_confirmation.current_revision + 1,
          snapshot = after_snapshot,
          updated_at = pg_catalog.clock_timestamp()
        WHERE tenant_id = p_tenant_id
          AND confirmation_id = current_confirmation.confirmation_id
          AND current_revision = current_confirmation.current_revision;

        INSERT INTO "inventory"."reservation_confirmation_history" (
          tenant_id,
          confirmation_id,
          revision,
          health_state,
          snapshot,
          transitioned_at
        ) VALUES (
          p_tenant_id,
          current_confirmation.confirmation_id,
          current_confirmation.current_revision + 1,
          'AT_RISK',
          after_snapshot,
          p_occurred_at
        );
      ELSE
        after_snapshot := current_confirmation.snapshot;
      END IF;

      INSERT INTO "inventory"."reservation_shortage_impact_decisions" (
        tenant_id,
        change_kind,
        change_id,
        confirmation_id,
        priority_ordinal,
        decision,
        affected_amount,
        health_before,
        health_after,
        confirmation_revision_before,
        confirmation_revision_after,
        rank_issued_at,
        rank_owner_evidence_ref
      ) VALUES (
        p_tenant_id,
        p_change_kind,
        p_change_id,
        current_confirmation.confirmation_id,
        decision_index,
        decision ->> 'capacity',
        expected_amount,
        current_confirmation.current_health_state,
        after_snapshot #>> '{health,state}',
        current_confirmation.current_revision,
        (after_snapshot ->> 'revision')::integer,
        (decision #>> '{issuanceRank,issuedAt}')::timestamptz,
        decision #>> '{issuanceRank,ownerEvidenceRef}'
      );
    END LOOP;
  ELSE
    FOR decision IN
      SELECT entry
      FROM pg_catalog.jsonb_array_elements(p_evaluation -> 'candidateRefs') AS evaluated(entry)
    LOOP
      SELECT eligible.entry
      INTO candidate
      FROM pg_catalog.jsonb_array_elements(context_record #> '{evaluationInput,candidates}') AS eligible(entry)
      WHERE eligible.entry ->> 'poolBoundary' = 'NONE'
        AND eligible.entry #>> '{confirmation,health,state}' IN ('VALID', 'AT_RISK', 'UNVERIFIABLE')
        AND eligible.entry #>> '{confirmation,ref,resourceId}' = decision ->> 'resourceId';

      IF candidate IS NULL
        OR decision ->> 'moduleId' IS DISTINCT FROM 'commerce.inventory'
        OR decision ->> 'resourceType' IS DISTINCT FROM 'commerce.inventory.reservation-confirmation'
        OR decision ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_reservation_shortage_impacts_evaluation_ck',
          MESSAGE = 'Indeterminate shortage candidate must exactly match one eligible Confirmation';
      END IF;

      SELECT confirmation.*
      INTO current_confirmation
      FROM "inventory"."reservation_confirmations" AS confirmation
      WHERE confirmation.tenant_id = p_tenant_id
        AND confirmation.confirmation_id = (decision ->> 'resourceId')::uuid
      FOR KEY SHARE;

      IF current_confirmation.snapshot IS DISTINCT FROM candidate -> 'confirmation' THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'Reservation Confirmation changed while applying shortage impact';
      END IF;

      INSERT INTO "inventory"."reservation_shortage_impact_decisions" (
        tenant_id,
        change_kind,
        change_id,
        confirmation_id,
        priority_ordinal,
        decision,
        affected_amount,
        health_before,
        health_after,
        confirmation_revision_before,
        confirmation_revision_after,
        rank_issued_at,
        rank_owner_evidence_ref
      ) VALUES (
        p_tenant_id,
        p_change_kind,
        p_change_id,
        current_confirmation.confirmation_id,
        NULL,
        'ORDER_UNRESOLVABLE',
        NULL,
        current_confirmation.current_health_state,
        current_confirmation.current_health_state,
        current_confirmation.current_revision,
        current_confirmation.current_revision,
        (current_confirmation.snapshot #>> '{issuanceRank,issuedAt}')::timestamptz,
        current_confirmation.snapshot #>> '{issuanceRank,ownerEvidenceRef}'
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."find_reservation_shortage_impact_for_worker"(uuid, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."read_reservation_shortage_impact_context_for_worker"(uuid, uuid, text, uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."apply_reservation_shortage_impact_for_worker"(uuid, uuid, text, uuid, uuid, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."find_reservation_shortage_impact_for_worker"(uuid, uuid, text, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."read_reservation_shortage_impact_context_for_worker"(uuid, uuid, text, uuid, uuid, timestamptz) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."apply_reservation_shortage_impact_for_worker"(uuid, uuid, text, uuid, uuid, timestamptz, jsonb) TO "ontos_runtime";
