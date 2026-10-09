CREATE TABLE "inventory"."source_import_ledger" (
	"tenant_id" uuid,
	"action_invocation_id" uuid,
	"item_index" integer,
	"assertion_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"fact_meaning" text NOT NULL,
	"position_id" uuid NOT NULL,
	"source_reference" text NOT NULL,
	"ordering_evidence_kind" text NOT NULL,
	"ordering_evidence_value" text NOT NULL,
	"status" text NOT NULL,
	"proposal_json" jsonb NOT NULL,
	"outcome_json" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_source_import_ledger_pk" PRIMARY KEY("tenant_id","action_invocation_id","item_index"),
	CONSTRAINT "inventory_source_import_ledger_item_index_ck" CHECK ("item_index" >= 0),
	CONSTRAINT "inventory_source_import_ledger_meaning_ck" CHECK ("fact_meaning" = 'ABSOLUTE_PHYSICAL_ON_HAND' and "issuer_backend_kind" = 'external_business_system'),
	CONSTRAINT "inventory_source_import_ledger_ordering_ck" CHECK ("ordering_evidence_kind" in ('SOURCE_REVISION', 'OWNER_ORDER_KEY')),
	CONSTRAINT "inventory_source_import_ledger_status_ck" CHECK ("status" in ('ACCEPTED', 'DUPLICATE', 'STALE', 'REJECTED', 'INDETERMINATE')),
	CONSTRAINT "inventory_source_import_ledger_text_ck" CHECK (length(btrim("customer_configuration_id")) between 1 and 300 and length(btrim("issuer_backend_id")) between 1 and 300 and length(btrim("source_reference")) between 1 and 300 and length(btrim("ordering_evidence_value")) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."source_import_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "inventory_source_import_ledger_stream_idx" ON "inventory"."source_import_ledger" ("tenant_id","customer_configuration_id","issuer_backend_kind","issuer_backend_id","fact_meaning","position_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_import_accepted_assertion_uk" ON "inventory"."source_import_ledger" ("tenant_id","assertion_id") WHERE "status" = 'ACCEPTED';--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_import_accepted_source_identity_uk" ON "inventory"."source_import_ledger" ("tenant_id","customer_configuration_id","issuer_backend_kind","issuer_backend_id","fact_meaning","position_id","source_reference") WHERE "status" = 'ACCEPTED';--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_import_accepted_revision_uk" ON "inventory"."source_import_ledger" ("tenant_id","customer_configuration_id","issuer_backend_kind","issuer_backend_id","fact_meaning","position_id","ordering_evidence_kind","ordering_evidence_value") WHERE "status" = 'ACCEPTED';--> statement-breakpoint
ALTER TABLE "inventory"."source_import_ledger" ADD CONSTRAINT "inventory_source_import_ledger_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_source_import_ledger_tenant_select" ON "inventory"."source_import_ledger" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."source_import_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_import_ledger_tenant_insert" ON "inventory"."source_import_ledger" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."source_import_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_import_ledger_tenant_update" ON "inventory"."source_import_ledger" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."source_import_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."source_import_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_import_ledger_tenant_delete" ON "inventory"."source_import_ledger" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."source_import_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."source_import_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_source_import_ledger_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.proposal_json) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.proposal_json -> 'issuer') IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.proposal_json -> 'positionRef') IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.proposal_json -> 'orderingEvidence') IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.outcome_json) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_import_ledger_exact_scope_ck',
      MESSAGE = 'Inventory Source Import ledger JSON evidence must use canonical object shapes';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.proposal_json)) <> 14
    OR NOT (
      NEW.proposal_json ?& ARRAY[
        'assertionId', 'businessObservedAt', 'coverage', 'customerConfigurationId', 'factMeaning', 'issuer',
        'itemExternalKey', 'locationExternalKey', 'orderingEvidence', 'ownerEvidenceRef', 'positionRef',
        'quantity', 'receivedAt', 'sourceReference'
      ]
    )
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.proposal_json -> 'issuer')) <> 2
    OR NOT (NEW.proposal_json -> 'issuer' ?& ARRAY['backendId', 'backendKind'])
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.proposal_json -> 'positionRef')) <> 4
    OR NOT (NEW.proposal_json -> 'positionRef' ?& ARRAY['moduleId', 'resourceId', 'resourceType', 'tenantId'])
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.proposal_json -> 'orderingEvidence')) <> 2
    OR NEW.proposal_json ->> 'assertionId' IS DISTINCT FROM NEW.assertion_id::text
    OR NEW.proposal_json ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
    OR NEW.proposal_json #>> '{issuer,backendKind}' IS DISTINCT FROM NEW.issuer_backend_kind
    OR NEW.proposal_json #>> '{issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
    OR NEW.proposal_json ->> 'factMeaning' IS DISTINCT FROM NEW.fact_meaning
    OR NEW.proposal_json #>> '{positionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.proposal_json #>> '{positionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
    OR NEW.proposal_json #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.proposal_json #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
    OR NEW.proposal_json ->> 'sourceReference' IS DISTINCT FROM NEW.source_reference
    OR NEW.proposal_json #>> '{orderingEvidence,_tag}' IS DISTINCT FROM NEW.ordering_evidence_kind
    OR NEW.outcome_json ->> 'assertionId' IS DISTINCT FROM NEW.assertion_id::text
    OR NEW.outcome_json ->> 'status' IS DISTINCT FROM NEW.status
    OR (
      NEW.ordering_evidence_kind = 'SOURCE_REVISION'
      AND (
        NEW.proposal_json #>> '{orderingEvidence,revision}' IS DISTINCT FROM NEW.ordering_evidence_value
        OR NEW.proposal_json #> '{orderingEvidence,key}' IS NOT NULL
      )
    )
    OR (
      NEW.ordering_evidence_kind = 'OWNER_ORDER_KEY'
      AND (
        NEW.proposal_json #>> '{orderingEvidence,key}' IS DISTINCT FROM NEW.ordering_evidence_value
        OR NEW.proposal_json #> '{orderingEvidence,revision}' IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_import_ledger_exact_scope_ck',
      MESSAGE = 'Inventory Source Import ledger JSON evidence must exactly match its relational stream and outcome';
  END IF;

  IF (
    NEW.status = 'ACCEPTED'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) <> 3
      OR NOT (NEW.outcome_json ?& ARRAY['assertionId', 'postEffectOnHand', 'status'])
      OR pg_catalog.jsonb_typeof(NEW.outcome_json -> 'postEffectOnHand') IS DISTINCT FROM 'object'
    )
  ) OR (
    NEW.status = 'DUPLICATE'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) <> 4
      OR NOT (NEW.outcome_json ?& ARRAY['assertionId', 'duplicateOfAssertionId', 'reason', 'status'])
      OR NEW.outcome_json ->> 'duplicateOfAssertionId' IS NULL
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.outcome_json ->> 'reason')), 0) NOT BETWEEN 1 AND 300
    )
  ) OR (
    NEW.status = 'STALE'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) NOT IN (3, 4)
      OR NOT (NEW.outcome_json ?& ARRAY['assertionId', 'reason', 'status'])
      OR (
        (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) = 4
        AND NOT (NEW.outcome_json ? 'currentAssertionId')
      )
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.outcome_json ->> 'reason')), 0) NOT BETWEEN 1 AND 300
    )
  ) OR (
    NEW.status = 'REJECTED'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) <> 3
      OR NOT (NEW.outcome_json ?& ARRAY['assertionId', 'reason', 'status'])
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.outcome_json ->> 'reason')), 0) NOT BETWEEN 1 AND 300
    )
  ) OR (
    NEW.status = 'INDETERMINATE'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) <> 4
      OR NOT (NEW.outcome_json ?& ARRAY['assertionId', 'reason', 'reconciliationRequired', 'status'])
      OR NEW.outcome_json -> 'reconciliationRequired' IS DISTINCT FROM 'true'::jsonb
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.outcome_json ->> 'reason')), 0) NOT BETWEEN 1 AND 300
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_import_ledger_exact_scope_ck',
      MESSAGE = 'Inventory Source Import ledger outcome JSON must exactly match its status contract';
  END IF;

  IF NEW.status = 'ACCEPTED' THEN
    PERFORM 1
    FROM "inventory"."source_assertions" AS assertion
    WHERE assertion.tenant_id = NEW.tenant_id
      AND assertion.assertion_id = NEW.assertion_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        CONSTRAINT = 'inventory_source_import_ledger_accepted_assertion_fk',
        MESSAGE = 'Accepted Inventory Source Import outcome must reference the exact persisted source assertion';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_source_import_ledger_exact_scope_trg"
BEFORE INSERT ON "inventory"."source_import_ledger"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_import_ledger_exact_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_source_import_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_source_import_ledger_append_only_ck',
    MESSAGE = 'Inventory Source Import ledger evidence is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_source_import_ledger_immutable_trg"
BEFORE UPDATE OR DELETE ON "inventory"."source_import_ledger"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_source_import_ledger_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_source_import_ledger_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_source_import_ledger_mutation"() FROM PUBLIC, "ontos_runtime";
