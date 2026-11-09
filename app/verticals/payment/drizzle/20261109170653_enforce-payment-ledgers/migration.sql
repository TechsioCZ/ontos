-- Custom SQL migration file, put your code below! --
-- Typed Drizzle owns tables, checks, unique/partial indexes, FKs and policies in the preceding
-- generated migration. FORCE RLS, least-privilege grants, append-only/transition triggers and the Core
-- durable-work tracking of unknown effects cannot be expressed by that typed DDL API and are this
-- migration's only job.
ALTER TABLE payment.method_enablements FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.method_enablement_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.source_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.source_authority_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.payments FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.payment_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.operation_outcome_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.refund_item_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.observations FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.payment_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.recovery_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.reconciliation_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE payment.reconciliation_decisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA payment TO ontos_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA payment FROM PUBLIC;
GRANT SELECT, INSERT ON
  payment.method_enablements,
  payment.method_enablement_revisions,
  payment.source_authorities,
  payment.source_authority_revisions,
  payment.payments,
  payment.payment_operations,
  payment.operation_outcome_transitions,
  payment.refund_item_claims,
  payment.observations,
  payment.payment_authorizations,
  payment.recovery_requests,
  payment.reconciliation_cases,
  payment.reconciliation_decisions
TO ontos_runtime;
GRANT UPDATE (enabled, revision, reason, configured_at, action_invocation_id, actor_principal_id, composition_revision) ON payment.method_enablements TO ontos_runtime;
GRANT UPDATE (status, revision, refund_route, reason, configured_at, action_invocation_id, actor_principal_id, composition_revision) ON payment.source_authorities TO ontos_runtime;
GRANT UPDATE (coverage_revision, aggregate_version) ON payment.payments TO ontos_runtime;
GRANT UPDATE (outcome, outcome_revision) ON payment.payment_operations TO ontos_runtime;
GRANT UPDATE (active, released_at, released_by_action_invocation_id) ON payment.refund_item_claims TO ontos_runtime;
GRANT UPDATE (status, closed_at, revision) ON payment.reconciliation_cases TO ontos_runtime;
-- Pre-authentication replay infrastructure has no trusted tenant scope; it is never updated.
REVOKE ALL ON TABLE payment.gateway_assertion_redemptions FROM ontos_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE payment.gateway_assertion_redemptions TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION payment.reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_append_only_ck', MESSAGE = 'Payment evidence is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_method_enablement_revisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.method_enablement_revisions FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_source_authority_revisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.source_authority_revisions FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_outcome_transitions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.operation_outcome_transitions FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_observations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.observations FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_authorizations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.payment_authorizations FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_recovery_requests_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.recovery_requests FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_reconciliation_decisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payment.reconciliation_decisions FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_method_enablements_no_delete BEFORE DELETE OR TRUNCATE ON payment.method_enablements FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_source_authorities_no_delete BEFORE DELETE OR TRUNCATE ON payment.source_authorities FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_payments_no_delete BEFORE DELETE OR TRUNCATE ON payment.payments FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_operations_no_delete BEFORE DELETE OR TRUNCATE ON payment.payment_operations FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_refund_item_claims_no_delete BEFORE DELETE OR TRUNCATE ON payment.refund_item_claims FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
CREATE TRIGGER payment_reconciliation_cases_no_delete BEFORE DELETE OR TRUNCATE ON payment.reconciliation_cases FOR EACH STATEMENT EXECUTE FUNCTION payment.reject_ledger_mutation();
--> statement-breakpoint
-- Payment meaning is immutable: only the coverage revision and aggregate version advance, one step at a time.
CREATE FUNCTION payment.guard_payment_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'coverage_revision' - 'aggregate_version') IS DISTINCT FROM (to_jsonb(OLD) - 'coverage_revision' - 'aggregate_version')
    OR NEW.aggregate_version <> OLD.aggregate_version + 1
    OR NEW.coverage_revision NOT IN (OLD.coverage_revision, OLD.coverage_revision + 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_payment_transition_ck', MESSAGE = 'Payment meaning is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_payments_transition BEFORE UPDATE ON payment.payments FOR EACH ROW EXECUTE FUNCTION payment.guard_payment_update();
--> statement-breakpoint
-- Operation material is immutable; outcomes follow the canonical lifecycle (#1148/#1151):
-- a stale PENDING never overrides EFFECT_CONFIRMED and terminal outcomes only move to CONFLICT.
CREATE FUNCTION payment.guard_operation_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'outcome' - 'outcome_revision') IS DISTINCT FROM (to_jsonb(OLD) - 'outcome' - 'outcome_revision')
    OR NEW.outcome_revision <> OLD.outcome_revision + 1
    OR NOT (
      (OLD.outcome = 'PENDING' AND NEW.outcome IN ('EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'INDETERMINATE', 'CONFLICT'))
      OR (OLD.outcome = 'INDETERMINATE' AND NEW.outcome IN ('PENDING', 'EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'CONFLICT'))
      OR (OLD.outcome = 'CONFLICT' AND NEW.outcome IN ('EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED'))
      OR (OLD.outcome IN ('EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED') AND NEW.outcome = 'CONFLICT')
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_operation_transition_ck', MESSAGE = 'Invalid Payment Operation outcome transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_operations_transition BEFORE UPDATE ON payment.payment_operations FOR EACH ROW EXECUTE FUNCTION payment.guard_operation_update();
--> statement-breakpoint
-- Every operation outcome revision is explained by exactly one appended transition row at commit.
CREATE FUNCTION payment.require_outcome_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment.operation_outcome_transitions AS transition
    WHERE transition.tenant_id = NEW.tenant_id
      AND transition.legal_entity_id = NEW.legal_entity_id
      AND transition.payment_id = NEW.payment_id
      AND transition.operation_id = NEW.operation_id
      AND transition.outcome_revision = NEW.outcome_revision
      AND transition.to_outcome = NEW.outcome
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_operation_lineage_ck', MESSAGE = 'Payment Operation outcome lacks its transition lineage';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_operations_lineage AFTER INSERT OR UPDATE ON payment.payment_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payment.require_outcome_transition();
--> statement-breakpoint
-- A refund item reservation is released once, only by definitive non-execution, and never reactivated.
CREATE FUNCTION payment.guard_refund_claim_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'active' - 'released_at' - 'released_by_action_invocation_id') IS DISTINCT FROM (to_jsonb(OLD) - 'active' - 'released_at' - 'released_by_action_invocation_id')
    OR NOT OLD.active OR NEW.active
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_claim_transition_ck', MESSAGE = 'Invalid refund item reservation transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_refund_item_claims_transition BEFORE UPDATE ON payment.refund_item_claims FOR EACH ROW EXECUTE FUNCTION payment.guard_refund_claim_update();
--> statement-breakpoint
-- Configuration current rows keep their identity; each change is exactly the next revision.
CREATE FUNCTION payment.guard_method_enablement_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.method_enablement_id, NEW.customer_configuration_id, NEW.method)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.method_enablement_id, OLD.customer_configuration_id, OLD.method)
    OR NEW.revision <> OLD.revision + 1 OR NEW.configured_at < OLD.configured_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_method_enablement_transition_ck', MESSAGE = 'Invalid method enablement revision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_method_enablements_transition BEFORE UPDATE ON payment.method_enablements FOR EACH ROW EXECUTE FUNCTION payment.guard_method_enablement_update();
--> statement-breakpoint
CREATE FUNCTION payment.guard_source_authority_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.source_authority_id, NEW.fact_family, NEW.method, NEW.source_kind, NEW.source_system, NEW.account_ref, NEW.environment)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.source_authority_id, OLD.fact_family, OLD.method, OLD.source_kind, OLD.source_system, OLD.account_ref, OLD.environment)
    OR NEW.revision <> OLD.revision + 1 OR NEW.configured_at < OLD.configured_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_source_authority_transition_ck', MESSAGE = 'Invalid source authority revision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_source_authorities_transition BEFORE UPDATE ON payment.source_authorities FOR EACH ROW EXECUTE FUNCTION payment.guard_source_authority_update();
--> statement-breakpoint
-- A reconciliation case only closes once; closing never rewrites what it held.
CREATE FUNCTION payment.guard_reconciliation_case_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'closed_at' - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'closed_at' - 'revision')
    OR OLD.status <> 'OPEN' OR NEW.status <> 'CLOSED' OR NEW.revision <> OLD.revision + 1
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_reconciliation_case_transition_ck', MESSAGE = 'Invalid reconciliation case transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_reconciliation_cases_transition BEFORE UPDATE ON payment.reconciliation_cases FOR EACH ROW EXECUTE FUNCTION payment.guard_reconciliation_case_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  payment.reject_ledger_mutation(),
  payment.guard_payment_update(),
  payment.guard_operation_update(),
  payment.require_outcome_transition(),
  payment.guard_refund_claim_update(),
  payment.guard_method_enablement_update(),
  payment.guard_source_authority_update(),
  payment.guard_reconciliation_case_update()
