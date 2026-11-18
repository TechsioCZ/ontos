// @rstest-environment happy-dom
// Staff create a product through the real form, router, translations and generated Action client. The Shell gateway
// issuer and merchandise Action endpoint answer in process, recording the classification that reaches the owner.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadEncoded } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { CreateProductDialog } from '../../src/routes/[lang]/provoz/produkty/product-forms.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { mountInRoute } from '../support/module-ui.ts';

const rate = Schema.decodeSync(TaxRateViewSchema);
const standardRate = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 21 });
const reducedRate = rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 });
const payerWith = (...rates: (typeof standardRate)[]): CompanyVat => ({ rates, regime: 'VAT_PAYER' });
const labels = saveLabelsFor('cs');
const created = Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [], revision: 4 });
const commands: ApplyCommandPayloadEncoded[] = [];
const OwnerApi = ApplyCommandActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return created;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

const mount = (vat: CompanyVat) =>
  mountInRoute(
    <CreateProductDialog
      onCommitted={constVoid}
      onOpenChange={constVoid}
      onReload={constVoid}
      open
      revision={3}
      vat={vat}
    />,
    { path: 'provoz/produkty', url: '/cs/provoz/produkty' },
  );

const fieldById = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));
const typeInto = (id: string, value: string) =>
  acted(() => {
    const field = fieldById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
const vatSelect = (): HTMLSelectElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLSelectElement>('select[name="taxClassification"]')));
const pickVat = (value: string) =>
  Effect.gen(function* pickVisibleVatOption() {
    yield* acted(() => {
      const root = Option.getOrThrow(Option.fromNullOr(vatSelect().parentElement));
      Option.getOrThrow(Option.fromNullOr(root.querySelector<HTMLButtonElement>('[data-part="trigger"]'))).click();
    });
    yield* waitUntil(() => document.querySelector(`[role="option"][data-value="${value}"]`) !== null);
    yield* acted(() => {
      Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)),
      ).click();
    });
  });
const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent.trim() === labels.save,
      ),
    ),
  );
const fillRequired = Effect.gen(function* fillRequiredFields() {
  yield* typeInto('product-sku', 'KAVA-500');
  yield* typeInto('product-name', 'Káva 500 g');
  yield* typeInto('product-category', 'Káva');
  yield* typeInto('product-price', '250');
});
const sentClassifications = () => commands.map(({ command }) => command.taxClassificationCode);
const text = () => (document.body.textContent ?? '').replaceAll(' ', ' ');

beforeEach(() => {
  commands.length = 0;
});
afterEach(unmountAll);

it.live('sends the classification staff picked in the CreateProduct payload', () =>
  Effect.gen(function* pickedClassification() {
    yield* pinTestDocument;
    yield* mount(payerWith(standardRate, reducedRate));
    expect(vatSelect().value).toBe(CZ_VAT_STANDARD);
    yield* fillRequired;
    yield* pickVat(CZ_VAT_REDUCED);
    yield* acted(() => saveButton().click());
    yield* waitUntil(() => commands.length > 0);
    expect(sentClassifications()).toEqual([CZ_VAT_REDUCED]);
  }).pipe(Effect.provide(network)),
);

it.live('starts on the first classification with a rate when the standard one has none', () =>
  Effect.gen(function* firstPricedClassification() {
    yield* pinTestDocument;
    yield* mount(payerWith(reducedRate));
    expect(vatSelect().value).toBe(CZ_VAT_REDUCED);
    yield* fillRequired;
    yield* acted(() => saveButton().click());
    yield* waitUntil(() => commands.length > 0);
    expect(sentClassifications()).toEqual([CZ_VAT_REDUCED]);
  }).pipe(Effect.provide(network)),
);

it.live('a company without any rate in force is told why, and nothing is sent', () =>
  Effect.gen(function* noRateInForce() {
    yield* pinTestDocument;
    yield* mount(payerWith());
    expect(text()).toContain('Firma zatím nemá v modulu Daně platnou sazbu DPH, produkt proto nelze založit.');
    yield* fillRequired;
    yield* acted(() => saveButton().click());
    // A wrong send (gateway context, then the Action) has reached the owner by the time the network is idle.
    yield* networkIdle;
    expect(sentClassifications()).toEqual([]);
  }).pipe(Effect.provide(network)),
);
