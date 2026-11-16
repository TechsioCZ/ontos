-- Every paid amount of an invoice becomes a dated payment record. A ledger can hold an invoice whose `paidMinor` no
-- payment record explains (a seeded or imported paid balance). Finance used to date that part on the invoice's
-- `updatedAt`, so any later edit moved the payment into the month of the edit, past the cash-flow opening date. Each
-- such part becomes one payment record now, with `source` IMPORT, dated on the invoice's `updatedAt` as stored today:
--   unrecorded = paidMinor - (earlier advances the invoice takes into account) - (its payment records)
-- An invoice with nothing unrecorded, and a ledger with no invoices, no payments or nothing to record, stays exactly as
-- stored. Amounts, totals, payment states and every existing record stay as they are; records are only appended, in
-- invoice order, after the existing ones. A part of a ledger nobody could read (not a list, a non-integer amount, an
-- invoice without its reference or timestamp) is left as stored, and so is an invoice whose own values are odd. The
-- same rule creates the records of a seeded ledger (`withImportedPaymentRecords`).
--
-- Expand step. The release before this one keeps serving until the new one publishes (minutes). It rewrites a
-- company's whole ledger on every write without the `source` it does not know, and a write it prepared from a ledger
-- read before this backfill would drop the new records. So a trigger keeps, on every write, each stored IMPORT record:
-- its `source` when the write stripped it, and the whole record when the write left it out while the invoice still
-- carries that paid amount unrecorded. The contract step drops the trigger and its functions.
-- The release still serving writes this table while this runs. A long transaction of it would make the UPDATE below
-- wait, and every later write would queue behind it: fail the deploy fast instead. The migrator then fails, the new
-- container does not publish, the old release keeps serving, and the next deploy runs it again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- Every function below has a fixed search path and names its own objects by schema.
-- A stored whole-number amount, or NULL for anything else.
CREATE FUNCTION "finance_billing"."payment_record_amount"(p_value jsonb) RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE
             WHEN jsonb_typeof(p_value) = 'number' THEN
               CASE WHEN (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
                 THEN (p_value #>> '{}')::numeric END
           END
  $$;--> statement-breakpoint
-- The UTC calendar date of a stored instant, or NULL when it is not an ISO instant with its offset.
CREATE FUNCTION "finance_billing"."payment_record_date"(p_value jsonb) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE
             WHEN jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN NULL
             WHEN (p_value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' THEN left(p_value #>> '{}', 10)
             WHEN (p_value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$'
               THEN to_char(((p_value #>> '{}')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
           END
  $$;--> statement-breakpoint
-- Each invoice of a ledger with the part of its paid amount no payment record explains (NULL when any of the amounts
-- it is made of is not a whole number) and the date that part takes.
CREATE FUNCTION "finance_billing"."unrecorded_payments"(p_state jsonb)
  RETURNS TABLE (invoice_position bigint, invoice_resource_id text, unrecorded_minor numeric, paid_on text,
                 recorded_at jsonb)
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    WITH payments AS (
      SELECT payment
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(p_state -> 'manualPayments') = 'array' THEN p_state -> 'manualPayments'
                    ELSE '[]'::jsonb END) AS entries(payment)
    ),
    invoices AS (
      SELECT invoice, entries.position, invoice -> 'ref' ->> 'resourceId' AS resource_id
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(p_state -> 'invoices') = 'array' THEN p_state -> 'invoices'
                    ELSE '[]'::jsonb END) WITH ORDINALITY AS entries(invoice, position)
       WHERE jsonb_typeof(invoice) = 'object'
    )
    SELECT invoices.position,
           invoices.resource_id,
           "finance_billing"."payment_record_amount"(invoice -> 'paidMinor')
             - CASE
                 WHEN NOT invoice ? 'priorSettlement' THEN 0
                 WHEN jsonb_typeof(invoice -> 'priorSettlement' -> 'entries') = 'array' THEN (
                   SELECT CASE WHEN bool_and(amount IS NOT NULL) IS FALSE THEN NULL ELSE coalesce(sum(amount), 0) END
                     FROM (SELECT "finance_billing"."payment_record_amount"(entry -> 'amountMinor') AS amount
                             FROM jsonb_array_elements(invoice -> 'priorSettlement' -> 'entries') AS advances(entry)) AS amounts)
               END
             - (SELECT CASE WHEN bool_and(amount IS NOT NULL) IS FALSE THEN NULL ELSE coalesce(sum(amount), 0) END
                  FROM (SELECT "finance_billing"."payment_record_amount"(payment -> 'amountMinor') AS amount
                          FROM payments
                         WHERE payment ->> 'invoiceResourceId' = invoices.resource_id) AS amounts),
           "finance_billing"."payment_record_date"(invoice -> 'updatedAt'),
           invoice -> 'updatedAt'
      FROM invoices
     WHERE invoices.resource_id IS NOT NULL
  $$;--> statement-breakpoint
-- A ledger with one IMPORT payment record for the unrecorded part of each invoice.
CREATE FUNCTION "finance_billing"."imported_payment_records_state"(p_state jsonb) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    WITH imported AS (
      SELECT invoice_position,
             jsonb_build_object(
               'amountMinor', unrecorded_minor,
               'id', invoice_resource_id || ':import',
               'invoiceResourceId', invoice_resource_id,
               'paidOn', paid_on,
               'recordedAt', recorded_at,
               'source', 'IMPORT') AS record
        FROM "finance_billing"."unrecorded_payments"(p_state)
       WHERE unrecorded_minor > 0 AND paid_on IS NOT NULL
    )
    SELECT CASE
             WHEN NOT EXISTS (SELECT 1 FROM imported) THEN p_state
             -- A ledger whose payment list is not a list stays as stored.
             WHEN p_state ? 'manualPayments' AND jsonb_typeof(p_state -> 'manualPayments') IS DISTINCT FROM 'array'
               THEN p_state
             ELSE p_state || jsonb_build_object(
               'manualPayments',
               coalesce(p_state -> 'manualPayments', '[]'::jsonb)
                 || (SELECT jsonb_agg(record ORDER BY invoice_position) FROM imported))
           END
  $$;--> statement-breakpoint
UPDATE "finance_billing"."finance_states"
   SET "state" = "finance_billing"."imported_payment_records_state"("state")
 WHERE "state" IS DISTINCT FROM "finance_billing"."imported_payment_records_state"("state");--> statement-breakpoint
-- A record Finance could not read would make that company's whole ledger unreadable: refuse the deploy instead.
DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
        FROM "finance_billing"."finance_states" AS ledger
       WHERE jsonb_typeof(ledger."state" -> 'manualPayments') = 'array'
         AND EXISTS (SELECT 1
                       FROM jsonb_array_elements(ledger."state" -> 'manualPayments') AS payments(payment)
                      WHERE payment -> 'source' = '"IMPORT"'::jsonb)
         AND (jsonb_array_length(ledger."state" -> 'manualPayments') > 5000
              OR EXISTS (SELECT 1
                           FROM jsonb_array_elements(ledger."state" -> 'manualPayments') AS payments(payment)
                          WHERE payment -> 'source' = '"IMPORT"'::jsonb
                            AND (char_length(btrim(payment ->> 'id')) > 500
                                 OR char_length(btrim(payment ->> 'invoiceResourceId')) NOT BETWEEN 1 AND 500)))
    ) THEN
      RAISE EXCEPTION 'A Finance ledger would hold a payment record it cannot read';
    END IF;
  END
$$;--> statement-breakpoint
DROP FUNCTION "finance_billing"."imported_payment_records_state"(jsonb);--> statement-breakpoint
-- The written ledger with each IMPORT record of the stored one kept: its source restored when the write stripped it,
-- the stored record appended when the write left it out while its invoice still carries that amount unrecorded.
CREATE FUNCTION "finance_billing"."imported_payments_kept_state"(p_old jsonb, p_new jsonb) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    WITH stored AS (
      SELECT entry, entries.position
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(p_old -> 'manualPayments') = 'array' THEN p_old -> 'manualPayments'
                    ELSE '[]'::jsonb END) WITH ORDINALITY AS entries(entry, position)
       WHERE jsonb_typeof(entry) = 'object' AND entry -> 'source' = '"IMPORT"'::jsonb
    ),
    written AS (
      SELECT payment, entries.position
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(p_new -> 'manualPayments') = 'array' THEN p_new -> 'manualPayments'
                    ELSE '[]'::jsonb END) WITH ORDINALITY AS entries(payment, position)
    ),
    left_out AS (
      SELECT stored.entry, stored.position
        FROM stored
       WHERE NOT EXISTS (SELECT 1 FROM written WHERE written.payment -> 'id' = stored.entry -> 'id')
         AND EXISTS (SELECT 1
                       FROM "finance_billing"."unrecorded_payments"(p_new) AS invoice
                      WHERE invoice.invoice_resource_id = stored.entry ->> 'invoiceResourceId'
                        AND invoice.unrecorded_minor
                              >= "finance_billing"."payment_record_amount"(stored.entry -> 'amountMinor'))
    ),
    kept AS (
      SELECT CASE
               WHEN jsonb_typeof(payment) = 'object' AND NOT payment ? 'source'
                    AND EXISTS (SELECT 1 FROM stored WHERE stored.entry -> 'id' = written.payment -> 'id')
                 THEN payment || '{"source":"IMPORT"}'::jsonb
               ELSE payment
             END AS payment,
             0 AS part,
             written.position
        FROM written
      UNION ALL
      SELECT entry, 1, left_out.position FROM left_out
    )
    SELECT CASE
             WHEN NOT EXISTS (SELECT 1 FROM stored) THEN p_new
             WHEN p_new ? 'manualPayments' AND jsonb_typeof(p_new -> 'manualPayments') IS DISTINCT FROM 'array'
               THEN p_new
             WHEN NOT EXISTS (SELECT 1 FROM kept) THEN p_new
             ELSE p_new || jsonb_build_object(
               'manualPayments', (SELECT jsonb_agg(payment ORDER BY part, kept.position) FROM kept))
           END
  $$;--> statement-breakpoint
CREATE FUNCTION "finance_billing"."keep_imported_payments"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
    BEGIN
      NEW."state" := "finance_billing"."imported_payments_kept_state"(OLD."state", NEW."state");
      RETURN NEW;
    END
  $$;--> statement-breakpoint
CREATE TRIGGER "finance_states_imported_payments"
  BEFORE UPDATE OF "state" ON "finance_billing"."finance_states"
  FOR EACH ROW EXECUTE FUNCTION "finance_billing"."keep_imported_payments"();--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
