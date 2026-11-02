import { FinanceCommandSchema } from '@app/finance-billing/contracts/apply-command';
import type { FinanceCommand } from '@app/finance-billing/contracts/apply-command';
import { Option, Schema } from 'effect';
import type { PurchaseOrder, Supplier } from '../../../../../shared/domain/purchasing.ts';

type IncomingInvoice = Extract<FinanceCommand, { readonly _tag: 'RecordIncomingInvoice' }>;
type IncomingInvoiceInput = Extract<typeof FinanceCommandSchema.Encoded, { readonly _tag: 'RecordIncomingInvoice' }>;
type MutableIncomingInvoiceInput = {
  -readonly [Key in keyof IncomingInvoiceInput]: IncomingInvoiceInput[Key];
};

export interface PurchaseInvoiceInput extends Pick<IncomingInvoice, 'dueDate' | 'issueDate' | 'lines' | 'totalMinor'> {
  readonly order: Pick<PurchaseOrder, 'currency' | 'id' | 'number'>;
  readonly supplier: Pick<Supplier, 'ico' | 'name'>;
}

/** Build only a command supported by Finance's public incoming-invoice contract. */
export const purchaseInvoiceCommandOf = ({ order, supplier, ...invoice }: PurchaseInvoiceInput) => {
  // RecordIncomingInvoice currently records CZK only. No implicit conversion is permitted.
  if (order.currency !== 'CZK') {
    return Option.none();
  }
  const command: MutableIncomingInvoiceInput = {
    ...invoice,
    _tag: 'RecordIncomingInvoice',
    documentNumber: `NÁVRH-${order.number}`,
    note: `Návrh z nákupní objednávky ${order.number}. Číslo a sazbu DPH ověří účetní podle dokladu dodavatele.`,
    sourceOrder: { id: order.id, number: order.number },
    supplierName: supplier.name,
  };
  if (supplier.ico !== undefined) {
    command.supplierCompanyId = supplier.ico;
  }
  return Schema.decodeUnknownOption(FinanceCommandSchema)(command);
};
