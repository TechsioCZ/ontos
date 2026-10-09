ALTER TABLE "inventory"."effect_ledger" DROP CONSTRAINT "inventory_effect_ledger_kind_ck", ADD CONSTRAINT "inventory_effect_ledger_kind_ck" CHECK ("effect_kind" in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'ESTABLISH_COMMITMENT_PROTECTION', 'PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE'));
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
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
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
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger relational state must exactly match its canonical snapshot';
  END IF;

  IF NEW.effect_kind = 'RESERVATION_CREATE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 5
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
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
        MESSAGE = 'Reservation Create ledger scope does not match its canonical business intent';
    END IF;
  ELSIF NEW.effect_kind = 'RESERVATION_RELEASE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 3
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
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
        MESSAGE = 'Reservation Release ledger scope does not match its canonical business intent';
    END IF;
  ELSIF NEW.effect_kind IN ('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE') THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 12
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
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
        MESSAGE = 'Physical Stock effect ledger scope does not match its canonical business intent';
    END IF;
  ELSIF NEW.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Commitment Protection effect intent is reserved until its typed owner contract is installed';
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
    resolution_identity := NEW.resolution_json #>> '{effect,request,effectId}';
    resolution_business_request := CASE NEW.effect_kind
      WHEN 'RESERVATION_CREATE' THEN
        NEW.resolution_json #> '{effect,request}' - 'mutationId' - 'requestedAt' - 'sourceActionInvocationId'
      WHEN 'RESERVATION_RELEASE' THEN
        NEW.resolution_json #> '{effect,request}' - 'mutationId' - 'requestedAt' - 'sourceActionInvocationId'
      WHEN 'PHYSICAL_RECEIPT' THEN
        NEW.resolution_json #> '{effect,request}' - 'actionInvocationId' - 'requestedAt'
      WHEN 'PHYSICAL_ISSUE' THEN
        NEW.resolution_json #> '{effect,request}' - 'actionInvocationId' - 'requestedAt'
    END;
    IF NEW.resolution_json ->> '_tag' IS DISTINCT FROM NEW.effect_kind
      OR resolution_identity IS DISTINCT FROM NEW.effect_id
      OR resolution_business_request IS DISTINCT FROM intent -> 'request'
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
      END)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Inventory effect resolution must preserve the exact business intent, kind, and owner effect identity';
    END IF;
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
    WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Commitment Protection effect claim is reserved until its typed owner contract is installed';
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
REVOKE ALL ON FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."claim_inventory_effect_ledger"(uuid, uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."claim_inventory_effect_ledger"(uuid, uuid, text, jsonb) TO "ontos_runtime";
