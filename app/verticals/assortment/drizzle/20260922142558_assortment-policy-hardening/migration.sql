-- Drizzle cannot model forced RLS, append-only ledger triggers, or cross-row
-- Admission Set invariants. Keep these owner guards in a separate hardening
-- migration so the generated initial schema remains a clean typed diff.
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
CREATE FUNCTION "assortment"."reject_immutable_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'assortment policy facts are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assortment_stable_rules_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_stable_rules" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_rule_revisions_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_rule_revisions" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_rule_retirement_facts_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_rule_retirement_facts" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_bindings_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_applicability_bindings" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_binding_end_facts_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_applicability_binding_end_facts" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_closed_boundaries_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_closed_boundaries" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_boundary_end_facts_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_closed_boundary_end_facts" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_admission_sets_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_admission_sets" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_admission_entries_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_admission_set_entries" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
CREATE TRIGGER "assortment_collection_revisions_append_only" BEFORE UPDATE OR DELETE ON "assortment"."assortment_collection_revisions" FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_immutable_mutation"();
--> statement-breakpoint
CREATE FUNCTION "assortment"."validate_admission_entry"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_set_kind text;
  v_purpose text;
  v_existing_count integer;
BEGIN
  SELECT set_kind, purpose INTO v_set_kind, v_purpose
    FROM "assortment"."assortment_admission_sets"
   WHERE tenant_id = NEW.tenant_id
     AND legal_entity_id = NEW.legal_entity_id
     AND admission_set_id = NEW.admission_set_id;
  IF v_set_kind IS NULL OR v_set_kind <> 'ENTRIES' THEN
    RAISE EXCEPTION 'admission entries require an ENTRIES admission set' USING ERRCODE = '23514';
  END IF;
  IF v_purpose = 'VISIBILITY' AND NEW.coverage_kind IN ('VARIANT', 'PACKAGE_OPTION') THEN
    RAISE EXCEPTION 'visibility admission sets cannot contain variant or package-option coverage' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_existing_count
    FROM "assortment"."assortment_admission_set_entries"
   WHERE tenant_id = NEW.tenant_id
     AND legal_entity_id = NEW.legal_entity_id
     AND admission_set_id = NEW.admission_set_id;
  IF NEW.coverage_kind = 'ALL' AND v_existing_count > 0 THEN
    RAISE EXCEPTION 'ALL admission coverage cannot be combined with another entry' USING ERRCODE = '23514';
  END IF;
  IF NEW.coverage_kind <> 'ALL' AND EXISTS (
    SELECT 1 FROM "assortment"."assortment_admission_set_entries"
     WHERE tenant_id = NEW.tenant_id AND legal_entity_id = NEW.legal_entity_id
       AND admission_set_id = NEW.admission_set_id AND coverage_kind = 'ALL'
  ) THEN
    RAISE EXCEPTION 'ALL admission coverage cannot be combined with another entry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assortment_admission_entry_semantics" BEFORE INSERT ON "assortment"."assortment_admission_set_entries" FOR EACH ROW EXECUTE FUNCTION "assortment"."validate_admission_entry"();
--> statement-breakpoint
-- The aggregate header, collection proof, and immutable children must form one
-- complete meaning at commit, regardless of insert order within the transaction.
CREATE FUNCTION "assortment"."assert_admission_set_complete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_set record;
  v_collection record;
  v_count integer;
  v_all_count integer;
BEGIN
  SELECT * INTO v_set
    FROM "assortment"."assortment_admission_sets"
   WHERE admission_set_id = COALESCE(NEW.admission_set_id, OLD.admission_set_id)
     AND tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
     AND legal_entity_id = COALESCE(NEW.legal_entity_id, OLD.legal_entity_id);
  IF v_set IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_collection
    FROM "assortment"."assortment_collection_revisions"
   WHERE collection_revision_id = v_set.collection_revision_id
     AND tenant_id = v_set.tenant_id
     AND legal_entity_id = v_set.legal_entity_id;
  IF v_collection IS NULL
     OR v_collection.aggregate_id <> v_set.closed_boundary_id
     OR v_collection.purpose <> v_set.purpose
     OR v_collection.completeness <> 'COMPLETE' THEN
    RAISE EXCEPTION 'admission set collection proof does not match its Boundary aggregate and purpose' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer, count(*) FILTER (WHERE coverage_kind = 'ALL')::integer
    INTO v_count, v_all_count
    FROM "assortment"."assortment_admission_set_entries"
   WHERE admission_set_id = v_set.admission_set_id
     AND tenant_id = v_set.tenant_id
     AND legal_entity_id = v_set.legal_entity_id;
  IF v_set.set_kind = 'EMPTY' AND (v_count <> 0 OR v_collection.member_count <> 0) THEN
    RAISE EXCEPTION 'EMPTY admission sets require zero children and a zero collection member count' USING ERRCODE = '23514';
  END IF;
  IF v_set.set_kind = 'ENTRIES' AND (v_count < 1 OR v_count <> v_collection.member_count) THEN
    RAISE EXCEPTION 'ENTRIES admission sets require at least one child and an exact collection member count' USING ERRCODE = '23514';
  END IF;
  IF v_all_count > 0 AND (v_all_count <> 1 OR v_count <> 1) THEN
    RAISE EXCEPTION 'explicit ALL admission coverage must be exactly one child' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "assortment_admission_sets_complete_ct"
AFTER INSERT OR UPDATE ON "assortment"."assortment_admission_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assortment"."assert_admission_set_complete"();
CREATE CONSTRAINT TRIGGER "assortment_admission_entries_complete_ct"
AFTER INSERT OR UPDATE OR DELETE ON "assortment"."assortment_admission_set_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assortment"."assert_admission_set_complete"();
