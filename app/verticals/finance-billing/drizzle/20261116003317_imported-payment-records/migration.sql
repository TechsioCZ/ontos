-- Every paid amount of an invoice becomes a dated payment record. A ledger can hold an invoice whose `paidMinor` no
-- payment record explains (a seeded or imported paid balance). Finance used to date that part on the invoice's
-- `updatedAt`, so any later edit moved the payment into the month of the edit, past the cash-flow opening date. Each
-- such part becomes one payment record now, with `source` IMPORT, dated on the invoice's `updatedAt` as stored today:
--   unrecorded = paidMinor - (earlier advances the invoice takes into account) - (its payment records)
-- This is exactly the rule of `withImportedPaymentRecords`, which creates the records of a seeded ledger, and it writes
-- the same record: id `<invoice>:import`, `paidOn` the UTC calendar date of `updatedAt`, `recordedAt` that instant.
--
-- A ledger with nothing unrecorded stays exactly as stored, revision included. A changed ledger gets the new records
-- appended after its existing ones, in invoice order (the list is created when the ledger has none), and its revision
-- goes up by one: a save the release still serving prepared from the ledger before this migration then fails as a
-- stale revision and is retried, so it can never drop the new records. That release decodes a record with `source` as
-- a plain payment record (an unknown key is dropped on decode), so a save it makes later keeps the record and its date
-- and loses only the IMPORT label. Amounts, totals, payment states and every existing record stay as they are.
--
-- Nothing is written unless every changed ledger stays readable by Finance. The migration refuses, naming the tenant,
-- the company and the invoice, when an invoice's `updatedAt` cannot be read as an instant here, when its reference is
-- empty or has surrounding whitespace (Finance trims it as JavaScript trims), when the new record's
-- id is already taken (by an existing record or by another invoice with the same reference), when the id or the invoice
-- reference is not a Finance text, or when the ledger would hold more than 5,000 payment records. Parts of a ledger
-- Finance itself cannot read (a list that is not a list, an amount that is not a whole number, an invoice without its
-- reference) give no record: such a ledger is unreadable before and after.
-- The release still serving writes this table while this runs. A long transaction of it would make the UPDATE below
-- wait, and every later write would queue behind it: fail the deploy fast instead. The migrator then fails, the new
-- container does not publish, the old release keeps serving, and the next deploy runs it again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- No ledger changes between computing the records and writing them: saves wait for this transaction (reads do not).
-- When the lock is not granted within the timeout, this statement fails, the migration writes nothing and the deploy
-- fails before the new release publishes.
LOCK TABLE "finance_billing"."finance_states" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- Finance reads an instant without an offset as UTC, and so does every conversion below.
SET LOCAL TIME ZONE 'UTC';--> statement-breakpoint
CREATE TEMP TABLE "finance_imported_payments" ON COMMIT DROP AS
  WITH ledgers AS (
    SELECT ledger."tenant_id", ledger."legal_entity_id", ledger."state",
           CASE WHEN jsonb_typeof(ledger."state" -> 'manualPayments') = 'array' THEN ledger."state" -> 'manualPayments'
                ELSE '[]'::jsonb END AS payments
      FROM "finance_billing"."finance_states" AS ledger
     WHERE jsonb_typeof(ledger."state" -> 'invoices') = 'array'
       AND (ledger."state" -> 'manualPayments' IS NULL OR jsonb_typeof(ledger."state" -> 'manualPayments') = 'array')
  ),
  invoices AS (
    SELECT ledgers."tenant_id", ledgers."legal_entity_id", ledgers.payments, entries.invoice, entries.position,
           entries.invoice -> 'ref' ->> 'resourceId' AS resource_id,
           CASE WHEN jsonb_typeof(entries.invoice -> 'updatedAt') = 'string'
                -- Finance keeps the milliseconds of a finer instant and never rounds them up.
                THEN regexp_replace(entries.invoice ->> 'updatedAt', '(\.\d{3})\d+', '\1') END AS stamp
      FROM ledgers, jsonb_array_elements(ledgers."state" -> 'invoices') WITH ORDINALITY AS entries(invoice, position)
     WHERE jsonb_typeof(entries.invoice) = 'object'
       AND jsonb_typeof(entries.invoice -> 'ref' -> 'resourceId') = 'string'
  ),
  -- An amount is a whole JSON number; the nested CASE casts nothing else, so no stored value can abort the migration.
  amounts AS (
    SELECT invoices.*,
           CASE WHEN jsonb_typeof((invoice -> 'paidMinor')) = 'number'
                THEN CASE WHEN ((invoice -> 'paidMinor') #>> '{}')::numeric = trunc(((invoice -> 'paidMinor') #>> '{}')::numeric)
                          THEN ((invoice -> 'paidMinor') #>> '{}')::numeric END END AS paid,
           CASE
             WHEN invoice -> 'priorSettlement' IS NULL THEN 0
             WHEN jsonb_typeof(invoice -> 'priorSettlement' -> 'entries') = 'array' THEN (
               SELECT CASE WHEN bool_and(amount IS NOT NULL) IS FALSE THEN NULL ELSE coalesce(sum(amount), 0) END
                 FROM (SELECT CASE WHEN jsonb_typeof((entry -> 'amountMinor')) = 'number'
                THEN CASE WHEN ((entry -> 'amountMinor') #>> '{}')::numeric = trunc(((entry -> 'amountMinor') #>> '{}')::numeric)
                          THEN ((entry -> 'amountMinor') #>> '{}')::numeric END END AS amount
                         FROM jsonb_array_elements(invoice -> 'priorSettlement' -> 'entries') AS advances(entry)) AS listed)
           END AS settled,
           (SELECT CASE WHEN bool_and(amount IS NOT NULL) IS FALSE THEN NULL ELSE coalesce(sum(amount), 0) END
              FROM (SELECT CASE WHEN jsonb_typeof((payment -> 'amountMinor')) = 'number'
                THEN CASE WHEN ((payment -> 'amountMinor') #>> '{}')::numeric = trunc(((payment -> 'amountMinor') #>> '{}')::numeric)
                          THEN ((payment -> 'amountMinor') #>> '{}')::numeric END END AS amount
                      FROM jsonb_array_elements(invoices.payments) AS listed_payments(payment)
                     -- Finance reads a record's invoice reference trimmed.
                     WHERE btrim(payment ->> 'invoiceResourceId', E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') = invoices.resource_id) AS listed) AS recorded
      FROM invoices
  ),
  unrecorded AS (
    SELECT amounts.*, paid - settled - recorded AS amount_minor,
           CASE WHEN stamp ~ '^\d{4}-\d{2}-\d{2}' AND pg_input_is_valid(stamp, 'timestamp with time zone')
                THEN stamp::timestamptz END AS paid_at
      FROM amounts
     WHERE paid - settled - recorded > 0
  )
  SELECT "tenant_id", "legal_entity_id", position, resource_id, amount_minor, paid_at,
         resource_id || ':import' AS record_id,
         jsonb_array_length(payments) AS existing_records,
         -- Finance trims every stored id as JavaScript trims; the ids are compared as Finance reads them.
         coalesce((SELECT array_agg(btrim(payment ->> 'id', E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'))
                     FROM jsonb_array_elements(payments) AS listed(payment)),
                  '{}'::text[]) AS existing_ids,
         jsonb_build_object(
           'amountMinor', amount_minor,
           'id', resource_id || ':import',
           'invoiceResourceId', resource_id,
           'paidOn', to_char(paid_at, 'YYYY-MM-DD'),
           'recordedAt', to_char(paid_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'source', 'IMPORT') AS record
    FROM unrecorded;--> statement-breakpoint
-- Every check runs before anything is written, over every ledger the migration would change; the first problem in
-- ledger and invoice order is reported.
DO $$
  DECLARE
    refusal record;
  BEGIN
    SELECT checked."tenant_id", checked."legal_entity_id", checked.resource_id, checked.problem
      INTO refusal
      FROM (SELECT imported."tenant_id", imported."legal_entity_id", imported.resource_id, imported.position,
                   CASE
                     -- A reference is written only as Finance would read it back: trimmed as JavaScript trims.
                     WHEN btrim(imported.resource_id, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> imported.resource_id
                          OR btrim(imported.resource_id, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') = ''
                       THEN 'its reference is empty or has surrounding whitespace'
                     WHEN char_length(imported.record_id) > 500
                       THEN 'its reference makes no readable payment record id'
                     WHEN imported.paid_at IS NULL THEN 'its updatedAt cannot be read as an instant'
                     WHEN imported.record_id = ANY (imported.existing_ids)
                       THEN 'a payment record already has the id ' || imported.record_id
                     WHEN count(*) OVER (PARTITION BY imported."tenant_id", imported."legal_entity_id",
                                                      imported.record_id) > 1
                       THEN 'another invoice of the ledger has the same reference'
                     WHEN imported.existing_records
                            + count(*) OVER (PARTITION BY imported."tenant_id", imported."legal_entity_id") > 5000
                       THEN 'the ledger would hold more than 5000 payment records'
                   END AS problem
              FROM pg_temp."finance_imported_payments" AS imported) AS checked
     WHERE checked.problem IS NOT NULL
     ORDER BY checked."tenant_id", checked."legal_entity_id", checked.position
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Finance ledger of tenant % company %: the paid amount of invoice % cannot become a payment record: %',
        refusal."tenant_id", refusal."legal_entity_id", refusal.resource_id, refusal.problem;
    END IF;
  END
$$;--> statement-breakpoint
UPDATE "finance_billing"."finance_states" AS ledger
   SET "state" = ledger."state" || jsonb_build_object(
         'manualPayments',
         coalesce(ledger."state" -> 'manualPayments', '[]'::jsonb) || imports.records),
       "revision" = ledger."revision" + 1
  FROM (SELECT "tenant_id", "legal_entity_id", jsonb_agg(record ORDER BY position) AS records
          FROM pg_temp."finance_imported_payments"
         GROUP BY "tenant_id", "legal_entity_id") AS imports
 WHERE ledger."tenant_id" = imports."tenant_id"
   AND ledger."legal_entity_id" = imports."legal_entity_id";--> statement-breakpoint
DROP TABLE pg_temp."finance_imported_payments";--> statement-breakpoint
SET LOCAL TIME ZONE DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
