import { Schema } from 'effect';
import { SalesOrderIdSchema } from '../../../../../shared/domain/purchasing.ts';

export class SalesInvoicePreparationDenied extends Schema.TaggedError<SalesInvoicePreparationDenied>()(
  'SalesInvoicePreparationDenied',
  { orderId: SalesOrderIdSchema },
) {}
