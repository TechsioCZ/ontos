-- Narrow database-only exception: Drizzle cannot express deferred cross-table
-- equality, append-only history, or a root's exact generation chain. These
-- INVOKER functions run with the already installed source SLE and forced RLS.
-- They never scan another SLE's private Cart rows or elevate privileges.
CREATE FUNCTION commerce_cart.reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_cart, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Cart immutable history cannot change';
END;
$$;

CREATE FUNCTION commerce_cart.check_cart_population_consistency() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_cart, pg_temp AS $$
DECLARE
  scope_tenant uuid;
  source_cart uuid;
  source_sle uuid;
  canonical commerce_cart.carts%ROWTYPE;
  revision commerce_cart.cart_revisions%ROWTYPE;
  current_root commerce_cart.population_roots%ROWTYPE;
  current_history commerce_cart.population_generation_history%ROWTYPE;
  expected_entries jsonb;
BEGIN
  scope_tenant := coalesce(NEW.tenant_id, OLD.tenant_id);
  IF scope_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart consistency scope mismatch';
  END IF;
  SELECT * INTO current_root FROM commerce_cart.population_roots WHERE tenant_id = scope_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart authority is missing';
  END IF;
  SELECT * INTO current_history FROM commerce_cart.population_generation_history
    WHERE tenant_id = scope_tenant AND generation = current_root.generation AND history_id = current_root.history_id;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM commerce_cart.population_generation_history h
    WHERE h.tenant_id = scope_tenant AND (
      h.generation > current_root.generation OR
      (h.generation > 0 AND NOT EXISTS (
        SELECT 1 FROM commerce_cart.population_generation_history p
        WHERE p.tenant_id = h.tenant_id AND p.generation = h.generation - 1 AND p.history_id = h.previous_history_id
      ))
    )
  ) OR NOT EXISTS (SELECT 1 FROM commerce_cart.population_generation_history WHERE tenant_id = scope_tenant AND generation = 0)
  THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart population generation chain is inconsistent'; END IF;

  IF TG_TABLE_NAME IN ('population_roots', 'population_generation_history') THEN
    -- Root initialization has no SLE or Cart. Mutation history carries its
    -- actual source SLE; never resolve another SLE's private canonical rows.
    IF TG_TABLE_NAME = 'population_roots' OR coalesce(NEW.generation, OLD.generation) = 0 THEN
      RETURN NULL;
    END IF;
    source_cart := coalesce(NEW.cart_id, OLD.cart_id);
    source_sle := coalesce(NEW.legal_entity_id, OLD.legal_entity_id);
  ELSE
    source_cart := coalesce(NEW.cart_id, OLD.cart_id);
    source_sle := coalesce(NEW.legal_entity_id, OLD.legal_entity_id);
  END IF;
  IF source_sle IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart consistency source SLE mismatch';
  END IF;
  SELECT * INTO canonical FROM commerce_cart.carts WHERE tenant_id = scope_tenant AND cart_id = source_cart;
  IF NOT FOUND OR canonical.legal_entity_id IS DISTINCT FROM source_sle THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart population has no canonical source';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM commerce_cart.population_cart_heads h
    WHERE h.tenant_id = scope_tenant AND h.cart_id = source_cart AND h.revision_id = canonical.current_revision_id AND h.legal_entity_id = source_sle
  ) OR canonical.current_revision_id IS DISTINCT FROM (
    SELECT r.revision_id FROM commerce_cart.cart_revisions r WHERE r.tenant_id = scope_tenant AND r.cart_id = source_cart ORDER BY r.revision_number DESC LIMIT 1
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart canonical and population heads differ'; END IF;

  IF EXISTS (
    SELECT 1 FROM commerce_cart.population_generation_history h
    LEFT JOIN commerce_cart.cart_revisions r ON r.tenant_id = h.tenant_id AND r.cart_id = h.cart_id AND r.revision_id = h.revision_id
    WHERE h.tenant_id = scope_tenant AND h.cart_id = source_cart AND (
      r.revision_id IS NULL OR r.population_generation IS DISTINCT FROM h.generation OR
      r.action_invocation_id IS DISTINCT FROM h.action_invocation_id OR r.actor_principal_id IS DISTINCT FROM h.actor_principal_id
    )
  ) OR EXISTS (
    SELECT 1 FROM commerce_cart.population_selection_refs a
    JOIN commerce_cart.population_selection_refs b ON b.tenant_id = a.tenant_id AND b.selection_id = a.selection_id
    WHERE a.tenant_id = scope_tenant AND a.cart_id = source_cart AND (
      a.cart_id IS DISTINCT FROM b.cart_id OR a.selection IS DISTINCT FROM b.selection OR
      a.created_by_principal_id IS DISTINCT FROM b.created_by_principal_id OR a.origin_revision_id IS DISTINCT FROM b.origin_revision_id OR
      a.source_action_invocation_id IS DISTINCT FROM b.source_action_invocation_id
    )
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart population contains a ghost generation or redefined owner identity'; END IF;

  FOR revision IN SELECT * FROM commerce_cart.cart_revisions WHERE tenant_id = scope_tenant AND cart_id = source_cart LOOP
    IF NOT EXISTS (
      SELECT 1 FROM commerce_cart.population_cart_versions v
      WHERE v.tenant_id = scope_tenant AND v.cart_id = source_cart AND v.revision_id = revision.revision_id
        AND v.legal_entity_id = revision.legal_entity_id AND v.revision_number = revision.revision_number
        AND v.creator_principal_id = canonical.creator_principal_id AND v.actor_principal_id = revision.actor_principal_id
        AND v.action_invocation_id = revision.action_invocation_id AND v.status = revision.status
    ) OR NOT EXISTS (
      SELECT 1 FROM commerce_cart.population_generation_history h
      WHERE h.tenant_id = scope_tenant AND h.generation = revision.population_generation AND h.cart_id = source_cart
        AND h.revision_id = revision.revision_id AND h.legal_entity_id = source_sle
        AND h.action_invocation_id = revision.action_invocation_id AND h.actor_principal_id = revision.actor_principal_id
    ) OR (revision.revision_number > 1 AND NOT EXISTS (
      SELECT 1 FROM commerce_cart.cart_revisions p WHERE p.tenant_id = scope_tenant AND p.cart_id = source_cart
        AND p.revision_number = revision.revision_number - 1 AND p.revision_id = revision.previous_revision_id AND p.status = 'OPEN'
    )) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart revision attestation or predecessor differs'; END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'createdByPrincipalId', e.created_by_principal_id, 'originRevisionId', e.origin_revision_id,
      'quantity', jsonb_build_object('amount', e.requested_quantity, 'unitRef', e.requested_unit),
      'selection', e.selection, 'selectionId', e.selection_id, 'sourceActionInvocationId', e.source_action_invocation_id
    ) ORDER BY e.position), '[]'::jsonb) INTO expected_entries
    FROM commerce_cart.cart_revision_selections e WHERE e.tenant_id = scope_tenant AND e.cart_id = source_cart AND e.revision_id = revision.revision_id;
    IF EXISTS (
        SELECT 1 FROM commerce_cart.cart_revision_selections e
        WHERE e.tenant_id = scope_tenant AND e.cart_id = source_cart AND e.revision_id = revision.revision_id
        HAVING min(e.position) <> 0 OR max(e.position) <> count(*) - 1
      ) OR expected_entries IS DISTINCT FROM revision.encoded_cart->'entries'
      OR revision.encoded_cart->'cartRef'->>'resourceId' IS DISTINCT FROM source_cart::text
      OR revision.encoded_cart->'cartRef'->>'tenantId' IS DISTINCT FROM scope_tenant::text
      OR revision.encoded_cart->'cartRef'->>'moduleId' IS DISTINCT FROM 'commerce.cart'
      OR revision.encoded_cart->'cartRef'->>'resourceType' IS DISTINCT FROM 'commerce.cart.cart'
      OR revision.encoded_cart->'revisionRef'->'resourceRef' IS DISTINCT FROM revision.encoded_cart->'cartRef'
      OR (revision.status = 'CLOSED' AND revision.encoded_cart->'entries' IS DISTINCT FROM (
        SELECT p.encoded_cart->'entries' FROM commerce_cart.cart_revisions p
        WHERE p.tenant_id = scope_tenant AND p.cart_id = source_cart AND p.revision_id = revision.previous_revision_id
      ))
      OR EXISTS (
        SELECT 1 FROM commerce_cart.cart_revision_selections e
        WHERE e.tenant_id = scope_tenant AND e.cart_id = source_cart AND e.revision_id = revision.revision_id
          AND (e.selection->'productRef'->>'tenantId' IS DISTINCT FROM scope_tenant::text OR e.requested_unit->>'tenantId' IS DISTINCT FROM scope_tenant::text)
      )
      OR revision.encoded_cart->>'legalEntityId' IS DISTINCT FROM source_sle::text
      OR revision.encoded_cart->>'preparationPrincipalId' IS DISTINCT FROM canonical.creator_principal_id::text
      OR revision.encoded_cart->>'status' IS DISTINCT FROM revision.status
      OR revision.encoded_cart->'intendedContext' IS DISTINCT FROM canonical.intended_context
      OR revision.encoded_cart->'revisionRef'->>'revisionId' IS DISTINCT FROM revision.revision_id::text
      OR revision.encoded_cart->'revisionRef'->>'revision' IS DISTINCT FROM revision.revision_number::text
      OR EXISTS (
        (SELECT e.selection_id, e.position, e.selection, e.created_by_principal_id, e.origin_revision_id, e.source_action_invocation_id
         FROM commerce_cart.cart_revision_selections e WHERE e.tenant_id = scope_tenant AND e.cart_id = source_cart AND e.revision_id = revision.revision_id
         EXCEPT
         SELECT i.selection_id, i.position, i.selection, i.created_by_principal_id, i.origin_revision_id, i.source_action_invocation_id
         FROM commerce_cart.population_selection_refs i WHERE i.tenant_id = scope_tenant AND i.cart_id = source_cart AND i.revision_id = revision.revision_id)
        UNION ALL
        (SELECT i.selection_id, i.position, i.selection, i.created_by_principal_id, i.origin_revision_id, i.source_action_invocation_id
         FROM commerce_cart.population_selection_refs i WHERE i.tenant_id = scope_tenant AND i.cart_id = source_cart AND i.revision_id = revision.revision_id
         EXCEPT
         SELECT e.selection_id, e.position, e.selection, e.created_by_principal_id, e.origin_revision_id, e.source_action_invocation_id
         FROM commerce_cart.cart_revision_selections e WHERE e.tenant_id = scope_tenant AND e.cart_id = source_cart AND e.revision_id = revision.revision_id)
      )
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart entries and minimal population index differ'; END IF;
    IF EXISTS (
      SELECT 1 FROM commerce_cart.cart_revision_selections e
      WHERE e.tenant_id = scope_tenant AND e.cart_id = source_cart AND e.revision_id = revision.revision_id
      AND NOT EXISTS (
        SELECT 1 FROM commerce_cart.cart_revisions origin
        JOIN commerce_cart.cart_revision_selections original_entry ON original_entry.tenant_id = origin.tenant_id AND original_entry.cart_id = origin.cart_id AND original_entry.revision_id = origin.revision_id AND original_entry.selection_id = e.selection_id
        WHERE origin.tenant_id = e.tenant_id AND origin.cart_id = e.cart_id AND origin.revision_id = e.origin_revision_id
          AND origin.actor_principal_id = e.created_by_principal_id AND origin.action_invocation_id = e.source_action_invocation_id
          AND origin.revision_number <= revision.revision_number
      )
    ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart entry origin attribution is invalid'; END IF;
    -- Reused owner identity means the same held value/provenance in every revision.
    IF EXISTS (
      SELECT 1 FROM commerce_cart.cart_revision_selections a
      JOIN commerce_cart.cart_revision_selections b ON b.tenant_id = a.tenant_id AND b.selection_id = a.selection_id
      WHERE a.tenant_id = scope_tenant AND a.cart_id = source_cart AND (
        a.cart_id IS DISTINCT FROM b.cart_id OR a.selection IS DISTINCT FROM b.selection OR
        a.requested_quantity IS DISTINCT FROM b.requested_quantity OR a.requested_unit IS DISTINCT FROM b.requested_unit OR
        a.created_by_principal_id IS DISTINCT FROM b.created_by_principal_id OR a.origin_revision_id IS DISTINCT FROM b.origin_revision_id OR
        a.source_action_invocation_id IS DISTINCT FROM b.source_action_invocation_id
      )
    ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart held-entry identity was redefined'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION commerce_cart.guard_cart_head_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_cart, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - CASE WHEN TG_TABLE_NAME = 'carts' THEN 'current_revision_id' ELSE 'revision_id' END) IS DISTINCT FROM (to_jsonb(OLD) - CASE WHEN TG_TABLE_NAME = 'carts' THEN 'current_revision_id' ELSE 'revision_id' END) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Cart identity and preparation context are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION commerce_cart.guard_population_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_cart, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.generation <> OLD.generation + 1 OR NEW.history_id = OLD.history_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cart population generation must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cart_identity_immutable BEFORE UPDATE ON commerce_cart.carts FOR EACH ROW EXECUTE FUNCTION commerce_cart.guard_cart_head_update();
CREATE TRIGGER cart_population_head_identity_immutable BEFORE UPDATE ON commerce_cart.population_cart_heads FOR EACH ROW EXECUTE FUNCTION commerce_cart.guard_cart_head_update();
CREATE TRIGGER cart_identity_no_delete BEFORE DELETE ON commerce_cart.carts FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
CREATE TRIGGER cart_population_generation BEFORE UPDATE ON commerce_cart.population_roots FOR EACH ROW EXECUTE FUNCTION commerce_cart.guard_population_generation();
CREATE TRIGGER cart_population_no_delete BEFORE DELETE ON commerce_cart.population_roots FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
CREATE TRIGGER cart_revisions_immutable BEFORE UPDATE OR DELETE ON commerce_cart.cart_revisions FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
CREATE TRIGGER cart_revision_selections_immutable BEFORE UPDATE OR DELETE ON commerce_cart.cart_revision_selections FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
CREATE TRIGGER population_cart_versions_immutable BEFORE UPDATE OR DELETE ON commerce_cart.population_cart_versions FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
CREATE TRIGGER population_selection_refs_immutable BEFORE UPDATE OR DELETE ON commerce_cart.population_selection_refs FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
CREATE TRIGGER population_generation_history_immutable BEFORE UPDATE OR DELETE ON commerce_cart.population_generation_history FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
ALTER TABLE commerce_cart.carts FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER carts_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.carts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
ALTER TABLE commerce_cart.cart_revisions FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER cart_revisions_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.cart_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
ALTER TABLE commerce_cart.cart_revision_selections FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER cart_revision_selections_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.cart_revision_selections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
ALTER TABLE commerce_cart.population_roots FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER population_roots_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.population_roots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
ALTER TABLE commerce_cart.population_cart_versions FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER population_cart_versions_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.population_cart_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
ALTER TABLE commerce_cart.population_selection_refs FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER population_selection_refs_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.population_selection_refs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
ALTER TABLE commerce_cart.population_cart_heads FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER population_cart_heads_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.population_cart_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
ALTER TABLE commerce_cart.population_generation_history FORCE ROW LEVEL SECURITY;
CREATE CONSTRAINT TRIGGER population_generation_history_population_consistency AFTER INSERT OR UPDATE OR DELETE ON commerce_cart.population_generation_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_cart_population_consistency();
-- The ordinary runtime may use only this owner schema and its declared rows.
GRANT USAGE ON SCHEMA commerce_cart TO ontos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commerce_cart.carts, commerce_cart.cart_revisions,
  commerce_cart.cart_revision_selections, commerce_cart.population_roots,
  commerce_cart.population_cart_versions, commerce_cart.population_selection_refs,
  commerce_cart.population_cart_heads, commerce_cart.population_generation_history TO ontos_runtime;
REVOKE ALL ON FUNCTION commerce_cart.reject_immutable_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_cart.check_cart_population_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_cart.guard_cart_head_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION commerce_cart.guard_population_generation() FROM PUBLIC;
