import { Schema } from 'effect';
import { SalesOrderIdSchema } from '../../../../../shared/domain/purchasing.ts';

/** Finance holds the invoice of this order for another customer: it is corrected in Finance, never retried here. */
export class SalesInvoiceOtherCustomer extends Schema.TaggedError<SalesInvoiceOtherCustomer>()(
  'SalesInvoiceOtherCustomer',
  { orderId: SalesOrderIdSchema },
) {}
