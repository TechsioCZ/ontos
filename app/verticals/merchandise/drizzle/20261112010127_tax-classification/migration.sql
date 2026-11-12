-- Products name a VAT classification instead of a rate; Tax (commerce.tax) holds the rates. Mapping: 21 -> standard,
-- 12 and 10 -> reduced. Any other product rate (0 included) stops the deploy: decide those products first
-- (`pnpm --filter @app/merchandise vat:preflight` lists them). Order lines keep their stored rate (history keeps its
-- numbers) and gain the classification by the same mapping; a 0 % line keeps 0 % and gets no classification.
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
-- A product at 10 % becomes reduced (12 %): its net price stays, its gross prices are recomputed from net at 12 %.
UPDATE "demo_merchandise"."price_tiers" AS t
   SET price_minor = t.price_excluding_vat_minor + floor((t.price_excluding_vat_minor * 12 + 50) / 100)
  FROM "demo_merchandise"."products" AS p
 WHERE p.tenant_id = t.tenant_id AND p.legal_entity_id = t.legal_entity_id AND p.id = t.product_id
   AND p.document->>'vatRate' = '10';--> statement-breakpoint
UPDATE "demo_merchandise"."product_variants" AS v
   SET gross_price_minor = coalesce(
     (SELECT t.price_minor FROM "demo_merchandise"."price_tiers" AS t
       WHERE t.tenant_id = v.tenant_id AND t.legal_entity_id = v.legal_entity_id AND t.product_id = v.product_id
         AND t.variant_position = v.position AND t.position = 0),
     v.price_minor + floor((v.price_minor * 12 + 50) / 100))
  FROM "demo_merchandise"."products" AS p
 WHERE p.tenant_id = v.tenant_id AND p.legal_entity_id = v.legal_entity_id AND p.id = v.product_id
   AND p.document->>'vatRate' = '10' AND v.price_minor IS NOT NULL;--> statement-breakpoint
UPDATE "demo_merchandise"."products" AS p
   SET gross_price_minor = CASE
     WHEN EXISTS (SELECT 1 FROM "demo_merchandise"."product_variants" AS v
                   WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
                     AND v.variant_id IS NOT NULL AND v.price_minor IS NOT NULL)
     THEN (SELECT min(v.gross_price_minor) FROM "demo_merchandise"."product_variants" AS v
            WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
              AND v.variant_id IS NOT NULL AND v.price_minor IS NOT NULL
              AND (v.active OR NOT EXISTS (
                SELECT 1 FROM "demo_merchandise"."product_variants" AS a
                 WHERE a.tenant_id = p.tenant_id AND a.legal_entity_id = p.legal_entity_id AND a.product_id = p.id
                   AND a.variant_id IS NOT NULL AND a.price_minor IS NOT NULL AND a.active)))
     ELSE coalesce(
       (SELECT t.price_minor FROM "demo_merchandise"."price_tiers" AS t
         WHERE t.tenant_id = p.tenant_id AND t.legal_entity_id = p.legal_entity_id AND t.product_id = p.id
           AND t.variant_position = -1 AND t.position = 0),
       p.current_price_minor + floor((p.current_price_minor * 12 + 50) / 100))
   END
 WHERE p.document->>'vatRate' = '10';--> statement-breakpoint
UPDATE "demo_merchandise"."products"
   SET tax_classification_code = CASE document->>'vatRate' WHEN '21' THEN 'cz.vat.standard' ELSE 'cz.vat.reduced' END,
       document = (document - 'vatRate') || jsonb_build_object(
         'taxClassificationCode',
         CASE document->>'vatRate' WHEN '21' THEN 'cz.vat.standard' ELSE 'cz.vat.reduced' END);--> statement-breakpoint
UPDATE "demo_merchandise"."orders" AS o
   SET document = jsonb_set(o.document, '{lines}', (
     SELECT jsonb_agg(
       CASE line->>'vatRate'
         WHEN '21' THEN line || '{"taxClassificationCode":"cz.vat.standard"}'::jsonb
         WHEN '12' THEN line || '{"taxClassificationCode":"cz.vat.reduced"}'::jsonb
         WHEN '10' THEN line || '{"taxClassificationCode":"cz.vat.reduced"}'::jsonb
         ELSE line
       END ORDER BY position)
       FROM jsonb_array_elements(o.document->'lines') WITH ORDINALITY AS lines(line, position)))
 WHERE jsonb_typeof(o.document->'lines') = 'array';--> statement-breakpoint
-- Stored gross prices were computed at 21 % (standard) and 12 % (reduced, after the recompute above). Nothing is
-- sellable until Merchandise first reads the company's rates from Tax; that sync reprices only a classification whose
-- Tax rate differs from these.
UPDATE "demo_merchandise"."catalog_heads"
   SET tax_rates = '{"priced":{"cz.vat.standard":21,"cz.vat.reduced":12}}'::jsonb;--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ALTER COLUMN "tax_classification_code" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "demo_merchandise_products_tax_classification" ON "demo_merchandise"."products" ("tenant_id","legal_entity_id","tax_classification_code");--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ADD CONSTRAINT "demo_merchandise_product_tax_classification" CHECK ("tax_classification_code" in ('cz.vat.standard', 'cz.vat.reduced'));
