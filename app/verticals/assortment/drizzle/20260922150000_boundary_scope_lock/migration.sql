CREATE OR REPLACE FUNCTION "assortment"."lock_closed_assortment_boundary_scope"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_subject_kind text,
  p_subject_resource_id text,
  p_purpose text,
  p_channel_resource_id text
)
RETURNS TABLE(locked boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      concat_ws('|', p_tenant_id::text, p_legal_entity_id::text, p_subject_kind,
        p_subject_resource_id, p_purpose, p_channel_resource_id),
      0
    )
  );
  RETURN QUERY SELECT true;
END;
$$;

ALTER TABLE "assortment"."assortment_closed_boundaries"
  ADD COLUMN IF NOT EXISTS "semantic_fingerprint" text NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE "assortment"."assortment_closed_boundaries"
  ALTER COLUMN "semantic_fingerprint" DROP DEFAULT;

ALTER TABLE "assortment"."assortment_closed_boundary_end_facts"
  ADD COLUMN IF NOT EXISTS "basis_fingerprint" text NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE "assortment"."assortment_closed_boundary_end_facts"
  ALTER COLUMN "basis_fingerprint" DROP DEFAULT;
