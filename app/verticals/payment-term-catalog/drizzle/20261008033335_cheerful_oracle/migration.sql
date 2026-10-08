CREATE TABLE "payment_term_catalog"."payment_term_source_acceptance_lineage" (
	"source_acceptance_lineage_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"accepted_statement_ledger_id" uuid NOT NULL CONSTRAINT "payment_term_catalog_source_acceptance_lineage_accepted_uk" UNIQUE,
	"predecessor_statement_ledger_id" uuid CONSTRAINT "payment_term_catalog_source_acceptance_lineage_predecessor_uk" UNIQUE,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_source_acceptance_lineage_not_self_ck" CHECK ("predecessor_statement_ledger_id" is null or "predecessor_statement_ledger_id" <> "accepted_statement_ledger_id")
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_acceptance_lineage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_term_catalog"."payment_term_source_record_states" (
	"source_record_state_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"external_business_system_id" text NOT NULL,
	"namespace" text NOT NULL,
	"integration_route" text NOT NULL,
	"source_record_id" text NOT NULL,
	"highest_observed_revision" bigint NOT NULL,
	"highest_observed_statement_ledger_id" uuid NOT NULL,
	"current_accepted_statement_ledger_id" uuid,
	"current_payment_term_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_term_catalog_source_record_states_identity_uk" UNIQUE("tenant_id","legal_entity_id","external_business_system_id","namespace","integration_route","source_record_id"),
	CONSTRAINT "payment_term_catalog_source_record_states_revision_ck" CHECK ("highest_observed_revision" between 0 and 9007199254740991),
	CONSTRAINT "payment_term_catalog_source_record_states_mapping_ck" CHECK (("current_accepted_statement_ledger_id" is null) = ("current_payment_term_id" is null))
);
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_record_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_acceptance_lineage" ADD CONSTRAINT "payment_term_catalog_source_acceptance_lineage_accepted_fk" FOREIGN KEY ("accepted_statement_ledger_id") REFERENCES "payment_term_catalog"."payment_term_source_statements"("source_statement_ledger_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_acceptance_lineage" ADD CONSTRAINT "payment_term_catalog_source_acceptance_lineage_predecessor_fk" FOREIGN KEY ("predecessor_statement_ledger_id") REFERENCES "payment_term_catalog"."payment_term_source_statements"("source_statement_ledger_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_record_states" ADD CONSTRAINT "payment_term_catalog_source_record_states_highest_fk" FOREIGN KEY ("highest_observed_statement_ledger_id") REFERENCES "payment_term_catalog"."payment_term_source_statements"("source_statement_ledger_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_record_states" ADD CONSTRAINT "payment_term_catalog_source_record_states_accepted_fk" FOREIGN KEY ("current_accepted_statement_ledger_id") REFERENCES "payment_term_catalog"."payment_term_source_statements"("source_statement_ledger_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_record_states" ADD CONSTRAINT "payment_term_catalog_source_record_states_term_fk" FOREIGN KEY ("tenant_id","legal_entity_id","current_payment_term_id") REFERENCES "payment_term_catalog"."payment_terms"("tenant_id","legal_entity_id","payment_term_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_acceptance_lineage_scope_select" ON "payment_term_catalog"."payment_term_source_acceptance_lineage" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_acceptance_lineage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_acceptance_lineage"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_acceptance_lineage_scope_insert" ON "payment_term_catalog"."payment_term_source_acceptance_lineage" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_term_source_acceptance_lineage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_acceptance_lineage"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_acceptance_lineage_scope_update" ON "payment_term_catalog"."payment_term_source_acceptance_lineage" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_acceptance_lineage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_acceptance_lineage"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_term_source_acceptance_lineage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_acceptance_lineage"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_acceptance_lineage_scope_delete" ON "payment_term_catalog"."payment_term_source_acceptance_lineage" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_acceptance_lineage"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_acceptance_lineage"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_record_states_scope_select" ON "payment_term_catalog"."payment_term_source_record_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_record_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_record_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_record_states_scope_insert" ON "payment_term_catalog"."payment_term_source_record_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment_term_catalog"."payment_term_source_record_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_record_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_record_states_scope_update" ON "payment_term_catalog"."payment_term_source_record_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_record_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_record_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment_term_catalog"."payment_term_source_record_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_record_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_term_catalog_source_record_states_scope_delete" ON "payment_term_catalog"."payment_term_source_record_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment_term_catalog"."payment_term_source_record_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment_term_catalog"."payment_term_source_record_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
INSERT INTO "payment_term_catalog"."payment_term_source_acceptance_lineage"(
  tenant_id, legal_entity_id, accepted_statement_ledger_id, predecessor_statement_ledger_id, recorded_at
)
SELECT tenant_id, legal_entity_id, source_statement_ledger_id,
  lag(source_statement_ledger_id) OVER (
    PARTITION BY tenant_id, legal_entity_id, external_business_system_id, namespace, integration_route, source_record_id
    ORDER BY source_revision, recorded_at, source_statement_ledger_id
  ), recorded_at
