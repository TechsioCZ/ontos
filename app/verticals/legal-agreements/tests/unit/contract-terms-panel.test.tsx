// @rstest-environment happy-dom
// The contract terms panel as the person sees it: one Save button in the panel footer, the draft's status next to it,
// and a question before unsaved changes are left. The real client, i18n and router run against the Shell gateway
// issuer and the agreement owner's Action contract in process.
import { acted, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
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
import { mountInRoute } from '../support/module-ui.ts';

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

beforeEach(() => {
  commands.length = 0;
});

afterEach(unmountAll);

describe('contract terms panel with one Save button', () => {
  it.live('one click on Save sends the terms once and shows them saved', () =>
    Effect.gen(function* saveOnce() {
      yield* pinTestDocument;
      yield* mount();
      yield* type(notice, '3 měsíce');
      yield* click(button('Uložit'));
      yield* waitUntil(() => text().includes('Uloženo'));
      yield* networkIdle;
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
      yield* networkIdle;
      expect(commands.length).toBe(0);
    }).pipe(Effect.provide(network)),
  );
});
