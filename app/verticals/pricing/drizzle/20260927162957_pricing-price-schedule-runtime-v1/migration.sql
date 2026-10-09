-- Custom SQL migration file, put your code below! --
-- #756 deploy/runtime migration. The #755 compatibility relation remains in place during
-- expand/deploy/contract and is maintained as a read-only projection of schedule authority.
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

DO $block$
DECLARE
  v_pgcrypto_schema text;
BEGIN
  SELECT namespace.nspname
    INTO v_pgcrypto_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'pgcrypto';
  IF v_pgcrypto_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Pricing requires pgcrypto in the trusted public schema' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pricing_schedule_projection_writer') THEN
    CREATE ROLE pricing_schedule_projection_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  ALTER ROLE pricing_schedule_projection_writer
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END;
$block$;

-- The guarded backfill must work for an ordinary migration owner without BYPASSRLS.
-- RLS is restored and forced on every relation before this migration completes.
ALTER TABLE pricing.price_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_acknowledgements NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_acknowledgements DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_entries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_heads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_heads DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_revisions DISABLE ROW LEVEL SECURITY;

ALTER TABLE pricing.price_schedule_entries
  ADD CONSTRAINT pricing_price_schedule_entries_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    legal_entity_id WITH =,
    price_id WITH =,
    price_schedule_revision_id WITH =,
    pg_catalog.tstzrange(effective_from, effective_to, '[)') WITH &&
  );

-- Backfill is deliberately performed with RLS disabled in the same transaction. The migration
-- fails unless every #755 compatibility row produces exactly one revision, entry, and head.
ALTER TABLE pricing.price_current_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_current_revisions DISABLE ROW LEVEL SECURITY;

DO $backfill$
DECLARE
  v_source_count bigint;
  v_revision_count bigint;
  v_entry_count bigint;
  v_head_count bigint;
BEGIN
  SELECT count(*) INTO v_source_count FROM pricing.price_current_revisions;

  CREATE TEMPORARY TABLE price_schedule_backfill_mapping ON COMMIT DROP AS
  SELECT current_revision.tenant_id,
         current_revision.legal_entity_id,
         current_revision.price_id,
         current_revision.price_revision_id,
         current_revision.revision_number,
         current_revision.effective_from,
         current_revision.bound_by_action_invocation_id,
         pg_catalog.gen_random_uuid() AS price_schedule_revision_id
    FROM pricing.price_current_revisions AS current_revision;

  IF (SELECT count(*) FROM price_schedule_backfill_mapping) <> v_source_count THEN
    RAISE EXCEPTION 'Pricing schedule backfill source cardinality changed' USING ERRCODE = '55000';
  END IF;

  INSERT INTO pricing.price_schedule_revisions (
    price_schedule_revision_id, tenant_id, legal_entity_id, price_id, schedule_revision,
    previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason, recorded_at
  )
  SELECT mapping.price_schedule_revision_id, mapping.tenant_id, mapping.legal_entity_id,
         mapping.price_id, 1, NULL, mapping.bound_by_action_invocation_id,
         revision.acting_principal_id, 'Backfilled from the #755 Current compatibility binding.',
         revision.recorded_at
    FROM price_schedule_backfill_mapping AS mapping
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = mapping.tenant_id
     AND revision.legal_entity_id = mapping.legal_entity_id
     AND revision.price_id = mapping.price_id
     AND revision.price_revision_id = mapping.price_revision_id;
  GET DIAGNOSTICS v_revision_count = ROW_COUNT;

  INSERT INTO pricing.price_schedule_entries (
    tenant_id, legal_entity_id, price_id, price_revision_id, price_schedule_revision_id,
    schedule_revision, effective_from, effective_to
  )
  SELECT mapping.tenant_id, mapping.legal_entity_id, mapping.price_id,
         mapping.price_revision_id, mapping.price_schedule_revision_id, 1,
         mapping.effective_from, revision.effective_to
    FROM price_schedule_backfill_mapping AS mapping
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = mapping.tenant_id
     AND revision.legal_entity_id = mapping.legal_entity_id
     AND revision.price_id = mapping.price_id
     AND revision.price_revision_id = mapping.price_revision_id;
  GET DIAGNOSTICS v_entry_count = ROW_COUNT;

  INSERT INTO pricing.price_schedule_heads (
    tenant_id, legal_entity_id, price_id, price_schedule_revision_id, schedule_revision
  )
  SELECT tenant_id, legal_entity_id, price_id, price_schedule_revision_id, 1
    FROM price_schedule_backfill_mapping;
  GET DIAGNOSTICS v_head_count = ROW_COUNT;

  IF v_revision_count <> v_source_count OR v_entry_count <> v_source_count OR v_head_count <> v_source_count THEN
    RAISE EXCEPTION 'Pricing schedule backfill was incomplete' USING ERRCODE = '55000';
  END IF;
END;
$backfill$;

ALTER TABLE pricing.price_current_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_current_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_schedule_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY pricing_price_current_projection_writer
  ON pricing.price_current_revisions
  AS PERMISSIVE FOR ALL
  TO pricing_schedule_projection_writer
  USING (
    tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  );

CREATE POLICY pricing_price_schedule_heads_projection_select
  ON pricing.price_schedule_heads FOR SELECT TO pricing_schedule_projection_writer
  USING (
    tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  );
CREATE POLICY pricing_price_schedule_entries_projection_select
  ON pricing.price_schedule_entries FOR SELECT TO pricing_schedule_projection_writer
  USING (
    tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  );
CREATE POLICY pricing_price_revisions_projection_select
  ON pricing.price_revisions FOR SELECT TO pricing_schedule_projection_writer
  USING (
    tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  );

GRANT USAGE ON SCHEMA pricing TO pricing_schedule_projection_writer;
GRANT SELECT ON pricing.price_schedule_heads, pricing.price_schedule_entries, pricing.price_revisions
  TO pricing_schedule_projection_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON pricing.price_current_revisions
  TO pricing_schedule_projection_writer;

