import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Effect } from 'effect';
import { constVoid } from 'effect/Function';

import { saveLabelsFor } from '@app/admin-ui';
import { createCustomer } from '../../src/api/customers-client.ts';
import type { CreatedCustomer } from '../../src/api/customers-client.ts';
import { CustomerCreateDialog } from '../../src/routes/[lang]/prodej/zakaznici/customer-create-dialog.tsx';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/api/customers-client.ts');

const KEY = 'party-registry.pages.customers.create';
const labels = saveLabelsFor('cs');
const tenantId = '11111111-1111-4111-8111-111111111111';
const created = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  displayName: 'Nová firma',
  outcome: 'CREATED',
  partyRef: {
    moduleId: 'party.registry',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'party.registry.party',
    tenantId,
  },
} as const satisfies CreatedCustomer;

const field = (id: string) => {
  const element = document.querySelector<HTMLInputElement>(`#${id}`);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element;
};
const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });
const button = (name: string) => screen.getByRole('button', { name });
/** The button with this text, when the confirmation has opened (it opens after a short animation). */
const findButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text);

const renderDialog = () => {
  const onOpenChange = rstest.fn<(open: boolean) => void>(constVoid);
  const onCreated = rstest.fn<() => void>(constVoid);
  render(
    <CustomerCreateDialog
      existing={[]}
      onCreated={onCreated}
      onOpenChange={onOpenChange}
      onWriteRefused={constVoid}
      open
    />,
  );
  return { onCreated, onOpenChange };
};

beforeEach(() => {
  rstest.mocked(createCustomer).mockReturnValue(Effect.succeed(created));
});
afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

it.live('typing only changes the draft and writes nothing', () =>
  Effect.sync(() => {
    renderDialog();
    type('customer-name', 'Nová firma');
    type('customer-email', 'obchod@example.test');
    expect(createCustomer).not.toHaveBeenCalled();
    expect(button(labels.save).hasAttribute('disabled')).toBe(false);
  }),
);

it.live('Uložit writes exactly once', () =>
  Effect.gen(function* saveOnce() {
    const { onCreated } = renderDialog();
    type('customer-name', 'Nová firma');
    fireEvent.click(button(labels.save));
    yield* Effect.promise(() => waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1)));
    expect(createCustomer).toHaveBeenCalledTimes(1);
  }),
);

it.live('leaving with unsaved input asks first and keeps the form on Zůstat', () =>
  Effect.gen(function* askBeforeLeaving() {
    const { onOpenChange } = renderDialog();
    type('customer-name', 'Nová firma');
    fireEvent.click(button(`${KEY}.cancel`));
    yield* Effect.promise(() => waitFor(() => expect(findButton(labels.stay)).toBeDefined()));
    expect(createCustomer).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const stay = findButton(labels.stay);
    if (stay === undefined) {
      throw new Error('missing Zůstat');
    }
    fireEvent.click(stay);
    yield* Effect.promise(() => waitFor(() => expect(findButton(labels.stay)).toBeUndefined()));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  }),
);
