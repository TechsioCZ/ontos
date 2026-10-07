CREATE TABLE "payment_term_catalog"."payment_term_source_authorities" (
	"source_authority_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"external_business_system_id" text NOT NULL,
	"namespace" text NOT NULL,
	"integration_route" text NOT NULL,
	"fact_family" text DEFAULT 'PAYMENT_TERM_DEFINITION' NOT NULL,
	"authority_revision" integer NOT NULL,
	"ingest_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_authorities_revision_uk" UNIQUE("tenant_id","legal_entity_id","external_business_system_id","namespace","integration_route","authority_revision"),
	CONSTRAINT "payment_term_catalog_authorities_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "payment_term_catalog_authorities_revision_ck" CHECK ("authority_revision" > 0),
	CONSTRAINT "payment_term_catalog_authorities_family_ck" CHECK ("fact_family" = 'PAYMENT_TERM_DEFINITION'),
	CONSTRAINT "payment_term_catalog_authorities_qualification_ck" CHECK (length(btrim("external_business_system_id")) between 1 and 200 and length(btrim("namespace")) between 1 and 200 and length(btrim("integration_route")) between 1 and 200),
	CONSTRAINT "payment_term_catalog_authorities_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_authorities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_term_catalog"."payment_term_source_statements" (
	"source_statement_ledger_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"external_business_system_id" text NOT NULL,
	"namespace" text NOT NULL,
	"integration_route" text NOT NULL,
	"source_record_id" text NOT NULL,
	"source_statement_id" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_code" text NOT NULL,
	"business_observed_at" timestamp with time zone NOT NULL,
	"authority_revision" integer NOT NULL,
	"content" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_statements_identity_uk" UNIQUE("tenant_id","legal_entity_id","external_business_system_id","namespace","integration_route","source_record_id","source_statement_id"),
	CONSTRAINT "payment_term_catalog_statements_revision_ck" CHECK ("source_revision" between 0 and 9007199254740991),
	CONSTRAINT "payment_term_catalog_statements_authority_ck" CHECK ("authority_revision" > 0),
	CONSTRAINT "payment_term_catalog_statements_outcome_ck" CHECK ("outcome" in ('ACCEPTED', 'REJECTED') and "result"->>'_tag' = "outcome")
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "payment_term_catalog_statements_ordering_idx" ON "payment_term_catalog"."payment_term_source_statements" ("tenant_id","legal_entity_id","external_business_system_id","namespace","integration_route","source_record_id","source_revision");--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_revisions" DROP CONSTRAINT "payment_term_catalog_revisions_semantics_ck", ADD CONSTRAINT "payment_term_catalog_revisions_semantics_ck" CHECK (("semantic_kind" = 'IMMEDIATE' and "net_days" is null and "due_date_anchor" is null and "calendar_rule" = 'NOT_APPLICABLE') or ("semantic_kind" = 'NET_DAYS' and "net_days" is not null and "net_days" between 0 and 9007199254740991 and "due_date_anchor" is not null and (("calculation_rule_version" = 1 and "due_date_anchor" = 'INVOICE_ISSUED_AT' and "calendar_rule" = 'CALENDAR_DAYS_UTC') or ("calculation_rule_version" = 2 and "due_date_anchor" = 'INVOICE_ISSUE_DATE' and "calendar_rule" = 'CALENDAR_DAYS'))));--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_revisions" DROP CONSTRAINT "payment_term_catalog_revisions_calculation_version_ck", ADD CONSTRAINT "payment_term_catalog_revisions_calculation_version_ck" CHECK ("calculation_rule_version" in (1, 2));--> statement-breakpoint
CREATE POLICY "payment_term_catalog_authorities_scope_select" ON "payment_term_catalog"."payment_term_source_authorities" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_authorities_scope_insert" ON "payment_term_catalog"."payment_term_source_authorities" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_term_source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_authorities_scope_update" ON "payment_term_catalog"."payment_term_source_authorities" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_term_source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_authorities_scope_delete" ON "payment_term_catalog"."payment_term_source_authorities" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_authorities"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_authorities"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_statements_scope_select" ON "payment_term_catalog"."payment_term_source_statements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_statements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_statements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_statements_scope_insert" ON "payment_term_catalog"."payment_term_source_statements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_term_source_statements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_statements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_statements_scope_update" ON "payment_term_catalog"."payment_term_source_statements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_statements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_statements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_term_source_statements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_statements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_statements_scope_delete" ON "payment_term_catalog"."payment_term_source_statements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_statements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_statements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payment_term_catalog"."definition_json"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payment_term_id uuid,
  p_revision_number integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'code', term.business_code,
    'compatibilityId', revision.compatibility_key,
    'created', jsonb_build_object(
      'actionInvocationId', term.created_by_action_invocation_id,
      'actorPrincipalId', term.created_by_principal_id,
      'at', to_char(term.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reason', term.creation_reason
    ),
    'description', revision.explanation,
    'definitionRevisionId', revision.payment_term_revision_id,
    'lifecycle', jsonb_build_object(
      'effectiveFrom', to_char(term.active_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN term.retired_effective_at IS NULL THEN NULL ELSE to_char(term.retired_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'state', term.lifecycle_state
    ),
    'metadataRevision', revision.revision_number,
    'name', revision.display_name,
    'paymentTermRef', jsonb_build_object(
      'moduleId', 'payment.term-catalog',
      'resourceId', term.payment_term_id,
      'resourceType', 'payment.term-catalog.payment-term',
      'tenantId', term.tenant_id
    ),
    'retired', CASE
      WHEN term.retired_effective_at IS NULL THEN NULL
      ELSE jsonb_build_object(
        'actionInvocationId', term.retired_by_action_invocation_id,
        'actorPrincipalId', term.retired_by_principal_id,
        'at', to_char(term.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reason', term.retirement_reason
      )
    END,
    'semanticFingerprint', revision.semantic_fingerprint,
    'semanticRevisionId', revision.semantic_revision_id,
    'semantics', CASE
      WHEN revision.semantic_kind = 'IMMEDIATE' THEN jsonb_build_object(
        'calculationRuleVersion', revision.calculation_rule_version,
        'calendarRule', 'NOT_APPLICABLE',
        'kind', 'IMMEDIATE'
      )
      ELSE jsonb_build_object(
        'calculationRuleVersion', revision.calculation_rule_version,
        'calendarRule', revision.calendar_rule,
        'days', revision.net_days,
        'dueDateAnchor', revision.due_date_anchor,
        'kind', 'NET_DAYS'
      )
    END,
    'updated', jsonb_build_object(
      'actionInvocationId', revision.action_invocation_id,
      'actorPrincipalId', revision.acting_principal_id,
      'at', to_char(revision.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reason', revision.change_reason
    )
  )
  FROM "payment_term_catalog"."payment_terms" AS term
  INNER JOIN LATERAL (
    SELECT candidate.*
    FROM "payment_term_catalog"."payment_term_revisions" AS candidate
    WHERE candidate.tenant_id = term.tenant_id
      AND candidate.legal_entity_id = term.legal_entity_id
      AND candidate.payment_term_id = term.payment_term_id
      AND (p_revision_number IS NULL OR candidate.revision_number = p_revision_number)
    ORDER BY candidate.revision_number DESC
    LIMIT 1
  ) AS revision ON true
  WHERE term.tenant_id = p_tenant_id
    AND term.legal_entity_id = p_legal_entity_id
    AND term.payment_term_id = p_payment_term_id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payment_term_catalog"."create_term"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_existing_id uuid;
  v_payment_term_id uuid := coalesce(nullif(p_input->>'paymentTermId', '')::uuid, gen_random_uuid());
  v_semantic_kind text := p_input->'semantics'->>'kind';
  v_net_days bigint := CASE WHEN p_input->'semantics'->>'kind' = 'NET_DAYS' THEN (p_input->'semantics'->>'days')::bigint ELSE NULL END;
  v_canonical text;
  v_fingerprint text;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  IF p_input->'semantics'->>'calculationRuleVersion' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'new payment terms require canonical semantics' USING ERRCODE = '23514';
  END IF;
  v_canonical := CASE
    WHEN v_semantic_kind = 'IMMEDIATE' THEN 'IMMEDIATE|' || (p_input->'semantics'->>'calculationRuleVersion') || '|NOT_APPLICABLE|' || (p_input->>'compatibilityKey')
    ELSE 'NET_DAYS|' || v_net_days::text || '|' || (p_input->'semantics'->>'dueDateAnchor') || '|' || (p_input->'semantics'->>'calendarRule') || '|' || (p_input->'semantics'->>'calculationRuleVersion') || '|' || (p_input->>'compatibilityKey')
  END;
  v_fingerprint := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- Serialise competing requests on both durable business keys. The fixed lock order
  -- makes the following existence checks authoritative for this transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payment-term-code|' || p_tenant_id::text || '|' || p_legal_entity_id::text || '|' || (p_input->>'businessCode'),
    0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payment-term-semantics|' || p_tenant_id::text || '|' || p_legal_entity_id::text || '|' || v_fingerprint,
    0
  ));

  SELECT term.payment_term_id INTO v_existing_id
  FROM "payment_term_catalog"."payment_terms" AS term
  WHERE term.tenant_id = p_tenant_id
    AND term.legal_entity_id = p_legal_entity_id
    AND term.business_code = p_input->>'businessCode'
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'business_code_conflict', 'existingPaymentTermId', v_existing_id
    );
    RETURN;
  END IF;

  SELECT revision.payment_term_id INTO v_existing_id
  FROM "payment_term_catalog"."payment_term_revisions" AS revision
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.semantic_fingerprint = v_fingerprint
    AND revision.revision_number = 1
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      '_tag', 'duplicate_semantics', 'existingPaymentTermId', v_existing_id
    );
    RETURN;
  END IF;

  INSERT INTO "payment_term_catalog"."payment_terms" (
    payment_term_id, tenant_id, legal_entity_id, business_code, active_from,
    creation_reason, created_by_action_invocation_id, created_by_principal_id
  ) VALUES (
    v_payment_term_id, p_tenant_id, p_legal_entity_id, p_input->>'businessCode',
    (p_input->>'activeFrom')::timestamptz, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  INSERT INTO "payment_term_catalog"."payment_term_revisions" (
    tenant_id, legal_entity_id, payment_term_id, revision_number, change_kind,
    display_name, explanation, semantic_kind, net_days, due_date_anchor, calendar_rule,
    calculation_rule_version, compatibility_key, semantic_fingerprint, change_reason,
    action_invocation_id, acting_principal_id
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_payment_term_id, 1, 'CREATED',
    p_input->>'displayName', p_input->>'explanation', v_semantic_kind, v_net_days,
    CASE WHEN v_semantic_kind = 'NET_DAYS' THEN p_input->'semantics'->>'dueDateAnchor' ELSE NULL END,
    CASE WHEN v_semantic_kind = 'NET_DAYS' THEN p_input->'semantics'->>'calendarRule' ELSE 'NOT_APPLICABLE' END,
    (p_input->'semantics'->>'calculationRuleVersion')::integer, p_input->>'compatibilityKey', v_fingerprint, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  INSERT INTO "payment_term_catalog"."payment_term_lifecycle_events" (
    tenant_id, legal_entity_id, payment_term_id, event_kind, effective_at, reason,
    action_invocation_id, acting_principal_id
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_payment_term_id, 'ACTIVATED',
    (p_input->>'activeFrom')::timestamptz, p_input->>'reason',
    (p_input->>'actionInvocationId')::uuid, (p_input->>'actingPrincipalId')::uuid
  );
  RETURN QUERY SELECT jsonb_build_object(
    '_tag', 'created',
    'definition', "payment_term_catalog"."definition_json"(
      p_tenant_id, p_legal_entity_id, v_payment_term_id, NULL
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."create_term"(uuid, uuid, jsonb) TO "ontos_runtime";

--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_authorities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_term_catalog"."payment_term_source_statements" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "payment_term_catalog"."payment_term_source_authorities", "payment_term_catalog"."payment_term_source_statements" FROM PUBLIC, "ontos_runtime";
CREATE TRIGGER "payment_term_source_authorities_append_only" BEFORE UPDATE OR DELETE ON "payment_term_catalog"."payment_term_source_authorities" FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."reject_ledger_mutation"();
CREATE TRIGGER "payment_term_source_statements_append_only" BEFORE UPDATE OR DELETE ON "payment_term_catalog"."payment_term_source_statements" FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."configure_source_authority"(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_revision integer;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id, p_legal_entity_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('payment-term-authority',p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',p_input->>'namespace',p_input->>'integrationRoute')::text,0));
  SELECT coalesce(max(authority_revision),0) INTO v_revision FROM "payment_term_catalog"."payment_term_source_authorities"
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND external_business_system_id=p_input->>'externalBusinessSystemId' AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute';
  IF v_revision <> (p_input->>'expectedRevision')::bigint THEN
    RETURN QUERY SELECT jsonb_build_object('_tag','revision_conflict','actualRevision',v_revision); RETURN;
  END IF;
  INSERT INTO "payment_term_catalog"."payment_term_source_authorities"(tenant_id,legal_entity_id,external_business_system_id,namespace,integration_route,authority_revision,ingest_principal_id,reason,acting_principal_id,action_invocation_id)
    VALUES(p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',p_input->>'namespace',p_input->>'integrationRoute',v_revision+1,(p_input->>'ingestPrincipalId')::uuid,p_input->>'reason',(p_input->>'actingPrincipalId')::uuid,(p_input->>'actionInvocationId')::uuid);
  RETURN QUERY SELECT jsonb_build_object('_tag','configured','authorityRevision',v_revision+1);
END; $$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."accept_source_statement"(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  v_authority "payment_term_catalog"."payment_term_source_authorities"%ROWTYPE;
  v_previous "payment_term_catalog"."payment_term_source_statements"%ROWTYPE;
  v_content jsonb := p_input - 'actionInvocationId' - 'actingPrincipalId' - 'reason';
  v_result jsonb;
  v_reason text;
  v_latest bigint;
  v_definition jsonb;
  v_creation jsonb;
  v_compatibility text;
  v_received timestamptz := clock_timestamp();
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id,p_legal_entity_id);
  -- Authority updates and source decisions serialize; caller identity is injected by Core's owner service.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('payment-term-authority',p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',p_input->>'namespace',p_input->>'integrationRoute')::text,0));
  SELECT * INTO v_authority FROM "payment_term_catalog"."payment_term_source_authorities"
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND external_business_system_id=p_input->>'externalBusinessSystemId' AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute' ORDER BY authority_revision DESC LIMIT 1;
  IF NOT FOUND OR v_authority.ingest_principal_id IS DISTINCT FROM (p_input->>'actingPrincipalId')::uuid THEN
    RETURN QUERY SELECT jsonb_build_object('canonicalCreated',false,'changed',false,'result',jsonb_build_object('_tag','REJECTED','reason','UNAUTHORIZED_SOURCE','sourceStatementId',p_input->>'sourceStatementId','sourceRevision',(p_input->>'sourceRevision')::bigint)); RETURN;
  END IF;
  SELECT * INTO v_previous FROM "payment_term_catalog"."payment_term_source_statements"
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND external_business_system_id=p_input->>'externalBusinessSystemId' AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute' AND source_record_id=p_input->>'sourceRecordId' AND source_statement_id=p_input->>'sourceStatementId';
  IF FOUND THEN
    IF v_previous.content = v_content THEN
      RETURN QUERY SELECT jsonb_build_object('canonicalCreated',false,'changed',false,'result',v_previous.result);
    ELSE
      RETURN QUERY SELECT jsonb_build_object('canonicalCreated',false,'changed',false,'result',jsonb_build_object('_tag','REJECTED','reason','STATEMENT_CONFLICT','sourceStatementId',p_input->>'sourceStatementId','sourceRevision',(p_input->>'sourceRevision')::bigint));
    END IF;
    RETURN;
  END IF;
  SELECT max(source_revision) INTO v_latest FROM "payment_term_catalog"."payment_term_source_statements"
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND external_business_system_id=p_input->>'externalBusinessSystemId' AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute' AND source_record_id=p_input->>'sourceRecordId' AND outcome='ACCEPTED';
  IF (p_input->>'sourceRevision')::bigint < v_latest THEN v_reason := 'STALE_REVISION';
  ELSIF (p_input->>'sourceRevision')::bigint = v_latest THEN v_reason := 'AMBIGUOUS_MAPPING';
  ELSIF p_input->'semantics'->>'kind' = 'UNSUPPORTED' THEN v_reason := 'UNSUPPORTED_SEMANTICS';
  ELSIF p_input->'semantics'->>'calculationRuleVersion' IS DISTINCT FROM '2' THEN v_reason := 'UNSUPPORTED_SEMANTICS';
  ELSIF p_input->'mapping'->>'kind' = 'EXISTING' THEN
    -- Explicit mapping requires exact semantic equality and a currently usable canonical Ref.
    IF EXISTS (SELECT 1 FROM "payment_term_catalog"."payment_term_aliases" WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND alias_payment_term_id=(p_input->'mapping'->>'paymentTermId')::uuid) THEN
      v_reason := 'AMBIGUOUS_MAPPING';
    ELSE
      v_definition := "payment_term_catalog"."definition_json"(p_tenant_id,p_legal_entity_id,(p_input->'mapping'->>'paymentTermId')::uuid,NULL);
      IF v_definition IS NULL THEN v_reason := 'MISSING_REFERENCE';
      ELSIF v_definition->'semantics' <> p_input->'semantics' THEN v_reason := 'INCOMPATIBLE_REFERENCE';
      ELSIF (v_definition->'lifecycle'->>'effectiveFrom')::timestamptz > v_received OR ((v_definition->'lifecycle'->>'effectiveTo') IS NOT NULL AND (v_definition->'lifecycle'->>'effectiveTo')::timestamptz <= v_received) THEN v_reason := 'INACTIVE_REFERENCE';
      END IF;
    END IF;
  ELSIF p_input->'mapping'->>'kind' = 'CREATE' THEN
    v_compatibility := CASE WHEN p_input->'semantics'->>'kind'='IMMEDIATE' THEN 'immediate.v2' ELSE 'net_days.invoice_issue_date.calendar_days.v2' END;
    SELECT c.payload INTO v_creation FROM "payment_term_catalog"."create_term"(p_tenant_id,p_legal_entity_id,jsonb_build_object(
      'businessCode',p_input->'mapping'->>'code','displayName',p_input->'mapping'->>'name','explanation',p_input->'mapping'->>'description','activeFrom',p_input->'mapping'->>'activeFrom','semantics',p_input->'semantics','compatibilityKey',v_compatibility,'reason',p_input->>'reason','actingPrincipalId',p_input->>'actingPrincipalId','actionInvocationId',p_input->>'actionInvocationId')) c;
    IF v_creation->>'_tag'='business_code_conflict' THEN v_reason := 'BUSINESS_CODE_CONFLICT';
    ELSIF v_creation->>'_tag'='duplicate_semantics' THEN v_reason := 'DUPLICATE_SEMANTICS';
    ELSE v_definition := v_creation->'definition'; END IF;
  ELSE v_reason := 'AMBIGUOUS_MAPPING';
  END IF;
  IF v_reason IS NULL THEN
    v_result := jsonb_build_object('_tag','ACCEPTED','definition',v_definition,'sourceRevision',(p_input->>'sourceRevision')::bigint,'sourceStatementId',p_input->>'sourceStatementId','receivedAt',to_char(v_received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authorityRevision',v_authority.authority_revision);
  ELSE
    v_result := jsonb_build_object('_tag','REJECTED','reason',v_reason,'sourceRevision',(p_input->>'sourceRevision')::bigint,'sourceStatementId',p_input->>'sourceStatementId');
  END IF;
  INSERT INTO "payment_term_catalog"."payment_term_source_statements"(tenant_id,legal_entity_id,external_business_system_id,namespace,integration_route,source_record_id,source_statement_id,source_revision,source_code,business_observed_at,authority_revision,content,result,outcome,acting_principal_id,action_invocation_id,recorded_at)
    VALUES(p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',p_input->>'namespace',p_input->>'integrationRoute',p_input->>'sourceRecordId',p_input->>'sourceStatementId',(p_input->>'sourceRevision')::bigint,p_input->>'sourceCode',(p_input->>'businessObservedAt')::timestamptz,v_authority.authority_revision,v_content,v_result,v_result->>'_tag',(p_input->>'actingPrincipalId')::uuid,(p_input->>'actionInvocationId')::uuid,v_received);
  RETURN QUERY SELECT jsonb_build_object('canonicalCreated',coalesce(v_creation->>'_tag' = 'created',false),'changed',true,'result',v_result);
END; $$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."get_source_statement"(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id,p_legal_entity_id);
  RETURN QUERY SELECT (SELECT result FROM "payment_term_catalog"."payment_term_source_statements"
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND external_business_system_id=p_input->>'externalBusinessSystemId' AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute' AND source_record_id=p_input->>'sourceRecordId' AND source_statement_id=p_input->>'sourceStatementId');
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment_term_catalog"."configure_source_authority"(uuid,uuid,jsonb), "payment_term_catalog"."accept_source_statement"(uuid,uuid,jsonb), "payment_term_catalog"."get_source_statement"(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."configure_source_authority"(uuid,uuid,jsonb), "payment_term_catalog"."accept_source_statement"(uuid,uuid,jsonb), "payment_term_catalog"."get_source_statement"(uuid,uuid,jsonb) TO "ontos_runtime";
