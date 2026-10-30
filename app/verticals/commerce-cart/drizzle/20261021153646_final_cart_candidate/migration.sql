CREATE TABLE "commerce_cart"."final_cart_candidates" (
	"action_invocation_id" uuid NOT NULL,
	"buyer_principal_id" uuid NOT NULL,
	"candidate_hash" text NOT NULL,
	"candidate_id" uuid,
	"cart_id" uuid NOT NULL,
	"encoded_candidate" jsonb NOT NULL,
	"final_revision_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"material_json" text NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "final_cart_candidates_pk" PRIMARY KEY("tenant_id","candidate_id"),
	CONSTRAINT "final_cart_candidates_cart_uk" UNIQUE("tenant_id","cart_id"),
	CONSTRAINT "final_cart_candidates_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "final_cart_candidates_digest_ck" CHECK ("candidate_hash" ~ '^[a-f0-9]{64}$' and "candidate_hash" = encode(sha256(convert_to("material_json", 'UTF8')), 'hex')),
	CONSTRAINT "final_cart_candidates_material_ck" CHECK (octet_length("material_json") between 2 and 2097152 and "material_json"::jsonb = "encoded_candidate" - 'candidateHash' and ("encoded_candidate"->>'candidateHash') is not distinct from "candidate_hash")
);
--> statement-breakpoint
ALTER TABLE "commerce_cart"."final_cart_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_cart"."final_cart_candidates" ADD CONSTRAINT "final_cart_candidates_source_fk" FOREIGN KEY ("tenant_id","legal_entity_id","cart_id","source_revision_id") REFERENCES "commerce_cart"."cart_revisions"("tenant_id","legal_entity_id","cart_id","revision_id");--> statement-breakpoint
ALTER TABLE "commerce_cart"."final_cart_candidates" ADD CONSTRAINT "final_cart_candidates_closed_fk" FOREIGN KEY ("tenant_id","legal_entity_id","cart_id","final_revision_id") REFERENCES "commerce_cart"."cart_revisions"("tenant_id","legal_entity_id","cart_id","revision_id");--> statement-breakpoint
CREATE POLICY "final_cart_candidates_scope_select" ON "commerce_cart"."final_cart_candidates" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_cart"."final_cart_candidates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_cart"."final_cart_candidates"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "final_cart_candidates_scope_insert" ON "commerce_cart"."final_cart_candidates" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_cart"."final_cart_candidates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_cart"."final_cart_candidates"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "final_cart_candidates_scope_update" ON "commerce_cart"."final_cart_candidates" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_cart"."final_cart_candidates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_cart"."final_cart_candidates"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_cart"."final_cart_candidates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_cart"."final_cart_candidates"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "final_cart_candidates_scope_delete" ON "commerce_cart"."final_cart_candidates" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_cart"."final_cart_candidates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_cart"."final_cart_candidates"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
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
