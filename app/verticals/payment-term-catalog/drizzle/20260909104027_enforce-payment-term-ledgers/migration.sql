-- Drizzle models RLS enablement and policies, but PostgreSQL FORCE ROW LEVEL SECURITY is explicit.
ALTER TABLE "payment_term_catalog"."payment_terms" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_lifecycle_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_aliases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Revisions, lifecycle evidence, and aliases are historical facts: append, never rewrite or erase.
CREATE FUNCTION "payment_term_catalog"."reject_ledger_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment term catalog ledgers are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payment_term_revisions_append_only"
BEFORE UPDATE OR DELETE ON "payment_term_catalog"."payment_term_revisions"
FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "payment_term_lifecycle_events_append_only"
BEFORE UPDATE OR DELETE ON "payment_term_catalog"."payment_term_lifecycle_events"
FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "payment_term_aliases_append_only"
BEFORE UPDATE OR DELETE ON "payment_term_catalog"."payment_term_aliases"
FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."reject_ledger_mutation"();
--> statement-breakpoint
-- The stable Resource shell may change lifecycle only; identity and creation evidence are immutable.
CREATE FUNCTION "payment_term_catalog"."protect_payment_term_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment term resources cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."payment_term_id" <> OLD."payment_term_id"
    OR NEW."tenant_id" <> OLD."tenant_id"
    OR NEW."legal_entity_id" <> OLD."legal_entity_id"
    OR NEW."business_code" <> OLD."business_code"
    OR NEW."active_from" <> OLD."active_from"
    OR NEW."creation_reason" <> OLD."creation_reason"
    OR NEW."created_by_action_invocation_id" <> OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" <> OLD."created_by_principal_id"
    OR NEW."created_at" <> OLD."created_at"
  THEN
    RAISE EXCEPTION 'payment term resource identity and creation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payment_terms_identity_immutable"
BEFORE UPDATE OR DELETE ON "payment_term_catalog"."payment_terms"
FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."protect_payment_term_identity"();
