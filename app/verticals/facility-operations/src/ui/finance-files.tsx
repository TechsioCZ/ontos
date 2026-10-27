// Files uploaded in Finance (invoice PDFs, scans) shown read-through in the shared documents register and on a party
// dossier. Finance stays the owner: the list and the bytes come from Finance's governed read with the person's own
// credential, so only people who may read Finance see them, and only for their current company.
import { dividedListClassName, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DateTime, Effect, Match, Schema } from 'effect';
import type { Cause } from 'effect';
import { useEffect, useState } from 'react';
import { readFinance } from '../api/finance-reads.ts';
import type { FinanceFileView, FinanceInvoiceView } from '../api/finance-reads.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { FileTypeIcon, formatBytes } from './documents-kit.tsx';

export interface FinanceFileRow {
  readonly file: FinanceFileView;
  readonly invoice: FinanceInvoiceView | undefined;
}

type FinanceReadFailure = Effect.Error<ReturnType<typeof readFinance>> | Cause.TimeoutError;

export type FinanceFilesState =
  | { readonly status: 'loading' }
  | { readonly error: FinanceReadFailure; readonly status: 'forbidden' | 'unavailable' }
  | { readonly rows: readonly FinanceFileRow[]; readonly status: 'ready' };

const failureStatus = (error: FinanceReadFailure): 'forbidden' | 'unavailable' =>
  Match.value(error).pipe(
    Match.whenOr(
      { _tag: 'RecordsForbiddenProblem' },
      { _tag: 'RecordsAuthenticationProblem' },
      { _tag: 'GatewayForbiddenProblem' },
      { _tag: 'GatewayAuthenticationRequiredProblem' },
      (): 'forbidden' => 'forbidden',
    ),
    Match.orElse((): 'unavailable' => 'unavailable'),
  );

/** Finance files of the current company, newest first, each with the invoice it belongs to. */
export const useFinanceFiles = (): FinanceFilesState => {
  const [state, setState] = useState<FinanceFilesState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    browserRuntime.runFork(
      readFinance('facility-operations.documents.finance-files').pipe(
        Effect.timeout('12 seconds'),
        Effect.match({
          onFailure: (error): FinanceFilesState => ({ error, status: failureStatus(error) }),
          onSuccess: (records): FinanceFilesState => {
            const invoices = new Map(records.state.invoices.map((invoice) => [invoice.ref.resourceId, invoice]));
            return {
              rows: (records.state.documents ?? [])
                .flatMap((file): FinanceFileRow[] => {
                  const invoice =
                    file.invoiceResourceId === undefined ? undefined : invoices.get(file.invoiceResourceId);
                  return invoice?.businessState === 'VOIDED' ? [] : [{ file, invoice }];
                })
                .toSorted((left, right) => DateTime.Order(right.file.uploadedAt, left.file.uploadedAt)),
              status: 'ready',
            };
          },
        }),
        Effect.tap((next) =>
          Effect.sync(() => {
            if (alive) {
              setState(next);
            }
          }),
        ),
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
  [
    row.file.fileName,
    row.invoice?.number,
    row.invoice?.documentNumber,
    row.invoice?.counterpartyName,
    row.file.actorLabel,
  ]
    .filter((part) => part !== undefined)
    .join(' ');

class FinanceFileDownloadFailed extends Schema.TaggedError<FinanceFileDownloadFailed>()('FinanceFileDownloadFailed', {
  cause: Schema.Defect(),
}) {}

const downloadFinanceFile = Effect.fn('FacilityOperations.downloadFinanceFile')(
  function* downloadFinanceFile(documentId: string) {
    const records = yield* readFinance('facility-operations.documents.finance-file', { documentId });
    const stored = records.document;
    if (stored === undefined) {
      return false;
    }
    const url = yield* Effect.try({
      catch: (cause) => new FinanceFileDownloadFailed({ cause }),
      try: () => {
        const binary = atob(stored.contentBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.codePointAt(index) ?? 0;
        }
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: stored.mimeType }));
        let downloaded = false;
        try {
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = stored.fileName;
          anchor.click();
          downloaded = true;
          return objectUrl;
        } finally {
          if (!downloaded) {
            URL.revokeObjectURL(objectUrl);
          }
        }
      },
    });
    yield* Effect.forkDetach(
      Effect.sleep('10 seconds').pipe(Effect.ensuring(Effect.sync(() => URL.revokeObjectURL(url)))),
    );
    return true;
  },
  Effect.matchEffect({
    onFailure: (error) => Effect.logWarning('Finance file download failed', error).pipe(Effect.as(false)),
    onSuccess: (downloaded: boolean) => Effect.succeed(downloaded),
  }),
);

const FinanceFileDownload = ({ file }: { readonly file: FinanceFileView }) => {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      isLoading={busy}
      onClick={() => {
        setBusy(true);
        browserRuntime.runFork(
          downloadFinanceFile(file.id).pipe(
            Effect.tap((ok) =>
              Effect.sync(() => {
                setBusy(false);
                if (!ok) {
                  toast.create({ title: 'Soubor se nepodařilo stáhnout z Financí.', type: 'error' });
                }
              }),
            ),
          ),
        );
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
  <ul className={`flex flex-col ${dividedListClassName}`} data-testid="finance-files">
    {rows.map(({ file, invoice }) => (
      <li className="flex flex-wrap items-center gap-150 px-150 py-100" key={file.id}>
        <FileTypeIcon mime={file.mimeType} name={file.fileName} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">{file.fileName}</span>
          <span className="text-fg-secondary text-xs">
            {[
              formatBytes(file.sizeBytes),
              file.actorLabel ?? 'Finance',
              formatDateTime(DateTime.formatIso(file.uploadedAt)),
            ].join(' · ')}
          </span>
        </div>
        <span className="flex min-w-0 flex-col text-right">
          {invoice === undefined ? (
            <span className="text-fg-secondary text-xs">{financeInvoiceLabel(invoice)}</span>
          ) : (
            <Link
              className="font-medium text-sm"
              href={`/${language}/finance?resourceId=${encodeURIComponent(invoice.ref.resourceId)}`}
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
        <p className="text-fg-secondary text-sm">
          K fakturám této protistrany zatím nejsou ve Financích nahrané soubory.
        </p>
      ) : (
        <FinanceFilesList language={language} rows={rows} />
      )}
    </section>
  );
};
