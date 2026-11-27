// The PDF or scan picked for a received invoice. Picking only changes the form's draft; nothing is uploaded until Uložit.
import { FileField } from '@app/core-runtime/ui/form';
import type { FormReact } from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Result } from 'effect';
import { createElement, useState } from 'react';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { fieldPart } from './field-lens.ts';
import { ACCEPTED_DOCUMENT_TYPES, formatBytes, MAX_UPLOAD_BYTES, readUpload } from './finance-ui.tsx';
import type { IncomingFile } from './incoming-invoice-draft.ts';

/** Reads a picked file, or fails with why it cannot be attached. */
const pickProgram = Effect.fn('Finance.pickFile')(function* pickProgram(picked: File) {
  if (!ACCEPTED_DOCUMENT_TYPES.some((mimeType) => mimeType === picked.type)) {
    return Result.fail('Podporované jsou soubory PDF, PNG, JPEG a WebP.');
  }
  if (picked.size > MAX_UPLOAD_BYTES) {
    return Result.fail('Soubor je příliš velký (nejvýše 3 MB).');
  }
  const uploaded = yield* Effect.result(readUpload(picked));
  return Result.isFailure(uploaded)
    ? Result.fail('Obsah dokladu se nepodařilo načíst.')
    : Result.succeed<IncomingFile>({ size: picked.size, upload: uploaded.success });
});

/**
 * The attached document of a received invoice as one field: the picker reads the picked file into the draft, or says
 * why it cannot be attached; "Odebrat soubor" drops it again.
 */
export const IncomingFileField: FormReact.FieldComponent<IncomingFile | null> = ({ field }) => {
  const [error, setError] = useState<string>();
  const file = field.value;
  const pick = (picked: File | null) => {
    setError(undefined);
    if (picked === null) {
      field.onChange(null);
      return;
    }
    void financeBrowserRuntime.runPromise(
      pickProgram(picked).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            Result.match(result, {
              onFailure: setError,
              onSuccess: field.onChange,
            }),
          ),
        ),
      ),
    );
  };
  return (
    <div className="flex flex-col gap-100">
      <span className="font-label text-label-md">Doklad (PDF nebo obrázek)</span>
      {error !== undefined && (
        <StatusText showIcon size="sm" status="error">
          {error}
        </StatusText>
      )}
      <label className="flex cursor-pointer flex-col items-center justify-center gap-100 rounded-md border border-border-primary border-dashed bg-surface-secondary px-300 py-300 text-center text-sm hover:bg-fill-hover">
        {createElement(FileField, {
          // The native picker keeps no value of its own here: the field holds the file it read.
          field: fieldPart<IncomingFile | null, File | null>(field, 'picked', null, pick),
          props: { accept: ACCEPTED_DOCUMENT_TYPES.join(','), id: 'incoming-file' },
        })}
        <span aria-hidden className="icon-[mdi--file-upload-outline] size-6 text-fg-secondary" />
        {file === null ? (
          <span className="text-fg-secondary">Klikněte a vyberte soubor · PDF, PNG, JPEG · max. 3 MB</span>
        ) : (
          <span className="font-medium">
            {file.upload.fileName} · {formatBytes(file.size)}
          </span>
        )}
      </label>
      {file !== null && (
        <Button
          appearance="ghost"
          className="self-start"
          icon="icon-[mdi--close]"
          onClick={() => field.onChange(null)}
          severity="secondary"
          size="sm"
        >
          Odebrat soubor
        </Button>
      )}
    </div>
  );
};
