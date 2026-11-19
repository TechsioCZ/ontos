-- Marks the orphan source variants of the AKROS source import in every company holding it. Products imported before
-- `sourceBaseProduct` existed have no key, and the storefront listing reads an absent key as a main product, so the
-- AKROS and ŠroubShop listings still show the 232 variants that were never a main product in the source. Nothing on
-- deploy re-imports them: the AKROS seed runs by hand for one company and the playground company is copied from a frozen
-- snapshot. The ids below are the source groups whose product the import marks `sourceBaseProduct: false` in
-- akros-storefront/src/catalog-import/generated/catalog.generated.json (the integration test keeps them equal); the real,
-- pseudonymised and playground copies keep the ids and source groups, so one list finds them all.
-- Only `false` is written, only where the key is absent and the id is the import's own `product-<source group>`: a
-- stored value is never overwritten, and an absent key already means a main product. Nothing else changes: no other key,
-- no column, no variant, no revision. Idempotent: a second run finds no product without the key.
-- Safe while either release serves: the release before never reads the key and decodes past it; a product it rewrites
-- in the overlap drops the key and lists as before. This release lists only after its migrations ran.
-- The migration administrator is not bound by the table's row-level security: every tenant's rows change.
-- The table is locked by every catalogue write; never queue them behind this statement for long.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
UPDATE "demo_merchandise"."products"
   SET document = document || '{"sourceBaseProduct": false}'::jsonb
 WHERE source_group_id = ANY (ARRAY[
    '2022', '2182', '13987', '14386', '15251', '15610', '15611', '15612', '15613', '15614', '15615', '15616',
    '15617', '15618', '15619', '15620', '15621', '15622', '15623', '15624', '15625', '15626', '15627', '15628',
    '15629', '15630', '15631', '15633', '15634', '15635', '15636', '15637', '15638', '15639', '15640', '15641',
    '15642', '15643', '16702', '16741', '19266', '19925', '20715', '22395', '24278', '25178', '25181', '26378',
    '26379', '27741', '27847', '28110', '28189', '28198', '28249', '28290', '28314', '28330', '28403', '28566',
    '29381', '29493', '29501', '29847', '29926', '30428', '30429', '30430', '30431', '30459', '30488', '30489',
    '30612', '30918', '31357', '31728', '31935', '31941', '32172', '32173', '32257', '32321', '32883', '32924',
    '33147', '33149', '33209', '33321', '33426', '33427', '33428', '33492', '33576', '33879', '33910', '33951',
    '34040', '34164', '34284', '34285', '34286', '34287', '34291', '34296', '34297', '34323', '34388', '34413',
    '34414', '34417', '34419', '34420', '34423', '34424', '34425', '34429', '34431', '34432', '34436', '34446',
    '34452', '34456', '34458', '34459', '34465', '34470', '34482', '34494', '34505', '34509', '34524', '34525',
    '34534', '34552', '34554', '34561', '34572', '34573', '34725', '34839', '34855', '34856', '34875', '34876',
    '34877', '34878', '34924', '34937', '34939', '34942', '34943', '34947', '34948', '34955', '34956', '34957',
    '34966', '34967', '34968', '34969', '34971', '34972', '34973', '34975', '34976', '34977', '34978', '34979',
    '34980', '34982', '34993', '35014', '35023', '35078', '35097', '35102', '35105', '35108', '35113', '35114',
    '35116', '35130', '35161', '35248', '35252', '35267', '35269', '35340', '35353', '35354', '35361', '35372',
    '35375', '35376', '35390', '35391', '35392', '35393', '35394', '35395', '35396', '35397', '35419', '35427',
    '35444', '35450', '35454', '35460', '35559', '35578', '35579', '35589', '35594', '35654', '35656', '35657',
    '35660', '35665', '35668', '35671', '35672', '35682', '35699', '35704', '37773', '37776', '37777', '37779',
    '37782', '37826', '37827', '37841'
   ]::text[])
   AND id = 'product-' || source_group_id
   AND NOT document ? 'sourceBaseProduct';--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;