CREATE FUNCTION pricing.refresh_price_current_projection_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_count integer;
  v_revision_id uuid;
  v_revision_number integer;
  v_effective_from timestamptz;
  v_action_invocation_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_catalog.set_config('ontos.tenant_id', OLD.tenant_id::text, true);
    PERFORM pg_catalog.set_config('ontos.legal_entity_id', OLD.legal_entity_id::text, true);
    DELETE FROM pricing.price_current_revisions
     WHERE tenant_id = OLD.tenant_id
       AND legal_entity_id = OLD.legal_entity_id
       AND price_id = OLD.price_id;
    RETURN OLD;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR NEW.legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Current projection scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer,
         min(entry.price_revision_id::text)::uuid,
         min(revision.revision_number),
         min(entry.effective_from),
         min(revision.action_invocation_id::text)::uuid
    INTO v_count, v_revision_id, v_revision_number, v_effective_from, v_action_invocation_id
    FROM pricing.price_schedule_entries AS entry
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = entry.tenant_id
     AND revision.legal_entity_id = entry.legal_entity_id
     AND revision.price_id = entry.price_id
     AND revision.price_revision_id = entry.price_revision_id
   WHERE entry.tenant_id = NEW.tenant_id
     AND entry.legal_entity_id = NEW.legal_entity_id
     AND entry.price_id = NEW.price_id
     AND entry.price_schedule_revision_id = NEW.price_schedule_revision_id
     AND entry.effective_from <= pg_catalog.statement_timestamp()
     AND (entry.effective_to IS NULL OR pg_catalog.statement_timestamp() < entry.effective_to);

  IF v_count > 1 THEN
    RAISE EXCEPTION 'Pricing schedule has multiple Current revisions' USING ERRCODE = '23514';
  END IF;

  DELETE FROM pricing.price_current_revisions
   WHERE tenant_id = NEW.tenant_id
     AND legal_entity_id = NEW.legal_entity_id
     AND price_id = NEW.price_id;

  IF v_count = 1 THEN
    INSERT INTO pricing.price_current_revisions (
      tenant_id, legal_entity_id, price_id, price_revision_id, revision_number,
      effective_from, bound_by_action_invocation_id, bound_at
    ) VALUES (
      NEW.tenant_id, NEW.legal_entity_id, NEW.price_id, v_revision_id, v_revision_number,
      v_effective_from, v_action_invocation_id, pg_catalog.statement_timestamp()
    );
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION pricing.refresh_price_current_projection_v1() OWNER TO pricing_schedule_projection_writer;
REVOKE ALL ON FUNCTION pricing.refresh_price_current_projection_v1() FROM PUBLIC, ontos_runtime;
CREATE TRIGGER pricing_price_schedule_head_refresh_current
AFTER INSERT OR UPDATE OR DELETE
ON pricing.price_schedule_heads
FOR EACH ROW EXECUTE FUNCTION pricing.refresh_price_current_projection_v1();

