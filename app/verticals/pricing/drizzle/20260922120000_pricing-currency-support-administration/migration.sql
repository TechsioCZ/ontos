CREATE OR REPLACE FUNCTION "pricing"."set_supported_currencies"(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pricing
AS $function$
DECLARE
  current_revision pricing.currency_support_revisions%ROWTYPE;
  desired_currencies jsonb := p_input -> 'supportedCurrencies';
  desired_effective_from timestamptz := (p_input ->> 'effectiveFrom')::timestamptz;
  expected_generation integer := (p_input ->> 'expectedGeneration')::integer;
  next_generation integer;
BEGIN
  SELECT revision.* INTO current_revision
  FROM pricing.currency_support_revisions AS revision
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.context_revision = p_input ->> 'contextRevision'
    AND revision.storefront_id = p_input ->> 'storefrontId'
    AND revision.market_id = p_input ->> 'marketId'
    AND revision.channel_id = p_input ->> 'channelId'
    AND revision.cart_id = p_input ->> 'cartId'
    AND revision.subject_fingerprint = p_input ->> 'subjectFingerprint'
    AND revision.effective_to IS NULL
  ORDER BY revision.generation DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND current_revision.supported_currencies = desired_currencies THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', current_revision.generation,
      'changed', false,
      'outcome', 'UNCHANGED',
      'pricingRevision', current_revision.pricing_revision,
      'supportedCurrencies', current_revision.supported_currencies
    );
    RETURN;
  END IF;

  IF COALESCE(current_revision.generation, 0) <> expected_generation THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', COALESCE(current_revision.generation, 0),
      'changed', false,
      'outcome', 'REVISION_CONFLICT',
      'pricingRevision', NULL,
      'supportedCurrencies', '[]'::jsonb
    );
    RETURN;
  END IF;

  IF FOUND AND desired_effective_from <= current_revision.effective_from THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', current_revision.generation,
      'changed', false,
      'outcome', 'EFFECTIVE_TIME_CONFLICT',
      'pricingRevision', NULL,
      'supportedCurrencies', '[]'::jsonb
    );
    RETURN;
  END IF;

  next_generation := expected_generation + 1;
  IF current_revision.currency_support_revision_id IS NOT NULL THEN
    UPDATE pricing.currency_support_revisions
    SET effective_to = desired_effective_from
    WHERE currency_support_revision_id = current_revision.currency_support_revision_id;
  END IF;

  INSERT INTO pricing.currency_support_revisions (
    tenant_id, legal_entity_id, context_revision, storefront_id, market_id, channel_id, cart_id,
    subject_fingerprint, generation, pricing_revision, supported_currencies, effective_from,
    action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_input ->> 'contextRevision', p_input ->> 'storefrontId',
    p_input ->> 'marketId', p_input ->> 'channelId', p_input ->> 'cartId', p_input ->> 'subjectFingerprint',
    next_generation, 'pricing-currency-support:' || next_generation::text, desired_currencies,
    desired_effective_from, (p_input ->> 'actionInvocationId')::uuid, (p_input ->> 'actorPrincipalId')::uuid,
    p_input ->> 'reason'
  );

  RETURN QUERY SELECT jsonb_build_object(
    'actualGeneration', next_generation,
    'changed', true,
    'outcome', 'APPLIED',
    'pricingRevision', 'pricing-currency-support:' || next_generation::text,
    'supportedCurrencies', desired_currencies
  );
END;
$function$;

REVOKE ALL ON FUNCTION "pricing"."set_supported_currencies"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "pricing"."set_supported_currencies"(uuid, uuid, jsonb) TO ontos_runtime;
