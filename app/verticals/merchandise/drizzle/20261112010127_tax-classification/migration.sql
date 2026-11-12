-- Products name a VAT classification instead of a rate; Tax (commerce.tax) holds the rates. Products: 21 -> standard,
-- 12 and 10 -> reduced; any other product rate (0 included) stops the deploy (`pnpm demo:vat-preflight` lists them).
-- Prices are never recomputed: every stored net, gross, tier and market price stays exactly as stored. Order lines keep
-- their stored rate and amounts and gain the classification only where it is unambiguous: 21 -> standard,
-- 12 -> reduced, anything else (10 %, 0 %) none. Each company's materialised rates are seeded from the stored ones, so
-- nothing waits for Tax after the deploy.
DO $$
DECLARE
  blocking text;
BEGIN
  SELECT string_agg(format('%s/%s %s: %s', tenant_id, legal_entity_id, id, coalesce(document->>'vatRate', 'missing')), '; ')
    INTO blocking
    FROM (
      SELECT tenant_id, legal_entity_id, id, document
        FROM "demo_merchandise"."products"
       WHERE coalesce(document->>'vatRate', '') NOT IN ('21', '12', '10')
       ORDER BY tenant_id, legal_entity_id, id
       LIMIT 50
    ) AS unmapped;
  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION 'Products without a VAT classification mapping (only 21, 12 and 10 map): %', blocking
      USING ERRCODE = '23514', HINT = 'Run the merchandise VAT preflight and decide these products before deploying.';
  END IF;
  SELECT string_agg(format('%s/%s order %s: %s', tenant_id, legal_entity_id, id, rate), '; ')
    INTO blocking
    FROM (
      SELECT o.tenant_id, o.legal_entity_id, o.id, line->>'vatRate' AS rate
        FROM "demo_merchandise"."orders" AS o
        CROSS JOIN LATERAL jsonb_array_elements(o.document->'lines') AS line
       WHERE coalesce(line->>'vatRate', '') NOT IN ('21', '12', '10', '0')
       LIMIT 50
    ) AS unmapped;
  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION 'Order lines with an unknown VAT rate: %', blocking USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "demo_merchandise"."catalog_heads" ADD COLUMN "tax_rates" jsonb;--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ADD COLUMN "tax_classification_code" text;--> statement-breakpoint
-- Every company starts from the rates its products were stored with, as the same materialised state a sync with Tax
-- writes (`catalog_heads.tax_rates`), marked MIGRATION (not yet confirmed by Tax): standard 21 %, reduced 12 %, and each
-- product stored at 10 % (BOOK-IT) held at 10 % until Tax first prices the company. Storefront reads and orders keep
-- working exactly as before without any call to Tax; Tax's first answer that prices the company replaces this state.
UPDATE "demo_merchandise"."catalog_heads" AS h
   SET tax_rates = jsonb_build_object(
         'book', jsonb_build_object(
           'fingerprint', 'migration:cz.vat.standard=21;cz.vat.reduced=12',
           'periods', jsonb_build_array(
             jsonb_build_object('code', 'cz.vat.standard', 'effectiveFrom', '1970-01-01T00:00:00.000Z', 'ratePercent', '21'),
             jsonb_build_object('code', 'cz.vat.reduced', 'effectiveFrom', '1970-01-01T00:00:00.000Z', 'ratePercent', '12')),
           'regime', 'VAT_PAYER'),
         'source', 'MIGRATION',
         'syncedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       || coalesce((
         SELECT jsonb_build_object('heldProductRates', jsonb_object_agg(p.id, (p.document->>'vatRate')::integer))
           FROM "demo_merchandise"."products" AS p
          WHERE p.tenant_id = h.tenant_id AND p.legal_entity_id = h.legal_entity_id AND p.document->>'vatRate' = '10'
       ), '{}'::jsonb);--> statement-breakpoint
UPDATE "demo_merchandise"."products"
   SET tax_classification_code = CASE document->>'vatRate' WHEN '21' THEN 'cz.vat.standard' ELSE 'cz.vat.reduced' END,
       document = (document - 'vatRate') || jsonb_build_object(
         'taxClassificationCode',
         CASE document->>'vatRate' WHEN '21' THEN 'cz.vat.standard' ELSE 'cz.vat.reduced' END);--> statement-breakpoint
UPDATE "demo_merchandise"."orders" AS o
   SET document = jsonb_set(o.document, '{lines}', (
     SELECT coalesce(jsonb_agg(
       CASE line->>'vatRate'
         WHEN '21' THEN line || '{"taxClassificationCode":"cz.vat.standard"}'::jsonb
         WHEN '12' THEN line || '{"taxClassificationCode":"cz.vat.reduced"}'::jsonb
         ELSE line
       END ORDER BY position), '[]'::jsonb)
       FROM jsonb_array_elements(o.document->'lines') WITH ORDINALITY AS lines(line, position)))
 WHERE jsonb_typeof(o.document->'lines') = 'array';--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ALTER COLUMN "tax_classification_code" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "demo_merchandise_products_tax_classification" ON "demo_merchandise"."products" ("tenant_id","legal_entity_id","tax_classification_code");--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ADD CONSTRAINT "demo_merchandise_product_tax_classification" CHECK ("tax_classification_code" in ('cz.vat.standard', 'cz.vat.reduced'));
