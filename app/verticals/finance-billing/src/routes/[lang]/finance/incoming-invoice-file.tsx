// The PDF or scan picked for a received invoice. Picking only changes the form's draft; nothing is uploaded until Uložit.
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Result } from 'effect';
import { useState } from 'react';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
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

export const IncomingFileField = ({
  file,
  onChange,
}: {
  readonly file: IncomingFile | null;
  readonly onChange: (file: IncomingFile | null) => void;
}) => {
  const [error, setError] = useState<string>();
  const pick = (picked: File | undefined) => {
    setError(undefined);
    if (picked === undefined) {
      onChange(null);
      return;
    }
    void financeBrowserRuntime.runPromise(
      pickProgram(picked).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            Result.match(result, {
              onFailure: setError,
              onSuccess: onChange,
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
      <label
        className="flex cursor-pointer flex-col items-center justify-center gap-100 rounded-md border border-border-primary border-dashed bg-surface-secondary px-300 py-300 text-center text-sm hover:bg-surface-hover"
        htmlFor="incoming-file"
      >
        <span aria-hidden className="icon-[mdi--file-upload-outline] size-6 text-fg-secondary" />
        {file === null ? (
          <span className="text-fg-secondary">Klikněte a vyberte soubor · PDF, PNG, JPEG · max. 3 MB</span>
        ) : (
          <span className="font-medium">
            {file.upload.fileName} · {formatBytes(file.size)}
          </span>
        )}
      </label>
      <input
        accept={ACCEPTED_DOCUMENT_TYPES.join(',')}
        className="sr-only"
        id="incoming-file"
        onChange={(event) => pick(event.target.files?.[0])}
        type="file"
      />
      {file !== null && (
        <Button
          className="self-start"
          icon="icon-[mdi--close]"
          onClick={() => onChange(null)}
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          Odebrat soubor
        </Button>
      )}
    </div>
  );
};