FROM "payment_term_catalog"."payment_term_source_statements"
WHERE outcome='ACCEPTED';
--> statement-breakpoint
WITH ranked AS (
  SELECT statement.*,
    row_number() OVER (
      PARTITION BY tenant_id, legal_entity_id, external_business_system_id, namespace, integration_route, source_record_id
      ORDER BY source_revision DESC, recorded_at DESC, source_statement_ledger_id DESC
    ) AS observed_rank,
    row_number() OVER (
      PARTITION BY tenant_id, legal_entity_id, external_business_system_id, namespace, integration_route, source_record_id, outcome
      ORDER BY source_revision DESC, recorded_at DESC, source_statement_ledger_id DESC
    ) AS outcome_rank
  FROM "payment_term_catalog"."payment_term_source_statements" statement
), records AS (
  SELECT highest.tenant_id, highest.legal_entity_id, highest.external_business_system_id, highest.namespace,
    highest.integration_route, highest.source_record_id, highest.source_revision,
    highest.source_statement_ledger_id AS highest_ledger_id,
    accepted.source_statement_ledger_id AS accepted_ledger_id,
    nullif(accepted.result->'definition'->'paymentTermRef'->>'resourceId','')::uuid AS payment_term_id,
    greatest(highest.recorded_at, coalesce(accepted.recorded_at, highest.recorded_at)) AS updated_at
  FROM ranked highest
  LEFT JOIN ranked accepted
    ON accepted.tenant_id=highest.tenant_id AND accepted.legal_entity_id=highest.legal_entity_id
    AND accepted.external_business_system_id=highest.external_business_system_id
    AND accepted.namespace=highest.namespace AND accepted.integration_route=highest.integration_route
    AND accepted.source_record_id=highest.source_record_id AND accepted.outcome='ACCEPTED' AND accepted.outcome_rank=1
  WHERE highest.observed_rank=1
)
INSERT INTO "payment_term_catalog"."payment_term_source_record_states"(
  tenant_id, legal_entity_id, external_business_system_id, namespace, integration_route, source_record_id,
  highest_observed_revision, highest_observed_statement_ledger_id,
  current_accepted_statement_ledger_id, current_payment_term_id, updated_at
)
SELECT tenant_id, legal_entity_id, external_business_system_id, namespace, integration_route, source_record_id,
  source_revision, highest_ledger_id, accepted_ledger_id, payment_term_id, updated_at
