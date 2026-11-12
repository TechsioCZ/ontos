-- Invoice lines, recurring-template lines and price-list items name the Tax VAT classification of their rate.
-- A stored 21 % becomes the standard classification (cz.vat.standard) and 12 % the reduced one (cz.vat.reduced).
-- Every other stored rate (10 %, 15 %, 0 %) keeps its rate and gets no classification, and an entry that already
-- names a classification or a VAT treatment is left as it is. Rates, amounts, totals and VAT recaps do not change,
-- so every invoice keeps exactly the amounts it was issued with. A stored line gets no Tax rule revision reference:
-- only lines priced from Tax carry one.
UPDATE "finance_billing"."finance_states" AS finance
   SET "state" = classified.state
  FROM (
    SELECT row_state.tenant_id,
           row_state.legal_entity_id,
           row_state.state
             || CASE WHEN jsonb_typeof(row_state.state -> 'invoices') = 'array' THEN jsonb_build_object(
                  'invoices',
                  (SELECT coalesce(jsonb_agg(
                            CASE WHEN jsonb_typeof(invoice -> 'lines') = 'array' THEN invoice || jsonb_build_object(
                              'lines',
                              (SELECT coalesce(jsonb_agg(
                                        CASE
                                          WHEN line ? 'vatClassification' OR line ? 'vatTreatment' THEN line
                                          WHEN line -> 'vatRate' = '21'::jsonb
                                            THEN line || '{"vatClassification":"cz.vat.standard"}'::jsonb
                                          WHEN line -> 'vatRate' = '12'::jsonb
                                            THEN line || '{"vatClassification":"cz.vat.reduced"}'::jsonb
                                          ELSE line
                                        END ORDER BY line_position), '[]'::jsonb)
                                 FROM jsonb_array_elements(invoice -> 'lines') WITH ORDINALITY AS lines(line, line_position)))
                            ELSE invoice END ORDER BY invoice_position), '[]'::jsonb)
                     FROM jsonb_array_elements(row_state.state -> 'invoices') WITH ORDINALITY AS invoices(invoice, invoice_position)))
                ELSE '{}'::jsonb END
             || CASE WHEN jsonb_typeof(row_state.state -> 'recurringTemplates') = 'array' THEN jsonb_build_object(
                  'recurringTemplates',
                  (SELECT coalesce(jsonb_agg(
                            CASE WHEN jsonb_typeof(template -> 'lines') = 'array' THEN template || jsonb_build_object(
                              'lines',
                              (SELECT coalesce(jsonb_agg(
                                        CASE
                                          WHEN line ? 'vatClassification' OR line ? 'vatTreatment' THEN line
                                          WHEN line -> 'vatRate' = '21'::jsonb
                                            THEN line || '{"vatClassification":"cz.vat.standard"}'::jsonb
                                          WHEN line -> 'vatRate' = '12'::jsonb
                                            THEN line || '{"vatClassification":"cz.vat.reduced"}'::jsonb
                                          ELSE line
                                        END ORDER BY line_position), '[]'::jsonb)
                                 FROM jsonb_array_elements(template -> 'lines') WITH ORDINALITY AS lines(line, line_position)))
                            ELSE template END ORDER BY template_position), '[]'::jsonb)
                     FROM jsonb_array_elements(row_state.state -> 'recurringTemplates')
                          WITH ORDINALITY AS templates(template, template_position)))
                ELSE '{}'::jsonb END
             || CASE WHEN jsonb_typeof(row_state.state -> 'priceList') = 'array' THEN jsonb_build_object(
                  'priceList',
                  (SELECT coalesce(jsonb_agg(
                            CASE
                              WHEN item ? 'vatClassification' OR item ? 'vatTreatment' THEN item
                              WHEN item -> 'vatRate' = '21'::jsonb
                                THEN item || '{"vatClassification":"cz.vat.standard"}'::jsonb
                              WHEN item -> 'vatRate' = '12'::jsonb
                                THEN item || '{"vatClassification":"cz.vat.reduced"}'::jsonb
                              ELSE item
                            END ORDER BY item_position), '[]'::jsonb)
                     FROM jsonb_array_elements(row_state.state -> 'priceList') WITH ORDINALITY AS items(item, item_position)))
                ELSE '{}'::jsonb END AS state
      FROM "finance_billing"."finance_states" AS row_state
  ) AS classified
 WHERE finance.tenant_id = classified.tenant_id
   AND finance.legal_entity_id = classified.legal_entity_id
   AND finance.state IS DISTINCT FROM classified.state;
