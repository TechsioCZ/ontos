// @rstest-environment happy-dom
// The pickers of the opportunity form wrap ui-kit's Combobox and pass `required` on through their props; the real
// Combobox renders here, so its label shows the required text screen readers read.
import { requiredLabelFor } from '@app/admin-ui';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { PickerCombobox } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-combobox.tsx';

const copy = { customer: 'customer-field' } as const;
const mounted: { readonly container: HTMLElement; readonly root: Root }[] = [];

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  rstest.unstubAllGlobals();
});

it('a required picker reads its required text in Czech', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(<PickerCombobox id="opportunity-customer" items={[]} label={copy.customer} required />);
  });
  const input = container.querySelector('input[role="combobox"]');
  const labelId = input?.getAttribute('aria-labelledby') ?? '';
  const label = labelId === '' ? container.querySelector('label') : container.querySelector(`[id="${labelId}"]`);
  expect(label?.textContent).toContain(copy.customer);
  expect(label?.textContent).toContain(requiredLabelFor('cs'));
  expect(container.textContent).not.toContain('(required)');
});
