import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';

import { Combobox, DatePicker, FormInput, FormTextarea, RadioGroup } from '../../src/form-controls.tsx';
import { requiredLabelFor } from '../../src/required-labels.ts';

const copy = { date: 'Issue date', name: 'Name', note: 'Note', owner: 'Owner', person: 'Person' };

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});

describe('admin form controls', () => {
  it('read the Czech required text on a page without a language', () => {
    render(
      <>
        <FormInput id="name" label={copy.name} required />
        <FormTextarea id="note" label={copy.note} required />
        <Combobox id="person" items={[]} label={copy.person} required />
      </>,
    );
    expect(screen.getByRole('textbox', { name: `${copy.name} (povinné)` })).toBeDefined();
    expect(screen.getByRole('textbox', { name: `${copy.note} (povinné)` })).toBeDefined();
    expect(screen.getByRole('combobox', { name: `${copy.person} (povinné)` })).toBeDefined();
    expect(document.body.textContent).not.toContain('(required)');
  });

  it.live('read the text of the page language and follow a change of it', () => {
    document.documentElement.lang = 'en';
    render(<FormInput id="name" label={copy.name} required />);
    expect(document.body.textContent).toContain(requiredLabelFor('en'));
    expect(document.body.textContent).not.toContain('(povinné)');
    act(() => {
      document.documentElement.lang = 'cs';
    });
    return Effect.promise(() => waitFor(() => expect(document.body.textContent).toContain('(povinné)')));
  });

  it('pass the text to the label part of compound controls', () => {
    render(
      <>
        <RadioGroup name="owner" required>
          <RadioGroup.Label>{copy.owner}</RadioGroup.Label>
        </RadioGroup>
        <DatePicker.Root required>
          <DatePicker.Label>{copy.date}</DatePicker.Label>
        </DatePicker.Root>
      </>,
    );
    expect(document.body.textContent?.match(/\(povinné\)/gu)).toHaveLength(2);
    expect(document.body.textContent).not.toContain('(required)');
  });

  it('let the caller choose its own text', () => {
    render(<FormInput id="name" label={copy.name} required requiredLabel="" />);
    expect(document.body.textContent).not.toContain('(povinné)');
  });
});
