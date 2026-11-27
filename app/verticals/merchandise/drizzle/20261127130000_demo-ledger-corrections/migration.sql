-- Corrects leftover demo data in the stock ledger that operators and the demo stage customer read under Pohyby.
--
-- 1. ŠroubShop (tenant 70000000-0000-4000-8000-000000000020, company 71000000-0000-4000-8000-000000000024, the
--    seed's `akrosDemoLegalEntityId`) was seeded with the real-AKROS builder before its neutral copy existed, so its
--    opening receipts still read 'Výchozí sklad AKROS (demo)': the ŠroubShop operator sees another company's name in
--    their own ledger. The seed and the in-app reset already write 'Výchozí sklad ŠroubShop (demo)'
--    (akros-pseudonym.ts), but nothing rewrites a stored movement: the seed merge adds only missing ids. Only that
--    exact note of that company's receipts changes; the real-AKROS builder and every other company keep their notes.
--    N1 never had it.
--
-- 2. Proof scripts recorded real movements on 26 and 27 November 2026 on two variants operators look at. Per variant
--    they sum to exactly 0, so no stored stock and no later balance depends on them. Each set is replaced by one
--    ADJUSTMENT of 0, recorded now, that says what happened: it is the newest row of its ledger and shows the unchanged
--    balance. The stock columns are the ledger's sums and stay as they are. Removed, by id (at UTC, delta, reason,
--    note):
--   ŠroubShop product-20532, variant item-5569 (10799700030030), balance 10, one entry
--   4819d4c7-2612-4c47-9cb7-8f8be38f3644:
--     d6f3e1fd-87ae-49f4-86f7-1038fce695ed  2026-11-27T00:55:15Z  +190  ADJUSTMENT availability-one-rule: stav = 1 balení
--     62c8740a-cec7-47b5-b845-fefc3f36430a  2026-11-27T00:55:45Z  +190  ADJUSTMENT availability-one-rule: stav = 1 balení
--     7b4ad3c0-77dd-4315-ba3f-11d171f5395a  2026-11-27T00:56:17Z  +190  ADJUSTMENT availability-one-rule: stav = 1 balení
--     efc59147-ae2d-4549-b904-0fc59f877d79  2026-11-27T00:56:49Z  +190  ADJUSTMENT availability-one-rule: stav = 1 balení
--     e848f7f5-bff0-4dff-b5e8-87c579acd6c7  2026-11-27T00:57:23Z  +190  ADJUSTMENT availability-one-rule: stav = 1 balení
--     535eec9e-a164-4432-8ca4-6d199d5f6533  2026-11-27T00:59:07Z  -950  ADJUSTMENT availability-one-rule: oprava zdvojeného zápisu
--     5b1f833c-6803-46a1-b857-179522216506  2026-11-27T00:59:42Z  +190  ADJUSTMENT availability-one-rule: stav = 1 balení
--     b2e1683c-a77d-4476-b3fd-bfebf797896a  2026-11-27T01:02:55Z  +10   ADJUSTMENT availability-one-rule: stav nad 1 balení
--     b07dd98d-e003-4882-baa6-b333da0ea19f  2026-11-27T01:04:05Z  -200  ADJUSTMENT availability-one-rule: obnova na 10
--     9866ae14-99b4-4d8d-8fe6-d02ccf9c4f3f  2026-11-27T02:11:57Z  +200  RECEIPT    qty-package-ship dočasný příjem pro ověření
--     40074d1a-937f-4757-8fc5-b00f0900100a  2026-11-27T02:16:30Z  -200  ADJUSTMENT qty-package-ship vrácení dočasného příjmu
--     255c08d0-01da-47dc-9f1e-069382522466  2026-11-27T02:46:54Z  +1    ADJUSTMENT pohyby-proof +1 2026-11-27T02:46:52.385Z
--     f75bc01f-f60d-45b3-9b59-38b7f1792271  2026-11-27T02:47:02Z  -1    ADJUSTMENT pohyby-proof −1 2026-11-27T02:46:52.385Z
--   AKROS playground product-25577, variant item-11405 (10835300330020), balance 6, one entry
--   3c039d83-e2b5-4954-a7b6-e385c7e3150e:
--     d08c1fa8-89c8-4337-8304-f926d9b4367e  2026-11-26T20:44:26Z  +10   RECEIPT    demo-overeni prijem
--     23295d91-16da-4dea-8c5f-166f0027f7f2  2026-11-26T20:44:54Z  -10   ISSUE      demo-overeni vraceni
--     e3d926c3-1faa-4a51-a9ee-e351a24c4876  2026-11-26T21:50:26Z  +10   RECEIPT    R4 overeni prijem
--     6a6354c8-b499-4ca2-94f1-c147df47742f  2026-11-26T21:51:06Z  -10   ISSUE      R4 overeni vraceni
--     a852672b-d86a-4dab-86bd-e811c625fcbb  2026-11-26T21:52:54Z  +10   RECEIPT    R4 overeni prijem 2
--     260efe7b-31cb-495a-b52b-d28d6fea4a90  2026-11-26T21:53:32Z  -10   ISSUE      R4 overeni vraceni 2
--     346afbeb-8c58-4f7f-a17e-f116f0c5b7c1  2026-11-27T00:47:10Z  +4    ADJUSTMENT availability-one-rule: stav = 1 balení
--     5881b88e-03ff-45f9-91e6-0a676dd2a1b7  2026-11-27T00:50:58Z  +5    ADJUSTMENT availability-one-rule: stav nad 1 balení
--     250bc991-0bcc-4c58-8bf6-47c89530218e  2026-11-27T00:52:47Z  -9    ADJUSTMENT availability-one-rule: obnova na 6
--     ce21f7f8-b44a-4e50-97a5-23a0bdea143c  2026-11-27T02:11:56Z  +9    RECEIPT    qty-package-ship dočasný příjem pro ověření
--     0a1cefdd-2140-42c7-bd92-13a73bfaf1d3  2026-11-27T02:16:30Z  -9    ADJUSTMENT qty-package-ship vrácení dočasného příjmu
--     5d335244-27ce-453a-bd7f-f422ed183217  2026-11-27T02:46:24Z  +1    ADJUSTMENT pohyby-proof +1 2026-11-27T02:46:21.140Z
--     285415ed-3a82-45f8-8f7a-7604ed445e76  2026-11-27T02:46:30Z  -1    ADJUSTMENT pohyby-proof −1 2026-11-27T02:46:21.140Z
--    A set is removed only while all 13 of its rows are present in one company and sum to 0; anywhere else the ids
--    do not exist and nothing happens.
--
-- Nothing else changes: no stock, delta, ordinal, product, variant or revision. Idempotent: a second run finds no note
-- to rewrite and no proof row to remove. Safe while either release serves: both read and write the ledger alike.
-- The migration administrator is not bound by the table's row-level security.
-- Every stock write appends to this table; never queue them behind these statements for long.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
UPDATE "demo_merchandise"."stock_movements"
   SET note = 'Výchozí sklad ŠroubShop (demo)'
 WHERE tenant_id = '70000000-0000-4000-8000-000000000020'
   AND legal_entity_id = '71000000-0000-4000-8000-000000000024'
   AND reason = 'RECEIPT'
   AND note = 'Výchozí sklad AKROS (demo)';--> statement-breakpoint
