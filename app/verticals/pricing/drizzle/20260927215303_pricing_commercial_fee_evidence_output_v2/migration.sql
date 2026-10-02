-- Custom SQL migration file, put your code below! --
-- #773 canonical wire timestamp for immutable Catalog snapshot evidence.
CREATE OR REPLACE FUNCTION pricing.scheduled_fee_revision_json_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_fee_id uuid,
  p_fee_revision_id uuid,
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
      'catalogTargetEvidence', revision.catalog_target_evidence || jsonb_build_object(
        'capturedAt', to_char(
          (revision.catalog_target_evidence ->> 'capturedAt')::timestamptz AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      ),
      'feeRef', jsonb_build_object(
        'moduleId', 'commerce.pricing',
        'resourceId', revision.fee_id::text,
        'resourceType', 'commerce.pricing.commercial-fee',
        'tenantId', revision.tenant_id::text
      ),
      'identityKey', pricing.fee_identity_json_v1(p_tenant_id, p_legal_entity_id, p_fee_id),
      'revision', jsonb_build_object(
        'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'configuredAmount', jsonb_build_object(
          'amount', revision.amount::text,
          'currencyCode', revision.currency_code
        ),
        'revision', revision.revision_number,
        'revisionId', revision.fee_revision_id::text
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
    FROM pricing.fee_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.fee_id = p_fee_id
     AND revision.fee_revision_id = p_fee_revision_id
$function$;

REVOKE ALL ON FUNCTION pricing.scheduled_fee_revision_json_v1(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.scheduled_fee_revision_json_v1(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) TO ontos_runtime;
