import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { EntityIdSchema } from '../../../../../shared/domain/common.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Effect, Option, Schema, pipe } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
// AREA: imports — owned by the crm-imports lane. CSV import: choose / drop / paste a file or take a sample, see a
// row-by-row preview computed by the same engine the server runs, then import (C03).
import { SidePanel, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import {
  FileField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextAreaField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { CsvProblem, ImportRowOutcome } from '../../../../../shared/domain/imports.ts';
import { parseOrdersCsv } from '../../../../../shared/imports/csv.ts';
import { importOrders } from '../../../../../shared/imports/engine.ts';
import { useCsvProblemText, useImportRowText } from '../../../../crm/csv-problem-text.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { RESIZE_LABEL, importRowsLabel, outcomeMeta } from './order-model.ts';

const MAX_BYTES = 350_000;

/** The file an import previews and sends: from the device, a sample, or pasted text. */
export interface ImportDraft {
  readonly csv: string;
  readonly fileName: string;
}

/** A picked file the import cannot use; `reason` is the Czech copy shown under the drop zone. */
class ImportFileUnusable extends Schema.TaggedError<ImportFileUnusable>()('ImportFileUnusable', {
  cause: Schema.optional(Schema.Unknown),
  reason: Schema.String,
}) {}

/** Reads a picked file as the import's draft: too large a file, or one that cannot be read, is refused. */
const readImportFile = Effect.fn('CrmImport.readFile')(function* readImportFile(file: File) {
  if (file.size > MAX_BYTES) {
    return yield* new ImportFileUnusable({ reason: 'Soubor je pro demo import příliš velký (max. 350 kB).' });
  }
  const csv = yield* Effect.tryPromise(file.text.bind(file)).pipe(
    Effect.timeout('10 seconds'),
    Effect.tapError((cause) => Effect.logWarning('CRM import file read failed', cause)),
    Effect.mapError((cause) => new ImportFileUnusable({ cause, reason: 'Soubor se nepodařilo přečíst.' })),
  );
  return { csv, fileName: file.name } satisfies ImportDraft;
});

/** The draft the import shows: the last picked file once read, or a sample or pasted text taken as it is. */
const importDraft = browserAtomRuntime.fn(
  (source: { readonly file: File } | { readonly text: ImportDraft }): Effect.Effect<ImportDraft, ImportFileUnusable> =>
    'file' in source ? readImportFile(source.file) : Effect.succeed(source.text),
);

/** The file picked from the device (the latest pick) and the text being pasted; their draft is `importDraft`. */
const importForm = FormReact.make(
  FormBuilder.empty.addField('file', Schema.OptionFromNullOr(Schema.instanceOf(File))).addField('paste', Schema.String),
  {
    fields: { file: FileField, paste: TextAreaField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
/** The picked file itself, so following it reads a file once per pick, not once per change of the form. */
const pickedFile = importForm
  .getFieldAtoms(importForm.fields.file)
  .value.pipe(Atom.map((file) => pipe(file, Option.flatMap(Option.fromNullishOr), Option.getOrUndefined)));
const noInput: typeof importForm.schema.Encoded = { file: null, paste: '' };

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
  readonly results: readonly {
    externalId?: string;
    message: string;
    outcome: ImportRowOutcome;
    problem?: CsvProblem;
    row: number;
  }[];
}) => {
  const rowText = useImportRowText();
  return (
    <div className="max-h-[50dvh] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface text-fg-secondary text-xs">
          <tr>
            <th className="px-150 py-100 text-left font-normal">Řádek</th>
            <th className="px-150 py-100 text-left font-normal">Výsledek</th>
            <th className="px-150 py-100 text-left font-normal">Detail</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr className="border-border-primary border-t align-top" key={`${String(result.row)}-${result.outcome}`}>
              <td className="px-150 py-100 tabular-nums">{result.row}</td>
              <td className="px-150 py-100">
                <Badge severity={outcomeMeta[result.outcome].variant} size="sm">
                  {outcomeMeta[result.outcome].label}
                </Badge>
              </td>
              <td className="px-150 py-100">{rowText(result)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const previewImport = (draft: ImportDraft | undefined, records: RecordsResponse) => {
  if (draft === undefined) {
    return draft;
  }
  const parsed = parseOrdersCsv(draft.csv);
  const result = importOrders(records.state.imports, records.state.clients, parsed, {
    batchId: EntityIdSchema.make('preview'),
    by: records.viewer.principalId,
    fileName: draft.fileName,
    newId: (suffix) => EntityIdSchema.make(`preview-${suffix}`),
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
  const read = useAtomSet(importDraft);
  const result = useAtomValue(importDraft);
  const setFile = useAtomSet(importForm.getFieldAtoms(importForm.fields.file).setValue);
  const { paste } = Option.getOrElse(useAtomValue(importForm.values), () => noInput);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Every pick, from the dialog or a drop, is read once.
  useAtomSubscribe(
    pickedFile,
    (file) => {
      if (file !== undefined) {
        read({ file });
      }
    },
    { immediate: false },
  );
  const draft = AsyncResult.match(result, {
    onFailure: (): ImportDraft | undefined => undefined,
    onInitial: () => initial,
    onSuccess: ({ value }) => value,
  });
  const fileError =
    AsyncResult.isFailure(result) && !result.waiting
      ? Option.getOrUndefined(Option.map(AsyncResult.error(result), (unusable) => unusable.reason))
      : undefined;
  const takeText = (text: ImportDraft) => read({ text });

  const preview = previewImport(draft, records);

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
    okRows,
    onClose,
    paste,
    pasteOpen,
    preview,
    records,
    setDragging,
    setFile,
    setPasteOpen,
    takeText,
  };
};

export const ImportPanel = (props: Parameters<typeof useImportPanel>[0]) => {
  const { t } = useModernI18n();
  const problemText = useCsvProblemText();
  const {
    busy,
    confirm,
    counts,
    draft,
    dragging,
    fileError,
    okRows,
    onClose,
    paste,
    pasteOpen,
    preview,
    records,
    setDragging,
    setFile,
    setPasteOpen,
    takeText,
  } = useImportPanel(props);

  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={onClose} severity="secondary">
            Zrušit
          </Button>
          {/* A command, not a form: the import sends a previewed file once; nothing here edits a stored record. */}
          <Button
            disabled={preview === undefined || preview.parsed.fileError !== undefined || okRows === 0}
            icon="icon-[mdi--database-import-outline]"
            isLoading={busy}
            loadingText="Importuji…"
            onClick={confirm}
            severity="primary"
          >
            {counts === undefined ? 'Importovat' : importRowsLabel(counts.rowCount)}
          </Button>
        </>
      }
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
      <FormRoot
        className="flex flex-col gap-250"
        defaultValues={noInput}
        form={importForm}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
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
            const dropped = Option.fromNullishOr(event.dataTransfer.files.item(0));
            if (Option.isSome(dropped)) {
              setFile(dropped.value);
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
            <importForm.file
              accept=".csv,text/csv,text/plain"
              aria-label={t('crm.ciWorkflow.csvFile')}
              className="hidden"
              data-testid="crm-import-file"
            >
              {(pick) => (
                <Button
                  icon="icon-[mdi--folder-open-outline]"
                  onClick={pick}
                  severity="secondary"
                  size="sm"
                  type="button"
                >
                  Vybrat soubor
                </Button>
              )}
            </importForm.file>
            <Button
              appearance="outline"
              icon="icon-[mdi--clipboard-text-outline]"
              onClick={() => setPasteOpen((value) => !value)}
              severity="secondary"
              size="sm"
            >
              Vložit text
            </Button>
          </div>
          {fileError !== undefined && <span className="text-danger text-sm">{fileError}</span>}
        </div>
        <div className="flex flex-col gap-100">
          <span className="text-fg-secondary text-xs">Nebo použijte vzorový soubor:</span>
          <div className="flex flex-wrap gap-100">
            {(records.importSamples ?? []).map((sample) => (
              <Button
                appearance={draft?.fileName === sample.fileName ? 'solid' : 'outline'}
                key={sample.key}
                onClick={() => takeText({ csv: sample.csv, fileName: sample.fileName })}
                severity="secondary"
                size="sm"
              >
                {sample.title}
              </Button>
            ))}
          </div>
        </div>
        {pasteOpen && (
          <div className="flex flex-col gap-100">
            <importForm.paste
              className="font-mono"
              id="crm-import-paste"
              label={t('crm.ciWorkflow.csvContents')}
              maxLength={MAX_BYTES}
              rows={6}
              size="sm"
            />
            <div className="flex justify-end">
              <Button
                disabled={paste.trim() === ''}
                onClick={() => {
                  takeText({ csv: paste, fileName: 'vlozeny-text.csv' });
                  setPasteOpen(false);
                }}
                severity="secondary"
                size="sm"
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
              <div className="rounded-lg bg-bg-danger-subtle p-150 text-sm">
                {problemText(preview.parsed.fileError)}
              </div>
            )}
          </div>
        )}
      </FormRoot>
    </SidePanel>
  );
};