CREATE FUNCTION pricing.scheduled_price_revision_json_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_price_id uuid,
  p_price_revision_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'definition', jsonb_build_object(
      'identityKey', jsonb_build_object(
        'catalogSelection', price.catalog_selection,
        'commercialScope', jsonb_build_object(
          'channelId', price.channel_id,
          'marketId', price.market_id,
          'sellingLegalEntityId', price.legal_entity_id::text
        ),
        'currencyCode', price.currency_code,
        'priceGroupSelector', price.price_group_selector,
        'unitBasis', jsonb_build_object('quantity', price.basis_quantity::text, 'unitRef', price.unit_ref)
      ),
      'priceRef', jsonb_build_object(
        'moduleId', 'commerce.pricing', 'resourceId', price.price_id::text,
        'resourceType', 'commerce.pricing.price', 'tenantId', price.tenant_id::text
      ),
      'revision', jsonb_build_object(
        'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'monetaryAmount', jsonb_build_object('amount', revision.amount::text, 'currencyCode', revision.currency_code),
        'monetaryBoundary', revision.monetary_boundary,
        'revision', revision.revision_number,
        'revisionId', revision.price_revision_id::text
      )
    ),
    'effectivePeriod', jsonb_build_object(
      'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN p_effective_to IS NULL THEN NULL ELSE
        to_char(p_effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'lineage', jsonb_build_object(
      'correctedRevisionId', revision.corrected_revision_id::text,
      'kind', revision.transition_kind,
      'previousRevisionId', revision.previous_revision_id::text
    )
  )
    FROM pricing.prices AS price
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = price.tenant_id
     AND revision.legal_entity_id = price.legal_entity_id
     AND revision.price_id = price.price_id
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = p_price_id
     AND revision.price_revision_id = p_price_revision_id
$function$;

REVOKE ALL ON FUNCTION pricing.scheduled_price_revision_json_v1(uuid, uuid, uuid, uuid, timestamptz, timestamptz)
  FROM PUBLIC, ontos_runtime;

CREATE OR REPLACE FUNCTION pricing.read_price_schedule_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_price_id uuid;
  v_observed_at timestamptz;
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_current_count integer;
  v_current jsonb;
  v_current_ids jsonb;
  v_revisions jsonb;
  v_future jsonb;
  v_price_ref jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price schedule read scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Price schedule read input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_price_id := (p_input #>> '{priceRef,resourceId}')::uuid;
    v_observed_at := (p_input ->> 'trustedOperationAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Price schedule read input is invalid' USING ERRCODE = '22023';
  END;
  v_price_ref := jsonb_build_object(
    'moduleId', 'commerce.pricing', 'resourceId', v_price_id::text,
    'resourceType', 'commerce.pricing.price', 'tenantId', p_tenant_id::text
  );
  IF v_price_id IS NULL OR v_observed_at IS NULL
    OR p_input #>> '{priceRef,moduleId}' <> 'commerce.pricing'
    OR p_input #>> '{priceRef,resourceType}' <> 'commerce.pricing.price'
    OR p_input #>> '{priceRef,tenantId}' <> p_tenant_id::text
  THEN
    RAISE EXCEPTION 'Pricing Price schedule read input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT head.price_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.price_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = v_price_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PRICE_SCHEDULE_ABSENT', 'priceRef', v_price_ref);
    RETURN;
  END IF;

  SELECT count(*)::integer,
         coalesce(jsonb_agg(entry.price_revision_id::text ORDER BY entry.effective_from), '[]'::jsonb),
         min(pricing.scheduled_price_revision_json_v1(
           p_tenant_id, p_legal_entity_id, v_price_id, entry.price_revision_id,
           entry.effective_from, entry.effective_to
         )::text)::jsonb
    INTO v_current_count, v_current_ids, v_current
    FROM pricing.price_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = v_price_id
     AND entry.price_schedule_revision_id = v_head_revision_id
     AND entry.effective_from <= v_observed_at
     AND (entry.effective_to IS NULL OR v_observed_at < entry.effective_to);

  IF v_current_count > 1 THEN
    RETURN QUERY SELECT jsonb_build_object(
      'candidateRevisionIds', v_current_ids,
      'outcome', 'PRICE_SCHEDULE_CONFLICT',
      'priceRef', v_price_ref
    );
    RETURN;
  END IF;

  SELECT coalesce(jsonb_agg(
           pricing.scheduled_price_revision_json_v1(
             p_tenant_id, p_legal_entity_id, v_price_id, entry.price_revision_id,
             entry.effective_from, entry.effective_to
           ) ORDER BY entry.effective_from, entry.price_revision_id
         ), '[]'::jsonb),
         coalesce(jsonb_agg(
           pricing.scheduled_price_revision_json_v1(
             p_tenant_id, p_legal_entity_id, v_price_id, entry.price_revision_id,
             entry.effective_from, entry.effective_to
           ) ORDER BY entry.effective_from, entry.price_revision_id
         ) FILTER (WHERE entry.effective_from > v_observed_at), '[]'::jsonb)
    INTO v_revisions, v_future
    FROM pricing.price_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = v_price_id
     AND entry.price_schedule_revision_id = v_head_revision_id;

  RETURN QUERY SELECT jsonb_build_object(
    'outcome', CASE WHEN v_current_count = 1 THEN 'PRICE_SCHEDULE_CURRENT' ELSE 'PRICE_SCHEDULE_GAP' END,
    'schedule', jsonb_build_object(
      'future', v_future,
      'observedAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'priceRef', v_price_ref,
      'revisions', v_revisions,
      'scheduleRevision', v_schedule_revision
    ) || CASE WHEN v_current_count = 1 THEN jsonb_build_object('current', v_current) ELSE '{}'::jsonb END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.read_current_price_definition_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_price_id uuid
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_count integer;
  v_candidate_ids jsonb;
  v_scheduled jsonb;
  v_price_ref jsonb;
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price read scope mismatch' USING ERRCODE = '42501';
  END IF;
  v_price_ref := jsonb_build_object(
    'moduleId', 'commerce.pricing', 'resourceId', p_price_id::text,
    'resourceType', 'commerce.pricing.price', 'tenantId', p_tenant_id::text
  );
  IF NOT EXISTS (
    SELECT 1 FROM pricing.prices AS price
     WHERE price.tenant_id = p_tenant_id
       AND price.legal_entity_id = p_legal_entity_id
       AND price.price_id = p_price_id
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PRICE_DEFINITION_NOT_FOUND', 'priceRef', v_price_ref);
    RETURN;
  END IF;

  SELECT head.price_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.price_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = p_price_id;

  SELECT count(*)::integer,
         coalesce(jsonb_agg(entry.price_revision_id::text ORDER BY entry.effective_from), '[]'::jsonb),
         min(pricing.scheduled_price_revision_json_v1(
           p_tenant_id, p_legal_entity_id, p_price_id, entry.price_revision_id,
           entry.effective_from, entry.effective_to
         )::text)::jsonb
    INTO v_count, v_candidate_ids, v_scheduled
    FROM pricing.price_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = p_price_id
     AND entry.price_schedule_revision_id = v_head_revision_id
     AND entry.effective_from <= v_observed_at
     AND (entry.effective_to IS NULL OR v_observed_at < entry.effective_to);

  IF v_count <> 1 THEN
    RETURN QUERY SELECT jsonb_build_object(
      'candidateRevisionIds', v_candidate_ids,
      'outcome', 'PRICE_DEFINITION_CONFLICT',
      'priceRef', v_price_ref,
      'reason', CASE WHEN v_count = 0 THEN 'ZERO_CURRENT_REVISION' ELSE 'MULTIPLE_CURRENT_REVISIONS' END
    );
    RETURN;
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    'currentEvidence', jsonb_build_object(
      'observedAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'priceRef', v_price_ref,
      'revision', v_scheduled #> '{definition,revision,revision}',
      'revisionId', v_scheduled #> '{definition,revision,revisionId}'
    ),
    'definition', v_scheduled -> 'definition',
    'outcome', 'PRICE_DEFINITION_CURRENT'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.define_price_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_requested_price_id uuid;
  v_price_id uuid;
  v_existing_price_id uuid;
  v_price_revision_id uuid;
  v_price_schedule_revision_id uuid;
  v_amount_text text;
  v_amount numeric(38,9);
  v_basis_text text;
  v_basis numeric(38,9);
  v_effective_from timestamptz;
  v_trusted_at timestamptz;
  v_catalog jsonb;
  v_channel text;
  v_market text;
  v_currency text;
  v_unit jsonb;
  v_group jsonb;
  v_reason text;
  v_requested_ref jsonb;
  v_count integer;
  v_revision_number integer;
  v_current_amount numeric(38,9);
  v_current_currency text;
  v_current_from timestamptz;
  v_definition jsonb;
  v_receipt record;
  v_lock_a bigint;
  v_lock_b bigint;
  v_created boolean := false;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price write scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Price write input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_requested_price_id := (p_input #>> '{priceRef,resourceId}')::uuid;
    v_effective_from := (p_input ->> 'effectiveFrom')::timestamptz;
    v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Price write input is invalid' USING ERRCODE = '22023';
  END;
  v_amount_text := p_input #>> '{monetaryAmount,amount}';
  v_basis_text := p_input #>> '{identityKey,unitBasis,quantity}';
  IF v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR v_basis_text IS NULL OR v_basis_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
  THEN
    RAISE EXCEPTION 'Pricing Price decimal input is not exactly representable as numeric(38,9)' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_amount := v_amount_text::numeric(38,9);
    v_basis := v_basis_text::numeric(38,9);
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Price decimal input is not exactly representable as numeric(38,9)' USING ERRCODE = '22023';
  END;

  v_price_id := v_requested_price_id;
  v_requested_ref := p_input -> 'priceRef';
  v_catalog := p_input #> '{identityKey,catalogSelection}';
  v_channel := p_input #>> '{identityKey,commercialScope,channelId}';
  v_market := p_input #>> '{identityKey,commercialScope,marketId}';
  v_currency := p_input #>> '{identityKey,currencyCode}';
  v_unit := p_input #> '{identityKey,unitBasis,unitRef}';
  v_group := p_input #> '{identityKey,priceGroupSelector}';
  v_reason := p_input ->> 'reason';

  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_price_id IS NULL
    OR v_effective_from IS NULL OR v_trusted_at IS NULL OR v_amount IS NULL OR v_amount < 0 OR v_basis <= 0
    OR jsonb_typeof(v_catalog) <> 'object' OR jsonb_typeof(v_catalog -> 'productRef') <> 'object'
    OR jsonb_typeof(v_catalog -> 'variantRef') <> 'object'
    OR v_channel IS NULL OR v_channel <> btrim(v_channel) OR v_channel = '*'
    OR v_market IS NULL OR v_market <> btrim(v_market) OR v_market = '*'
    OR v_currency !~ '^[A-Z]{3}$' OR v_currency IS DISTINCT FROM p_input #>> '{monetaryAmount,currencyCode}'
    OR v_unit ->> 'resourceType' <> 'commerce.catalog.product-unit'
    OR jsonb_typeof(v_group) <> 'object'
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_requested_ref ->> 'moduleId' <> 'commerce.pricing'
    OR v_requested_ref ->> 'resourceType' <> 'commerce.pricing.price'
    OR v_requested_ref ->> 'tenantId' <> p_tenant_id::text
    OR v_catalog #>> '{productRef,tenantId}' <> p_tenant_id::text
    OR v_catalog #>> '{variantRef,tenantId}' <> p_tenant_id::text
    OR v_unit ->> 'tenantId' <> p_tenant_id::text
    OR p_input #>> '{identityKey,commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR NOT (
      (v_group ->> 'kind' = 'NO_GROUP' AND NOT (v_group ? 'priceGroupRef'))
      OR (v_group ->> 'kind' = 'PRICE_GROUP'
        AND v_group #>> '{priceGroupRef,tenantId}' = p_tenant_id::text
        AND v_group #>> '{priceGroupRef,resourceType}' = 'pricing.price-group-catalog.price-group')
    )
  THEN
    RAISE EXCEPTION 'Pricing Price write input is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_effective_from > v_trusted_at THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'EFFECTIVE_TIME_INVALID');
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text || ':invocation:' || v_action_invocation_id::text, 0)
  );
  SELECT receipt.*, revision.revision_number
    INTO v_receipt
    FROM pricing.price_invocation_receipts AS receipt
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = receipt.tenant_id
     AND revision.legal_entity_id = receipt.legal_entity_id
     AND revision.price_id = receipt.resolved_price_id
     AND revision.price_revision_id = receipt.resolved_price_revision_id
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF v_receipt.requested_price_id IS DISTINCT FROM v_requested_price_id
      OR v_receipt.legal_entity_id IS DISTINCT FROM p_legal_entity_id
      OR v_receipt.catalog_selection IS DISTINCT FROM v_catalog
      OR v_receipt.channel_id IS DISTINCT FROM v_channel
      OR v_receipt.market_id IS DISTINCT FROM v_market
      OR v_receipt.currency_code IS DISTINCT FROM v_currency
      OR v_receipt.unit_ref IS DISTINCT FROM v_unit
      OR v_receipt.basis_quantity IS DISTINCT FROM v_basis
      OR v_receipt.price_group_selector IS DISTINCT FROM v_group
      OR v_receipt.amount IS DISTINCT FROM v_amount
      OR v_receipt.monetary_boundary IS DISTINCT FROM 'PRE_TAX'
      OR v_receipt.effective_from IS DISTINCT FROM v_effective_from
      OR v_receipt.acting_principal_id IS DISTINCT FROM v_acting_principal_id
      OR v_receipt.reason IS DISTINCT FROM v_reason
    THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT');
      RETURN;
    END IF;
    v_definition := pricing.scheduled_price_revision_json_v1(
      p_tenant_id, p_legal_entity_id, v_receipt.resolved_price_id,
      v_receipt.resolved_price_revision_id, v_receipt.effective_from, NULL
    ) -> 'definition';
    RETURN QUERY SELECT jsonb_build_object('definition', v_definition, 'outcome', 'REUSED');
    RETURN;
  END IF;

  v_lock_a := pg_catalog.hashtextextended(p_tenant_id::text || ':price:' || v_price_id::text, 0);
  v_lock_b := pg_catalog.hashtextextended(
    p_tenant_id::text || ':identity:' || jsonb_build_array(
      v_catalog, p_legal_entity_id, v_channel, v_market, v_currency, v_unit, v_basis, v_group
    )::text, 0
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(lock_key)
    FROM unnest(ARRAY[v_lock_a, v_lock_b]) AS lock_key ORDER BY lock_key;

  SELECT price.price_id INTO v_existing_price_id
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = v_requested_price_id;
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM pricing.prices AS price
     WHERE price.tenant_id = p_tenant_id AND price.legal_entity_id = p_legal_entity_id
       AND price.price_id = v_requested_price_id
       AND price.catalog_selection = v_catalog AND price.channel_id = v_channel
       AND price.market_id = v_market AND price.currency_code = v_currency
       AND price.unit_ref = v_unit AND price.basis_quantity = v_basis
       AND price.price_group_selector = v_group
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'PRICE_RESOURCE_ALREADY_BOUND');
    RETURN;
  END IF;

  SELECT price.price_id INTO v_existing_price_id
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.catalog_selection = v_catalog
     AND price.channel_id = v_channel
     AND price.market_id = v_market
     AND price.currency_code = v_currency
     AND price.unit_ref = v_unit
     AND price.basis_quantity = v_basis
     AND price.price_group_selector = v_group;

  IF FOUND THEN
    v_price_id := v_existing_price_id;
    SELECT count(*)::integer,
           min(entry.price_revision_id::text)::uuid,
           min(revision.revision_number), min(revision.amount), min(revision.currency_code), min(entry.effective_from)
      INTO v_count, v_price_revision_id, v_revision_number, v_current_amount, v_current_currency, v_current_from
      FROM pricing.price_schedule_heads AS head
      JOIN pricing.price_schedule_entries AS entry
        ON entry.tenant_id = head.tenant_id AND entry.legal_entity_id = head.legal_entity_id
       AND entry.price_id = head.price_id AND entry.price_schedule_revision_id = head.price_schedule_revision_id
      JOIN pricing.price_revisions AS revision
        ON revision.tenant_id = entry.tenant_id AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.price_id = entry.price_id AND revision.price_revision_id = entry.price_revision_id
     WHERE head.tenant_id = p_tenant_id AND head.legal_entity_id = p_legal_entity_id
       AND head.price_id = v_price_id AND entry.effective_from <= v_effective_from
       AND (entry.effective_to IS NULL OR v_effective_from < entry.effective_to);
    IF v_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'UNVERIFIABLE_CURRENTNESS');
      RETURN;
    END IF;
    IF v_current_amount IS DISTINCT FROM v_amount OR v_current_currency IS DISTINCT FROM v_currency
      OR v_current_from IS DISTINCT FROM v_effective_from
    THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'EXACT_KEY_ALREADY_BOUND');
      RETURN;
    END IF;
  ELSE
    v_created := true;
    v_price_revision_id := pg_catalog.gen_random_uuid();
    v_price_schedule_revision_id := pg_catalog.gen_random_uuid();
    v_revision_number := 1;
    INSERT INTO pricing.prices (
      price_id, tenant_id, legal_entity_id, catalog_selection, channel_id, market_id,
      currency_code, unit_ref, basis_quantity, price_group_selector,
      created_by_action_invocation_id, created_by_principal_id
    ) VALUES (
      v_price_id, p_tenant_id, p_legal_entity_id, v_catalog, v_channel, v_market,
      v_currency, v_unit, v_basis, v_group, v_action_invocation_id, v_acting_principal_id
    );
    INSERT INTO pricing.price_revisions (
      price_revision_id, tenant_id, legal_entity_id, price_id, revision_number, amount,
      currency_code, monetary_boundary, effective_from, effective_to, transition_kind,
      action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_price_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, 1, v_amount,
      v_currency, 'PRE_TAX', v_effective_from, NULL, 'INITIAL',
      v_action_invocation_id, v_acting_principal_id, v_reason
    );
    INSERT INTO pricing.price_schedule_revisions (
      price_schedule_revision_id, tenant_id, legal_entity_id, price_id, schedule_revision,
      previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_price_schedule_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, 1,
      NULL, v_action_invocation_id, v_acting_principal_id, v_reason
    );
    INSERT INTO pricing.price_schedule_entries (
      tenant_id, legal_entity_id, price_id, price_revision_id, price_schedule_revision_id,
      schedule_revision, effective_from, effective_to
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id, v_price_schedule_revision_id,
      1, v_effective_from, NULL
    );
    INSERT INTO pricing.price_schedule_heads (
      tenant_id, legal_entity_id, price_id, price_schedule_revision_id, schedule_revision
    ) VALUES (p_tenant_id, p_legal_entity_id, v_price_id, v_price_schedule_revision_id, 1);
  END IF;

  INSERT INTO pricing.price_invocation_receipts (
    tenant_id, legal_entity_id, action_invocation_id, requested_price_id, resolved_price_id,
    resolved_price_revision_id, catalog_selection, channel_id, market_id, currency_code,
    unit_ref, basis_quantity, price_group_selector, amount, monetary_boundary, effective_from,
    acting_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_action_invocation_id, v_requested_price_id, v_price_id,
    v_price_revision_id, v_catalog, v_channel, v_market, v_currency, v_unit, v_basis, v_group,
    v_amount, 'PRE_TAX', v_effective_from, v_acting_principal_id, v_reason
  );

  v_definition := pricing.scheduled_price_revision_json_v1(
    p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id, v_effective_from, NULL
  ) -> 'definition';
  RETURN QUERY SELECT jsonb_build_object(
    'definition', v_definition,
    'outcome', CASE WHEN v_created THEN 'CREATED' ELSE 'REUSED' END
  );
END;
$function$;

CREATE FUNCTION pricing.price_schedule_acknowledgement_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_price_id uuid,
  p_price_schedule_revision_id uuid,
  p_schedule_revision integer,
  p_target_revision_id uuid,
  p_intended_from timestamptz,
  p_intent text,
  p_amount numeric,
  p_currency text,
  p_acting_principal_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_target_to timestamptz;
  v_future jsonb;
  v_body jsonb;
  v_fingerprint text;
BEGIN
  SELECT entry.effective_to INTO STRICT v_target_to
    FROM pricing.price_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = p_price_id
     AND entry.price_schedule_revision_id = p_price_schedule_revision_id
     AND entry.price_revision_id = p_target_revision_id;

  SELECT coalesce(jsonb_agg(
           pricing.scheduled_price_revision_json_v1(
             p_tenant_id, p_legal_entity_id, p_price_id, entry.price_revision_id,
             entry.effective_from, entry.effective_to
           ) ORDER BY entry.effective_from, entry.price_revision_id
         ), '[]'::jsonb)
    INTO v_future
    FROM pricing.price_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = p_price_id
     AND entry.price_schedule_revision_id = p_price_schedule_revision_id
     AND entry.effective_from > p_intended_from;

  v_body := jsonb_build_object(
    'actingPrincipalId', p_acting_principal_id::text,
    'intendedEffectivePeriod', jsonb_build_object(
      'effectiveFrom', to_char(p_intended_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN v_target_to IS NULL THEN NULL ELSE
        to_char(v_target_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'intendedMonetaryAmount', jsonb_build_object('amount', p_amount::numeric(38,9)::text, 'currencyCode', p_currency),
    'intent', p_intent,
    'presentedFuture', v_future,
    'priceRef', jsonb_build_object(
      'moduleId', 'commerce.pricing', 'resourceId', p_price_id::text,
      'resourceType', 'commerce.pricing.price', 'tenantId', p_tenant_id::text
    ),
    'scheduleRevision', p_schedule_revision,
    'targetRevisionId', p_target_revision_id::text
  );
  v_fingerprint := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(v_body::text, 'UTF8'), 'sha256'),
    'hex'
  );
  RETURN v_body || jsonb_build_object('fingerprint', v_fingerprint);
END;
$function$;

REVOKE ALL ON FUNCTION pricing.price_schedule_acknowledgement_v1(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz, text, numeric, text, uuid
) FROM PUBLIC, ontos_runtime;

CREATE OR REPLACE FUNCTION pricing.revise_price_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_price_id uuid;
  v_trusted_at timestamptz;
  v_intent text;
  v_reason text;
  v_amount_text text;
  v_amount numeric(38,9);
  v_currency text;
  v_identity_currency text;
  v_head_id uuid;
  v_head_revision integer;
  v_new_head_id uuid := pg_catalog.gen_random_uuid();
  v_new_revision_id uuid := pg_catalog.gen_random_uuid();
  v_new_revision_number integer;
  v_target_revision_id uuid;
  v_target_revision_number integer;
  v_target_amount numeric(38,9);
  v_target_currency text;
  v_target_from timestamptz;
  v_target_to timestamptz;
  v_target_count integer;
  v_new_from timestamptz;
  v_new_to timestamptz;
  v_requested_to timestamptz;
  v_expected_schedule integer;
  v_expected_revision_id uuid;
  v_expected_revision_number integer;
  v_ack jsonb;
  v_expected_ack jsonb;
  v_has_ack boolean;
  v_future_count integer;
  v_overlap_count integer;
  v_previous_revision_id uuid;
  v_transition text;
  v_result jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price revision scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Price revision input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_price_id := (p_input #>> '{priceRef,resourceId}')::uuid;
    v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Price revision input is invalid' USING ERRCODE = '22023';
  END;
  v_intent := p_input ->> 'intent';
  v_reason := p_input ->> 'reason';
  v_has_ack := p_input ? 'acknowledgement';
  v_ack := p_input -> 'acknowledgement';
  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_price_id IS NULL OR v_trusted_at IS NULL
    OR v_intent NOT IN ('VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION', 'CORRECT_REVISION', 'RETIRE_CURRENT')
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR p_input #>> '{priceRef,moduleId}' <> 'commerce.pricing'
    OR p_input #>> '{priceRef,resourceType}' <> 'commerce.pricing.price'
    OR p_input #>> '{priceRef,tenantId}' <> p_tenant_id::text
  THEN
    RAISE EXCEPTION 'Pricing Price revision input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT price.currency_code INTO v_identity_currency
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = v_price_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ABSENT');
    RETURN;
  END IF;

  IF v_intent <> 'RETIRE_CURRENT' THEN
    v_amount_text := p_input #>> '{monetaryAmount,amount}';
    v_currency := p_input #>> '{monetaryAmount,currencyCode}';
    IF v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$' THEN
      RAISE EXCEPTION 'Pricing Price decimal input is not exactly representable as numeric(38,9)' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_amount := v_amount_text::numeric(38,9);
    EXCEPTION WHEN numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pricing Price decimal input is not exactly representable as numeric(38,9)' USING ERRCODE = '22023';
    END;
    IF v_amount < 0 OR v_currency IS DISTINCT FROM v_identity_currency THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'CURRENCY_IDENTITY_MISMATCH');
      RETURN;
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text || ':price-schedule:' || v_price_id::text, 0)
  );
  SELECT head.price_schedule_revision_id, head.schedule_revision
    INTO v_head_id, v_head_revision
    FROM pricing.price_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = v_price_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ABSENT');
    RETURN;
  END IF;

  IF v_intent IN ('SCHEDULE_REVISION', 'CORRECT_REVISION') THEN
    BEGIN
      v_expected_schedule := (p_input ->> 'expectedScheduleRevision')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pricing Price revision input is invalid' USING ERRCODE = '22023';
    END;
    IF v_expected_schedule IS DISTINCT FROM v_head_revision THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SCHEDULE_REVISION_STALE');
      RETURN;
    END IF;
  ELSE
    BEGIN
      v_expected_schedule := (p_input #>> '{expectedCurrent,scheduleRevision}')::integer;
      v_expected_revision_id := (p_input #>> '{expectedCurrent,revisionId}')::uuid;
      v_expected_revision_number := (p_input #>> '{expectedCurrent,revision}')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pricing Price revision input is invalid' USING ERRCODE = '22023';
    END;
    IF p_input #>> '{expectedCurrent,priceRef,moduleId}' <> 'commerce.pricing'
      OR p_input #>> '{expectedCurrent,priceRef,resourceType}' <> 'commerce.pricing.price'
      OR p_input #>> '{expectedCurrent,priceRef,tenantId}' <> p_tenant_id::text
      OR p_input #>> '{expectedCurrent,priceRef,resourceId}' <> v_price_id::text
      OR v_expected_schedule IS DISTINCT FROM v_head_revision
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'outcome', 'CONFLICT',
        'reason', CASE WHEN v_has_ack THEN 'SCHEDULE_ACKNOWLEDGEMENT_STALE' ELSE 'EXPECTED_CURRENT_MISMATCH' END
      );
      RETURN;
    END IF;

    SELECT count(*)::integer,
           min(entry.price_revision_id::text)::uuid,
           min(revision.revision_number), min(revision.amount), min(revision.currency_code),
           min(entry.effective_from), min(entry.effective_to)
      INTO v_target_count, v_target_revision_id, v_target_revision_number, v_target_amount,
           v_target_currency, v_target_from, v_target_to
      FROM pricing.price_schedule_entries AS entry
      JOIN pricing.price_revisions AS revision
        ON revision.tenant_id = entry.tenant_id AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.price_id = entry.price_id AND revision.price_revision_id = entry.price_revision_id
     WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
       AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
       AND entry.effective_from <= v_trusted_at
       AND (entry.effective_to IS NULL OR v_trusted_at < entry.effective_to);

    IF v_target_count <> 1 OR v_target_revision_id IS DISTINCT FROM v_expected_revision_id
      OR v_target_revision_number IS DISTINCT FROM v_expected_revision_number
      OR to_char(v_target_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           IS DISTINCT FROM p_input #>> '{expectedCurrent,effectivePeriod,effectiveFrom}'
      OR (CASE WHEN v_target_to IS NULL THEN NULL ELSE
            to_char(v_target_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
           IS DISTINCT FROM (p_input #>> '{expectedCurrent,effectivePeriod,effectiveTo}')
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'outcome', 'CONFLICT',
        'reason', CASE WHEN v_has_ack THEN 'SCHEDULE_ACKNOWLEDGEMENT_STALE' ELSE 'EXPECTED_CURRENT_MISMATCH' END
      );
      RETURN;
    END IF;

    IF v_intent = 'RETIRE_CURRENT' THEN
      v_amount := v_target_amount;
      v_currency := v_target_currency;
    END IF;

    IF v_has_ack THEN
      BEGIN
        v_new_from := (v_ack #>> '{intendedEffectivePeriod,effectiveFrom}')::timestamptz;
      EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
        RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SCHEDULE_ACKNOWLEDGEMENT_STALE');
        RETURN;
      END;
      IF NOT EXISTS (
        SELECT 1 FROM pricing.price_schedule_acknowledgements AS ledger
         WHERE ledger.tenant_id = p_tenant_id AND ledger.legal_entity_id = p_legal_entity_id
           AND ledger.price_id = v_price_id AND ledger.fingerprint = v_ack ->> 'fingerprint'
           AND ledger.issued_by_principal_id = v_acting_principal_id
           AND ledger.acknowledgement = v_ack
      ) THEN
        RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SCHEDULE_ACKNOWLEDGEMENT_STALE');
        RETURN;
      END IF;
      v_expected_ack := pricing.price_schedule_acknowledgement_v1(
        p_tenant_id, p_legal_entity_id, v_price_id, v_head_id, v_head_revision,
        v_target_revision_id, v_new_from, v_intent, v_amount, v_currency, v_acting_principal_id
      );
      IF v_ack IS DISTINCT FROM v_expected_ack
        OR (v_intent = 'VALUE_ONLY_CURRENT' AND v_new_from < v_target_from)
        OR (v_intent = 'RETIRE_CURRENT' AND v_new_from <= v_target_from)
        OR (v_target_to IS NOT NULL AND v_new_from >= v_target_to)
      THEN
        RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SCHEDULE_ACKNOWLEDGEMENT_STALE');
        RETURN;
      END IF;
    ELSE
      v_new_from := v_trusted_at;
      SELECT count(*)::integer INTO v_future_count
        FROM pricing.price_schedule_entries AS entry
       WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
         AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
         AND entry.effective_from > v_new_from;
      IF v_future_count > 0 THEN
        v_expected_ack := pricing.price_schedule_acknowledgement_v1(
          p_tenant_id, p_legal_entity_id, v_price_id, v_head_id, v_head_revision,
          v_target_revision_id, v_new_from, v_intent, v_amount, v_currency, v_acting_principal_id
        );
        INSERT INTO pricing.price_schedule_acknowledgements (
          tenant_id, legal_entity_id, price_id, fingerprint, acknowledgement, issued_by_principal_id
        ) VALUES (
          p_tenant_id, p_legal_entity_id, v_price_id, v_expected_ack ->> 'fingerprint',
          v_expected_ack, v_acting_principal_id
        ) ON CONFLICT (tenant_id, fingerprint) DO NOTHING;
        RETURN QUERY SELECT jsonb_build_object('acknowledgement', v_expected_ack, 'outcome', 'ACKNOWLEDGEMENT_REQUIRED');
        RETURN;
      END IF;
    END IF;

    IF (v_intent = 'VALUE_ONLY_CURRENT' AND v_new_from < v_target_from)
      OR (v_intent = 'RETIRE_CURRENT' AND v_new_from <= v_target_from)
      OR (v_target_to IS NOT NULL AND v_new_from >= v_target_to)
    THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'BOUNDARY_CROSSED');
      RETURN;
    END IF;
    IF v_intent = 'VALUE_ONLY_CURRENT' AND v_amount = v_target_amount AND v_currency = v_target_currency THEN
      v_result := pricing.scheduled_price_revision_json_v1(
        p_tenant_id, p_legal_entity_id, v_price_id, v_target_revision_id, v_target_from, v_target_to
      );
      RETURN QUERY SELECT jsonb_build_object('outcome', 'UNCHANGED', 'revision', v_result);
      RETURN;
    END IF;
  END IF;

  IF v_intent = 'SCHEDULE_REVISION' THEN
    BEGIN
      v_new_from := (p_input #>> '{effectivePeriod,effectiveFrom}')::timestamptz;
      v_requested_to := (p_input #>> '{effectivePeriod,effectiveTo}')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Pricing Price revision input is invalid' USING ERRCODE = '22023';
    END;
    IF v_new_from <= v_trusted_at OR (v_requested_to IS NOT NULL AND v_requested_to <= v_new_from) THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'BOUNDARY_CROSSED');
      RETURN;
    END IF;
    SELECT count(*)::integer,
           min(entry.price_revision_id::text)::uuid,
           min(entry.effective_from), min(entry.effective_to)
      INTO v_target_count, v_target_revision_id, v_target_from, v_target_to
      FROM pricing.price_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
       AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
       AND entry.effective_from < v_new_from
       AND (entry.effective_to IS NULL OR v_new_from < entry.effective_to);
    IF v_target_count > 1 THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'OVERLAPPING_SCHEDULE');
      RETURN;
    END IF;
    IF v_target_count = 1 THEN
      IF v_requested_to IS DISTINCT FROM v_target_to THEN
        RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'OVERLAPPING_SCHEDULE');
        RETURN;
      END IF;
      v_new_to := v_target_to;
      v_previous_revision_id := v_target_revision_id;
    ELSE
      v_new_to := v_requested_to;
      SELECT entry.price_revision_id INTO v_previous_revision_id
        FROM pricing.price_schedule_entries AS entry
       WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
         AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
         AND entry.effective_from < v_new_from
       ORDER BY entry.effective_from DESC LIMIT 1;
    END IF;
    SELECT count(*)::integer INTO v_overlap_count
      FROM pricing.price_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
       AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
       AND (v_target_count = 0 OR entry.price_revision_id <> v_target_revision_id)
       AND pg_catalog.tstzrange(entry.effective_from, entry.effective_to, '[)')
           && pg_catalog.tstzrange(v_new_from, v_new_to, '[)');
    IF v_overlap_count > 0 OR v_previous_revision_id IS NULL THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'OVERLAPPING_SCHEDULE');
      RETURN;
    END IF;
    v_transition := 'SCHEDULED';
  ELSIF v_intent = 'CORRECT_REVISION' THEN
    BEGIN
      v_target_revision_id := (p_input ->> 'targetRevisionId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Pricing Price revision input is invalid' USING ERRCODE = '22023';
    END;
    SELECT count(*)::integer, min(entry.effective_from), min(entry.effective_to)
      INTO v_target_count, v_target_from, v_target_to
      FROM pricing.price_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
       AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
       AND entry.price_revision_id = v_target_revision_id;
    IF v_target_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'TARGET_REVISION_NOT_FOUND');
      RETURN;
    END IF;
    v_new_from := v_target_from;
    v_new_to := v_target_to;
    v_previous_revision_id := v_target_revision_id;
    v_transition := 'CORRECTION';
  ELSIF v_intent = 'VALUE_ONLY_CURRENT' THEN
    v_new_to := v_target_to;
    v_previous_revision_id := v_target_revision_id;
    v_transition := 'VALUE_ONLY_CURRENT';
  ELSE
    v_new_to := v_new_from;
    v_previous_revision_id := v_target_revision_id;
    v_transition := 'RETIREMENT';
  END IF;

  SELECT coalesce(max(revision.revision_number), 0) + 1 INTO v_new_revision_number
    FROM pricing.price_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
     AND revision.price_id = v_price_id;

  INSERT INTO pricing.price_revisions (
    price_revision_id, tenant_id, legal_entity_id, price_id, revision_number, amount,
    currency_code, monetary_boundary, effective_from, effective_to, previous_revision_id,
    corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_new_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, v_new_revision_number, v_amount,
    v_currency, 'PRE_TAX', CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_target_from ELSE v_new_from END,
    CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_new_from ELSE v_new_to END,
    v_previous_revision_id, CASE WHEN v_intent = 'CORRECT_REVISION' THEN v_target_revision_id ELSE NULL END,
    v_transition, v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.price_schedule_revisions (
    price_schedule_revision_id, tenant_id, legal_entity_id, price_id, schedule_revision,
    previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_new_head_id, p_tenant_id, p_legal_entity_id, v_price_id, v_head_revision + 1,
    v_head_id, v_action_invocation_id, v_acting_principal_id, v_reason
  );

  INSERT INTO pricing.price_schedule_entries (
    tenant_id, legal_entity_id, price_id, price_revision_id, price_schedule_revision_id,
    schedule_revision, effective_from, effective_to
  )
  SELECT entry.tenant_id, entry.legal_entity_id, entry.price_id, entry.price_revision_id,
         v_new_head_id, v_head_revision + 1, entry.effective_from, entry.effective_to
    FROM pricing.price_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
     AND (v_target_count = 0 OR entry.price_revision_id <> v_target_revision_id);

  IF v_intent IN ('VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION') AND v_target_count = 1 AND v_target_from < v_new_from THEN
    INSERT INTO pricing.price_schedule_entries (
      tenant_id, legal_entity_id, price_id, price_revision_id, price_schedule_revision_id,
      schedule_revision, effective_from, effective_to
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_price_id, v_target_revision_id, v_new_head_id,
      v_head_revision + 1, v_target_from, v_new_from
    );
  END IF;

  INSERT INTO pricing.price_schedule_entries (
    tenant_id, legal_entity_id, price_id, price_revision_id, price_schedule_revision_id,
    schedule_revision, effective_from, effective_to
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_price_id, v_new_revision_id, v_new_head_id,
    v_head_revision + 1,
    CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_target_from ELSE v_new_from END,
    CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_new_from ELSE v_new_to END
  );

  UPDATE pricing.price_schedule_heads
     SET price_schedule_revision_id = v_new_head_id,
         schedule_revision = v_head_revision + 1
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id AND price_id = v_price_id;

  v_result := pricing.scheduled_price_revision_json_v1(
    p_tenant_id, p_legal_entity_id, v_price_id, v_new_revision_id,
    CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_target_from ELSE v_new_from END,
    CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_new_from ELSE v_new_to END
  );
  RETURN QUERY SELECT jsonb_build_object('outcome', 'REVISED', 'revision', v_result);
EXCEPTION WHEN exclusion_violation THEN
  RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'OVERLAPPING_SCHEDULE');
END;
$function$;

-- Explicit runtime ACLs are part of the deploy artifact; RLS remains the row-level boundary.
GRANT USAGE ON SCHEMA pricing TO ontos_runtime;
REVOKE ALL ON TABLE pricing.currency_support_revisions,
  pricing.prices,
  pricing.price_revisions,
  pricing.price_current_revisions,
  pricing.price_invocation_receipts,
  pricing.price_schedule_acknowledgements,
  pricing.price_schedule_entries,
  pricing.price_schedule_heads,
  pricing.price_schedule_revisions
FROM PUBLIC, ontos_runtime;

GRANT SELECT, INSERT, UPDATE ON pricing.currency_support_revisions TO ontos_runtime;
GRANT SELECT, INSERT ON pricing.prices TO ontos_runtime;
GRANT SELECT, INSERT ON pricing.price_revisions TO ontos_runtime;
GRANT SELECT, INSERT ON pricing.price_invocation_receipts TO ontos_runtime;
GRANT SELECT, INSERT ON pricing.price_schedule_acknowledgements TO ontos_runtime;
GRANT SELECT, INSERT ON pricing.price_schedule_entries TO ontos_runtime;
GRANT SELECT, INSERT, UPDATE ON pricing.price_schedule_heads TO ontos_runtime;
GRANT SELECT, INSERT ON pricing.price_schedule_revisions TO ontos_runtime;

REVOKE ALL ON FUNCTION pricing.define_price_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_current_price_definition_v1(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_price_schedule_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_price_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.define_price_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_price_definition_v1(uuid, uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_price_schedule_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_price_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.scheduled_price_revision_json_v1(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.price_schedule_acknowledgement_v1(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz, text, numeric, text, uuid
) TO ontos_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA pricing REVOKE ALL ON TABLES FROM PUBLIC, ontos_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA pricing REVOKE ALL ON SEQUENCES FROM PUBLIC, ontos_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA pricing REVOKE ALL ON FUNCTIONS FROM PUBLIC, ontos_runtime;
