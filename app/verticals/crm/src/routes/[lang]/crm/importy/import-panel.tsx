import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { makeEntityId } from '../../../../../shared/domain/common.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Effect } from 'effect';
// AREA: imports — owned by the crm-imports lane. CSV import: choose / drop / paste a file or take a sample, see a
// row-by-row preview computed by the same engine the server runs, then import (C03).
import { SidePanel, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useRef, useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { ImportRowOutcome } from '../../../../../shared/domain/imports.ts';
import { parseOrdersCsv } from '../../../../../shared/imports/csv.ts';
import { importOrders } from '../../../../../shared/imports/engine.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { RESIZE_LABEL, importRowsLabel, outcomeMeta } from './order-model.ts';

const MAX_BYTES = 350_000;

export interface ImportDraft {
  readonly csv: string;
  readonly fileName: string;
}

const SummaryChip = ({ count, outcome }: { readonly count: number; readonly outcome: ImportRowOutcome }) => (
  <div className={`${surfaceTileClassName} flex min-w-28 flex-col gap-50 p-150`}>
    <span className="text-fg-secondary text-xs">{outcomeMeta[outcome].label}</span>
    <span className="font-semibold text-lg tabular-nums">{formatNumber(count)}</span>
  </div>
);

/** Row-by-row outcome table (preview and import history detail). */
export const RowResults = ({
  results,
}: {
  readonly results: readonly { externalId?: string; message: string; outcome: ImportRowOutcome; row: number }[];
}) => (
  <div className="max-h-[50dvh] overflow-auto">
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-surface text-fg-secondary text-xs">
        <tr>
          <th className="px-150 py-100 text-left font-normal">Řádek</th>
          <th className="px-150 py-100 text-left font-normal">ID objednávky</th>
          <th className="px-150 py-100 text-left font-normal">Výsledek</th>
          <th className="px-150 py-100 text-left font-normal">Detail</th>
        </tr>
      </thead>
      <tbody>
        {results.map((result) => (
          <tr className="border-border-primary border-t align-top" key={`${String(result.row)}-${result.outcome}`}>
            <td className="px-150 py-100 tabular-nums">{result.row}</td>
            <td className="px-150 py-100 font-mono text-xs">{result.externalId ?? '—'}</td>
            <td className="px-150 py-100">
              <Badge size="sm" variant={outcomeMeta[result.outcome].variant}>
                {outcomeMeta[result.outcome].label}
              </Badge>
            </td>
            <td className="px-150 py-100">{result.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const previewImport = (draft: ImportDraft | undefined, records: RecordsResponse) => {
  if (draft === undefined) {
    return draft;
  }
  const parsed = parseOrdersCsv(draft.csv);
  const result = importOrders(records.state.imports, records.state.clients, parsed, {
    batchId: makeEntityId('preview'),
    by: records.viewer.principalId,
    fileName: draft.fileName,
    newId: (suffix) => makeEntityId(`preview-${suffix}`),
    now: records.now,
  });
  return { batch: result.batch, parsed };
};

const useImportPanel = ({
  busy,
  initial,
  onClose,
  onImported,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly initial?: ImportDraft;
  readonly onClose: () => void;
  readonly onImported: (batchId: string) => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}) => {
  const toaster = useToast();
  const [draft, setDraft] = useState<ImportDraft | undefined>(initial);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  const preview = previewImport(draft, records);

  const readFile = (file: File) => {
    setFileError(undefined);
    if (file.size > MAX_BYTES) {
      setDraft(undefined);
      setFileError('Soubor je pro demo import příliš velký (max. 350 kB).');
      return;
    }
    const onReadFailure = () => {
      setDraft(undefined);
      setFileError('Soubor se nepodařilo přečíst.');
    };
    browserRuntime.runFork(
      Effect.tryPromise(file.text.bind(file)).pipe(
        Effect.timeout('10 seconds'),
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.logWarning('CRM import file read failed', cause).pipe(Effect.tap(() => Effect.sync(onReadFailure))),
          onSuccess: (text) => Effect.sync(() => setDraft({ csv: text, fileName: file.name })),
        }),
      ),
    );
  };

  const confirm = () => {
    if (draft === undefined) {
      return;
    }
    browserRuntime.runFork(
      submit({ _tag: 'ImportOrdersCsv', csv: draft.csv, fileName: draft.fileName }).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              const batch = preview?.batch;
              toaster.create({
                description:
                  batch === undefined
                    ? undefined
                    : `Nové ${String(batch.created ?? 0)} · změny stavu ${String(batch.updated ?? 0)} · duplicity ${String(batch.duplicates)} · ke kontrole ${String(batch.review ?? 0)} · chyby ${String(batch.rejected)}`,
                title: 'Import uložen',
                type: 'success',
              });
              onImported(outcome.entityIds[0] ?? '');
            } else {
              toaster.create({ description: outcome.message, title: 'Import se nezdařil', type: 'error' });
            }
          }),
        ),
      ),
    );
  };

  const counts = preview?.batch;
  const okRows = counts === undefined ? 0 : counts.accepted + counts.duplicates;

  return {
    busy,
    confirm,
    counts,
    draft,
    dragging,
    fileError,
    inputRef,
    okRows,
    onClose,
    paste,
    pasteOpen,
    preview,
    readFile,
    records,
    setDraft,
    setDragging,
    setPaste,
    setPasteOpen,
  };
};