FROM PUBLIC;
--> statement-breakpoint
-- #1151/#1153 TECH-01: an INDETERMINATE Payment Operation is admitted execution whose monetary effect is
-- unknown; it has neither a proven outcome nor a safe durable checkpoint. It is tracked as Core durable
-- work of payment.core under the runtime revision of the invocation that made the effect unknown, so the
-- existing Core fence refuses to drain or seal that release until the unknown is resolved by proven
-- evidence or a governed reconciliation decision. Business waiting (PENDING) is never tracked here.
-- The work is cleared under the exact revision it was tracked with; Core keeps that revision active
-- while the work exists, so no unknown effect is relabelled to another revision.
CREATE FUNCTION "payment"."track_indeterminate_operation_work"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, payment, pg_temp
AS $function$
DECLARE
  operation_work_id text := 'payment-operation:' || NEW.tenant_id || ':' || NEW.operation_id;
  tracked_revision text;
BEGIN
  IF NEW.from_outcome = 'INDETERMINATE' THEN
    FOR tracked_revision IN
      SELECT work.original_revision
      FROM core.application_composition_durable_work AS work
      WHERE work.owner_module_key = 'payment.core' AND work.work_id = operation_work_id
    LOOP
      PERFORM core.track_application_composition_durable_work('payment.core', tracked_revision, operation_work_id, false);
    END LOOP;
  END IF;
  IF NEW.to_outcome = 'INDETERMINATE' THEN
    PERFORM core.track_application_composition_durable_work(
      'payment.core', NEW.composition_revision, operation_work_id, true
    );
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment"."track_indeterminate_operation_work"() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER "payment_outcome_transitions_durable_work"
AFTER INSERT ON "payment"."operation_outcome_transitions"
FOR EACH ROW EXECUTE FUNCTION "payment"."track_indeterminate_operation_work"();
