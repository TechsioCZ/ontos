import type { executeApplyCommand } from '@app/finance-billing/clients/apply-command';
import {
  FinanceCompanyIdSchema,
  FinanceTextSchema,
  InvoiceLinesSchema,
  MoneyMinorSchema,
  SourceOrderSchema,
} from '@app/finance-billing/contracts/records';
import { CalendarDateWireSchema } from '@app/shared-contracts';
import { Option, Schema } from 'effect';
import type { PurchaseOrder, Supplier } from '../../../../../shared/domain/purchasing.ts';

type FinanceCommand = Parameters<typeof executeApplyCommand>[0]['command'];
type IncomingInvoice = Extract<FinanceCommand, { readonly _tag: 'RecordIncomingInvoice' }>;

/** The incoming-invoice fields a purchase order fills, decoded with Finance's published field schemas. */
const IncomingInvoiceDraftSchema = Schema.TaggedStruct('RecordIncomingInvoice', {
  documentNumber: FinanceTextSchema,
  dueDate: CalendarDateWireSchema,
  issueDate: CalendarDateWireSchema,
  lines: Schema.optionalKey(InvoiceLinesSchema),
  note: Schema.optionalKey(FinanceTextSchema),
  sourceOrder: Schema.optionalKey(SourceOrderSchema),
  supplierCompanyId: Schema.optionalKey(FinanceCompanyIdSchema),
  supplierName: FinanceTextSchema,
  totalMinor: MoneyMinorSchema.check(Schema.isGreaterThan(0)),
});
type IncomingInvoiceInput = typeof IncomingInvoiceDraftSchema.Encoded;
type MutableIncomingInvoiceInput = {
  -readonly [Key in keyof IncomingInvoiceInput]: IncomingInvoiceInput[Key];
};

export interface PurchaseInvoiceInput extends Pick<IncomingInvoice, 'dueDate' | 'issueDate' | 'lines' | 'totalMinor'> {
  readonly documentNumber: string;
  readonly order: Pick<PurchaseOrder, 'currency' | 'id' | 'number'>;
  readonly supplier: Pick<Supplier, 'ico' | 'name'>;
}

/** Build only a command supported by Finance's public incoming-invoice contract. */
export const purchaseInvoiceCommandOf = ({
  order,
  supplier,
  ...invoice
}: PurchaseInvoiceInput): Option.Option<IncomingInvoice> => {
  // RecordIncomingInvoice currently records CZK only. No implicit conversion is permitted.
  if (order.currency !== 'CZK') {
    return Option.none();
  }
  const command: MutableIncomingInvoiceInput = {
    ...invoice,
    _tag: 'RecordIncomingInvoice',
    note: `Návrh z nákupní objednávky ${order.number}. Údaje ověřte podle dokladu dodavatele.`,
    sourceOrder: { id: order.id, number: order.number },
    supplierName: supplier.name,
  };
  if (supplier.ico !== undefined) {
    command.supplierCompanyId = supplier.ico;
  }
  return Schema.decodeUnknownOption(IncomingInvoiceDraftSchema)(command);
};
