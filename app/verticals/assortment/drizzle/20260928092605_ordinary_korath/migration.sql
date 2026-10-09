CREATE POLICY "assortment_decision_set_fences_owner_routine" ON "assortment"."assortment_decision_set_fences" AS PERMISSIVE FOR ALL TO public USING ("assortment"."assortment_decision_set_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_decision_set_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
LOCK TABLE
  "assortment"."assortment_decision_set_fences",
  "assortment"."assortment_stable_rules",
  "assortment"."assortment_rule_revisions",
  "assortment"."assortment_rule_retirement_facts",
  "assortment"."assortment_applicability_bindings",
  "assortment"."assortment_applicability_binding_end_facts",
  "assortment"."assortment_closed_boundaries",
  "assortment"."assortment_closed_boundary_end_facts",
  "assortment"."assortment_admission_sets",
  "assortment"."assortment_admission_set_entries",
  "assortment"."assortment_collection_revisions"
IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_decision_set_fences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_stable_rules" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_rule_revisions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_rule_retirement_facts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_applicability_bindings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_applicability_binding_end_facts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_closed_boundaries" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_closed_boundary_end_facts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_admission_sets" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_admission_set_entries" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_collection_revisions" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "assortment"."advance_decision_set_fence"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, assortment, pg_temp
AS $$
DECLARE
  affected_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_tenant := OLD.tenant_id;
  ELSE
    affected_tenant := NEW.tenant_id;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Assortment material fact tenant is immutable';
  END IF;
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM affected_tenant::text THEN
    RAISE EXCEPTION 'Assortment decision-set fence scope mismatch';
  END IF;

  INSERT INTO "assortment"."assortment_decision_set_fences" (tenant_id)
  VALUES (affected_tenant)
  ON CONFLICT (tenant_id) DO UPDATE
    SET generation = gen_random_uuid(), updated_at = now();

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "assortment"."lock_decision_set_fence"(p_tenant_id uuid)
RETURNS TABLE(generation uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, assortment, pg_temp
AS $$
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text THEN
    RAISE EXCEPTION 'Assortment decision-set fence scope mismatch';
  END IF;

  RETURN QUERY
  SELECT fence.generation
    FROM "assortment"."assortment_decision_set_fences" AS fence
   WHERE fence.tenant_id = p_tenant_id
   FOR SHARE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "assortment"."advance_decision_set_fence"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "assortment"."lock_decision_set_fence"(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA "assortment" TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "assortment"."lock_decision_set_fence"(uuid) TO "ontos_runtime";
--> statement-breakpoint
INSERT INTO "assortment"."assortment_decision_set_fences" (tenant_id)
SELECT tenant_id FROM "assortment"."assortment_stable_rules"
UNION SELECT tenant_id FROM "assortment"."assortment_rule_revisions"
UNION SELECT tenant_id FROM "assortment"."assortment_rule_retirement_facts"
UNION SELECT tenant_id FROM "assortment"."assortment_applicability_bindings"
UNION SELECT tenant_id FROM "assortment"."assortment_applicability_binding_end_facts"
UNION SELECT tenant_id FROM "assortment"."assortment_closed_boundaries"
UNION SELECT tenant_id FROM "assortment"."assortment_closed_boundary_end_facts"
UNION SELECT tenant_id FROM "assortment"."assortment_admission_sets"
UNION SELECT tenant_id FROM "assortment"."assortment_admission_set_entries"
UNION SELECT tenant_id FROM "assortment"."assortment_collection_revisions"
ON CONFLICT (tenant_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_decision_set_fences" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_stable_rules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_rule_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_rule_retirement_facts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_applicability_bindings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_applicability_binding_end_facts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_closed_boundaries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_closed_boundary_end_facts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_admission_sets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_admission_set_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "assortment"."assortment_collection_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_stable_rules" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_stable_rules" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_rule_revisions" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_rule_revisions" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_rule_retirement_facts" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_rule_retirement_facts" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_applicability_bindings" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_applicability_bindings" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_applicability_binding_end_facts" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_applicability_binding_end_facts" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_closed_boundaries" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_closed_boundaries" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_closed_boundary_end_facts" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_closed_boundary_end_facts" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_admission_sets" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_admission_sets" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_admission_set_entries" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_admission_set_entries" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_set_fence_collection_revisions" AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_collection_revisions" FOR EACH ROW EXECUTE FUNCTION "assortment"."advance_decision_set_fence"();
