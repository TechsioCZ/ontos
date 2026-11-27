import { Effect } from 'effect';

/** The prefix of every derived customer record. No customer id is ever taken as a record under it. */
const DERIVED_CUSTOMER_RECORD_PREFIX = 'symmy-customer:';
/** A source record id the owners accept: bounded to the Party source identifier and free of surrounding blanks. */
const MAX_SOURCE_RECORD_LENGTH = 200;

/** The text whose digest names the source record of a customer id the owners cannot take as it is. */
export const symmyCustomerRecordSeed = (customerId: string): string => `customer-record\u0000${customerId}`;

/**
 * The one source record of an ERP customer id, wherever it is computed: the customer intake, the membership plan and
 * the ingress that looks a customer up. An id the owners accept is its own record; any other id, and any id that
 * already starts with the derived prefix, is the derived record of the SHA-256 of its seed, as lowercase hex. The two
 * ranges never meet, so two customer ids never name one record.
 */
export const symmyCustomerSourceRecordId = <E>(
  customerId: string,
  digest: (value: string) => Effect.Effect<string, E>,
): Effect.Effect<string, E> =>
  customerId.length <= MAX_SOURCE_RECORD_LENGTH &&
  customerId === customerId.trim() &&
  !customerId.startsWith(DERIVED_CUSTOMER_RECORD_PREFIX)
    ? Effect.succeed(customerId)
    : digest(symmyCustomerRecordSeed(customerId)).pipe(
        Effect.map((hash) => `${DERIVED_CUSTOMER_RECORD_PREFIX}${hash}`),
      );
