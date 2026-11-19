// @rstest-environment happy-dom
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Option } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { emptyDraft } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-draft.ts';
import { OpportunityFields } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-fields.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const customerName = moduleText('cs')('sales-pipeline.pages.records.create.fields.customer');

// Read only the labels actually associated with this input, never an unrelated required field's label.
const associatedLabels = (input: HTMLInputElement) => {
  const ids = input.getAttribute('aria-labelledby');
  return ids === null
    ? [...(input.labels ?? [])]
    : ids
        .trim()
        .split(/\s+/u)
        .map((id) => Option.getOrThrow(Option.fromNullOr(document.querySelector(`#${CSS.escape(id)}`))));
};

// The visible asterisk is aria-hidden; only the Czech required text belongs in the accessible name.
const labelText = (label: Element): string => {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('[aria-hidden="true"]') === null
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  let result = '';
  while (walker.nextNode() !== null) {
    result += walker.currentNode.textContent;
  }
  return result.trim().replaceAll(/\s+/gu, ' ');
};

afterEach(unmountAll);

it.live('identifies the customer picker and its required state in Czech to screen readers', () =>
  Effect.gen(function* requiredCustomer() {
    yield* mountInRoute(
      <OpportunityFields
        customers={{ items: [], status: 'ready' }}
        draft={emptyDraft}
        employees={{ items: [], status: 'ready' }}
        isEdit={false}
        onChange={() => {}}
        products={{ items: [], status: 'ready' }}
        showErrors={false}
      />,
      { language: 'cs', path: 'prodej/prilezitosti', url: '/cs/prodej/prilezitosti' },
    );
    const customers = [...document.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].filter((input) => {
      const name = input.hasAttribute('aria-labelledby')
        ? associatedLabels(input).map(labelText).join(' ')
        : (input.getAttribute('aria-label') ?? associatedLabels(input).map(labelText).join(' '));
      return name === customerName || name === `${customerName} (povinné)`;
    });
    expect(customers).toHaveLength(1);
    const input = Option.getOrThrow(Option.fromNullishOr(customers[0]));
    expect(input.getAttribute('aria-required')).toBe('true');
    const labels = associatedLabels(input);
    expect(labels).toHaveLength(1);
    const label = Option.getOrThrow(Option.fromNullishOr(labels[0]));
    expect(label.tagName).toBe('LABEL');
    expect(label.getAttribute('for')).toBe(input.id);
    expect(labelText(label)).toBe(`${customerName} (povinné)`);
    expect(document.body.textContent).not.toContain('(required)');
  }),
);