export const ImportPanel = (props: Parameters<typeof useImportPanel>[0]) => {
  const { t } = useModernI18n();
  const {
    busy,
    confirm,
    counts,
    draft,
    dragging,
    fileError,
    inputRef,
    okRows,
    onClose,
    paste,
    pasteOpen,
    preview,
    readFile,
    records,
    setDraft,
    setDragging,
    setPaste,
    setPasteOpen,
  } = useImportPanel(props);

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button
            disabled={preview === undefined || preview.parsed.fileError !== undefined || okRows === 0}
            icon="icon-[mdi--database-import-outline]"
            isLoading={busy}
            loadingText="Importuji…"
            onClick={confirm}
            variant="primary"
          >
            {counts === undefined ? 'Importovat' : importRowsLabel(counts.rowCount)}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description="Šablona crm-orders-csv-v1. Objednávky zůstávají v e-shopu a účetním systému; CRM je jen zobrazuje."
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="xl"
      title={t('crm.ciWorkflow.csvImport')}
    >
      <div className="flex flex-col gap-250">
        <div
          className={`flex flex-col items-center gap-150 rounded-lg border-2 border-dashed text-center ${draft === undefined ? 'p-300' : 'p-150'} ${dragging ? 'border-primary bg-base' : 'border-border-primary'}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const [file] = event.dataTransfer.files;
            if (file !== undefined) {
              readFile(file);
            }
          }}
        >
          {draft === undefined && (
            <span aria-hidden="true" className="icon-[mdi--file-delimited-outline] size-600 text-fg-secondary" />
          )}
          <span className="text-sm">
            {draft === undefined ? 'Přetáhněte sem soubor CSV' : `Načteno: ${draft.fileName}`}
          </span>
          <div className="flex flex-wrap justify-center gap-100">
            <Button
              icon="icon-[mdi--folder-open-outline]"
              onClick={() => inputRef.current?.click()}
              size="sm"
              variant="secondary"
            >
              Vybrat soubor
            </Button>
            <Button
              icon="icon-[mdi--clipboard-text-outline]"
              onClick={() => setPasteOpen((value) => !value)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Vložit text
            </Button>
          </div>
          <input
            accept=".csv,text/csv,text/plain"
            aria-label={t('crm.ciWorkflow.csvFile')}
            className="hidden"
            data-testid="crm-import-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                readFile(file);
              }
              event.target.value = '';
            }}
            ref={inputRef}
            type="file"
          />
          {fileError !== undefined && <span className="text-danger text-sm">{fileError}</span>}
        </div>
        <div className="flex flex-col gap-100">
          <span className="text-fg-secondary text-xs">Nebo použijte vzorový soubor:</span>
          <div className="flex flex-wrap gap-100">
            {(records.importSamples ?? []).map((sample) => (
              <Button
                key={sample.key}
                onClick={() => setDraft({ csv: sample.csv, fileName: sample.fileName })}
                size="sm"
                theme={draft?.fileName === sample.fileName ? 'solid' : 'outlined'}
                variant="secondary"
              >
                {sample.title}
              </Button>
            ))}
          </div>
        </div>
        {pasteOpen && (
          <div className="flex flex-col gap-100">
            <FormTextarea
              className="font-mono"
              id="crm-import-paste"
              label={t('crm.ciWorkflow.csvContents')}
              maxLength={MAX_BYTES}
              onChange={(event) => setPaste(event.target.value)}
              rows={6}
              size="sm"
              value={paste}
            />
            <div className="flex justify-end">
              <Button
                disabled={paste.trim() === ''}
                onClick={() => {
                  setDraft({ csv: paste, fileName: 'vlozeny-text.csv' });
                  setPasteOpen(false);
                }}
                size="sm"
                variant="secondary"
              >
                Zobrazit náhled
              </Button>
            </div>
          </div>
        )}
        {preview !== undefined && (
          <div className="flex flex-col gap-200">
            <div className="flex flex-wrap items-baseline justify-between gap-100">
              <h3 className="font-semibold text-md">Náhled importu</h3>
              <span className="text-fg-secondary text-xs">
                Výsledek spočítaný stejnými pravidly jako server; nic zatím není uloženo.
              </span>
            </div>
            {preview.parsed.fileError === undefined ? (
              <>
                <div className="flex flex-wrap gap-100">
                  <SummaryChip count={preview.batch.created ?? 0} outcome="created" />
                  <SummaryChip count={preview.batch.updated ?? 0} outcome="updated" />
                  <SummaryChip count={preview.batch.duplicates} outcome="duplicate" />
                  <SummaryChip count={preview.batch.review ?? 0} outcome="review" />
                  <SummaryChip count={preview.batch.rejected} outcome="error" />
                </div>
                {preview.parsed.unknownColumns.length > 0 && (
                  <span className="text-fg-secondary text-xs">
                    {`Neznámé sloupce budou ignorovány: ${preview.parsed.unknownColumns.join(', ')}`}
                  </span>
                )}
                {(preview.batch.unpaired ?? 0) > 0 && (
                  <span className="text-sm">
                    {`Nové objednávky bez schválené vazby na klienta: ${String(preview.batch.unpaired)}. Po importu budou ve frontě k napárování.`}
                  </span>
                )}
                <RowResults results={preview.batch.results ?? []} />
              </>
            ) : (
              <div className="rounded-lg bg-bg-danger-subtle p-150 text-sm">{preview.parsed.fileError}</div>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
};
