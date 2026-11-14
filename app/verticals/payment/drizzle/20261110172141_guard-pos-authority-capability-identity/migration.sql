-- A source capability is part of the immutable identity, like its source account.
CREATE OR REPLACE FUNCTION payment.guard_source_authority_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, payment, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.source_authority_id, NEW.fact_family, NEW.method, NEW.source_kind, NEW.source_system, NEW.account_ref, NEW.environment, NEW.pickup_capability_ref)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.source_authority_id, OLD.fact_family, OLD.method, OLD.source_kind, OLD.source_system, OLD.account_ref, OLD.environment, OLD.pickup_capability_ref)
    OR NEW.revision <> OLD.revision + 1 OR NEW.configured_at < OLD.configured_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payment_source_authority_transition_ck', MESSAGE = 'Invalid source authority revision';
  END IF;
  RETURN NEW;
END;
$$;