FROM records;
--> statement-breakpoint
ALTER TABLE "payment_term_catalog"."payment_term_source_acceptance_lineage" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_term_catalog"."payment_term_source_record_states" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "payment_term_catalog"."payment_term_source_acceptance_lineage", "payment_term_catalog"."payment_term_source_record_states" FROM PUBLIC, "ontos_runtime";
CREATE TRIGGER "payment_term_source_acceptance_lineage_append_only" BEFORE UPDATE OR DELETE ON "payment_term_catalog"."payment_term_source_acceptance_lineage" FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."reject_ledger_mutation"();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payment_term_catalog"."payment_term_revisions" revision
    JOIN "payment_term_catalog"."payment_term_revisions" first_revision
      ON first_revision.tenant_id=revision.tenant_id
      AND first_revision.legal_entity_id=revision.legal_entity_id
      AND first_revision.payment_term_id=revision.payment_term_id
      AND first_revision.revision_number=1
    WHERE revision.revision_number>1
      AND (
        revision.semantic_kind IS DISTINCT FROM first_revision.semantic_kind
        OR revision.net_days IS DISTINCT FROM first_revision.net_days
        OR revision.due_date_anchor IS DISTINCT FROM first_revision.due_date_anchor
        OR revision.calendar_rule IS DISTINCT FROM first_revision.calendar_rule
        OR revision.calculation_rule_version IS DISTINCT FROM first_revision.calculation_rule_version
        OR revision.compatibility_key IS DISTINCT FROM first_revision.compatibility_key
        OR revision.semantic_fingerprint IS DISTINCT FROM first_revision.semantic_fingerprint
        OR revision.semantic_revision_id IS DISTINCT FROM first_revision.semantic_revision_id
      )
  ) THEN
    RAISE EXCEPTION 'existing Payment Term definition revisions violate semantic immutability' USING ERRCODE='23514';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."enforce_revision_semantic_immutability"()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_first "payment_term_catalog"."payment_term_revisions"%ROWTYPE;
BEGIN
  IF NEW.revision_number=1 THEN RETURN NEW; END IF;
  SELECT * INTO STRICT v_first
  FROM "payment_term_catalog"."payment_term_revisions"
  WHERE tenant_id=NEW.tenant_id AND legal_entity_id=NEW.legal_entity_id
    AND payment_term_id=NEW.payment_term_id AND revision_number=1;
  IF NEW.semantic_kind IS DISTINCT FROM v_first.semantic_kind
    OR NEW.net_days IS DISTINCT FROM v_first.net_days
    OR NEW.due_date_anchor IS DISTINCT FROM v_first.due_date_anchor
    OR NEW.calendar_rule IS DISTINCT FROM v_first.calendar_rule
    OR NEW.calculation_rule_version IS DISTINCT FROM v_first.calculation_rule_version
    OR NEW.compatibility_key IS DISTINCT FROM v_first.compatibility_key
    OR NEW.semantic_fingerprint IS DISTINCT FROM v_first.semantic_fingerprint
    OR NEW.semantic_revision_id IS DISTINCT FROM v_first.semantic_revision_id
  THEN
    RAISE EXCEPTION 'Payment Term definition revisions may change metadata only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "payment_term_revisions_semantic_immutability" BEFORE INSERT ON "payment_term_catalog"."payment_term_revisions" FOR EACH ROW EXECUTE FUNCTION "payment_term_catalog"."enforce_revision_semantic_immutability"();
