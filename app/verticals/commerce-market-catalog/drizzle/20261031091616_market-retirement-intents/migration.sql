CREATE TABLE "commerce_market_catalog"."market_retirement_intents" (
	"market_retirement_intent_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"expected_revision" integer NOT NULL,
	"expected_definition_revision_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"stage" text NOT NULL,
	"failure_reason" text,
	"retirement_impact_assessment" jsonb,
	"reservation_request" jsonb,
	"transition_changed" boolean,
	"retired_revision" integer,
	"retired_definition_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_market_catalog_retirement_intents_scope_id_uk" UNIQUE("tenant_id","market_retirement_intent_id"),
	CONSTRAINT "commerce_market_catalog_retirement_intents_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "commerce_market_catalog_retirement_intents_stage_ck" CHECK ("stage" in ('REQUESTED', 'RESERVATION_REQUESTED', 'RESERVED', 'COMMIT_PENDING', 'RELEASE_PENDING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "commerce_market_catalog_retirement_intents_failure_ck" CHECK (("stage" in ('RELEASE_PENDING', 'FAILED')) = ("failure_reason" is not null) and ("failure_reason" is null or "failure_reason" in ('replacement_impact_unresolved', 'impact_assessment_stale', 'impact_assessment_rejected', 'impact_assessment_unavailable', 'revision_conflict', 'invalid_lifecycle_transition'))),
	CONSTRAINT "commerce_market_catalog_retirement_intents_reservation_ck" CHECK ("stage" in ('REQUESTED', 'FAILED') or "reservation_request" is not null),
	CONSTRAINT "commerce_market_catalog_retirement_intents_revision_ck" CHECK ("expected_revision" > 0 and ("retired_revision" is null or "retired_revision" > 0)),
	CONSTRAINT "commerce_market_catalog_retirement_intents_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_retirement_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_market_catalog_retirement_intents_open_market_uk" ON "commerce_market_catalog"."market_retirement_intents" ("tenant_id","market_id") WHERE "stage" not in ('COMPLETED', 'FAILED');--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_retirement_intents" ADD CONSTRAINT "commerce_market_catalog_retirement_intents_market_fk" FOREIGN KEY ("tenant_id","market_id") REFERENCES "commerce_market_catalog"."markets"("tenant_id","market_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_retirement_intents_tenant_select" ON "commerce_market_catalog"."market_retirement_intents" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."market_retirement_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_retirement_intents_tenant_insert" ON "commerce_market_catalog"."market_retirement_intents" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."market_retirement_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_retirement_intents_tenant_update" ON "commerce_market_catalog"."market_retirement_intents" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."market_retirement_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."market_retirement_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_retirement_intents_tenant_delete" ON "commerce_market_catalog"."market_retirement_intents" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."market_retirement_intents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_retirement_intents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "commerce_market_catalog"."market_retirement_intents" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "commerce_market_catalog"."market_retirement_intents" FROM "ontos_runtime";--> statement-breakpoint
create or replace function commerce_market_catalog.market_retirement_intent_payload(
  p_intent commerce_market_catalog.market_retirement_intents
)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'actingPrincipalId', p_intent.acting_principal_id,
    'actionInvocationId', p_intent.action_invocation_id,
    'effectiveAt', to_char(p_intent.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expectedDefinitionRevisionId', p_intent.expected_definition_revision_id,
    'expectedRevision', p_intent.expected_revision,
    'failureReason', p_intent.failure_reason,
    'intentId', p_intent.market_retirement_intent_id,
    'legalEntityId', p_intent.selling_legal_entity_id,
    'marketId', p_intent.market_id,
    'reason', p_intent.reason,
    'reservationRequest', p_intent.reservation_request,
    'retiredDefinitionRevisionId', p_intent.retired_definition_revision_id,
    'retiredRevision', p_intent.retired_revision,
    'retirementImpactAssessment', p_intent.retirement_impact_assessment,
    'stage', p_intent.stage,
    'tenantId', p_intent.tenant_id,
    'transitionChanged', p_intent.transition_changed
  ));
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.request_market_retirement(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_market commerce_market_catalog.markets%rowtype;
  v_current commerce_market_catalog.market_lifecycle_periods%rowtype;
  v_intent commerce_market_catalog.market_retirement_intents%rowtype;
  v_market_id uuid := (p_payload->>'marketId')::uuid;
  v_effective_at timestamptz := (p_payload->>'effectiveAt')::timestamptz;
  v_action_id uuid := (p_payload->>'actionInvocationId')::uuid;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  select * into v_market from commerce_market_catalog.markets
    where tenant_id = p_tenant_id and market_id = v_market_id for update;
  if not found then return query select jsonb_build_object('_tag', 'not_found'); return; end if;
  if v_market.selling_legal_entity_id is distinct from p_legal_entity_id then
    return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
  end if;
  select * into v_intent from commerce_market_catalog.market_retirement_intents
    where tenant_id = p_tenant_id and action_invocation_id = v_action_id;
  if found then
    if v_intent.market_id is distinct from v_market_id then
      return query select jsonb_build_object('_tag', 'cross_tenant_reference'); return;
    end if;
    return query select jsonb_build_object('_tag', 'requested',
      'intent', commerce_market_catalog.market_retirement_intent_payload(v_intent)); return;
  end if;
  if v_market.aggregate_revision is distinct from (p_payload->>'expectedRevision')::integer
     or v_market.current_definition_revision_id is distinct from (p_payload->>'expectedCurrentDefinitionRevisionId')::uuid then
    return query select jsonb_build_object('_tag', 'revision_conflict', 'actualRevision', v_market.aggregate_revision); return;
  end if;
  select * into strict v_current from commerce_market_catalog.market_lifecycle_periods
    where tenant_id = p_tenant_id and market_id = v_market_id order by revision_number desc limit 1;
  if v_current.lifecycle = 'RETIRED' then
    return query select jsonb_build_object('_tag', 'already_retired',
      'definitionRevisionId', v_market.current_definition_revision_id, 'revision', v_market.aggregate_revision); return;
  end if;
  if v_effective_at <= v_current.effective_from then
    return query select jsonb_build_object('_tag', 'invalid_lifecycle_transition'); return;
  end if;
  select * into v_intent from commerce_market_catalog.market_retirement_intents
    where tenant_id = p_tenant_id and market_id = v_market_id and stage not in ('COMPLETED', 'FAILED');
  if found then
    return query select jsonb_build_object('_tag', 'retirement_in_progress',
      'intentId', v_intent.market_retirement_intent_id); return;
  end if;
  insert into commerce_market_catalog.market_retirement_intents (
    market_retirement_intent_id, tenant_id, market_id, selling_legal_entity_id, expected_revision,
    expected_definition_revision_id, effective_at, reason, stage, action_invocation_id, acting_principal_id,
    requested_at, updated_at
  ) values (
    gen_random_uuid(), p_tenant_id, v_market_id, p_legal_entity_id, v_market.aggregate_revision,
    v_market.current_definition_revision_id, v_effective_at, p_payload->>'reason', 'REQUESTED', v_action_id,
    (p_payload->>'principalId')::uuid, (p_payload->>'recordedAt')::timestamptz, (p_payload->>'recordedAt')::timestamptz
  ) returning * into v_intent;
  return query select jsonb_build_object('_tag', 'requested',
    'intent', commerce_market_catalog.market_retirement_intent_payload(v_intent));
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.read_market_retirement_intent(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  return query
    select commerce_market_catalog.market_retirement_intent_payload(intent)
      from commerce_market_catalog.market_retirement_intents intent
     where intent.tenant_id = p_tenant_id
       and intent.selling_legal_entity_id = p_legal_entity_id
       and intent.market_retirement_intent_id = (p_payload->>'intentId')::uuid
       and (p_payload->>'marketId' is null or intent.market_id = (p_payload->>'marketId')::uuid);
end;
$$;
--> statement-breakpoint
create or replace function commerce_market_catalog.advance_market_retirement_intent(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_payload jsonb
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_intent commerce_market_catalog.market_retirement_intents%rowtype;
  v_operation text := p_payload->>'operation';
  v_recorded_at timestamptz := (p_payload->>'recordedAt')::timestamptz;
  v_transition jsonb;
  v_failure text;
begin
  perform commerce_market_catalog.assert_operation_scope(p_tenant_id, p_legal_entity_id);
  select * into v_intent from commerce_market_catalog.market_retirement_intents
    where tenant_id = p_tenant_id and selling_legal_entity_id = p_legal_entity_id
      and market_retirement_intent_id = (p_payload->>'intentId')::uuid
    for update;
  if not found then return query select jsonb_build_object('_tag', 'not_found'); return; end if;
  -- Compare-and-set: a stale or duplicate worker attempt observes the current stage and writes nothing.
  if v_intent.stage is distinct from p_payload->>'expectedStage' then
    return query select jsonb_build_object('_tag', 'unchanged',
      'intent', commerce_market_catalog.market_retirement_intent_payload(v_intent)); return;
  end if;
  if v_operation = 'RECORD_RESERVATION_REQUEST' and v_intent.stage = 'REQUESTED'
     and jsonb_typeof(p_payload->'retirementImpactAssessment') = 'object'
     and jsonb_typeof(p_payload->'reservationRequest') = 'object' then
    update commerce_market_catalog.market_retirement_intents
       set stage = 'RESERVATION_REQUESTED', retirement_impact_assessment = p_payload->'retirementImpactAssessment',
           reservation_request = p_payload->'reservationRequest', updated_at = v_recorded_at
     where market_retirement_intent_id = v_intent.market_retirement_intent_id
     returning * into v_intent;
  elsif v_operation = 'RECORD_RESERVATION' and v_intent.stage = 'RESERVATION_REQUESTED'
     and jsonb_typeof(p_payload#>'{retirementImpactAssessment,reservation}') = 'object'
     and (p_payload#>>'{retirementImpactAssessment,assessmentDigest}')
         is not distinct from (v_intent.retirement_impact_assessment->>'assessmentDigest') then
    update commerce_market_catalog.market_retirement_intents
       set stage = 'RESERVED', retirement_impact_assessment = p_payload->'retirementImpactAssessment',
           updated_at = v_recorded_at
     where market_retirement_intent_id = v_intent.market_retirement_intent_id
     returning * into v_intent;
  elsif v_operation = 'RECORD_RELEASE_REQUIRED' and v_intent.stage in ('RESERVATION_REQUESTED', 'RESERVED')
     and jsonb_typeof(p_payload#>'{retirementImpactAssessment,reservation}') = 'object' then
    update commerce_market_catalog.market_retirement_intents
       set stage = 'RELEASE_PENDING', failure_reason = p_payload->>'failureReason',
           retirement_impact_assessment = p_payload->'retirementImpactAssessment', updated_at = v_recorded_at
     where market_retirement_intent_id = v_intent.market_retirement_intent_id
     returning * into v_intent;
  elsif v_operation = 'TRANSITION' and v_intent.stage = 'RESERVED' then
    select transition.payload into strict v_transition
      from commerce_market_catalog.transition_market_lifecycle(p_tenant_id, p_legal_entity_id, jsonb_build_object(
        'actionInvocationId', v_intent.action_invocation_id,
        'effectiveAt', to_char(v_intent.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expectedCurrentDefinitionRevisionId', v_intent.expected_definition_revision_id,
        'expectedRevision', v_intent.expected_revision,
        'lifecycle', 'RETIRED',
        'marketId', v_intent.market_id,
        'principalId', v_intent.acting_principal_id,
        'reason', v_intent.reason,
        'recordedAt', p_payload->>'recordedAt',
        'retirementImpactAssessment', v_intent.retirement_impact_assessment
      )) transition;
    if v_transition->>'_tag' = 'transitioned' then
      update commerce_market_catalog.market_retirement_intents
         set stage = 'COMMIT_PENDING', transition_changed = (v_transition->>'changed')::boolean,
             retired_revision = (v_transition->>'revision')::integer,
             retired_definition_revision_id = (v_transition->>'definitionRevisionId')::uuid,
             updated_at = v_recorded_at
       where market_retirement_intent_id = v_intent.market_retirement_intent_id
       returning * into v_intent;
    else
      v_failure := case v_transition->>'_tag'
        when 'revision_conflict' then 'revision_conflict'
        when 'invalid_lifecycle_transition' then 'invalid_lifecycle_transition'
        when 'replacement_impact_unresolved' then 'replacement_impact_unresolved'
        else null end;
      if v_failure is null then
        raise exception using errcode = 'P0001', message = 'market retirement intent scope is inconsistent';
      end if;
      update commerce_market_catalog.market_retirement_intents
         set stage = 'RELEASE_PENDING', failure_reason = v_failure, updated_at = v_recorded_at
       where market_retirement_intent_id = v_intent.market_retirement_intent_id
       returning * into v_intent;
    end if;
  elsif v_operation = 'RECORD_COMPLETED' and v_intent.stage = 'COMMIT_PENDING' then
    update commerce_market_catalog.market_retirement_intents
       set stage = 'COMPLETED', updated_at = v_recorded_at
     where market_retirement_intent_id = v_intent.market_retirement_intent_id
     returning * into v_intent;
  elsif v_operation = 'RECORD_FAILED' and v_intent.stage in ('REQUESTED', 'RESERVATION_REQUESTED', 'RELEASE_PENDING')
     and coalesce(v_intent.failure_reason, p_payload->>'failureReason') is not null then
    update commerce_market_catalog.market_retirement_intents
       set stage = 'FAILED', failure_reason = coalesce(v_intent.failure_reason, p_payload->>'failureReason'),
           updated_at = v_recorded_at
     where market_retirement_intent_id = v_intent.market_retirement_intent_id
     returning * into v_intent;
  else
    return query select jsonb_build_object('_tag', 'invalid_transition',
      'intent', commerce_market_catalog.market_retirement_intent_payload(v_intent)); return;
  end if;
  return query select jsonb_build_object('_tag', 'advanced',
    'intent', commerce_market_catalog.market_retirement_intent_payload(v_intent));
end;
$$;
--> statement-breakpoint
revoke all on function commerce_market_catalog.market_retirement_intent_payload(commerce_market_catalog.market_retirement_intents) from public;
--> statement-breakpoint
revoke all on function commerce_market_catalog.request_market_retirement(uuid, uuid, jsonb) from public;
--> statement-breakpoint
revoke all on function commerce_market_catalog.read_market_retirement_intent(uuid, uuid, jsonb) from public;
--> statement-breakpoint
revoke all on function commerce_market_catalog.advance_market_retirement_intent(uuid, uuid, jsonb) from public;
--> statement-breakpoint
grant execute on function commerce_market_catalog.request_market_retirement(uuid, uuid, jsonb) to ontos_runtime;
--> statement-breakpoint
grant execute on function commerce_market_catalog.read_market_retirement_intent(uuid, uuid, jsonb) to ontos_runtime;
--> statement-breakpoint
grant execute on function commerce_market_catalog.advance_market_retirement_intent(uuid, uuid, jsonb) to ontos_runtime;