WITH proof AS (
  SELECT tenant_id, legal_entity_id
    FROM "demo_merchandise"."stock_movements"
   WHERE id = ANY (ARRAY[
    'd6f3e1fd-87ae-49f4-86f7-1038fce695ed',
    '62c8740a-cec7-47b5-b845-fefc3f36430a',
    '7b4ad3c0-77dd-4315-ba3f-11d171f5395a',
    'efc59147-ae2d-4549-b904-0fc59f877d79',
    'e848f7f5-bff0-4dff-b5e8-87c579acd6c7',
    '535eec9e-a164-4432-8ca4-6d199d5f6533',
    '5b1f833c-6803-46a1-b857-179522216506',
    'b2e1683c-a77d-4476-b3fd-bfebf797896a',
    'b07dd98d-e003-4882-baa6-b333da0ea19f',
    '9866ae14-99b4-4d8d-8fe6-d02ccf9c4f3f',
    '40074d1a-937f-4757-8fc5-b00f0900100a',
    '255c08d0-01da-47dc-9f1e-069382522466',
    'f75bc01f-f60d-45b3-9b59-38b7f1792271'
   ]::text[])
     AND product_id = 'product-20532' AND variant_id = 'item-5569'
   GROUP BY tenant_id, legal_entity_id
  HAVING count(*) = 13 AND sum(delta) = 0
), removed AS (
  DELETE FROM "demo_merchandise"."stock_movements" m
   USING proof
   WHERE m.tenant_id = proof.tenant_id AND m.legal_entity_id = proof.legal_entity_id
     AND m.product_id = 'product-20532' AND m.variant_id = 'item-5569'
     AND m.id = ANY (ARRAY[
    'd6f3e1fd-87ae-49f4-86f7-1038fce695ed',
    '62c8740a-cec7-47b5-b845-fefc3f36430a',
    '7b4ad3c0-77dd-4315-ba3f-11d171f5395a',
    'efc59147-ae2d-4549-b904-0fc59f877d79',
    'e848f7f5-bff0-4dff-b5e8-87c579acd6c7',
    '535eec9e-a164-4432-8ca4-6d199d5f6533',
    '5b1f833c-6803-46a1-b857-179522216506',
    'b2e1683c-a77d-4476-b3fd-bfebf797896a',
    'b07dd98d-e003-4882-baa6-b333da0ea19f',
    '9866ae14-99b4-4d8d-8fe6-d02ccf9c4f3f',
    '40074d1a-937f-4757-8fc5-b00f0900100a',
    '255c08d0-01da-47dc-9f1e-069382522466',
    'f75bc01f-f60d-45b3-9b59-38b7f1792271'
   ]::text[])
  RETURNING m.tenant_id, m.legal_entity_id
)
INSERT INTO "demo_merchandise"."stock_movements"
       (tenant_id, legal_entity_id, id, "at", delta, note, product_id, reason, variant_id)
