import { Schema } from 'effect';
import { SalesOrderIdSchema } from '../../../../../shared/domain/purchasing.ts';

export class SalesInvoicePreparationDenied extends Schema.TaggedError<SalesInvoicePreparationDenied>()(
  'SalesInvoicePreparationDenied',
  { orderId: SalesOrderIdSchema },
) {}

export class SalesInvoiceVatUnresolved extends Schema.TaggedError<SalesInvoiceVatUnresolved>()(
  'SalesInvoiceVatUnresolved',
  { orderId: SalesOrderIdSchema },
) {}
