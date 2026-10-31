import { Schema } from 'effect';
import { SalesOrderIdSchema } from '../../../../../shared/domain/purchasing.ts';

export class SalesInvoiceSnapshotMissing extends Schema.TaggedError<SalesInvoiceSnapshotMissing>()(
  'SalesInvoiceSnapshotMissing',
  { orderId: SalesOrderIdSchema },
) {}
