// @effect-diagnostics asyncFunction:off globalTimers:off
// Files uploaded in Finance (invoice PDFs, scans) shown read-through in the shared documents register and on a party
// dossier. Finance stays the owner: the list and the bytes come from Finance's governed read with the person's own
// credential, so only people who may read Finance see them, and only for their current company.
import { formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { readFinance } from '../api/finance-reads.ts';
import type { FinanceFileView, FinanceInvoiceView } from '../api/finance-reads.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { FileTypeIcon, formatBytes } from './documents-kit.tsx';

export interface FinanceFileRow {
  readonly file: FinanceFileView;
  readonly invoice: FinanceInvoiceView | undefined;
}

export type FinanceFilesState =
  | { readonly status: 'loading' | 'forbidden' | 'unavailable' }
  | { readonly status: 'ready'; readonly rows: readonly FinanceFileRow[] };

const failureStatus = (error: unknown): 'forbidden' | 'unavailable' => {
  const tag = typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : '';
  return /Forbidden|Authentication/u.test(tag) ? 'forbidden' : 'unavailable';
};

/** Finance files of the current company, newest first, each with the invoice it belongs to. */
export const useFinanceFiles = (): FinanceFilesState => {
  const [state, setState] = useState<FinanceFilesState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      readFinance('siampark-ops.documents.finance-files').pipe(
        Effect.timeout('12 seconds'),
        Effect.match({
          onFailure: (error): FinanceFilesState => ({ status: failureStatus(error) }),
          onSuccess: (records): FinanceFilesState => {
            const invoices = new Map(records.state.invoices.map((invoice) => [invoice.ref.resourceId, invoice]));
            return {
              rows: (records.state.documents ?? [])
                .map((file) => ({
                  file,
                  invoice: file.invoiceResourceId === undefined ? undefined : invoices.get(file.invoiceResourceId),
                }))
                .filter((row) => row.invoice?.businessState !== 'VOIDED')
                .toSorted((left, right) => right.file.uploadedAt.localeCompare(left.file.uploadedAt)),
              status: 'ready',
            };
          },
        }),
        Effect.map((next) => {
          if (alive) setState(next);
        }),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
};

export const financeInvoiceLabel = (invoice: FinanceInvoiceView | undefined) =>
  invoice === undefined ? 'Bez vazby na fakturu' : (invoice.number ?? invoice.documentNumber);

/** Search text of one row (file name, invoice number, counterparty, uploader). */
export const financeFileText = (row: FinanceFileRow) =>
  [row.file.fileName, row.invoice?.number, row.invoice?.documentNumber, row.invoice?.counterpartyName, row.file.actorLabel]
    .filter((part) => part !== undefined)
    .join(' ');

const downloadFinanceFile = (documentId: string) =>
  browserRuntime.runPromise(
    readFinance('siampark-ops.documents.finance-file', { documentId }).pipe(
      Effect.map((records) => {
        const stored = records.document;
        if (stored === undefined) {
          return false;
        }
        const binary = atob(stored.contentBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: stored.mimeType }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = stored.fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return true;
      }),
      Effect.orElseSucceed(() => false),
    ),
  );

const FinanceFileDownload = ({ file }: { readonly file: FinanceFileView }) => {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      isLoading={busy}
      onClick={() => {
        setBusy(true);
        void downloadFinanceFile(file.id).then((ok) => {
          setBusy(false);
          if (!ok) toast.create({ title: 'Soubor se nepodařilo stáhnout z Financí.', type: 'error' });
        });
      }}
      size="sm"
      theme="outlined"
      variant="secondary"
    >
      Stáhnout
    </Button>
  );
};

/** Read-only list of Finance files; writes (upload, replace, delete) stay in Finance. */
export const FinanceFilesList = ({
  language,
  rows,
}: {
  readonly language: string;
  readonly rows: readonly FinanceFileRow[];
}) => (
  <ul
    className="flex flex-col divide-y divide-border-primary rounded-lg border border-border-primary bg-surface"
    data-testid="finance-files"
  >
    {rows.map(({ file, invoice }) => (
      <li className="flex flex-wrap items-center gap-150 px-150 py-100" key={file.id}>
        <FileTypeIcon mime={file.mimeType} name={file.fileName} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">{file.fileName}</span>
          <span className="text-fg-secondary text-xs">
            {[
              formatBytes(file.sizeBytes),
              file.actorLabel ?? 'Finance',
              formatDateTime(file.uploadedAt),
            ].join(' · ')}
          </span>
        </div>
        <span className="flex min-w-0 flex-col text-right">
          {invoice === undefined ? (
            <span className="text-fg-secondary text-xs">{financeInvoiceLabel(invoice)}</span>
          ) : (
            <Link
              className="font-medium text-sm"
              href={`/${language}/siampark/finance?resourceId=${encodeURIComponent(invoice.ref.resourceId)}`}
            >
              {`Faktura ${financeInvoiceLabel(invoice)}`}
            </Link>
          )}
          {invoice?.counterpartyName !== undefined && (
            <span className="truncate text-fg-secondary text-xs">{invoice.counterpartyName}</span>
          )}
        </span>
        <Badge size="sm" variant="outline">
          {invoice?.direction === 'OUTGOING' ? 'Vydaná faktura' : 'Přijatá faktura'}
        </Badge>
        <FinanceFileDownload file={file} />
      </li>
    ))}
  </ul>
);

/** Finance files of the invoices of one counterparty (party registry id), for a party / tenant dossier. */
export const PartyFinanceFiles = ({
  counterpartyId,
  language,
}: {
  readonly counterpartyId: string;
  readonly language: string;
}) => {
  const files = useFinanceFiles();
  if (files.status === 'forbidden') {
    return null;
  }
  if (files.status !== 'ready') {
    return (
      <p className="text-fg-secondary text-sm">
        {files.status === 'loading' ? 'Načítám soubory faktur…' : 'Soubory faktur z Financí jsou teď nedostupné.'}
      </p>
    );
  }
  const rows = files.rows.filter((row) => row.invoice?.counterpartyRef.resourceId === counterpartyId);
  return (
    <section className="flex flex-col gap-100" data-testid="party-finance-files">
      <span className="font-semibold text-fg-secondary text-xs uppercase">Soubory faktur (Finance)</span>
      {rows.length === 0 ? (
        <p className="text-fg-secondary text-sm">K fakturám této protistrany zatím nejsou ve Financích nahrané soubory.</p>
      ) : (
        <FinanceFilesList language={language} rows={rows} />
      )}
    </section>
  );
};
