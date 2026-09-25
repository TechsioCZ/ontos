CREATE TABLE "inventory"."commitment_protection_history" (
	"history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"protection_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"health_state" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"transitioned_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_commitment_protection_history_health_ck" CHECK ("health_state" in ('PROTECTED', 'AT_RISK') and "revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."commitment_protection_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "inventory"."commitment_protections" (
	"protection_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"confirmation_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"owner_configuration_id" uuid NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"authority_effect_id" text NOT NULL,
	"owner_evidence_ref" text NOT NULL,
	"established_at" timestamp with time zone NOT NULL,
	"current_health_state" text DEFAULT 'PROTECTED' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_commitment_protections_meaning_ck" CHECK (char_length(btrim("attempt_id")) between 1 and 300 and char_length(btrim("issuer_backend_id")) between 1 and 300 and char_length(btrim("authority_effect_id")) between 1 and 300 and char_length(btrim("owner_evidence_ref")) between 1 and 300 and "issuer_backend_kind" in ('external_business_system', 'ontos_wms')),
	CONSTRAINT "inventory_commitment_protections_health_ck" CHECK ("current_health_state" in ('PROTECTED', 'AT_RISK') and "current_revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."commitment_protections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_commitment_protection_history_scope_id_uk" ON "inventory"."commitment_protection_history" ("tenant_id","history_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_commitment_protection_history_revision_uk" ON "inventory"."commitment_protection_history" ("tenant_id","protection_id","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_commitment_protections_scope_id_uk" ON "inventory"."commitment_protections" ("tenant_id","protection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_commitment_protections_reservation_attempt_uk" ON "inventory"."commitment_protections" ("tenant_id","reservation_id","attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_commitment_protections_confirmation_uk" ON "inventory"."commitment_protections" ("tenant_id","confirmation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_commitment_protections_authority_effect_uk" ON "inventory"."commitment_protections" ("tenant_id","authority_effect_id");
--> statement-breakpoint
CREATE INDEX "inventory_commitment_protections_health_idx" ON "inventory"."commitment_protections" ("tenant_id","current_health_state","established_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_effect_ledger_commitment_protection_attempt_uk" ON "inventory"."effect_ledger" ("tenant_id","reservation_id","attempt_id","effect_kind") WHERE "effect_kind" = 'ESTABLISH_COMMITMENT_PROTECTION';
--> statement-breakpoint
ALTER TABLE "inventory"."commitment_protection_history" ADD CONSTRAINT "inventory_commitment_protection_history_protection_fk" FOREIGN KEY ("tenant_id","protection_id") REFERENCES "inventory"."commitment_protections"("tenant_id","protection_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "inventory"."commitment_protections" ADD CONSTRAINT "inventory_commitment_protections_confirmation_fk" FOREIGN KEY ("tenant_id","confirmation_id") REFERENCES "inventory"."reservation_confirmations"("tenant_id","confirmation_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "inventory"."commitment_protections" ADD CONSTRAINT "inventory_commitment_protections_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "inventory"."obligations"("tenant_id","obligation_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "inventory"."commitment_protections" ADD CONSTRAINT "inventory_commitment_protections_backend_configuration_fk" FOREIGN KEY ("tenant_id","owner_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "inventory"."effect_ledger" DROP CONSTRAINT "inventory_effect_ledger_reservation_scope_ck", ADD CONSTRAINT "inventory_effect_ledger_reservation_scope_ck" CHECK (("effect_kind" in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'ESTABLISH_COMMITMENT_PROTECTION') and "reservation_id" is not null and "attempt_id" is not null and char_length(btrim("attempt_id")) between 1 and 300) or ("effect_kind" not in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'ESTABLISH_COMMITMENT_PROTECTION') and "reservation_id" is null and "attempt_id" is null));
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protection_history_tenant_select" ON "inventory"."commitment_protection_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."commitment_protection_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protection_history_tenant_insert" ON "inventory"."commitment_protection_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."commitment_protection_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protection_history_tenant_update" ON "inventory"."commitment_protection_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."commitment_protection_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."commitment_protection_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protection_history_tenant_delete" ON "inventory"."commitment_protection_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."commitment_protection_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protections_tenant_select" ON "inventory"."commitment_protections" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."commitment_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protections_tenant_insert" ON "inventory"."commitment_protections" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."commitment_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protections_tenant_update" ON "inventory"."commitment_protections" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."commitment_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."commitment_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "inventory_commitment_protections_tenant_delete" ON "inventory"."commitment_protections" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."commitment_protections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."commitment_protection_history" FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."commitment_protections" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inventory"."commitment_protection_history" TO "ontos_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inventory"."commitment_protections" TO "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_commitment_protection_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  authority "inventory"."backend_configurations"%ROWTYPE;
  confirmation "inventory"."reservation_confirmations"%ROWTYPE;
  candidate_confirmation jsonb := NEW.snapshot -> 'confirmation';
  expected_allocations jsonb;
  actual_allocations jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
    OR (NEW.snapshot #>> '{ref,resourceId}')::uuid IS DISTINCT FROM NEW.protection_id
    OR NEW.snapshot #>> '{ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR (NEW.snapshot #>> '{confirmation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.confirmation_id
    OR NEW.snapshot #>> '{confirmation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR (NEW.snapshot #>> '{confirmation,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
    OR NEW.snapshot #>> '{confirmation,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR (NEW.snapshot #>> '{confirmation,reservation,authority,configurationId}')::uuid IS DISTINCT FROM NEW.owner_configuration_id
    OR NEW.snapshot #>> '{authorityEvidence,issuer,backend}' IS DISTINCT FROM NEW.issuer_backend_kind
    OR NEW.snapshot #>> '{authorityEvidence,issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
    OR NEW.snapshot #>> '{authorityEvidence,effectId}' IS DISTINCT FROM NEW.authority_effect_id
    OR NEW.snapshot #>> '{authorityEvidence,evidence,ownerEvidenceRef}' IS DISTINCT FROM NEW.owner_evidence_ref
    OR (NEW.snapshot #>> '{authorityEvidence,evidence,validFrom}')::timestamptz IS DISTINCT FROM NEW.established_at
    OR (NEW.snapshot ->> 'establishedAt')::timestamptz IS DISTINCT FROM NEW.established_at
    OR NEW.snapshot #>> '{health,state}' IS DISTINCT FROM NEW.current_health_state
    OR (NEW.snapshot ->> 'revision')::integer IS DISTINCT FROM NEW.current_revision
    OR (NEW.snapshot #>> '{health,observation,effectiveAt}')::timestamptz IS DISTINCT FROM NEW.updated_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection snapshot must exactly match its relational identity and current health';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  SELECT selected.* INTO authority
  FROM "inventory"."backend_configurations" AS selected
  WHERE selected.tenant_id = NEW.tenant_id
    AND selected.configuration_id = NEW.owner_configuration_id
    AND selected.customer_configuration_id = NEW.snapshot #>> '{confirmation,reservation,authority,customerConfigurationId}'
    AND selected.backend_kind = NEW.issuer_backend_kind
    AND selected.backend_id = NEW.issuer_backend_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR NEW.snapshot #>> '{authorityEvidence,issuer,origin}' IS DISTINCT FROM CASE NEW.issuer_backend_kind
      WHEN 'external_business_system' THEN 'EXTERNAL_BUSINESS_SYSTEM'
      WHEN 'ontos_wms' THEN 'ONTOS_WMS'
    END
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_exact_authority_ck',
      MESSAGE = 'Commitment Protection must preserve the exact selected backend authority';
  END IF;

  SELECT current_confirmation.* INTO confirmation
  FROM "inventory"."reservation_confirmations" AS current_confirmation
  WHERE current_confirmation.tenant_id = NEW.tenant_id
    AND current_confirmation.confirmation_id = NEW.confirmation_id
    AND current_confirmation.reservation_id = NEW.reservation_id
    AND current_confirmation.attempt_id = NEW.attempt_id
    AND current_confirmation.owner_configuration_id = NEW.owner_configuration_id
    AND current_confirmation.issuer_backend_kind = NEW.issuer_backend_kind
    AND current_confirmation.issuer_backend_id = NEW.issuer_backend_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR NEW.established_at >= confirmation.expires_at
    OR NOT EXISTS (
      SELECT 1 FROM "inventory"."reservation_confirmation_history" AS confirmation_history
      WHERE confirmation_history.tenant_id = NEW.tenant_id
        AND confirmation_history.confirmation_id = NEW.confirmation_id
        AND confirmation_history.snapshot = candidate_confirmation
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_exact_confirmation_ck',
      MESSAGE = 'Commitment Protection must reference exact retained Confirmation proof established before exclusive expiry';
  END IF;

  PERFORM 1 FROM "inventory"."obligations" AS reservation
  WHERE reservation.tenant_id = NEW.tenant_id
    AND reservation.obligation_id = NEW.reservation_id
    AND reservation.origin_kind = 'ORDER_COMMITMENT_ATTEMPT'
    AND reservation.origin_attempt_id = NEW.attempt_id
    AND reservation.owner_configuration_id = NEW.owner_configuration_id
    AND reservation.lifecycle_meaning = 'PROVISIONAL_RESERVATION'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_exact_reservation_ck',
      MESSAGE = 'Commitment Protection must reference the exact provisional Reservation and Attempt';
  END IF;

  SELECT pg_catalog.jsonb_agg(allocation.entry ORDER BY allocation.entry ->> 'allocationId')
  INTO expected_allocations
  FROM pg_catalog.jsonb_array_elements(candidate_confirmation #> '{reservation,requirements}') AS requirement(entry),
    LATERAL pg_catalog.jsonb_array_elements(requirement.entry -> 'allocations') AS allocation(entry);
  SELECT pg_catalog.jsonb_agg(allocation.entry ORDER BY allocation.entry ->> 'allocationId')
  INTO actual_allocations
  FROM pg_catalog.jsonb_array_elements(NEW.snapshot #> '{authorityEvidence,evidence,allocations}') AS allocation(entry);
  IF NEW.current_health_state IS DISTINCT FROM 'PROTECTED'
    OR NEW.current_revision IS DISTINCT FROM 1
    OR NEW.snapshot #>> '{authorityEvidence,kind}' IS DISTINCT FROM 'AUTHORITATIVE_RESERVATION_EVIDENCE'
    OR NEW.snapshot #>> '{authorityEvidence,operation}' IS DISTINCT FROM 'COMMITMENT_PROTECTION'
    OR NEW.snapshot #>> '{authorityEvidence,evidence,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot #>> '{authorityEvidence,evidence,reservationId}' IS DISTINCT FROM NEW.reservation_id::text
    OR NEW.snapshot #>> '{authorityEvidence,evidence,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR NEW.snapshot #>> '{authorityEvidence,evidence,customerConfigurationId}' IS DISTINCT FROM authority.customer_configuration_id
    OR NEW.snapshot #>> '{health,observation,_tag}' IS DISTINCT FROM 'ESTABLISHED'
    OR NEW.snapshot #>> '{health,observation,ownerEvidenceRef}' IS DISTINCT FROM NEW.owner_evidence_ref
    OR (NEW.snapshot #>> '{health,reconciliationRequired}')::boolean IS DISTINCT FROM false
    OR expected_allocations IS DISTINCT FROM actual_allocations
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection establishment must preserve exact authority allocation, quantity, Unit, Item, Position, and evidence scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."claim_inventory_effect_ledger"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_intent_canonical text,
  p_initial_snapshot jsonb
) RETURNS TABLE(record jsonb, inserted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_attempt_id text;
  v_authority_backend_id text;
  v_authority_backend_kind text;
  v_authority_configuration_id uuid;
  v_customer_configuration_id text;
  v_effect_id text := p_initial_snapshot ->> 'effectId';
  v_effect_kind text := p_initial_snapshot #>> '{intent,_tag}';
  v_existing "inventory"."effect_ledger"%ROWTYPE;
  v_intent jsonb;
  v_reservation_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Inventory effect ledger claim scope mismatch';
  END IF;
  BEGIN v_intent := p_intent_canonical::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
  END;
  IF p_initial_snapshot -> 'intent' IS DISTINCT FROM v_intent
    OR p_initial_snapshot ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR p_initial_snapshot ->> 'currentState' IS DISTINCT FROM 'REQUESTED'
    OR (p_initial_snapshot ->> 'revision')::integer IS DISTINCT FROM 1
    OR p_initial_snapshot -> 'resolution' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
  END IF;

  CASE v_effect_kind
    WHEN 'RESERVATION_CREATE' THEN
      v_customer_configuration_id := v_intent #>> '{request,authority,customerConfigurationId}';
      v_reservation_id := (v_intent #>> '{request,reservation,ref,resourceId}')::uuid;
      v_attempt_id := v_intent #>> '{request,reservation,origin,attemptId}';
      v_authority_configuration_id := (v_intent #>> '{request,authority,configurationId}')::uuid;
      v_authority_backend_kind := v_intent #>> '{request,authority,selection,backend}';
      v_authority_backend_id := v_intent #>> '{request,authority,selection,backendId}';
    WHEN 'RESERVATION_RELEASE' THEN
      v_customer_configuration_id := v_intent #>> '{request,reservation,authority,customerConfigurationId}';
      v_reservation_id := (v_intent #>> '{request,reservation,ref,resourceId}')::uuid;
      v_attempt_id := v_intent #>> '{request,reservation,origin,attemptId}';
      v_authority_configuration_id := (v_intent #>> '{request,reservation,authority,configurationId}')::uuid;
      v_authority_backend_kind := v_intent #>> '{request,reservation,authority,selection,backend}';
      v_authority_backend_id := v_intent #>> '{request,reservation,authority,selection,backendId}';
    WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN
      v_customer_configuration_id := v_intent #>> '{request,confirmation,reservation,authority,customerConfigurationId}';
      v_reservation_id := (v_intent #>> '{request,confirmation,reservation,ref,resourceId}')::uuid;
      v_attempt_id := v_intent #>> '{request,confirmation,reservation,origin,attemptId}';
      v_authority_configuration_id := (v_intent #>> '{request,confirmation,reservation,authority,configurationId}')::uuid;
      v_authority_backend_kind := v_intent #>> '{request,confirmation,reservation,authority,selection,backend}';
      v_authority_backend_id := v_intent #>> '{request,confirmation,reservation,authority,selection,backendId}';
    WHEN 'PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE' THEN
      v_customer_configuration_id := v_intent #>> '{request,customerConfigurationId}';
      v_reservation_id := NULL;
      v_attempt_id := NULL;
      v_authority_configuration_id := (v_intent #>> '{request,backendConfigurationRef,resourceId}')::uuid;
      v_authority_backend_kind := v_intent #>> '{request,backend}';
      v_authority_backend_id := v_intent #>> '{request,backendId}';
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
  END CASE;

  INSERT INTO "inventory"."effect_ledger" (
    tenant_id, effect_id, effect_kind, current_state, current_revision, legal_entity_id,
    customer_configuration_id, reservation_id, attempt_id, authority_configuration_id,
    authority_backend_kind, authority_backend_id, intent_json, intent_canonical, resolution_json,
    snapshot, requested_at, updated_at
  ) VALUES (
    p_tenant_id, v_effect_id, v_effect_kind, 'REQUESTED', 1, p_legal_entity_id,
    v_customer_configuration_id, v_reservation_id, v_attempt_id, v_authority_configuration_id,
    v_authority_backend_kind, v_authority_backend_id, v_intent, p_intent_canonical, NULL,
    p_initial_snapshot, (p_initial_snapshot ->> 'requestedAt')::timestamptz,
    (p_initial_snapshot ->> 'updatedAt')::timestamptz
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_existing;

  IF FOUND THEN
    INSERT INTO "inventory"."effect_ledger_history" (
      tenant_id, effect_id, revision, state, snapshot, transitioned_at
    ) VALUES (
      v_existing.tenant_id, v_existing.effect_id, v_existing.current_revision,
      v_existing.current_state, v_existing.snapshot, v_existing.updated_at
    );
    RETURN QUERY SELECT v_existing.snapshot, true;
    RETURN;
  END IF;

  SELECT stored.* INTO v_existing
  FROM "inventory"."effect_ledger" AS stored
  WHERE stored.tenant_id = p_tenant_id
    AND stored.legal_entity_id = p_legal_entity_id
    AND (
      stored.effect_id = v_effect_id
      OR (
        v_effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'
        AND stored.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'
        AND stored.reservation_id = v_reservation_id
        AND stored.attempt_id = v_attempt_id
      )
    )
  ORDER BY (stored.effect_id = v_effect_id) DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT v_existing.snapshot, false;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_commitment_protections_scope_trg"
BEFORE INSERT OR UPDATE ON "inventory"."commitment_protections"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_commitment_protection_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_commitment_protection_lifecycle"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection cannot be deleted or released';
  END IF;
  IF NEW.protection_id IS DISTINCT FROM OLD.protection_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.owner_configuration_id IS DISTINCT FROM OLD.owner_configuration_id
    OR NEW.issuer_backend_kind IS DISTINCT FROM OLD.issuer_backend_kind
    OR NEW.issuer_backend_id IS DISTINCT FROM OLD.issuer_backend_id
    OR NEW.authority_effect_id IS DISTINCT FROM OLD.authority_effect_id
    OR NEW.owner_evidence_ref IS DISTINCT FROM OLD.owner_evidence_ref
    OR NEW.established_at IS DISTINCT FROM OLD.established_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision + 1
    OR OLD.current_health_state NOT IN ('PROTECTED', 'AT_RISK')
    OR NEW.current_health_state IS DISTINCT FROM 'AT_RISK'
    OR NEW.updated_at < OLD.updated_at
    OR NEW.snapshot -> 'authorityEvidence' IS DISTINCT FROM OLD.snapshot -> 'authorityEvidence'
    OR NEW.snapshot -> 'confirmation' IS DISTINCT FROM OLD.snapshot -> 'confirmation'
    OR NEW.snapshot -> 'establishedAt' IS DISTINCT FROM OLD.snapshot -> 'establishedAt'
    OR NEW.snapshot -> 'ref' IS DISTINCT FROM OLD.snapshot -> 'ref'
    OR NEW.snapshot #>> '{health,observation,_tag}' NOT IN ('BINDING_CORRECTION', 'MATERIAL_IMPAIRMENT')
    OR (NEW.snapshot #>> '{health,reconciliationRequired}')::boolean IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection permits only monotonic PROTECTED or AT_RISK to AT_RISK health revisions';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_commitment_protections_lifecycle_trg"
BEFORE UPDATE OR DELETE ON "inventory"."commitment_protections"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_commitment_protection_lifecycle"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_commitment_protection_history_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  PERFORM 1 FROM "inventory"."commitment_protections" AS protection
  WHERE protection.tenant_id = NEW.tenant_id
    AND protection.protection_id = NEW.protection_id
    AND protection.current_revision = NEW.revision
    AND protection.current_health_state = NEW.health_state
    AND protection.snapshot = NEW.snapshot
    AND protection.updated_at = NEW.transitioned_at
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection history must exactly snapshot the current authoritative revision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_commitment_protection_history_scope_trg"
BEFORE INSERT ON "inventory"."commitment_protection_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_commitment_protection_history_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_commitment_protection_history_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
    MESSAGE = 'Commitment Protection history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_commitment_protection_history_no_update_trg"
BEFORE UPDATE ON "inventory"."commitment_protection_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_commitment_protection_history_mutation"();
CREATE TRIGGER "inventory_commitment_protection_history_no_delete_trg"
BEFORE DELETE ON "inventory"."commitment_protection_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_commitment_protection_history_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  intent jsonb := NEW.intent_json;
  intent_kind text := NEW.intent_json ->> '_tag';
  parsed_canonical jsonb;
  resolution_business_request jsonb;
  resolution_identity text;
BEGIN
  BEGIN
    parsed_canonical := NEW.intent_canonical::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect intent canonical fingerprint must be valid JSON';
  END;
  IF pg_catalog.jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 8
    OR pg_catalog.jsonb_typeof(intent) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent)) <> 2
    OR pg_catalog.jsonb_typeof(intent -> 'request') IS DISTINCT FROM 'object'
    OR NEW.snapshot ->> 'tenantId' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot ->> 'effectId' IS DISTINCT FROM NEW.effect_id
    OR NEW.snapshot ->> 'currentState' IS DISTINCT FROM NEW.current_state
    OR (NEW.snapshot ->> 'revision')::integer IS DISTINCT FROM NEW.current_revision
    OR (NEW.snapshot ->> 'requestedAt')::timestamptz IS DISTINCT FROM NEW.requested_at
    OR (NEW.snapshot ->> 'updatedAt')::timestamptz IS DISTINCT FROM NEW.updated_at
    OR NEW.updated_at < NEW.requested_at
    OR NEW.snapshot -> 'intent' IS DISTINCT FROM intent
    OR NEW.snapshot -> 'resolution' IS DISTINCT FROM coalesce(NEW.resolution_json, 'null'::jsonb)
    OR intent IS DISTINCT FROM parsed_canonical
    OR intent_kind IS DISTINCT FROM NEW.effect_kind
    OR (NEW.current_state = 'REQUESTED' AND (NEW.current_revision <> 1 OR NEW.resolution_json IS NOT NULL))
    OR (NEW.current_state IN ('SUCCEEDED', 'REJECTED') AND NEW.resolution_json IS NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger relational state must exactly match its canonical snapshot';
  END IF;

  IF NEW.effect_kind = 'RESERVATION_CREATE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 5
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,authority,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
    END IF;
  ELSIF NEW.effect_kind = 'RESERVATION_RELEASE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 3
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,reservation,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,reservation,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,reservation,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,reservation,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
    END IF;
  ELSIF NEW.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 4
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,confirmation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,protectionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,confirmation,reservation,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,confirmation,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,confirmation,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,confirmation,reservation,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,confirmation,reservation,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,confirmation,reservation,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Commitment Protection ledger scope does not match its canonical business intent';
    END IF;
  ELSIF NEW.effect_kind IN ('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE') THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 12
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,backendConfigurationRef,resourceId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,backendId}' IS DISTINCT FROM NEW.authority_backend_id
      OR NEW.reservation_id IS NOT NULL OR NEW.attempt_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
  END IF;

  PERFORM 1 FROM "inventory"."backend_configurations" AS authority
  WHERE authority.tenant_id = NEW.tenant_id
    AND authority.configuration_id = NEW.authority_configuration_id
    AND authority.customer_configuration_id = NEW.customer_configuration_id
    AND authority.backend_kind = NEW.authority_backend_kind
    AND authority.backend_id = NEW.authority_backend_id
  FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck'; END IF;

  IF NEW.resolution_json IS NOT NULL THEN
    resolution_identity := NEW.resolution_json #>> '{effect,request,effectId}';
    resolution_business_request := CASE NEW.effect_kind
      WHEN 'RESERVATION_CREATE' THEN NEW.resolution_json #> '{effect,request}' - 'mutationId' - 'requestedAt' - 'sourceActionInvocationId'
      WHEN 'RESERVATION_RELEASE' THEN NEW.resolution_json #> '{effect,request}' - 'mutationId' - 'requestedAt' - 'sourceActionInvocationId'
      WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN NEW.resolution_json #> '{effect,request}'
      WHEN 'PHYSICAL_RECEIPT' THEN NEW.resolution_json #> '{effect,request}' - 'actionInvocationId' - 'requestedAt'
      WHEN 'PHYSICAL_ISSUE' THEN NEW.resolution_json #> '{effect,request}' - 'actionInvocationId' - 'requestedAt'
    END;
    IF NEW.resolution_json ->> '_tag' IS DISTINCT FROM NEW.effect_kind
      OR resolution_identity IS DISTINCT FROM NEW.effect_id
      OR resolution_business_request IS DISTINCT FROM intent -> 'request'
      OR (
        NEW.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'
        AND NEW.resolution_json #>> '{effect,_tag}' = 'PROTECTED'
        AND (
          NEW.resolution_json #> '{effect,protection,ref}' IS DISTINCT FROM intent #> '{request,protectionRef}'
          OR NEW.resolution_json #> '{effect,protection,confirmation}' IS DISTINCT FROM intent #> '{request,confirmation}'
          OR NEW.resolution_json #>> '{effect,protection,authorityEvidence,effectId}' IS DISTINCT FROM NEW.effect_id
          OR NEW.resolution_json #>> '{effect,protection,authorityEvidence,operation}' IS DISTINCT FROM 'COMMITMENT_PROTECTION'
        )
      )
      OR NEW.current_state IS DISTINCT FROM CASE NEW.effect_kind
        WHEN 'RESERVATION_CREATE' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'RECONCILIATION_REQUIRED' THEN 'INDETERMINATE' WHEN 'ESTABLISHED' THEN 'SUCCEEDED' WHEN 'RESOLVED_NO_RESERVATION' THEN 'REJECTED' END
        WHEN 'RESERVATION_RELEASE' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'RELEASED' THEN 'SUCCEEDED' WHEN 'NOT_RELEASABLE' THEN 'REJECTED' END
        WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'PROTECTED' THEN 'SUCCEEDED' WHEN 'NOT_PROTECTABLE' THEN 'REJECTED' END
        WHEN 'PHYSICAL_RECEIPT' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'APPLIED' THEN 'SUCCEEDED' WHEN 'REJECTED' THEN 'REJECTED' END
        WHEN 'PHYSICAL_ISSUE' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'APPLIED' THEN 'SUCCEEDED' WHEN 'REJECTED' THEN 'REJECTED' END
      END THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Inventory effect resolution must preserve exact business intent, kind, identity, and terminal meaning';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_commitment_protection_scope"() FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "inventory"."enforce_commitment_protection_lifecycle"() FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "inventory"."enforce_commitment_protection_history_scope"() FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "inventory"."reject_commitment_protection_history_mutation"() FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON FUNCTION "inventory"."claim_inventory_effect_ledger"(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "inventory"."claim_inventory_effect_ledger"(uuid, uuid, text, jsonb) TO "ontos_runtime";
