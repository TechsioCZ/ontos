CREATE TABLE "inventory"."source_conflict_revisions" (
	"tenant_id" uuid,
	"conflict_id" uuid,
	"revision" integer,
	"status" text NOT NULL,
	"conflict_type" text NOT NULL,
	"current_truth" text NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"position_id" uuid,
	"fact_meaning" text,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"conflict_json" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_source_conflict_revisions_pk" PRIMARY KEY("tenant_id","conflict_id","revision"),
	CONSTRAINT "inventory_source_conflict_revision_ck" CHECK ("revision" in (1, 2)),
	CONSTRAINT "inventory_source_conflict_status_ck" CHECK (("revision" = 1 and "status" = 'OPEN' and "current_truth" = 'INDETERMINATE' and "resolved_at" is null) or ("revision" = 2 and "status" = 'RESOLVED' and "current_truth" in ('CURRENT', 'CONFIGURATION_SINGULAR') and "resolved_at" is not null and "resolved_at" >= "detected_at")),
	CONSTRAINT "inventory_source_conflict_type_ck" CHECK ("conflict_type" in ('CORRELATION', 'FACT_VALUE', 'BACKEND_CONFIGURATION', 'ASSERTION_INTEGRITY')),
	CONSTRAINT "inventory_source_conflict_scope_ck" CHECK (("conflict_type" in ('BACKEND_CONFIGURATION', 'CORRELATION') and "position_id" is null and "fact_meaning" is null) or ("conflict_type" in ('FACT_VALUE', 'ASSERTION_INTEGRITY') and "position_id" is not null and "fact_meaning" = 'ABSOLUTE_PHYSICAL_ON_HAND')),
	CONSTRAINT "inventory_source_conflict_customer_configuration_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."source_conflict_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "inventory_source_conflict_latest_idx" ON "inventory"."source_conflict_revisions" ("tenant_id","conflict_id","revision");--> statement-breakpoint
CREATE INDEX "inventory_source_conflict_position_idx" ON "inventory"."source_conflict_revisions" ("tenant_id","position_id","status");--> statement-breakpoint
ALTER TABLE "inventory"."source_conflict_revisions" ADD CONSTRAINT "inventory_source_conflict_revisions_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_source_conflict_revisions_tenant_select" ON "inventory"."source_conflict_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."source_conflict_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_conflict_revisions_tenant_insert" ON "inventory"."source_conflict_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."source_conflict_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_conflict_revisions_tenant_update" ON "inventory"."source_conflict_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."source_conflict_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."source_conflict_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_conflict_revisions_tenant_delete" ON "inventory"."source_conflict_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."source_conflict_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."source_conflict_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_source_conflict_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  ambiguous_key jsonb;
  proposal jsonb;
  resolution_assertion jsonb;
  source_evidence jsonb;
BEGIN
  source_evidence := CASE
    WHEN NEW.revision = 1 THEN NEW.conflict_json -> 'evidence'
    ELSE NEW.conflict_json -> 'originalEvidence'
  END;

  IF pg_catalog.jsonb_typeof(NEW.conflict_json) IS DISTINCT FROM 'object'
    OR NEW.conflict_json #>> '{conflictRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.conflict_json #>> '{conflictRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.inventory-source-conflict'
    OR NEW.conflict_json #>> '{conflictRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.conflict_json #>> '{conflictRef,resourceId}' IS DISTINCT FROM NEW.conflict_id::text
    OR NEW.conflict_json ->> 'revision' IS DISTINCT FROM NEW.revision::text
    OR NEW.conflict_json ->> 'status' IS DISTINCT FROM NEW.status
    OR NEW.conflict_json ->> 'conflictType' IS DISTINCT FROM NEW.conflict_type
    OR NEW.conflict_json ->> 'currentTruth' IS DISTINCT FROM NEW.current_truth
    OR NEW.conflict_json #>> '{scope,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
    OR NEW.conflict_json #>> '{authorityConfiguration,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.conflict_json #>> '{authorityConfiguration,customerConfigurationId}'
      IS DISTINCT FROM NEW.customer_configuration_id
    OR (NEW.conflict_json ->> 'detectedAt')::timestamptz IS DISTINCT FROM NEW.detected_at
    OR NOT EXISTS (
      SELECT 1
      FROM "inventory"."backend_configurations" AS authority
      WHERE authority.tenant_id = NEW.tenant_id
        AND authority.configuration_id = (NEW.conflict_json #>> '{authorityConfiguration,configurationId}')::uuid
        AND authority.customer_configuration_id = NEW.customer_configuration_id
        AND authority.backend_kind = NEW.conflict_json #>> '{authorityConfiguration,selection,backend}'
        AND authority.backend_id = NEW.conflict_json #>> '{authorityConfiguration,selection,backendId}'
        AND authority.exact_reservation_capability
          = NEW.conflict_json #>> '{authorityConfiguration,selection,exactReservationCapability}'
        AND authority.stock_correction_capability
          = NEW.conflict_json #>> '{authorityConfiguration,selection,stockCorrectionCapability}'
        AND authority.selected_at
          = (NEW.conflict_json #>> '{authorityConfiguration,selectedAt}')::timestamptz
        AND authority.revision = (NEW.conflict_json #>> '{authorityConfiguration,revision}')::integer
    )
    OR (
      NEW.revision = 1
      AND (
        NEW.conflict_json ? 'resolution'
        OR NEW.conflict_json ? 'originalEvidence'
        OR NEW.resolved_at IS NOT NULL
      )
    )
    OR (
      NEW.revision = 2
      AND (
        (NEW.conflict_json #>> '{resolution,resolvedAt}')::timestamptz IS DISTINCT FROM NEW.resolved_at
        OR NEW.resolved_at < NEW.detected_at
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
      MESSAGE = 'Inventory Source Conflict JSON must exactly match relational identity, authority, lifecycle, and time';
  END IF;

  IF NEW.conflict_type = 'BACKEND_CONFIGURATION' THEN
    IF NEW.position_id IS NOT NULL
      OR NEW.fact_meaning IS NOT NULL
      OR NEW.conflict_json #>> '{scope,_tag}' IS DISTINCT FROM 'CUSTOMER_CONFIGURATION'
      OR NEW.conflict_json #>> '{scope,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (
        NEW.revision = 2
        AND (
          NEW.current_truth IS DISTINCT FROM 'CONFIGURATION_SINGULAR'
          OR NEW.conflict_json #>> '{resolution,_tag}' IS DISTINCT FROM 'BACKEND_CONFIGURATION'
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
        MESSAGE = 'Backend Configuration conflict scope must remain Customer Configuration-wide';
    END IF;
  ELSIF NEW.conflict_type = 'CORRELATION' THEN
    ambiguous_key := NEW.conflict_json #> '{scope,ambiguousExternalKey}';
    proposal := source_evidence -> 'proposal';
    IF NEW.position_id IS NOT NULL
      OR NEW.fact_meaning IS NOT NULL
      OR NEW.conflict_json #>> '{scope,_tag}' IS DISTINCT FROM 'EXTERNAL_CORRELATION'
      OR NEW.conflict_json #>> '{scope,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.conflict_json #> '{scope,ambiguousExternalKey}'
        IS DISTINCT FROM source_evidence -> 'ambiguousExternalKey'
      OR ambiguous_key ->> 'tenantId' IS DISTINCT FROM NEW.tenant_id::text
      OR ambiguous_key ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
      OR ambiguous_key #>> '{issuer,backendKind}'
        IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backend}'
      OR ambiguous_key #>> '{issuer,backendId}'
        IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backendId}'
      OR ambiguous_key ->> 'identifierKind' IS NULL
      OR ambiguous_key ->> 'identifierKind' NOT IN ('ITEM', 'LOCATION')
      OR pg_catalog.jsonb_typeof(proposal) IS DISTINCT FROM 'object'
      OR proposal ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
      OR proposal ->> 'factMeaning' IS DISTINCT FROM 'ABSOLUTE_PHYSICAL_ON_HAND'
      OR proposal #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR proposal #>> '{quantity,unitRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR proposal #>> '{issuer,backendKind}'
        IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backend}'
      OR proposal #>> '{issuer,backendId}'
        IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backendId}'
      OR (proposal ->> 'businessObservedAt')::timestamptz
        < (NEW.conflict_json #>> '{authorityConfiguration,selectedAt}')::timestamptz
      OR proposal #>> '{itemExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR proposal #>> '{itemExternalKey,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR proposal #>> '{itemExternalKey,identifierKind}' IS DISTINCT FROM 'ITEM'
      OR proposal #>> '{itemExternalKey,issuer,backendKind}'
        IS DISTINCT FROM proposal #>> '{issuer,backendKind}'
      OR proposal #>> '{itemExternalKey,issuer,backendId}'
        IS DISTINCT FROM proposal #>> '{issuer,backendId}'
      OR proposal #>> '{locationExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR proposal #>> '{locationExternalKey,customerConfigurationId}'
        IS DISTINCT FROM NEW.customer_configuration_id
      OR proposal #>> '{locationExternalKey,identifierKind}' IS DISTINCT FROM 'LOCATION'
      OR proposal #>> '{locationExternalKey,issuer,backendKind}'
        IS DISTINCT FROM proposal #>> '{issuer,backendKind}'
      OR proposal #>> '{locationExternalKey,issuer,backendId}'
        IS DISTINCT FROM proposal #>> '{issuer,backendId}'
      OR (
        ambiguous_key ->> 'identifierKind' = 'ITEM'
        AND proposal -> 'itemExternalKey' IS DISTINCT FROM ambiguous_key
      )
      OR (
        ambiguous_key ->> 'identifierKind' = 'LOCATION'
        AND proposal -> 'locationExternalKey' IS DISTINCT FROM ambiguous_key
      )
      OR pg_catalog.jsonb_typeof(source_evidence -> 'candidateCorrelationRefs') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(source_evidence -> 'candidateCorrelationRefs') < 2
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(source_evidence -> 'candidateCorrelationRefs') AS candidate(entry)
      ) IS DISTINCT FROM (
        SELECT pg_catalog.count(
          DISTINCT (candidate.entry ->> 'tenantId', candidate.entry ->> 'resourceId')
        )
        FROM pg_catalog.jsonb_array_elements(source_evidence -> 'candidateCorrelationRefs') AS candidate(entry)
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(source_evidence -> 'candidateCorrelationRefs') AS candidate(entry)
        WHERE candidate.entry ->> 'moduleId' IS DISTINCT FROM 'commerce.inventory'
          OR candidate.entry ->> 'resourceType'
            IS DISTINCT FROM 'commerce.inventory.external-stock-correlation'
          OR candidate.entry ->> 'tenantId' IS DISTINCT FROM NEW.tenant_id::text
      )
      OR (
        NEW.revision = 2
        AND (
          NEW.current_truth IS DISTINCT FROM 'CURRENT'
          OR NEW.conflict_json #>> '{resolution,_tag}' IS DISTINCT FROM 'CURRENT_ASSERTION'
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
        MESSAGE = 'Correlation conflict must retain exact external-key scope without implying a Position';
    END IF;
  ELSIF NEW.position_id IS NULL
    OR NEW.fact_meaning IS DISTINCT FROM 'ABSOLUTE_PHYSICAL_ON_HAND'
    OR NEW.conflict_json #>> '{scope,_tag}' IS DISTINCT FROM 'STOCK_POSITION_FACT'
    OR NEW.conflict_json #>> '{scope,factMeaning}' IS DISTINCT FROM NEW.fact_meaning
    OR NEW.conflict_json #>> '{scope,positionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.conflict_json #>> '{scope,positionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
    OR NEW.conflict_json #>> '{scope,positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.conflict_json #>> '{scope,positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
    OR (
      NEW.revision = 2
      AND (
        NEW.current_truth IS DISTINCT FROM 'CURRENT'
        OR NEW.conflict_json #>> '{resolution,_tag}' IS DISTINCT FROM 'CURRENT_ASSERTION'
      )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "inventory"."stock_positions" AS position
      WHERE position.tenant_id = NEW.tenant_id
        AND position.stock_position_id = NEW.position_id
        AND position.customer_configuration_id = NEW.customer_configuration_id
        AND NEW.conflict_json #>> '{scope,unitRef,moduleId}' = position.stock_unit_module_id
        AND NEW.conflict_json #>> '{scope,unitRef,resourceId}' = position.stock_unit_resource_id::text
        AND NEW.conflict_json #>> '{scope,unitRef,resourceType}' = position.stock_unit_resource_type
        AND NEW.conflict_json #>> '{scope,unitRef,tenantId}' = position.stock_unit_tenant_id::text
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
      MESSAGE = 'Inventory source fact conflict must bind the exact Position fact scope';
  END IF;

  IF NEW.conflict_type IN ('FACT_VALUE', 'ASSERTION_INTEGRITY') THEN
    IF pg_catalog.jsonb_typeof(source_evidence) IS DISTINCT FROM 'array'
      OR (
        NEW.conflict_type = 'FACT_VALUE'
        AND pg_catalog.jsonb_array_length(source_evidence) < 2
      )
      OR (
        NEW.conflict_type = 'ASSERTION_INTEGRITY'
        AND pg_catalog.jsonb_array_length(source_evidence) <> 2
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
        MESSAGE = 'Inventory source fact conflict evidence must retain every exact conflicting proposal';
    END IF;

    FOR proposal IN
      SELECT entry
      FROM pg_catalog.jsonb_array_elements(source_evidence) AS evidence(entry)
    LOOP
      IF proposal ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
        OR proposal ->> 'factMeaning' IS DISTINCT FROM 'ABSOLUTE_PHYSICAL_ON_HAND'
        OR proposal #>> '{positionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
        OR proposal #>> '{positionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
        OR proposal #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR proposal #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
        OR proposal #>> '{quantity,unitRef,moduleId}'
          IS DISTINCT FROM NEW.conflict_json #>> '{scope,unitRef,moduleId}'
        OR proposal #>> '{quantity,unitRef,resourceId}'
          IS DISTINCT FROM NEW.conflict_json #>> '{scope,unitRef,resourceId}'
        OR proposal #>> '{quantity,unitRef,resourceType}'
          IS DISTINCT FROM NEW.conflict_json #>> '{scope,unitRef,resourceType}'
        OR proposal #>> '{quantity,unitRef,tenantId}'
          IS DISTINCT FROM NEW.conflict_json #>> '{scope,unitRef,tenantId}'
        OR proposal #>> '{issuer,backendKind}'
          IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backend}'
        OR proposal #>> '{issuer,backendId}'
          IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backendId}'
        OR (proposal ->> 'businessObservedAt')::timestamptz
          < (NEW.conflict_json #>> '{authorityConfiguration,selectedAt}')::timestamptz
        OR proposal #>> '{itemExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR proposal #>> '{itemExternalKey,customerConfigurationId}'
          IS DISTINCT FROM NEW.customer_configuration_id
        OR proposal #>> '{itemExternalKey,identifierKind}' IS DISTINCT FROM 'ITEM'
        OR proposal #>> '{itemExternalKey,issuer,backendKind}'
          IS DISTINCT FROM proposal #>> '{issuer,backendKind}'
        OR proposal #>> '{itemExternalKey,issuer,backendId}'
          IS DISTINCT FROM proposal #>> '{issuer,backendId}'
        OR proposal #>> '{locationExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR proposal #>> '{locationExternalKey,customerConfigurationId}'
          IS DISTINCT FROM NEW.customer_configuration_id
        OR proposal #>> '{locationExternalKey,identifierKind}' IS DISTINCT FROM 'LOCATION'
        OR proposal #>> '{locationExternalKey,issuer,backendKind}'
          IS DISTINCT FROM proposal #>> '{issuer,backendKind}'
        OR proposal #>> '{locationExternalKey,issuer,backendId}'
          IS DISTINCT FROM proposal #>> '{issuer,backendId}'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
          MESSAGE = 'Every conflict proposal must retain the exact Position, Unit, Tenant, and selected authority';
      END IF;
    END LOOP;
  END IF;

  IF NEW.conflict_type = 'BACKEND_CONFIGURATION' AND (
    pg_catalog.jsonb_typeof(source_evidence) IS DISTINCT FROM 'object'
    OR source_evidence -> 'selectedConfiguration'
      IS DISTINCT FROM NEW.conflict_json -> 'authorityConfiguration'
    OR source_evidence #>> '{attemptedSelection,backend}' IS NULL
    OR source_evidence #>> '{attemptedSelection,backend}'
      NOT IN ('external_business_system', 'ontos_wms')
    OR source_evidence #>> '{attemptedSelection,backend}'
      = NEW.conflict_json #>> '{authorityConfiguration,selection,backend}'
    OR coalesce(pg_catalog.length(pg_catalog.btrim(source_evidence ->> 'ownerEvidenceRef')), 0)
      NOT BETWEEN 1 AND 300
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
      MESSAGE = 'Backend Configuration conflict evidence must retain the selected and opposite attempted authority';
  END IF;

  IF NEW.revision = 2 THEN
    IF coalesce(pg_catalog.length(pg_catalog.btrim(NEW.conflict_json #>> '{resolution,ownerEvidenceRef}')), 0)
        NOT BETWEEN 1 AND 300
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.conflict_json #>> '{resolution,principalId}')), 0)
        NOT BETWEEN 1 AND 300
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
        MESSAGE = 'Inventory Source Conflict resolution must retain bounded owner and principal evidence';
    END IF;

    IF NEW.conflict_type = 'BACKEND_CONFIGURATION' THEN
      IF NEW.conflict_json #> '{resolution,configuration}'
        IS DISTINCT FROM NEW.conflict_json -> 'authorityConfiguration'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
          MESSAGE = 'Backend Configuration resolution must prove the exact singular authority';
      END IF;
    ELSE
      resolution_assertion := NEW.conflict_json #> '{resolution,assertion}';
      IF pg_catalog.jsonb_typeof(resolution_assertion) IS DISTINCT FROM 'object'
        OR resolution_assertion -> 'authorityConfiguration'
          IS DISTINCT FROM NEW.conflict_json -> 'authorityConfiguration'
        OR resolution_assertion ->> 'issuerAuthority' IS DISTINCT FROM 'SELECTED_BACKEND'
        OR resolution_assertion ->> 'customerConfigurationId'
          IS DISTINCT FROM NEW.customer_configuration_id
        OR resolution_assertion ->> 'factMeaning' IS DISTINCT FROM 'ABSOLUTE_PHYSICAL_ON_HAND'
        OR resolution_assertion #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR resolution_assertion #>> '{quantity,unitRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR resolution_assertion #>> '{issuer,backendKind}'
          IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backend}'
        OR resolution_assertion #>> '{issuer,backendId}'
          IS DISTINCT FROM NEW.conflict_json #>> '{authorityConfiguration,selection,backendId}'
        OR (resolution_assertion ->> 'businessObservedAt')::timestamptz
          < (NEW.conflict_json #>> '{authorityConfiguration,selectedAt}')::timestamptz
        OR resolution_assertion #>> '{itemExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR resolution_assertion #>> '{itemExternalKey,customerConfigurationId}'
          IS DISTINCT FROM NEW.customer_configuration_id
        OR resolution_assertion #>> '{itemExternalKey,identifierKind}' IS DISTINCT FROM 'ITEM'
        OR resolution_assertion #>> '{itemExternalKey,issuer,backendKind}'
          IS DISTINCT FROM resolution_assertion #>> '{issuer,backendKind}'
        OR resolution_assertion #>> '{itemExternalKey,issuer,backendId}'
          IS DISTINCT FROM resolution_assertion #>> '{issuer,backendId}'
        OR resolution_assertion #>> '{locationExternalKey,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR resolution_assertion #>> '{locationExternalKey,customerConfigurationId}'
          IS DISTINCT FROM NEW.customer_configuration_id
        OR resolution_assertion #>> '{locationExternalKey,identifierKind}' IS DISTINCT FROM 'LOCATION'
        OR resolution_assertion #>> '{locationExternalKey,issuer,backendKind}'
          IS DISTINCT FROM resolution_assertion #>> '{issuer,backendKind}'
        OR resolution_assertion #>> '{locationExternalKey,issuer,backendId}'
          IS DISTINCT FROM resolution_assertion #>> '{issuer,backendId}'
        OR resolution_assertion #>> '{itemCorrelationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR resolution_assertion #>> '{locationCorrelationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR resolution_assertion #>> '{stockItemRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR resolution_assertion #>> '{stockLocationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
        OR (
          NEW.conflict_type IN ('FACT_VALUE', 'ASSERTION_INTEGRITY')
          AND (
            resolution_assertion #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
            OR resolution_assertion #> '{quantity,unitRef}'
              IS DISTINCT FROM NEW.conflict_json #> '{scope,unitRef}'
          )
        )
        OR (
          NEW.conflict_type = 'CORRELATION'
          AND (
            CASE ambiguous_key ->> 'identifierKind'
              WHEN 'ITEM' THEN resolution_assertion -> 'itemExternalKey'
              ELSE resolution_assertion -> 'locationExternalKey'
            END
          ) IS DISTINCT FROM ambiguous_key
        )
        OR (
          NEW.conflict_type = 'CORRELATION'
          AND NOT EXISTS (
            SELECT 1
            FROM "inventory"."external_stock_correlations" AS repaired_correlation
            WHERE repaired_correlation.tenant_id = NEW.tenant_id
              AND repaired_correlation.customer_configuration_id = NEW.customer_configuration_id
              AND repaired_correlation.issuer_backend_kind = ambiguous_key #>> '{issuer,backendKind}'
              AND repaired_correlation.issuer_backend_id = ambiguous_key #>> '{issuer,backendId}'
              AND repaired_correlation.namespace = ambiguous_key ->> 'namespace'
              AND repaired_correlation.external_scope = ambiguous_key ->> 'externalScope'
              AND repaired_correlation.identifier_kind = ambiguous_key ->> 'identifierKind'
              AND repaired_correlation.external_value = ambiguous_key ->> 'externalValue'
              AND repaired_correlation.effective_from
                <= (resolution_assertion ->> 'businessObservedAt')::timestamptz
              AND (
                repaired_correlation.effective_to IS NULL
                OR (resolution_assertion ->> 'businessObservedAt')::timestamptz
                  < repaired_correlation.effective_to
              )
              AND (
                (
                  ambiguous_key ->> 'identifierKind' = 'ITEM'
                  AND repaired_correlation.correlation_id
                    = (resolution_assertion #>> '{itemCorrelationRef,resourceId}')::uuid
                  AND repaired_correlation.stock_item_id
                    = (resolution_assertion #>> '{stockItemRef,resourceId}')::uuid
                  AND repaired_correlation.stock_location_id IS NULL
                )
                OR (
                  ambiguous_key ->> 'identifierKind' = 'LOCATION'
                  AND repaired_correlation.correlation_id
                    = (resolution_assertion #>> '{locationCorrelationRef,resourceId}')::uuid
                  AND repaired_correlation.stock_location_id
                    = (resolution_assertion #>> '{stockLocationRef,resourceId}')::uuid
                  AND repaired_correlation.stock_item_id IS NULL
                )
              )
          )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "inventory"."source_assertions" AS persisted_assertion
          WHERE persisted_assertion.tenant_id = NEW.tenant_id
            AND persisted_assertion.assertion_id
              = (resolution_assertion ->> 'assertionId')::uuid
            AND persisted_assertion.assertion_json IS NOT DISTINCT FROM resolution_assertion
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "inventory"."stock_positions" AS position
          WHERE position.tenant_id = NEW.tenant_id
            AND position.stock_position_id = (resolution_assertion #>> '{positionRef,resourceId}')::uuid
            AND position.customer_configuration_id = NEW.customer_configuration_id
            AND position.owner_configuration_id
              = (NEW.conflict_json #>> '{authorityConfiguration,configurationId}')::uuid
            AND position.stock_item_id = (resolution_assertion #>> '{stockItemRef,resourceId}')::uuid
            AND position.stock_location_id = (resolution_assertion #>> '{stockLocationRef,resourceId}')::uuid
            AND position.stock_unit_module_id = resolution_assertion #>> '{quantity,unitRef,moduleId}'
            AND position.stock_unit_resource_id
              = (resolution_assertion #>> '{quantity,unitRef,resourceId}')::uuid
            AND position.stock_unit_resource_type = resolution_assertion #>> '{quantity,unitRef,resourceType}'
            AND position.stock_unit_tenant_id = (resolution_assertion #>> '{quantity,unitRef,tenantId}')::uuid
            AND position.lifecycle_state = 'CURRENT'
            AND position.on_hand_state = 'CURRENT'
            AND position.on_hand_evidence_ref = resolution_assertion ->> 'ownerEvidenceRef'
            AND position.on_hand_observed_at = (resolution_assertion ->> 'businessObservedAt')::timestamptz
            AND position.on_hand_amount = (resolution_assertion #>> '{quantity,amount}')::numeric
        )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_source_conflict_revisions_exact_scope_ck',
          MESSAGE = 'Current assertion resolution must prove the exact selected authority and established Position truth';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_source_conflict_revision"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  previous RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_conflict_revisions_immutable_ck',
      MESSAGE = 'Inventory Source Conflict revisions are append-only';
  END IF;

  SELECT revision_record.*
  INTO previous
  FROM "inventory"."source_conflict_revisions" AS revision_record
  WHERE revision_record.tenant_id = NEW.tenant_id
    AND revision_record.conflict_id = NEW.conflict_id
  ORDER BY revision_record.revision DESC
  LIMIT 1
  FOR UPDATE;

  IF NEW.revision = 1 THEN
    IF previous.revision IS NULL THEN
      RETURN NEW;
    END IF;
    IF previous.revision = 1
      AND previous.conflict_json IS NOT DISTINCT FROM NEW.conflict_json
      AND previous.status IS NOT DISTINCT FROM NEW.status
      AND previous.conflict_type IS NOT DISTINCT FROM NEW.conflict_type
      AND previous.current_truth IS NOT DISTINCT FROM NEW.current_truth
      AND previous.customer_configuration_id IS NOT DISTINCT FROM NEW.customer_configuration_id
      AND previous.position_id IS NOT DISTINCT FROM NEW.position_id
      AND previous.fact_meaning IS NOT DISTINCT FROM NEW.fact_meaning
      AND previous.detected_at IS NOT DISTINCT FROM NEW.detected_at
      AND previous.resolved_at IS NOT DISTINCT FROM NEW.resolved_at
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_conflict_revisions_sequence_ck',
      MESSAGE = 'Inventory Source Conflict revision one must establish one stable identity';
  END IF;

  IF NEW.revision = 2 AND previous.revision = 2 THEN
    IF previous.conflict_json IS NOT DISTINCT FROM NEW.conflict_json
      AND previous.status IS NOT DISTINCT FROM NEW.status
      AND previous.conflict_type IS NOT DISTINCT FROM NEW.conflict_type
      AND previous.current_truth IS NOT DISTINCT FROM NEW.current_truth
      AND previous.customer_configuration_id IS NOT DISTINCT FROM NEW.customer_configuration_id
      AND previous.position_id IS NOT DISTINCT FROM NEW.position_id
      AND previous.fact_meaning IS NOT DISTINCT FROM NEW.fact_meaning
      AND previous.detected_at IS NOT DISTINCT FROM NEW.detected_at
      AND previous.resolved_at IS NOT DISTINCT FROM NEW.resolved_at
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_conflict_revisions_sequence_ck',
      MESSAGE = 'Inventory Source Conflict resolution identity already has a different terminal revision';
  END IF;

  IF NEW.revision IS DISTINCT FROM 2
    OR previous.revision IS DISTINCT FROM 1
    OR NEW.conflict_type IS DISTINCT FROM previous.conflict_type
    OR NEW.customer_configuration_id IS DISTINCT FROM previous.customer_configuration_id
    OR NEW.position_id IS DISTINCT FROM previous.position_id
    OR NEW.fact_meaning IS DISTINCT FROM previous.fact_meaning
    OR NEW.detected_at IS DISTINCT FROM previous.detected_at
    OR NEW.resolved_at IS NULL
    OR NEW.resolved_at < NEW.detected_at
    OR NEW.conflict_json -> 'conflictRef' IS DISTINCT FROM previous.conflict_json -> 'conflictRef'
    OR NEW.conflict_json -> 'authorityConfiguration' IS DISTINCT FROM previous.conflict_json -> 'authorityConfiguration'
    OR NEW.conflict_json -> 'scope' IS DISTINCT FROM previous.conflict_json -> 'scope'
    OR NEW.conflict_json -> 'originalEvidence' IS DISTINCT FROM previous.conflict_json -> 'evidence'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_conflict_revisions_sequence_ck',
      MESSAGE = 'Inventory Source Conflict resolution must be the exact immutable successor of revision one';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_source_conflict_revisions_exact_scope_trg"
BEFORE INSERT ON "inventory"."source_conflict_revisions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_conflict_exact_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_conflict_revisions_sequence_trg"
BEFORE INSERT ON "inventory"."source_conflict_revisions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_conflict_revision"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_conflict_revisions_immutable_trg"
BEFORE UPDATE OR DELETE ON "inventory"."source_conflict_revisions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_conflict_revision"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_source_conflict_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_source_conflict_revision"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."enforce_source_import_ledger_exact_scope"() RETURNS trigger
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
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_source_import_ledger_exact_scope_ck',
      MESSAGE = 'Inventory Source Import ledger outcome JSON must exactly match its status contract';
  END IF;

  IF NEW.status = 'INDETERMINATE' THEN
    IF NEW.outcome_json ->> 'reason' = 'INVENTORY_SOURCE_CONFLICT' THEN
      IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) <> 5
        OR NOT (
          NEW.outcome_json ?& ARRAY[
            'assertionId', 'conflictRefs', 'reason', 'reconciliationRequired', 'status'
          ]
        )
        OR NEW.outcome_json -> 'reconciliationRequired' IS DISTINCT FROM 'true'::jsonb
        OR pg_catalog.jsonb_typeof(NEW.outcome_json -> 'conflictRefs') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_array_length(NEW.outcome_json -> 'conflictRefs') < 1
        OR (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(NEW.outcome_json -> 'conflictRefs') AS conflict_ref
        ) IS DISTINCT FROM (
          SELECT pg_catalog.count(DISTINCT conflict_ref ->> 'resourceId')
          FROM pg_catalog.jsonb_array_elements(NEW.outcome_json -> 'conflictRefs') AS conflict_ref
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(NEW.outcome_json -> 'conflictRefs') AS conflict_ref
          WHERE pg_catalog.jsonb_typeof(conflict_ref) IS DISTINCT FROM 'object'
            OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(conflict_ref)) <> 4
            OR NOT (conflict_ref ?& ARRAY['moduleId', 'resourceId', 'resourceType', 'tenantId'])
            OR conflict_ref ->> 'moduleId' IS DISTINCT FROM 'commerce.inventory'
            OR conflict_ref ->> 'resourceType'
              IS DISTINCT FROM 'commerce.inventory.inventory-source-conflict'
            OR conflict_ref ->> 'tenantId' IS DISTINCT FROM NEW.tenant_id::text
            OR NOT EXISTS (
              SELECT 1
              FROM "inventory"."source_conflict_revisions" AS source_conflict
              WHERE source_conflict.tenant_id = NEW.tenant_id
                AND source_conflict.conflict_id::text = conflict_ref ->> 'resourceId'
                AND source_conflict.revision = 1
                AND source_conflict.status = 'OPEN'
                AND source_conflict.customer_configuration_id = NEW.customer_configuration_id
                AND source_conflict.conflict_json -> 'conflictRef' IS NOT DISTINCT FROM conflict_ref
                AND (
                  (
                    source_conflict.conflict_type = 'CORRELATION'
                    AND source_conflict.conflict_json #> '{evidence,proposal}'
                      IS NOT DISTINCT FROM NEW.proposal_json
                  )
                  OR (
                    source_conflict.conflict_type IN ('FACT_VALUE', 'ASSERTION_INTEGRITY')
                    AND EXISTS (
                      SELECT 1
                      FROM pg_catalog.jsonb_array_elements(source_conflict.conflict_json -> 'evidence')
                        AS conflict_proposal
                      WHERE conflict_proposal IS NOT DISTINCT FROM NEW.proposal_json
                    )
                  )
                )
            )
        )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_source_import_ledger_exact_scope_ck',
          MESSAGE = 'Inventory Source Import conflict outcome must reference exact persisted conflict evidence';
      END IF;
    ELSIF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.outcome_json)) <> 4
      OR NOT (NEW.outcome_json ?& ARRAY['assertionId', 'reason', 'reconciliationRequired', 'status'])
      OR NEW.outcome_json ? 'conflictRefs'
      OR NEW.outcome_json -> 'reconciliationRequired' IS DISTINCT FROM 'true'::jsonb
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.outcome_json ->> 'reason')), 0) NOT BETWEEN 1 AND 300
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_source_import_ledger_exact_scope_ck',
        MESSAGE = 'Inventory Source Import reconciliation outcome must not claim source conflicts';
    END IF;
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
REVOKE ALL ON FUNCTION "inventory"."enforce_source_import_ledger_exact_scope"() FROM PUBLIC, "ontos_runtime";
