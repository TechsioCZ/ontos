-- Custom SQL migration file, put your code below! --
-- Typed Drizzle owns tables, checks, unique constraints, FKs, and policies in the
-- preceding generated migration. PostgreSQL FORCE RLS, privileges, and transition
-- triggers cannot be expressed by that typed DDL API and are this migration's only job.
ALTER TABLE commerce_order.acceptance_bundles FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_order.commitment_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_order.commitment_history FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_order.committed_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_order.consumption_obligations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA commerce_order TO ontos_runtime;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA commerce_order TO ontos_runtime;
GRANT UPDATE (status, revision, updated_at, order_id) ON commerce_order.commitment_attempts TO ontos_runtime;
GRANT UPDATE (completed_at) ON commerce_order.consumption_obligations TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_order.reject_immutable_commitment_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_order, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_immutable_commitment_ck', MESSAGE = 'Order commitment evidence is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_bundles_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON commerce_order.acceptance_bundles FOR EACH STATEMENT EXECUTE FUNCTION commerce_order.reject_immutable_commitment_change();
CREATE TRIGGER order_orders_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON commerce_order.committed_orders FOR EACH STATEMENT EXECUTE FUNCTION commerce_order.reject_immutable_commitment_change();
CREATE TRIGGER order_history_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON commerce_order.commitment_history FOR EACH STATEMENT EXECUTE FUNCTION commerce_order.reject_immutable_commitment_change();
--> statement-breakpoint
CREATE FUNCTION commerce_order.guard_attempt_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_order, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.attempt_id, NEW.bundle_id, NEW.bundle_hash, NEW.buyer_principal_id, NEW.commitment_correlation_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.attempt_id, OLD.bundle_id, OLD.bundle_hash, OLD.buyer_principal_id, OLD.commitment_correlation_id, OLD.created_at)
    OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
    OR OLD.status = 'CANCELLED'
    OR (OLD.status = 'COMMITTED' AND (NEW.status <> 'COMMITTED' OR NEW.order_id IS DISTINCT FROM OLD.order_id))
    OR (OLD.status IN ('READY', 'PRECOMMIT_FAILED') AND NEW.status NOT IN ('PRECOMMIT_FAILED', 'CANCELLED', 'COMMITTED'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_attempt_transition_ck', MESSAGE = 'Invalid Order commitment transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_attempt_transition BEFORE UPDATE ON commerce_order.commitment_attempts FOR EACH ROW EXECUTE FUNCTION commerce_order.guard_attempt_transition();
CREATE TRIGGER order_attempt_no_delete BEFORE DELETE OR TRUNCATE ON commerce_order.commitment_attempts FOR EACH STATEMENT EXECUTE FUNCTION commerce_order.reject_immutable_commitment_change();
--> statement-breakpoint
CREATE FUNCTION commerce_order.guard_consumption_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_order, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.order_id, NEW.consumption_intent)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.order_id, OLD.consumption_intent)
    OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'order_consumption_transition_ck', MESSAGE = 'Invalid Order consumption transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_consumption_transition BEFORE UPDATE ON commerce_order.consumption_obligations FOR EACH ROW EXECUTE FUNCTION commerce_order.guard_consumption_completion();
CREATE TRIGGER order_consumption_no_delete BEFORE DELETE OR TRUNCATE ON commerce_order.consumption_obligations FOR EACH STATEMENT EXECUTE FUNCTION commerce_order.reject_immutable_commitment_change();
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_order.reject_immutable_commitment_change(), commerce_order.guard_attempt_transition(), commerce_order.guard_consumption_completion() FROM PUBLIC;