REVOKE ALL ON FUNCTION "payment_term_catalog"."enforce_revision_semantic_immutability"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payment_term_catalog"."accept_source_statement"(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  v_authority "payment_term_catalog"."payment_term_source_authorities"%ROWTYPE;
  v_previous "payment_term_catalog"."payment_term_source_statements"%ROWTYPE;
  v_state "payment_term_catalog"."payment_term_source_record_states"%ROWTYPE;
  v_content jsonb := p_input - 'actionInvocationId' - 'actingPrincipalId' - 'reason';
  v_result jsonb;
  v_reason text;
  v_definition jsonb;
  v_creation jsonb;
  v_compatibility text;
  v_received timestamptz := clock_timestamp();
  v_statement_ledger_id uuid;
  v_payment_term_id uuid;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id,p_legal_entity_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'payment-term-source-record',p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',
    p_input->>'namespace',p_input->>'integrationRoute',p_input->>'sourceRecordId'
  )::text,0));

  SELECT * INTO v_previous FROM "payment_term_catalog"."payment_term_source_statements"
  WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
    AND external_business_system_id=p_input->>'externalBusinessSystemId'
    AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute'
    AND source_record_id=p_input->>'sourceRecordId' AND source_statement_id=p_input->>'sourceStatementId';
  IF FOUND THEN
    IF v_previous.content=v_content THEN
      RETURN QUERY SELECT jsonb_build_object('canonicalCreated',false,'changed',false,'result',v_previous.result);
    ELSE
      RETURN QUERY SELECT jsonb_build_object('canonicalCreated',false,'changed',false,'result',jsonb_build_object(
        '_tag','REJECTED','reason','STATEMENT_CONFLICT','sourceStatementId',p_input->>'sourceStatementId',
        'sourceRevision',(p_input->>'sourceRevision')::bigint));
    END IF;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'payment-term-authority',p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',
    p_input->>'namespace',p_input->>'integrationRoute'
  )::text,0));
  SELECT * INTO v_authority FROM "payment_term_catalog"."payment_term_source_authorities"
  WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
    AND external_business_system_id=p_input->>'externalBusinessSystemId'
    AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute'
  ORDER BY authority_revision DESC LIMIT 1;
  IF NOT FOUND OR v_authority.ingest_principal_id IS DISTINCT FROM (p_input->>'actingPrincipalId')::uuid THEN
    RETURN QUERY SELECT jsonb_build_object('canonicalCreated',false,'changed',false,'result',jsonb_build_object(
      '_tag','REJECTED','reason','UNAUTHORIZED_SOURCE','sourceStatementId',p_input->>'sourceStatementId',
      'sourceRevision',(p_input->>'sourceRevision')::bigint));
    RETURN;
  END IF;

  SELECT * INTO v_state FROM "payment_term_catalog"."payment_term_source_record_states"
  WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
    AND external_business_system_id=p_input->>'externalBusinessSystemId'
    AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute'
    AND source_record_id=p_input->>'sourceRecordId' FOR UPDATE;

  IF FOUND AND (p_input->>'sourceRevision')::bigint < v_state.highest_observed_revision THEN v_reason:='STALE_REVISION';
  ELSIF FOUND AND (p_input->>'sourceRevision')::bigint = v_state.highest_observed_revision THEN v_reason:='AMBIGUOUS_MAPPING';
  ELSIF p_input->'semantics'->>'kind'='UNSUPPORTED' THEN v_reason:='UNSUPPORTED_SEMANTICS';
  ELSIF p_input->'semantics'->>'calculationRuleVersion' IS DISTINCT FROM '2' THEN v_reason:='UNSUPPORTED_SEMANTICS';
  ELSIF p_input->'mapping'->>'kind'='EXISTING' THEN
    IF EXISTS (SELECT 1 FROM "payment_term_catalog"."payment_term_aliases" WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND alias_payment_term_id=(p_input->'mapping'->>'paymentTermId')::uuid) THEN
      v_reason:='AMBIGUOUS_MAPPING';
    ELSE
      v_definition:="payment_term_catalog"."definition_json"(p_tenant_id,p_legal_entity_id,(p_input->'mapping'->>'paymentTermId')::uuid,NULL);
      IF v_definition IS NULL THEN v_reason:='MISSING_REFERENCE';
      ELSIF v_definition->'semantics'<>p_input->'semantics' THEN v_reason:='INCOMPATIBLE_REFERENCE';
      ELSIF (v_definition->'lifecycle'->>'effectiveFrom')::timestamptz>v_received
        OR ((v_definition->'lifecycle'->>'effectiveTo') IS NOT NULL AND (v_definition->'lifecycle'->>'effectiveTo')::timestamptz<=v_received)
      THEN v_reason:='INACTIVE_REFERENCE'; END IF;
    END IF;
  ELSIF p_input->'mapping'->>'kind'='CREATE' THEN
    v_compatibility:=CASE WHEN p_input->'semantics'->>'kind'='IMMEDIATE' THEN 'immediate.v2' ELSE 'net_days.invoice_issue_date.calendar_days.v2' END;
    SELECT c.payload INTO v_creation FROM "payment_term_catalog"."create_term"(p_tenant_id,p_legal_entity_id,jsonb_build_object(
      'businessCode',p_input->'mapping'->>'code','displayName',p_input->'mapping'->>'name',
      'explanation',p_input->'mapping'->>'description','activeFrom',p_input->'mapping'->>'activeFrom',
      'semantics',p_input->'semantics','compatibilityKey',v_compatibility,'reason',p_input->>'reason',
      'actingPrincipalId',p_input->>'actingPrincipalId','actionInvocationId',p_input->>'actionInvocationId')) c;
    IF v_creation->>'_tag'='business_code_conflict' THEN v_reason:='BUSINESS_CODE_CONFLICT';
    ELSIF v_creation->>'_tag'='duplicate_semantics' THEN v_reason:='DUPLICATE_SEMANTICS';
    ELSE v_definition:=v_creation->'definition'; END IF;
  ELSE v_reason:='AMBIGUOUS_MAPPING'; END IF;

  IF v_reason IS NULL THEN
    v_result:=jsonb_build_object('_tag','ACCEPTED','definition',v_definition,
      'sourceRevision',(p_input->>'sourceRevision')::bigint,'sourceStatementId',p_input->>'sourceStatementId',
      'receivedAt',to_char(v_received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'authorityRevision',v_authority.authority_revision);
    v_payment_term_id:=(v_definition->'paymentTermRef'->>'resourceId')::uuid;
  ELSE
    v_result:=jsonb_build_object('_tag','REJECTED','reason',v_reason,
      'sourceRevision',(p_input->>'sourceRevision')::bigint,'sourceStatementId',p_input->>'sourceStatementId');
  END IF;

  INSERT INTO "payment_term_catalog"."payment_term_source_statements"(
    tenant_id,legal_entity_id,external_business_system_id,namespace,integration_route,source_record_id,
    source_statement_id,source_revision,source_code,business_observed_at,authority_revision,content,result,
    outcome,acting_principal_id,action_invocation_id,recorded_at
  ) VALUES(
    p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',p_input->>'namespace',p_input->>'integrationRoute',
    p_input->>'sourceRecordId',p_input->>'sourceStatementId',(p_input->>'sourceRevision')::bigint,p_input->>'sourceCode',
    (p_input->>'businessObservedAt')::timestamptz,v_authority.authority_revision,v_content,v_result,v_result->>'_tag',
    (p_input->>'actingPrincipalId')::uuid,(p_input->>'actionInvocationId')::uuid,v_received
  ) RETURNING source_statement_ledger_id INTO v_statement_ledger_id;

  IF v_result->>'_tag'='ACCEPTED' THEN
    INSERT INTO "payment_term_catalog"."payment_term_source_acceptance_lineage"(
      tenant_id,legal_entity_id,accepted_statement_ledger_id,predecessor_statement_ledger_id,recorded_at
    ) VALUES(p_tenant_id,p_legal_entity_id,v_statement_ledger_id,v_state.current_accepted_statement_ledger_id,v_received);
  END IF;

  IF v_state.source_record_state_id IS NULL THEN
    INSERT INTO "payment_term_catalog"."payment_term_source_record_states"(
      tenant_id,legal_entity_id,external_business_system_id,namespace,integration_route,source_record_id,
      highest_observed_revision,highest_observed_statement_ledger_id,current_accepted_statement_ledger_id,
      current_payment_term_id,updated_at
    ) VALUES(
      p_tenant_id,p_legal_entity_id,p_input->>'externalBusinessSystemId',p_input->>'namespace',p_input->>'integrationRoute',
      p_input->>'sourceRecordId',(p_input->>'sourceRevision')::bigint,v_statement_ledger_id,
      CASE WHEN v_result->>'_tag'='ACCEPTED' THEN v_statement_ledger_id END,
      CASE WHEN v_result->>'_tag'='ACCEPTED' THEN v_payment_term_id END,v_received
    );
  ELSIF (p_input->>'sourceRevision')::bigint>v_state.highest_observed_revision THEN
    UPDATE "payment_term_catalog"."payment_term_source_record_states" SET
      highest_observed_revision=(p_input->>'sourceRevision')::bigint,
      highest_observed_statement_ledger_id=v_statement_ledger_id,
      current_accepted_statement_ledger_id=CASE WHEN v_result->>'_tag'='ACCEPTED' THEN v_statement_ledger_id ELSE current_accepted_statement_ledger_id END,
      current_payment_term_id=CASE WHEN v_result->>'_tag'='ACCEPTED' THEN v_payment_term_id ELSE current_payment_term_id END,
      updated_at=v_received
    WHERE source_record_state_id=v_state.source_record_state_id;
  END IF;

  RETURN QUERY SELECT jsonb_build_object('canonicalCreated',coalesce(v_creation->>'_tag'='created',false),'changed',true,'result',v_result);
END; $$;
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."source_decision_json"(p_source_statement_ledger_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT jsonb_build_object(
    'authorityRevision', statement.authority_revision,
    'businessObservedAt', to_char(statement.business_observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'recordedAt', to_char(statement.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'result', statement.result,
    'sourceCode', statement.source_code,
    'sourceRevision', statement.source_revision,
    'sourceStatementId', statement.source_statement_id,
    'supersededBySourceStatementId', successor.source_statement_id,
    'supersedesSourceStatementId', predecessor.source_statement_id
  )
  FROM "payment_term_catalog"."payment_term_source_statements" statement
  LEFT JOIN "payment_term_catalog"."payment_term_source_acceptance_lineage" lineage
    ON lineage.accepted_statement_ledger_id=statement.source_statement_ledger_id
  LEFT JOIN "payment_term_catalog"."payment_term_source_statements" predecessor
    ON predecessor.source_statement_ledger_id=lineage.predecessor_statement_ledger_id
  LEFT JOIN "payment_term_catalog"."payment_term_source_acceptance_lineage" successor_lineage
    ON successor_lineage.predecessor_statement_ledger_id=statement.source_statement_ledger_id
  LEFT JOIN "payment_term_catalog"."payment_term_source_statements" successor
    ON successor.source_statement_ledger_id=successor_lineage.accepted_statement_ledger_id
  WHERE statement.source_statement_ledger_id=p_source_statement_ledger_id
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

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payment-term-code|' || p_tenant_id::text || '|' || p_legal_entity_id::text || '|' || (p_input->>'businessCode'), 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payment-term-semantics|' || p_tenant_id::text || '|' || p_legal_entity_id::text || '|' || v_fingerprint, 0
  ));

  SELECT term.payment_term_id INTO v_existing_id
  FROM "payment_term_catalog"."payment_terms" term
  WHERE term.tenant_id=p_tenant_id AND term.legal_entity_id=p_legal_entity_id
    AND term.business_code=p_input->>'businessCode'
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag','business_code_conflict','existingPaymentTermId',v_existing_id);
    RETURN;
  END IF;

  SELECT revision.payment_term_id INTO v_existing_id
  FROM "payment_term_catalog"."payment_term_revisions" revision
  WHERE revision.tenant_id=p_tenant_id AND revision.legal_entity_id=p_legal_entity_id
    AND revision.semantic_fingerprint=v_fingerprint
  ORDER BY revision.recorded_at,revision.revision_number
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('_tag','duplicate_semantics','existingPaymentTermId',v_existing_id);
    RETURN;
  END IF;

  INSERT INTO "payment_term_catalog"."payment_terms"(
    payment_term_id,tenant_id,legal_entity_id,business_code,active_from,creation_reason,
    created_by_action_invocation_id,created_by_principal_id
  ) VALUES(
    v_payment_term_id,p_tenant_id,p_legal_entity_id,p_input->>'businessCode',(p_input->>'activeFrom')::timestamptz,
    p_input->>'reason',(p_input->>'actionInvocationId')::uuid,(p_input->>'actingPrincipalId')::uuid
  );
  INSERT INTO "payment_term_catalog"."payment_term_revisions"(
    tenant_id,legal_entity_id,payment_term_id,revision_number,change_kind,display_name,explanation,
    semantic_kind,net_days,due_date_anchor,calendar_rule,calculation_rule_version,compatibility_key,
    semantic_fingerprint,change_reason,action_invocation_id,acting_principal_id
  ) VALUES(
    p_tenant_id,p_legal_entity_id,v_payment_term_id,1,'CREATED',p_input->>'displayName',p_input->>'explanation',
    v_semantic_kind,v_net_days,
    CASE WHEN v_semantic_kind='NET_DAYS' THEN p_input->'semantics'->>'dueDateAnchor' ELSE NULL END,
    CASE WHEN v_semantic_kind='NET_DAYS' THEN p_input->'semantics'->>'calendarRule' ELSE 'NOT_APPLICABLE' END,
    (p_input->'semantics'->>'calculationRuleVersion')::integer,p_input->>'compatibilityKey',v_fingerprint,
    p_input->>'reason',(p_input->>'actionInvocationId')::uuid,(p_input->>'actingPrincipalId')::uuid
  );
  INSERT INTO "payment_term_catalog"."payment_term_lifecycle_events"(
    tenant_id,legal_entity_id,payment_term_id,event_kind,effective_at,reason,action_invocation_id,acting_principal_id
  ) VALUES(
    p_tenant_id,p_legal_entity_id,v_payment_term_id,'ACTIVATED',(p_input->>'activeFrom')::timestamptz,
    p_input->>'reason',(p_input->>'actionInvocationId')::uuid,(p_input->>'actingPrincipalId')::uuid
  );
  RETURN QUERY SELECT jsonb_build_object('_tag','created','definition',
    "payment_term_catalog"."definition_json"(p_tenant_id,p_legal_entity_id,v_payment_term_id,NULL));
END;
$$;
REVOKE ALL ON FUNCTION "payment_term_catalog"."source_decision_json"(uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "payment_term_catalog"."get_source_record_history"(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  v_state "payment_term_catalog"."payment_term_source_record_states"%ROWTYPE;
  v_limit integer:=least(coalesce((p_input->>'limit')::integer,100),200);
  v_decisions jsonb;
  v_truncated boolean;
  v_current jsonb;
BEGIN
  PERFORM "payment_term_catalog"."assert_operation_scope"(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_state FROM "payment_term_catalog"."payment_term_source_record_states"
  WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
    AND external_business_system_id=p_input->>'externalBusinessSystemId'
    AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute'
    AND source_record_id=p_input->>'sourceRecordId';
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb; RETURN; END IF;

  SELECT coalesce(jsonb_agg("payment_term_catalog"."source_decision_json"(selected.source_statement_ledger_id)
      ORDER BY selected.source_revision DESC, selected.recorded_at DESC, selected.source_statement_ledger_id DESC),'[]'::jsonb)
  INTO v_decisions
  FROM (
    SELECT source_statement_ledger_id,source_revision,recorded_at
    FROM "payment_term_catalog"."payment_term_source_statements"
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
      AND external_business_system_id=p_input->>'externalBusinessSystemId'
      AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute'
      AND source_record_id=p_input->>'sourceRecordId'
    ORDER BY source_revision DESC,recorded_at DESC,source_statement_ledger_id DESC
    LIMIT v_limit
  ) selected;
  SELECT EXISTS(
    SELECT 1 FROM "payment_term_catalog"."payment_term_source_statements"
    WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
      AND external_business_system_id=p_input->>'externalBusinessSystemId'
      AND namespace=p_input->>'namespace' AND integration_route=p_input->>'integrationRoute'
      AND source_record_id=p_input->>'sourceRecordId'
    OFFSET v_limit
  ) INTO v_truncated;
  IF v_state.current_accepted_statement_ledger_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'paymentTermRef',statement.result->'definition'->'paymentTermRef',
      'sourceRevision',statement.source_revision,
      'sourceStatementId',statement.source_statement_id
    ) INTO v_current
    FROM "payment_term_catalog"."payment_term_source_statements" statement
    WHERE statement.source_statement_ledger_id=v_state.current_accepted_statement_ledger_id;
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'currentAccepted',v_current,
    'decisions',v_decisions,
    'highestObserved',"payment_term_catalog"."source_decision_json"(v_state.highest_observed_statement_ledger_id),
    'sourceRecord',jsonb_build_object(
      'externalBusinessSystemId',v_state.external_business_system_id,
      'integrationRoute',v_state.integration_route,
      'namespace',v_state.namespace,
      'sourceRecordId',v_state.source_record_id
    ),
    'truncated',v_truncated
  );
END $$;
REVOKE ALL ON FUNCTION "payment_term_catalog"."get_source_record_history"(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "payment_term_catalog"."get_source_record_history"(uuid,uuid,jsonb) TO "ontos_runtime";
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
      'effectiveTo', CASE
        WHEN p_revision_number IS NOT NULL OR term.retired_effective_at IS NULL THEN NULL
        ELSE to_char(term.retired_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END,
      'state', CASE WHEN p_revision_number IS NULL THEN term.lifecycle_state ELSE 'ACTIVE' END
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
      WHEN p_revision_number IS NOT NULL OR term.retired_effective_at IS NULL THEN NULL
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
