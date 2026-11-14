// @rstest-environment happy-dom
// A new document, an amendment, a new version and a manual signature are sent on the shared Uložit only: one click
// sends the same command as the old button did, and leaving with typed input asks first.
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { DocumentSchema, StoredFileRefSchema } from '../../shared/domain/documents.ts';
import { SignatureForm, VersionUpload } from '../../src/routes/[lang]/provoz/dokumenty/document-detail.tsx';
import { DocumentFormPanel } from '../../src/routes/[lang]/provoz/dokumenty/document-form.tsx';
import {
  MAX_UPLOAD_BYTES,
  downloadFile,
  loadRecords,
  preloadAgendaRecords,
  recordsRead,
  runCommand,
  useAgendaRecords,
} from '../../src/ui/use-agenda.ts' with { rstest: 'importActual' };
import { click, labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';
import { leaveQuestionOpen, recordingRunner, saveButton, saveSent } from './form-save-fixture.ts';
import type { RecordingRunner } from './form-save-fixture.ts';

const toasts: string[] = [];
const storedFile = Schema.decodeUnknownSync(StoredFileRefSchema)({
  id: 'file-1',
  mime: 'application/pdf',
  name: 'revize-v2.pdf',
  size: 1200,
});
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/ui/property-options.ts', () => ({
  usePropertyOptions: () => ({ status: 'loading' }),
}));
rstest.mock('../../src/ui/party-invoice-options.ts', () => ({
  useContactOptions: () => ({ status: 'loading' }),
  useInvoiceOptions: () => ({ status: 'loading' }),
}));
rstest.mock('../../src/ui/use-agenda.ts', () => ({
  downloadFile,
  loadRecords,
  MAX_UPLOAD_BYTES,
  preloadAgendaRecords,
  recordsRead,
  runCommand,
  useAgendaRecords,
  // The upload is answered at once; the command after it is what the test checks.
  uploadFile: () => Effect.succeed({ file: storedFile, ok: true }),
}));
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  Toaster: () => null,
  toaster: { attrs: {} },
  useToast: () => ({
    create: (toast: { readonly title?: string }) => {
      toasts.push(toast.title ?? '');
    },
  }),
}));

const copy = { cancel: 'facility-operations.common.cancel' };
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const contract = Schema.decodeUnknownSync(DocumentSchema)({
  category: 'contract',
  contract: { contractType: 'Servisní smlouva', owner: 'Petr Malý', parties: ['Kotelna s.r.o.'], status: 'active' },
  createdAt: '2026-10-01T08:00:00Z',
  createdBy: actor,
  id: 'doc-1',
  links: [],
  title: 'Servis kotle',
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
  versions: [
    {
      file: storedFile,
      uploadedAt: '2026-10-01T08:00:00Z',
      uploadedBy: actor,
      version: 1,
    },
  ],
});

const calls: string[] = [];
const page = (name: string) => () => {
  calls.push(name);
};

const mountCreate = (runner: RecordingRunner) =>
  mountPanel(
    createElement(DocumentFormPanel, {
      contracts: [],
      mode: { kind: 'create' },
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
      tasks: { status: 'loading' },
    }),
  );

/** Picks `file` in the version form's file input, the way the browser reports a choice. */
const pickVersionFile = (file: File) =>
  Effect.promise(async () => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="version-file-input"]');
      if (input === null) {
        return;
      }
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
  toasts.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('new document', () => {
  it.live('types a title, saves once with the create command, toasts and goes on', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountCreate(runner);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#document-title', 'Revize kotle 2026');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([expect.objectContaining({ _tag: 'DocumentCreate', title: 'Revize kotle 2026' })]);
      expect(calls).toEqual(['saved']);
      expect(toasts).toHaveLength(1);
    }),
  );

  it.live('Zrušit with a typed title asks; an untouched form closes at once', () =>
    Effect.gen(function* scenario() {
      yield* mountCreate(recordingRunner());
      yield* click(copy.cancel);
      expect(calls).toEqual(['close']);
      yield* typeInto('#document-title', 'Revize');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['close', 'close']);
    }),
  );

  it.live('an amendment opens filled in and Uložit sends it as it is', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(DocumentFormPanel, {
          contracts: [contract],
          mode: { kind: 'amend', original: contract },
          onClose: page('close'),
          onSaved: page('saved'),
          open: true,
          run: runner.run,
          tasks: { status: 'loading' },
        }),
      );
      expect(saveButton().disabled).toBe(false);
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({ _tag: 'DocumentCreate', amendsDocumentId: contract.id, category: 'amendment' }),
      ]);
      expect(calls).toEqual(['saved']);
    }),
  );
});

describe('new version and signature', () => {
  it.live('picks a file, types a note, saves once and starts over clean', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(createElement(VersionUpload, { document: contract, run: runner.run }));
      expect(saveButton().disabled).toBe(true);
      yield* pickVersionFile(new File(['%PDF'], 'revize-v2.pdf', { type: 'application/pdf' }));
      yield* typeInto('#version-note', 'Podepsaná verze');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        { _tag: 'DocumentVersionAdd', documentId: contract.id, file: storedFile, note: 'Podepsaná verze' },
      ]);
      expect(toasts).toHaveLength(1);
      // The next version starts empty: nothing to save, nothing to ask about.
      expect(saveButton().disabled).toBe(true);
      expect(document.querySelector('#version-note')).toBeNull();
    }),
  );

  it.live('records a signature with the typed signer and date, then closes the form', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(createElement(SignatureForm, { document: contract, onDone: page('done'), run: runner.run }));
      yield* typeInto('#signature-by', 'Jana Nováková');
      yield* typeInto('#signature-on', '2026-11-02');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        {
          _tag: 'DocumentSignatureRecord',
          documentId: contract.id,
          signedBy: 'Jana Nováková',
          signedOn: '2026-11-02',
          version: 1,
        },
      ]);
      expect(calls).toEqual(['done']);
    }),
  );

  it.live('a typed signer asks before Zrušit drops it', () =>
    Effect.gen(function* scenario() {
      yield* mountPanel(
        createElement(SignatureForm, { document: contract, onDone: page('done'), run: recordingRunner().run }),
      );
      yield* typeInto('#signature-by', 'Jana');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['done']);
    }),
  );
});
