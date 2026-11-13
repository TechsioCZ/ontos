-- The functions the tax-classification step left in place write the held rates as Merchandise decodes them: the key is
-- absent when a company holds nothing, never JSON null and never empty.
--
-- `migration_tax_rates` (the migrated state; the deploy rehearsal still builds companies with it while the expand step
-- serves) aggregated zero held products into `"heldProductRates": null`, the state that made catalogues unreadable on
-- stage (repaired by 20261113130000). It now adds the key only when at least one product is held.
-- `classify_written_product` (the window trigger for the release before classifications) leaves the key absent when it
-- drops a company's last hold, and never touches a held-rates value that is not an object.
-- Only function bodies change: no table is locked and no row is written.
CREATE OR REPLACE FUNCTION "demo_merchandise"."migration_tax_rates"(p_tenant_id uuid, p_legal_entity_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT jsonb_build_object(
             'book', jsonb_build_object(
               'fingerprint', 'migration:cz.vat.standard=21;cz.vat.reduced=12',
               'periods', jsonb_build_array(
                 jsonb_build_object('code', 'cz.vat.standard', 'effectiveFrom', '1970-01-01T00:00:00.000Z', 'ratePercent', '21'),
                 jsonb_build_object('code', 'cz.vat.reduced', 'effectiveFrom', '1970-01-01T00:00:00.000Z', 'ratePercent', '12')),
               'regime', 'VAT_PAYER'),
             'source', 'MIGRATION',
             'syncedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           || coalesce((
             SELECT jsonb_build_object(
                      'heldProductRates',
                      jsonb_object_agg(p.id, "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate')))
               FROM "demo_merchandise"."products" AS p
              WHERE p.tenant_id = p_tenant_id AND p.legal_entity_id = p_legal_entity_id
                AND "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate') IS NOT NULL
             HAVING count(*) > 0
           ), '{}'::jsonb)
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "demo_merchandise"."classify_written_product"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
    DECLARE
      code text;
      held integer;
    BEGIN
      IF NEW.document ? 'taxClassificationCode' OR NOT (NEW.document ? 'vatRate') THEN
        RETURN NEW;
      END IF;
      code := "demo_merchandise"."product_tax_classification"(NEW.document ->> 'vatRate');
      IF code IS NULL THEN
        RAISE EXCEPTION 'Product % has VAT rate % %%, which names no VAT classification (only 21, 12 and 10 do)',
          NEW.id, NEW.document ->> 'vatRate'
          USING ERRCODE = '23514';
      END IF;
      NEW.tax_classification_code := code;
      NEW.document := NEW.document || jsonb_build_object('taxClassificationCode', code);
      held := "demo_merchandise"."held_product_rate"(NEW.document ->> 'vatRate');
      IF held IS NULL THEN
        UPDATE "demo_merchandise"."catalog_heads" AS h
           SET tax_rates = CASE
                 WHEN (h.tax_rates -> 'heldProductRates') - NEW.id = '{}'::jsonb THEN h.tax_rates - 'heldProductRates'
                 ELSE jsonb_set(h.tax_rates, '{heldProductRates}', (h.tax_rates -> 'heldProductRates') - NEW.id)
               END
         WHERE h.tenant_id = NEW.tenant_id AND h.legal_entity_id = NEW.legal_entity_id
           AND h.tax_rates ->> 'source' = 'MIGRATION'
           AND jsonb_typeof(h.tax_rates -> 'heldProductRates') = 'object'
           AND h.tax_rates -> 'heldProductRates' ? NEW.id;
      END IF;
      RETURN NEW;
    END
  $$;
