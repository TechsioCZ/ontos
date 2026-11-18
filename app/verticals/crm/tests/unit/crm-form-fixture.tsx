// Shared records, recording submit and input helpers for the mounted CRM command tests.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { act } from 'react';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import { IsoTimeSchema } from '../../shared/domain/common.ts';
import { ImportedOrderSchema } from '../../shared/domain/imports.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import type { CrmCommandSubmit } from '../../src/crm/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

export const labels = saveLabelsFor('cs');
export const copy = {
  name: 'Jana Nováková',
  reason: 'Ověřeno telefonicky',
  result: 'Objednají v pondělí',
} as const;

/** The moment every fixture record was written and the records were read. */
const at = '2026-10-15T10:00:00.000Z';

export const client = (id: string, name: string) =>
  Schema.decodeSync(ClientSchema)({
    createdAt: at,
    createdBy: 'principal-1',
    id,
    kind: 'organization',
    name,
    status: 'active',
    updatedAt: at,
  });
export const akros = client('client-1', 'Akros CZ');
export const brano = client('client-2', 'Brano a.s.');

export const order = Schema.decodeUnknownSync(ImportedOrderSchema)({
  candidates: [{ clientId: brano.id, reason: 'IČO' }],
  externalCustomerId: 'C-77',
  externalId: 'EXT-1',
  id: 'order-1',
  pairing: 'unpaired',
  rawStatus: 'nova',
  receivedAt: '2026-10-02T10:00:00.000Z',
  source: 'E-shop',
  statusHistory: [],
});

export const records: RecordsResponse = {
  assignmentCandidates: [],
  departedPrincipalIds: [],
  now: Schema.decodeSync(IsoTimeSchema)(at),
  revision: 1,
  state: {
    ...initialCrmState,
    clients: { ...initialCrmState.clients, items: [akros, brano] },
    imports: { ...initialCrmState.imports, orders: [order] },
  },
  viewer: Schema.decodeSync(CrmViewerSchema)({
    assign: true,
    principalId: 'principal-1',
    readAll: true,
    readAssigned: false,
    writeAll: false,
    writeAssigned: false,
  }),
};

/** Lets the browser runtime run what the last step forked. */
export const settle = Effect.promise(async () => {
  await browserRuntime.runPromise(Effect.yieldNow);
});

/** One user step inside React's act, then whatever it forked. */
const step = (run: () => void) =>
  Effect.promise(async () => {
    await act(async () => {
      run();
    });
  }).pipe(Effect.andThen(settle));

export const recording =
  (sent: CrmCommandInput[], ok = true): CrmCommandSubmit =>
  (command) =>
    Effect.sync(() => {
      sent.push(command);
      return { entityIds: [], ok };
    });

export const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => (button.textContent ?? '').trim() === name,
  );

export const saveButton = (): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(labels.save).at(0)));

export const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

export const typeInto = (id: string, value: string) =>
  step(() => {
    const input = field(id);
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

export const click = (target: HTMLElement) => step(() => target.click());
