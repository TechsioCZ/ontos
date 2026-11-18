// @rstest-environment happy-dom
// A new document, an amendment, a new version and a manual signature are sent on the shared Uložit only: one click
// sends the same command as the old button did, and leaving with typed input asks first.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Toaster, toaster } from '@techsio/ui-kit/molecules/toast';
import { Effect, Layer, Match, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { OpsCommandSchema } from '../../shared/agendas.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { DocumentSchema, StoredFileRefSchema } from '../../shared/domain/documents.ts';
import { SignatureForm, VersionUpload } from '../../src/routes/[lang]/provoz/dokumenty/document-detail.tsx';
import { DocumentFormPanel } from '../../src/routes/[lang]/provoz/dokumenty/document-form.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const storedFile = Schema.decodeUnknownSync(StoredFileRefSchema)({
  id: 'file-1',
  mime: 'application/pdf',
  name: 'revize-v2.pdf',
  size: 1200,
});
const sent: OpsCommand[] = [];
const Owner = ApplyCommandActionApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() =>
          Match.value(payload.command).pipe(
            Match.tag('FileUpload', () =>
              Schema.decodeUnknownSync(ApplyCommandResultSchema)({
                entityIds: ['created-1'],
                file: storedFile,
                revision: sent.length + 1,
              }),
            ),
            Match.orElse((command) => {
              sent.push(Schema.decodeUnknownSync(OpsCommandSchema)(command));
              return Schema.decodeUnknownSync(ApplyCommandResultSchema)({
                entityIds: ['created-1'],
                revision: sent.length + 1,
              });
            }),
          ),
        ),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);
const run = (command: OpsCommand) => runCommand(command, 0);
const labels = saveLabelsFor('cs');
const t = moduleText('cs');
const copy = { cancel: t('facility-operations.common.cancel') };
const saveButton = () => Option.getOrThrow(Option.fromUndefinedOr(buttons(labels.save)[0]));
const leaveQuestionOpen = () => buttons(labels.discard).length > 0;
const click = (name: string) => acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click());
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
    Reflect.set(Object.getPrototypeOf(input), 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const mountPanel = (element: ReactElement) =>
  mountInRoute(
    <>
      {element}
      <Toaster />
    </>,
  );
const saveSent = () =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => sent.length === 1)),
    Effect.andThen(waitUntil(() => saveButton().textContent.trim() === labels.save)),
    Effect.andThen(settle),
  );
const toastTitles = () => [...document.querySelectorAll('[data-scope="toast"][data-part="title"]')];
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

const mountCreate = () =>
  mountPanel(
    createElement(DocumentFormPanel, {
      contracts: [],
      mode: { kind: 'create' },
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run,
      tasks: { status: 'loading' },
    }),
  );

/** Reports a real browser file selection to the input. */
const pickVersionFile = (file: File) =>
  acted(() => {
    const input = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLInputElement>('[data-testid="version-file-input"]')),
    );
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
});

afterEach(() => {
  toaster.dismiss();
  unmountAll();
});

describe('new document', () => {
  it.live('types a title, saves once with the create command, toasts and goes on', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountCreate();
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#document-title', 'Revize kotle 2026');
      yield* saveSent();
      expect(sent).toEqual([expect.objectContaining({ _tag: 'DocumentCreate', title: 'Revize kotle 2026' })]);
      expect(calls).toEqual(['saved']);
      yield* waitUntil(() => toastTitles().length === 1);
      expect(toastTitles()).toHaveLength(1);
      expect(toastTitles().map((title) => title.textContent)).toEqual([t('facility-operations.documents.created')]);
    }).pipe(Effect.provide(network)),
  );

  it.live('Zrušit with a typed title asks; an untouched form closes at once', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountCreate();
      yield* click(copy.cancel);
      expect(calls).toEqual(['close']);
      yield* typeInto('#document-title', 'Revize');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['close', 'close']);
    }).pipe(Effect.provide(network)),
  );

  it.live('an amendment opens filled in and Uložit sends it as it is', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(
        createElement(DocumentFormPanel, {
          contracts: [contract],
          mode: { kind: 'amend', original: contract },
          onClose: page('close'),
          onSaved: page('saved'),
          open: true,
          run,
          tasks: { status: 'loading' },
        }),
      );
      expect(saveButton().disabled).toBe(false);
      yield* saveSent();
      expect(sent).toEqual([
        expect.objectContaining({ _tag: 'DocumentCreate', amendsDocumentId: contract.id, category: 'amendment' }),
      ]);
      expect(calls).toEqual(['saved']);
    }).pipe(Effect.provide(network)),
  );
});

describe('new version and signature', () => {
  it.live('picks a file, types a note, saves once and starts over clean', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(createElement(VersionUpload, { document: contract, run }));
      expect(saveButton().disabled).toBe(true);
      yield* pickVersionFile(new File(['%PDF'], 'revize-v2.pdf', { type: 'application/pdf' }));
      yield* typeInto('#version-note', 'Podepsaná verze');
      yield* saveSent();
      expect(sent).toEqual([
        { _tag: 'DocumentVersionAdd', documentId: contract.id, file: storedFile, note: 'Podepsaná verze' },
      ]);
      yield* waitUntil(() => toastTitles().length === 1);
      expect(toastTitles()).toHaveLength(1);
      expect(toastTitles().map((title) => title.textContent)).toEqual([
        t('facility-operations.documents.detail.versionSaved', { version: 2 }),
      ]);
      // The next version starts empty: nothing to save, nothing to ask about.
      expect(saveButton().disabled).toBe(true);
      expect(document.querySelector('#version-note')).toBeNull();
    }).pipe(Effect.provide(network)),
  );

  it.live('records a signature with the typed signer and date, then closes the form', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(createElement(SignatureForm, { document: contract, onDone: page('done'), run }));
      yield* typeInto('#signature-by', 'Jana Nováková');
      yield* typeInto('#signature-on', '2026-11-02');
      yield* saveSent();
      expect(sent).toEqual([
        {
          _tag: 'DocumentSignatureRecord',
          documentId: contract.id,
          signedBy: 'Jana Nováková',
          signedOn: '2026-11-02',
          version: 1,
        },
      ]);
      expect(calls).toEqual(['done']);
    }).pipe(Effect.provide(network)),
  );

  it.live('a typed signer asks before Zrušit drops it', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(createElement(SignatureForm, { document: contract, onDone: page('done'), run }));
      yield* typeInto('#signature-by', 'Jana');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['done']);
    }).pipe(Effect.provide(network)),
  );
});
