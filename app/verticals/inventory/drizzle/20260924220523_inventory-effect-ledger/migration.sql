CREATE TABLE "inventory"."effect_ledger" (
	"tenant_id" uuid,
	"effect_id" text,
	"effect_kind" text NOT NULL,
	"current_state" text DEFAULT 'REQUESTED' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"reservation_id" uuid,
	"attempt_id" text,
	"authority_configuration_id" uuid NOT NULL,
	"authority_backend_kind" text NOT NULL,
	"authority_backend_id" text NOT NULL,
	"intent_json" jsonb NOT NULL,
	"intent_canonical" text NOT NULL,
	"resolution_json" jsonb,
	"snapshot" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inventory_effect_ledger_pkey" PRIMARY KEY("tenant_id","effect_id"),
	CONSTRAINT "inventory_effect_ledger_kind_ck" CHECK ("effect_kind" in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE', 'STOCK_CORRECTION')),
	CONSTRAINT "inventory_effect_ledger_state_ck" CHECK ("current_state" in ('REQUESTED', 'INDETERMINATE', 'SUCCEEDED', 'REJECTED')),
	CONSTRAINT "inventory_effect_ledger_identity_ck" CHECK (char_length(btrim("effect_id")) between 1 and 300 and char_length(btrim("customer_configuration_id")) between 1 and 300 and char_length(btrim("authority_backend_id")) between 1 and 300 and char_length("intent_canonical") > 0),
	CONSTRAINT "inventory_effect_ledger_reservation_scope_ck" CHECK (("effect_kind" in ('RESERVATION_CREATE', 'RESERVATION_RELEASE') and "reservation_id" is not null and "attempt_id" is not null and char_length(btrim("attempt_id")) between 1 and 300) or ("effect_kind" not in ('RESERVATION_CREATE', 'RESERVATION_RELEASE') and "reservation_id" is null and "attempt_id" is null)),
	CONSTRAINT "inventory_effect_ledger_resolution_ck" CHECK (("current_state" = 'REQUESTED' and "resolution_json" is null) or ("current_state" = 'INDETERMINATE') or ("current_state" in ('SUCCEEDED', 'REJECTED') and "resolution_json" is not null)),
	CONSTRAINT "inventory_effect_ledger_revision_ck" CHECK ("current_revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."effect_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."effect_ledger_history" (
	"history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"effect_id" text NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"transitioned_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_effect_ledger_history_state_ck" CHECK ("state" in ('REQUESTED', 'INDETERMINATE', 'SUCCEEDED', 'REJECTED') and "revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."effect_ledger_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "inventory_effect_ledger_state_idx" ON "inventory"."effect_ledger" ("tenant_id","current_state","effect_kind","updated_at");--> statement-breakpoint
CREATE INDEX "inventory_effect_ledger_reservation_idx" ON "inventory"."effect_ledger" ("tenant_id","reservation_id","effect_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_effect_ledger_history_scope_id_uk" ON "inventory"."effect_ledger_history" ("tenant_id","history_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_effect_ledger_history_revision_uk" ON "inventory"."effect_ledger_history" ("tenant_id","effect_id","revision");--> statement-breakpoint
ALTER TABLE "inventory"."effect_ledger" ADD CONSTRAINT "inventory_effect_ledger_authority_fk" FOREIGN KEY ("tenant_id","authority_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."effect_ledger_history" ADD CONSTRAINT "inventory_effect_ledger_history_effect_fk" FOREIGN KEY ("tenant_id","effect_id") REFERENCES "inventory"."effect_ledger"("tenant_id","effect_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_tenant_select" ON "inventory"."effect_ledger" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."effect_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_tenant_insert" ON "inventory"."effect_ledger" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."effect_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_tenant_update" ON "inventory"."effect_ledger" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."effect_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."effect_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_tenant_delete" ON "inventory"."effect_ledger" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."effect_ledger"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_history_tenant_select" ON "inventory"."effect_ledger_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."effect_ledger_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_history_tenant_insert" ON "inventory"."effect_ledger_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."effect_ledger_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_history_tenant_update" ON "inventory"."effect_ledger_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."effect_ledger_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."effect_ledger_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_effect_ledger_history_tenant_delete" ON "inventory"."effect_ledger_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."effect_ledger_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."effect_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."effect_ledger_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  intent jsonb := NEW.intent_json;
  intent_kind text := NEW.intent_json ->> '_tag';
  parsed_canonical jsonb;
  resolution_identity text;
BEGIN
  BEGIN
    parsed_canonical := NEW.intent_canonical::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect intent canonical fingerprint must be valid JSON';
  END;

  IF pg_catalog.jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 8
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
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger relational state must exactly match its canonical snapshot';
  END IF;

  IF NEW.effect_kind = 'RESERVATION_CREATE' THEN
    IF intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,authority,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,reservation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,commerceContext,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,commerceContext,commerceMarketRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,commerceContext,sellingLegalEntityRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR (intent #>> '{request,commerceContext,sellingLegalEntityRef,resourceId}')::uuid
        IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR intent #>> '{request,commerceContext,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Reservation Create ledger scope does not match its exact intent';
    END IF;
  ELSIF NEW.effect_kind = 'RESERVATION_RELEASE' THEN
    IF intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,reservation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,reservation,authority,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,reservation,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,reservation,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,reservation,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,reservation,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Reservation Release ledger scope does not match its exact intent';
    END IF;
  ELSIF NEW.effect_kind IN ('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE') THEN
    IF intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,stockItemRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,stockLocationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,backendConfigurationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,quantity,unitRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.reservation_id IS NOT NULL
      OR NEW.attempt_id IS NOT NULL
      OR (intent #>> '{request,backendConfigurationRef,resourceId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,backendId}' IS DISTINCT FROM NEW.authority_backend_id
      OR intent #>> '{request,kind}' IS DISTINCT FROM (CASE NEW.effect_kind
        WHEN 'PHYSICAL_RECEIPT' THEN 'RECEIPT'
        ELSE 'ISSUE'
      END)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Physical Stock effect ledger scope does not match its exact intent';
    END IF;
  ELSIF NEW.effect_kind = 'STOCK_CORRECTION' THEN
    IF intent #>> '{record,correctionId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{record,positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{record,authorityConfigurationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent ->> 'legalEntityId')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{record,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR NEW.reservation_id IS NOT NULL
      OR NEW.attempt_id IS NOT NULL
      OR (intent #>> '{record,authorityConfigurationRef,resourceId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{record,issuer,backendKind}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{record,issuer,backendId}' IS DISTINCT FROM NEW.authority_backend_id
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Stock Correction ledger scope does not match its exact intent';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger kind is not supported';
  END IF;

  PERFORM 1
  FROM "inventory"."backend_configurations" AS authority
  WHERE authority.tenant_id = NEW.tenant_id
    AND authority.configuration_id = NEW.authority_configuration_id
    AND authority.customer_configuration_id = NEW.customer_configuration_id
    AND authority.backend_kind = NEW.authority_backend_kind
    AND authority.backend_id = NEW.authority_backend_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger authority does not match the selected backend configuration';
  END IF;

  IF NEW.resolution_json IS NOT NULL THEN
    resolution_identity := CASE NEW.effect_kind
      WHEN 'STOCK_CORRECTION' THEN NEW.resolution_json #>> '{record,correctionId}'
      ELSE NEW.resolution_json #>> '{effect,request,effectId}'
    END;
    IF NEW.resolution_json ->> '_tag' IS DISTINCT FROM NEW.effect_kind
      OR resolution_identity IS DISTINCT FROM NEW.effect_id
      OR (
        NEW.effect_kind <> 'STOCK_CORRECTION'
        AND NEW.resolution_json #> '{effect,request}' IS DISTINCT FROM intent -> 'request'
      )
      OR (
        NEW.effect_kind = 'STOCK_CORRECTION'
        AND NEW.resolution_json -> 'record' IS DISTINCT FROM intent -> 'record'
      )
      OR (
        NEW.effect_kind IN ('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE')
        AND NEW.resolution_json #>> '{effect,request,kind}' IS DISTINCT FROM (CASE NEW.effect_kind
          WHEN 'PHYSICAL_RECEIPT' THEN 'RECEIPT'
          ELSE 'ISSUE'
        END)
      )
      OR NEW.current_state IS DISTINCT FROM (CASE NEW.effect_kind
        WHEN 'RESERVATION_CREATE' THEN CASE NEW.resolution_json #>> '{effect,_tag}'
          WHEN 'INDETERMINATE' THEN 'INDETERMINATE'
          WHEN 'RECONCILIATION_REQUIRED' THEN 'INDETERMINATE'
          WHEN 'ESTABLISHED' THEN 'SUCCEEDED'
          WHEN 'RESOLVED_NO_RESERVATION' THEN 'REJECTED'
        END
        WHEN 'RESERVATION_RELEASE' THEN CASE NEW.resolution_json #>> '{effect,_tag}'
          WHEN 'INDETERMINATE' THEN 'INDETERMINATE'
          WHEN 'RELEASED' THEN 'SUCCEEDED'
          WHEN 'NOT_RELEASABLE' THEN 'REJECTED'
        END
        WHEN 'PHYSICAL_RECEIPT' THEN CASE NEW.resolution_json #>> '{effect,_tag}'
          WHEN 'INDETERMINATE' THEN 'INDETERMINATE'
          WHEN 'APPLIED' THEN 'SUCCEEDED'
          WHEN 'REJECTED' THEN 'REJECTED'
        END
        WHEN 'PHYSICAL_ISSUE' THEN CASE NEW.resolution_json #>> '{effect,_tag}'
          WHEN 'INDETERMINATE' THEN 'INDETERMINATE'
          WHEN 'APPLIED' THEN 'SUCCEEDED'
          WHEN 'REJECTED' THEN 'REJECTED'
        END
        WHEN 'STOCK_CORRECTION' THEN CASE NEW.resolution_json #>> '{record,_tag}'
          WHEN 'INDETERMINATE' THEN 'INDETERMINATE'
          WHEN 'APPLIED' THEN 'SUCCEEDED'
        END
      END)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Inventory effect resolution must preserve the exact kind and owner effect identity';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_effect_ledger_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.effect_kind IS DISTINCT FROM OLD.effect_kind
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.authority_configuration_id IS DISTINCT FROM OLD.authority_configuration_id
    OR NEW.authority_backend_kind IS DISTINCT FROM OLD.authority_backend_kind
    OR NEW.authority_backend_id IS DISTINCT FROM OLD.authority_backend_id
    OR NEW.intent_json IS DISTINCT FROM OLD.intent_json
    OR NEW.intent_canonical IS DISTINCT FROM OLD.intent_canonical
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision + 1
    OR OLD.current_state IN ('SUCCEEDED', 'REJECTED')
    OR OLD.current_state NOT IN ('REQUESTED', 'INDETERMINATE')
    OR NEW.current_state NOT IN ('INDETERMINATE', 'SUCCEEDED', 'REJECTED')
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_effect_ledger_transition_ck',
      MESSAGE = 'Inventory effect ledger transition mutates immutable intent or violates monotonic lifecycle';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_effect_ledger_history_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  PERFORM 1
  FROM "inventory"."effect_ledger" AS effect
  WHERE effect.tenant_id = NEW.tenant_id
    AND effect.effect_id = NEW.effect_id
    AND effect.current_revision = NEW.revision
    AND effect.current_state = NEW.state
    AND effect.snapshot IS NOT DISTINCT FROM NEW.snapshot
    AND (NEW.snapshot ->> 'updatedAt')::timestamptz = NEW.transitioned_at
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_history_snapshot_ck',
      MESSAGE = 'Inventory effect ledger history must exactly snapshot the current validated revision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_effect_ledger_history_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_history_append_only_ck',
    MESSAGE = 'Inventory effect ledger history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_effect_ledger_exact_scope_trg"
BEFORE INSERT OR UPDATE ON "inventory"."effect_ledger"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_effect_ledger_exact_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_effect_ledger_transition_trg"
BEFORE UPDATE OR DELETE ON "inventory"."effect_ledger"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_effect_ledger_transition"();
--> statement-breakpoint
CREATE TRIGGER "inventory_effect_ledger_history_scope_trg"
BEFORE INSERT ON "inventory"."effect_ledger_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_effect_ledger_history_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_effect_ledger_history_no_update_trg"
BEFORE UPDATE ON "inventory"."effect_ledger_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_effect_ledger_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_effect_ledger_history_no_delete_trg"
BEFORE DELETE ON "inventory"."effect_ledger_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_effect_ledger_history_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_effect_ledger_transition"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_effect_ledger_history_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_effect_ledger_history_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "inventory"."claim_inventory_effect_ledger"(
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
  attempt_id text;
  authority_backend_id text;
  authority_backend_kind text;
  authority_configuration_id uuid;
  customer_configuration_id text;
  effect_id text := p_initial_snapshot ->> 'effectId';
  effect_kind text := p_initial_snapshot #>> '{intent,_tag}';
  existing "inventory"."effect_ledger"%ROWTYPE;
  intent jsonb;
  reservation_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Inventory effect ledger claim scope mismatch';
  END IF;

  BEGIN
    intent := p_intent_canonical::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger claim canonical intent must be valid JSON';
  END;

  IF p_initial_snapshot -> 'intent' IS DISTINCT FROM intent
    OR p_initial_snapshot ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR p_initial_snapshot ->> 'currentState' IS DISTINCT FROM 'REQUESTED'
    OR (p_initial_snapshot ->> 'revision')::integer IS DISTINCT FROM 1
    OR p_initial_snapshot -> 'resolution' IS DISTINCT FROM 'null'::jsonb
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger claim must carry one exact canonical REQUESTED snapshot';
  END IF;

  CASE effect_kind
    WHEN 'RESERVATION_CREATE' THEN
      customer_configuration_id := intent #>> '{request,authority,customerConfigurationId}';
      reservation_id := (intent #>> '{request,reservation,ref,resourceId}')::uuid;
      attempt_id := intent #>> '{request,reservation,origin,attemptId}';
      authority_configuration_id := (intent #>> '{request,authority,configurationId}')::uuid;
      authority_backend_kind := intent #>> '{request,authority,selection,backend}';
      authority_backend_id := intent #>> '{request,authority,selection,backendId}';
    WHEN 'RESERVATION_RELEASE' THEN
      customer_configuration_id := intent #>> '{request,reservation,authority,customerConfigurationId}';
      reservation_id := (intent #>> '{request,reservation,ref,resourceId}')::uuid;
      attempt_id := intent #>> '{request,reservation,origin,attemptId}';
      authority_configuration_id := (intent #>> '{request,reservation,authority,configurationId}')::uuid;
      authority_backend_kind := intent #>> '{request,reservation,authority,selection,backend}';
      authority_backend_id := intent #>> '{request,reservation,authority,selection,backendId}';
    WHEN 'PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE' THEN
      customer_configuration_id := intent #>> '{request,customerConfigurationId}';
      reservation_id := NULL;
      attempt_id := NULL;
      authority_configuration_id := (intent #>> '{request,backendConfigurationRef,resourceId}')::uuid;
      authority_backend_kind := intent #>> '{request,backend}';
      authority_backend_id := intent #>> '{request,backendId}';
    WHEN 'STOCK_CORRECTION' THEN
      customer_configuration_id := intent #>> '{record,customerConfigurationId}';
      reservation_id := NULL;
      attempt_id := NULL;
      authority_configuration_id := (intent #>> '{record,authorityConfigurationRef,resourceId}')::uuid;
      authority_backend_kind := intent #>> '{record,issuer,backendKind}';
      authority_backend_id := intent #>> '{record,issuer,backendId}';
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Inventory effect ledger claim kind is unsupported';
  END CASE;

  INSERT INTO "inventory"."effect_ledger" (
    tenant_id,
    effect_id,
    effect_kind,
    current_state,
    current_revision,
    legal_entity_id,
    customer_configuration_id,
    reservation_id,
    attempt_id,
    authority_configuration_id,
    authority_backend_kind,
    authority_backend_id,
    intent_json,
    intent_canonical,
    resolution_json,
    snapshot,
    requested_at,
    updated_at
  ) VALUES (
    p_tenant_id,
    effect_id,
    effect_kind,
    'REQUESTED',
    1,
    p_legal_entity_id,
    customer_configuration_id,
    reservation_id,
    attempt_id,
    authority_configuration_id,
    authority_backend_kind,
    authority_backend_id,
    intent,
    p_intent_canonical,
    NULL,
    p_initial_snapshot,
    (p_initial_snapshot ->> 'requestedAt')::timestamptz,
    (p_initial_snapshot ->> 'updatedAt')::timestamptz
  )
  ON CONFLICT ON CONSTRAINT inventory_effect_ledger_pkey DO NOTHING
  RETURNING * INTO existing;

  IF FOUND THEN
    INSERT INTO "inventory"."effect_ledger_history" (
      tenant_id, effect_id, revision, state, snapshot, transitioned_at
    ) VALUES (
      existing.tenant_id,
      existing.effect_id,
      existing.current_revision,
      existing.current_state,
      existing.snapshot,
      existing.updated_at
    );
    RETURN QUERY SELECT existing.snapshot, true;
    RETURN;
  END IF;

  SELECT stored.*
  INTO existing
  FROM "inventory"."effect_ledger" AS stored
  WHERE stored.tenant_id = p_tenant_id
    AND stored.effect_id = effect_id
    AND stored.legal_entity_id = p_legal_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT existing.snapshot, false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."read_inventory_effect_ledger_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id text
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Inventory effect ledger worker scope mismatch';
  END IF;

  RETURN QUERY
  SELECT effect.snapshot
  FROM "inventory"."effect_ledger" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id
  FOR UPDATE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."transition_inventory_effect_ledger_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id text,
  p_expected_revision integer,
  p_expected_state text,
  p_next_snapshot jsonb
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_effect "inventory"."effect_ledger"%ROWTYPE;
  next_state text := p_next_snapshot ->> 'currentState';
  next_revision integer := (p_next_snapshot ->> 'revision')::integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Inventory effect ledger worker scope mismatch';
  END IF;

  SELECT effect.*
  INTO current_effect
  FROM "inventory"."effect_ledger" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF current_effect.snapshot IS NOT DISTINCT FROM p_next_snapshot THEN
    IF current_effect.current_revision IS DISTINCT FROM p_expected_revision + 1
      OR current_effect.current_state IS DISTINCT FROM next_state
      OR next_revision IS DISTINCT FROM current_effect.current_revision
      OR NOT (
        (p_expected_state = 'REQUESTED' AND next_state IN ('INDETERMINATE', 'SUCCEEDED', 'REJECTED'))
        OR (p_expected_state = 'INDETERMINATE' AND next_state IN ('INDETERMINATE', 'SUCCEEDED', 'REJECTED'))
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "inventory"."effect_ledger_history" AS predecessor
        WHERE predecessor.tenant_id = p_tenant_id
          AND predecessor.effect_id = p_effect_id
          AND predecessor.revision = p_expected_revision
          AND predecessor.state = p_expected_state
      )
    THEN
      RETURN;
    END IF;
    RETURN QUERY SELECT current_effect.snapshot;
    RETURN;
  END IF;

  IF current_effect.current_revision IS DISTINCT FROM p_expected_revision
    OR current_effect.current_state IS DISTINCT FROM p_expected_state
    OR next_revision IS DISTINCT FROM p_expected_revision + 1
    OR p_next_snapshot ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR p_next_snapshot ->> 'effectId' IS DISTINCT FROM p_effect_id
    OR p_next_snapshot -> 'intent' IS DISTINCT FROM current_effect.intent_json
    OR NOT (
      (p_expected_state = 'REQUESTED' AND next_state IN ('INDETERMINATE', 'SUCCEEDED', 'REJECTED'))
      OR (p_expected_state = 'INDETERMINATE' AND next_state IN ('INDETERMINATE', 'SUCCEEDED', 'REJECTED'))
    )
  THEN
    RETURN;
  END IF;

  UPDATE "inventory"."effect_ledger"
  SET current_state = next_state,
    current_revision = next_revision,
    resolution_json = CASE WHEN p_next_snapshot -> 'resolution' = 'null'::jsonb
      THEN NULL
      ELSE p_next_snapshot -> 'resolution'
    END,
    snapshot = p_next_snapshot,
    updated_at = (p_next_snapshot ->> 'updatedAt')::timestamptz
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND effect_id = p_effect_id
    AND current_revision = p_expected_revision
    AND current_state = p_expected_state
  RETURNING * INTO current_effect;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO "inventory"."effect_ledger_history" (
    tenant_id, effect_id, revision, state, snapshot, transitioned_at
  ) VALUES (
    current_effect.tenant_id,
    current_effect.effect_id,
    current_effect.current_revision,
    current_effect.current_state,
    current_effect.snapshot,
    current_effect.updated_at
  );

  RETURN QUERY SELECT current_effect.snapshot;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."claim_inventory_effect_ledger"(uuid, uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."read_inventory_effect_ledger_for_worker"(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."transition_inventory_effect_ledger_for_worker"(uuid, uuid, text, integer, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."claim_inventory_effect_ledger"(uuid, uuid, text, jsonb) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."read_inventory_effect_ledger_for_worker"(uuid, uuid, text) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."transition_inventory_effect_ledger_for_worker"(uuid, uuid, text, integer, text, jsonb) TO "ontos_runtime";
