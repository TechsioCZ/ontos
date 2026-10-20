export interface IncomingInvoiceLink {
  readonly sourceOrder?: { readonly id: string; readonly number: string };
  readonly number: string;
  readonly supplier: string | undefined;
  readonly resourceId: string;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase('cs-CZ');

/** Never turn an ambiguous number or a different supplier's invoice into a link. */
export const matchingIncomingInvoice = (
  invoices: readonly IncomingInvoiceLink[],
  number: string,
  supplier: string,
): IncomingInvoiceLink | undefined => {
  const matches = invoices.filter(
    (invoice) =>
      normalize(invoice.number) === normalize(number) &&
      (invoice.supplier === undefined || normalize(invoice.supplier) === normalize(supplier)),
  );
  return matches.length === 1 ? matches[0] : undefined;
};
