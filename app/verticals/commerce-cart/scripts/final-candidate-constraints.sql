-- Database-only integrity extension: immutable candidate hash and exact native Cart
-- lineage. The function stays INVOKER under forced owner RLS; it reads no CCC,
-- Catalog, Pricing, Order, or authentication tables.
CREATE FUNCTION commerce_cart.check_final_cart_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, commerce_cart, pg_temp AS $$
DECLARE
  source commerce_cart.cart_revisions%ROWTYPE;
  closed commerce_cart.cart_revisions%ROWTYPE;
  canonical commerce_cart.carts%ROWTYPE;
  material jsonb;
BEGIN
  SELECT * INTO source FROM commerce_cart.cart_revisions
    WHERE tenant_id = NEW.tenant_id AND legal_entity_id = NEW.legal_entity_id
      AND cart_id = NEW.cart_id AND revision_id = NEW.source_revision_id;
  SELECT * INTO closed FROM commerce_cart.cart_revisions
    WHERE tenant_id = NEW.tenant_id AND legal_entity_id = NEW.legal_entity_id
      AND cart_id = NEW.cart_id AND revision_id = NEW.final_revision_id;
  SELECT * INTO canonical FROM commerce_cart.carts
    WHERE tenant_id = NEW.tenant_id AND legal_entity_id = NEW.legal_entity_id AND cart_id = NEW.cart_id;
  material := NEW.encoded_candidate;
  IF source.status IS DISTINCT FROM 'OPEN' OR closed.status IS DISTINCT FROM 'CLOSED'
    OR closed.previous_revision_id IS DISTINCT FROM source.revision_id
    OR closed.revision_number IS DISTINCT FROM source.revision_number + 1
    OR closed.action_invocation_id IS DISTINCT FROM NEW.action_invocation_id
    OR closed.actor_principal_id IS DISTINCT FROM NEW.buyer_principal_id
    OR canonical.creator_principal_id IS DISTINCT FROM NEW.buyer_principal_id
    OR canonical.current_revision_id IS DISTINCT FROM NEW.final_revision_id
    OR material->>'version' IS DISTINCT FROM 'FINAL_CART_CANDIDATE.v1'
    OR material->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
    OR material->>'legalEntityId' IS DISTINCT FROM NEW.legal_entity_id::text
    OR material->>'buyerPrincipalId' IS DISTINCT FROM NEW.buyer_principal_id::text
    OR material->'candidateRef' IS DISTINCT FROM jsonb_build_object('moduleId','commerce.cart','resourceType','commerce.cart.final-cart-candidate','resourceId',NEW.candidate_id,'tenantId',NEW.tenant_id)
    OR material->'sourceCart' IS DISTINCT FROM jsonb_build_object('cartRef',source.encoded_cart->'cartRef','revision',source.revision_number,'revisionId',source.revision_id)
    OR material->'finalCartRevision' IS DISTINCT FROM jsonb_build_object('cartRef',closed.encoded_cart->'cartRef','revision',closed.revision_number,'revisionId',closed.revision_id)
    OR material->'pricing'->'decision'->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
    OR material->'pricing'->'decision'->'commercialScope'->>'sellingLegalEntityId' IS DISTINCT FROM NEW.legal_entity_id::text
    OR material->'pricing'->'decision'->'purchasingContext'->'actor'->>'kind' IS DISTINCT FROM 'PRINCIPAL'
    OR material->'pricing'->'decision'->'purchasingContext'->'actor'->>'principalId' IS DISTINCT FROM NEW.buyer_principal_id::text
    OR material->>'orderCommitmentTime' IS NULL
    OR material->'pricing'->'decision'->>'operationTime' IS DISTINCT FROM material->>'orderCommitmentTime'
    OR jsonb_array_length(material->'pricing'->'decision'->'lines') IS DISTINCT FROM jsonb_array_length(source.encoded_cart->'entries')
    OR jsonb_array_length(source.encoded_cart->'entries') NOT BETWEEN 1 AND 500
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(source.encoded_cart->'entries') WITH ORDINALITY e(value, position)
      WHERE material->'pricing'->'decision'->'lines'->(e.position::int - 1)->>'occurrenceId' IS DISTINCT FROM e.value->>'selectionId'
        OR material->'pricing'->'decision'->'lines'->(e.position::int - 1)->'catalog'->'selection' IS DISTINCT FROM e.value->'selection'
        OR material->'pricing'->'decision'->'lines'->(e.position::int - 1)->'catalog'->'unitRef' IS DISTINCT FROM e.value->'quantity'->'unitRef'
        OR material->'pricing'->'decision'->'lines'->(e.position::int - 1)->'catalog'->'quantity'->>'requested' IS DISTINCT FROM e.value->'quantity'->>'amount'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Final Cart candidate must bind one exact closed owner revision and buyer';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER final_cart_candidates_immutable BEFORE UPDATE OR DELETE ON commerce_cart.final_cart_candidates
  FOR EACH ROW EXECUTE FUNCTION commerce_cart.reject_immutable_change();
--> statement-breakpoint
ALTER TABLE commerce_cart.final_cart_candidates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER final_cart_candidates_population_consistency AFTER INSERT ON commerce_cart.final_cart_candidates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_cart.check_final_cart_candidate();
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE commerce_cart.final_cart_candidates TO ontos_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_cart.check_final_cart_candidate() FROM PUBLIC;
