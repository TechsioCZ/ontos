import { Schema } from 'effect';
import { SalesOrderIdSchema } from '../../../../../shared/domain/purchasing.ts';

/** The order's VAT rates do not map to exactly one classification Finance publishes for the issue date. */
export class SalesInvoiceVatUnresolved extends Schema.TaggedError<SalesInvoiceVatUnresolved>()(
  'SalesInvoiceVatUnresolved',
  { orderId: SalesOrderIdSchema },
) {}