SELECT company.tenant_id, company.legal_entity_id, '4819d4c7-2612-4c47-9cb7-8f8be38f3644', now(), 0,
       'Technická oprava: sloučeno 13 ověřovacích pohybů z 27. 11. 2026, které se vzájemně ruší (součet 0). Stav skladu se nemění.',
       'product-20532', 'ADJUSTMENT', 'item-5569'
  FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM removed) company
    ON CONFLICT DO NOTHING;--> statement-breakpoint
WITH proof AS (
  SELECT tenant_id, legal_entity_id
    FROM "demo_merchandise"."stock_movements"
   WHERE id = ANY (ARRAY[
    'd08c1fa8-89c8-4337-8304-f926d9b4367e',
    '23295d91-16da-4dea-8c5f-166f0027f7f2',
    'e3d926c3-1faa-4a51-a9ee-e351a24c4876',
    '6a6354c8-b499-4ca2-94f1-c147df47742f',
    'a852672b-d86a-4dab-86bd-e811c625fcbb',
    '260efe7b-31cb-495a-b52b-d28d6fea4a90',
    '346afbeb-8c58-4f7f-a17e-f116f0c5b7c1',
    '5881b88e-03ff-45f9-91e6-0a676dd2a1b7',
    '250bc991-0bcc-4c58-8bf6-47c89530218e',
    'ce21f7f8-b44a-4e50-97a5-23a0bdea143c',
    '0a1cefdd-2140-42c7-bd92-13a73bfaf1d3',
    '5d335244-27ce-453a-bd7f-f422ed183217',
    '285415ed-3a82-45f8-8f7a-7604ed445e76'
   ]::text[])
     AND product_id = 'product-25577' AND variant_id = 'item-11405'
   GROUP BY tenant_id, legal_entity_id
  HAVING count(*) = 13 AND sum(delta) = 0
), removed AS (
  DELETE FROM "demo_merchandise"."stock_movements" m
   USING proof
   WHERE m.tenant_id = proof.tenant_id AND m.legal_entity_id = proof.legal_entity_id
     AND m.product_id = 'product-25577' AND m.variant_id = 'item-11405'
     AND m.id = ANY (ARRAY[
    'd08c1fa8-89c8-4337-8304-f926d9b4367e',
    '23295d91-16da-4dea-8c5f-166f0027f7f2',
    'e3d926c3-1faa-4a51-a9ee-e351a24c4876',
    '6a6354c8-b499-4ca2-94f1-c147df47742f',
    'a852672b-d86a-4dab-86bd-e811c625fcbb',
    '260efe7b-31cb-495a-b52b-d28d6fea4a90',
    '346afbeb-8c58-4f7f-a17e-f116f0c5b7c1',
    '5881b88e-03ff-45f9-91e6-0a676dd2a1b7',
    '250bc991-0bcc-4c58-8bf6-47c89530218e',
    'ce21f7f8-b44a-4e50-97a5-23a0bdea143c',
    '0a1cefdd-2140-42c7-bd92-13a73bfaf1d3',
    '5d335244-27ce-453a-bd7f-f422ed183217',
    '285415ed-3a82-45f8-8f7a-7604ed445e76'
   ]::text[])
  RETURNING m.tenant_id, m.legal_entity_id
)
INSERT INTO "demo_merchandise"."stock_movements"
       (tenant_id, legal_entity_id, id, "at", delta, note, product_id, reason, variant_id)
SELECT company.tenant_id, company.legal_entity_id, '3c039d83-e2b5-4954-a7b6-e385c7e3150e', now(), 0,
       'Technická oprava: sloučeno 13 ověřovacích pohybů z 26. a 27. 11. 2026, které se vzájemně ruší (součet 0). Stav skladu se nemění.',
       'product-25577', 'ADJUSTMENT', 'item-11405'
  FROM (SELECT DISTINCT tenant_id, legal_entity_id FROM removed) company
    ON CONFLICT DO NOTHING;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
