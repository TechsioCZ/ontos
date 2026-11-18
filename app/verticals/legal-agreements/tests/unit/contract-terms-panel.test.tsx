// @rstest-environment happy-dom
// The contract terms panel as the person sees it: one Save button in the panel footer, the draft's status next to it,
// and a question before unsaved changes are left. The real client, i18n and router run against the Shell gateway
// issuer and the agreement owner's Action contract in process.
import { acted, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { ContractSchema } from '../../shared/apis/records.ts';
import { ContractTermsPanel } from '../../src/routes/[lang]/smlouvy/contract-terms.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'legal.agreements.contract',
  tenantId,
} as const;
const contract = Schema.decodeUnknownSync(ContractSchema)({
  contractRef,
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: '2027-10-05',
  kind: 'LEASE',
  lifecycleState: 'ACTIVE',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  rentTerms: { currency: 'CZK', monthlyRentMinor: 1_850_000, paymentDay: 15, serviceChargesMinor: 250_050 },
  responsiblePerson: 'Jana Nováková',
  signatureState: 'SIGNED',
  startDate: '2026-10-05',
  subject: 'Nájem kanceláře',
  supersedesContractRef: null,
  unitRef: null,
});

const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const saved = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ resourceRef: contractRef, revision: 5 });
const OwnerActionApi = ApplyCommandActionApi.prefix('/legal-agreements-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'legal-agreements': '/legal-agreements-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return saved;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

const mount = () =>
  Effect.gen(function* mountPanel() {
    yield* pinTestDocument;
    const closed: string[] = [];
    yield* mountInRoute(
      <ContractTermsPanel
        contract={contract}
        onClose={() => {
          closed.push('close');
        }}
        revision={4}
      />,
      { path: 'smlouvy', url: '/cs/smlouvy' },
    );
    return { closed, unmount: unmountAll };
  });

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));

/** Types like a person: React sees a native input event, then focus leaves the field. */
const type = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });

const click = (target: HTMLElement) => acted(() => target.click());

const notice = 'contract-terms-notice';
const close = moduleText('cs')('legal-agreements.detail.close');

beforeEach(() => {
  commands.length = 0;
});

afterEach(unmountAll);

describe('contract terms panel with one Save button', () => {
  it.live('typing, waiting and closing the panel send nothing', () =>
    Effect.gen(function* typing() {
      yield* pinTestDocument;
      const view = yield* mount();
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* type(notice, '3 měsíce');
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      // Enter submits the form natively: it must not save.
      document.querySelector('form')?.requestSubmit();
      yield* Effect.sleep('1 second');
      yield* settle;
      expect(commands.length).toBe(0);

      view.unmount();
      yield* Effect.sleep('1 second');
      expect(commands.length).toBe(0);
    }).pipe(Effect.provide(network)),
  );

  it.live('one click on Save sends the terms once and shows them saved', () =>
    Effect.gen(function* saveOnce() {
      yield* pinTestDocument;
      yield* mount();
      yield* type(notice, '3 měsíce');
      yield* click(button('Uložit'));
      yield* waitUntil(() => text().includes('Uloženo'));
      expect(commands.length).toBe(1);
      expect(commands[0]).toMatchObject({
        command: { _tag: 'SetContractTerms', noticePeriod: '3 měsíce' },
        expectedRevision: 4,
      });
      expect(button('Uložit').disabled).toBe(true);
    }).pipe(Effect.provide(network)),
  );

  it.live('an invalid rent keeps Save disabled', () =>
    Effect.gen(function* invalid() {
      yield* pinTestDocument;
      yield* mount();
      yield* type('contract-terms-monthly', 'hodně');
      expect(button('Uložit').disabled).toBe(true);
      expect(commands.length).toBe(0);
    }).pipe(Effect.provide(network)),
  );

  it.live('closing with unsaved changes asks first; Zůstat keeps the draft, Zahodit změny closes unsaved', () =>
    Effect.gen(function* leave() {
      yield* pinTestDocument;
      const view = yield* mount();
      yield* type(notice, '3 měsíce');
      yield* click(button(close));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* click(button('Zůstat'));
      yield* waitUntil(() => buttons('Zůstat').length === 0);
      expect(field(notice).value).toBe('3 měsíce');

      yield* click(button(close));
      yield* click(button('Zahodit změny'));
      expect(view.closed).toEqual(['close']);
      expect(commands.length).toBe(0);
    }).pipe(Effect.provide(network)),
  );

  it.live('Uložit in the question saves once and then closes', () =>
    Effect.gen(function* saveAndLeave() {
      yield* pinTestDocument;
      const view = yield* mount();
      yield* type(notice, '3 měsíce');
      yield* click(button(close));
      const inDialog = buttons('Uložit').at(-1);
      expect(inDialog).toBeDefined();
      yield* click(inDialog ?? document.createElement('button'));
      yield* waitUntil(() => view.closed.length === 1);
      expect(commands.length).toBe(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('an unchanged panel closes without asking', () =>
    Effect.gen(function* cleanLeave() {
      yield* pinTestDocument;
      const view = yield* mount();
      yield* click(button(close));
      expect(buttons('Zůstat')).toHaveLength(0);
      expect(view.closed).toEqual(['close']);
    }).pipe(Effect.provide(network)),
  );
});
