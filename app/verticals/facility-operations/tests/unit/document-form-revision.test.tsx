// @rstest-environment happy-dom
// The document edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { DocumentSchema } from '../../shared/domain/documents.ts';
import type { DocumentRecord } from '../../shared/domain/documents.ts';
import { DocumentFormPanel } from '../../src/routes/[lang]/provoz/dokumenty/document-form.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'facility_operations_revision_conflict',
  detail: 'The document changed since this draft was opened.',
  status: 409,
  title: 'Revision conflict',
  type: 'urn:ontos:test:document-revision-conflict',
});

const agendaAt = (revision: number) => {
  const applied: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
  return { applied, recordRevision: revision, revision };
};
type Agenda = ReturnType<typeof agendaAt>;
const changeElsewhere = (agenda: Agenda): void => {
  agenda.revision += 1;
  agenda.recordRevision = agenda.revision;
};
const networkFor = (agenda: Agenda) =>
  browserNetwork(
    // The unrelated property, contact and invoice lookups are refused by the real Shell issuer.
    shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
    serveApi(
      OwnerActionApi,
      HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
        group.handle('execute', ({ payload }) =>
          Effect.suspend(() => {
            agenda.applied.push(payload);
            if (payload.expectedRevision < agenda.recordRevision) {
              return Effect.fail(conflict);
            }
            agenda.revision += 1;
            agenda.recordRevision = agenda.revision;
            return Effect.succeed(
              Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: [], revision: agenda.revision }),
            );
          }),
        ),
      ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
    ),
  );

const fieldOf = (selector: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)));
const fieldValue = (selector: string): string => fieldOf(selector).value;
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const field = fieldOf(selector);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (name: string) => acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click());
const save = (agenda: Agenda, count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => agenda.applied.length >= count)),
    Effect.andThen(waitUntil(() => text().includes(labels.conflict) || text().includes(labels.saved))),
    Effect.andThen(networkIdle),
  );
const toPage = (): void => {};

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const documentAt = (
  updatedAt: string,
  fields: { readonly description: string; readonly title: string },
): DocumentRecord =>
  Schema.decodeUnknownSync(DocumentSchema)({
    category: 'other',
    createdAt: '2026-10-01T08:00:00Z',
    createdBy: actor,
    description: fields.description,
    id: 'doc-1',
    links: [],
    title: fields.title,
    updatedAt,
    updatedBy: actor,
    versions: [],
  });
const opened = documentAt('2026-10-20T08:00:00Z', { description: 'Původní popis', title: 'Revize kotle' });
const theirs = documentAt('2026-10-21T09:30:00Z', { description: 'Jejich popis', title: 'Revize kotle' });
const title = '#document-title';
const description = '#document-description';

const panelOf = (document: DocumentRecord, revision: number) =>
  createElement(DocumentFormPanel, {
    contracts: [],
    mode: { document, kind: 'edit' },
    onClose: toPage,
    onSaved: toPage,
    open: true,
    run: (command) => runCommand(command, revision),
    tasks: { status: 'loading' },
  });

const sentRevisions = (agenda: Agenda) => agenda.applied.map((entry) => entry.expectedRevision);

afterEach(unmountAll);

describe('document edit save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () => {
    const agenda = agendaAt(3);
    return Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountInRoute(panelOf(opened, 3), { url: '/cs/provoz/dokumenty' });
      yield* typeInto(title, 'Revize kotle 2026');
      changeElsewhere(agenda);
      yield* panel.rerender(panelOf(theirs, 4));
      expect(fieldValue(title)).toBe('Revize kotle 2026');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([3]);
      expect(text()).toContain(labels.conflict);
      yield* click(labels.reloadLatest);
      expect(fieldValue(description)).toBe('Jejich popis');
      yield* typeInto(title, 'Revize kotle 2026');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(networkFor(agenda)));
  });

  it.live('a clean draft takes the refresh, with its revision', () => {
    const agenda = agendaAt(3);
    return Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountInRoute(panelOf(opened, 3), { url: '/cs/provoz/dokumenty' });
      changeElsewhere(agenda);
      yield* panel.rerender(panelOf(theirs, 4));
      expect(fieldValue(description)).toBe('Jejich popis');
      yield* typeInto(title, 'Revize kotle 2026');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(networkFor(agenda)));
  });

  it.live('its own save advances the base, so the next save is not refused', () => {
    const agenda = agendaAt(3);
    return Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountInRoute(panelOf(opened, 3), { url: '/cs/provoz/dokumenty' });
      yield* typeInto(title, 'Revize kotle 2026');
      yield* save(agenda, 1);
      // The page re-reads after the save: the record now carries this form's own change.
      yield* panel.rerender(
        panelOf(documentAt('2026-10-22T10:00:00Z', { description: 'Původní popis', title: 'Revize kotle 2026' }), 4),
      );
      yield* typeInto(title, 'Revize kotle 2027');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(networkFor(agenda)));
  });
});
