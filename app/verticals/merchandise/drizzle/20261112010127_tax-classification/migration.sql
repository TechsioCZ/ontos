-- Products name a VAT classification instead of a rate; Tax (commerce.tax) holds the rates. Products: 21 -> standard,
-- 12 and 10 -> reduced; any other product rate (0 included) stops the deploy (`vat:preflight` lists them first).
-- Prices are never recomputed: every stored net, gross, tier and market price stays exactly as stored (a 10 % product
-- keeps its gross; only the VAT split of new orders changes). Order lines keep their stored rate and amounts and gain
-- the classification only where it is unambiguous: 21 -> standard, 12 -> reduced, anything else (10 %, 0 %) none.
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
