// @rstest-environment happy-dom
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Option } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { PickerCombobox } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-combobox.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

afterEach(unmountAll);

it.live('identifies the customer picker and its required state in Czech to screen readers', () =>
  Effect.gen(function* requiredCustomer() {
    yield* mountInRoute(
      <PickerCombobox
        id="customer"
        items={[]}
        label={moduleText('cs')('sales-pipeline.pages.records.create.fields.customer')}
        required
      />,
    );
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector('input[role="combobox"]')));
    const labelledBy = input.getAttribute('aria-labelledby');
    const label =
      labelledBy === null ? document.querySelector('label') : document.querySelector(`[id="${labelledBy}"]`);
    expect(label?.textContent).toContain('Zákazník');
    expect(label?.textContent).toContain('(povinné)');
    expect(document.body.textContent).not.toContain('(required)');
  }),
);
