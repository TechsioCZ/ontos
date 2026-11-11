// @rstest-environment happy-dom
// The manual signature form as a person uses it: typing and Enter record nothing, the one Uložit records the
// signature once, a refusal keeps the input with its reason, and leaving with typed input asks first.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import type { AgreementOutcome } from '../../src/routes/[lang]/smlouvy/agreements-command.ts';
import { SignatureForm } from '../../src/routes/[lang]/smlouvy/signature-form.tsx';
import type { SignatureDraft } from '../../src/routes/[lang]/smlouvy/signature-form.tsx';
import { act } from 'react';
import { button, buttons, click, field, mount, text, type, unmountAll, waitUntil } from '../support/agreement-form.tsx';

interface Navigation {
  proceeded: number;
  shouldBlock: () => boolean;
  status: 'blocked' | 'idle';
}
const { navigation } = rstest.hoisted(() => {
  const state: Navigation = { proceeded: 0, shouldBlock: () => false, status: 'idle' };
  return { navigation: state };
});

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => {
    navigation.shouldBlock = options.shouldBlockFn;
    return {
      proceed: () => {
        navigation.status = 'idle';
        navigation.proceeded += 1;
      },
      reset: () => {
        navigation.status = 'idle';
      },
      status: navigation.status,
    };
  },
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const saved: AgreementOutcome = {
  _tag: 'Saved',
  resourceRef: {
    moduleId: 'legal.agreements',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'legal.agreements.document',
    tenantId: '11111111-1111-4111-8111-111111111111',
  },
  revision: 5,
};
const signature: SignatureDraft = {
  signedBy: 'Jana Nováková',
  signedFileName: 'smlouva.pdf',
  signedOn: '2026-11-10',
  signedReference: 'SP-2026-17',
};
const sentDrafts: SignatureDraft[] = [];
let answer: AgreementOutcome = saved;

const onSave = (draft: SignatureDraft) =>
  Effect.sync(() => {
    sentDrafts.push(draft);
    return answer;
  });

const mountForm = () => mount(<SignatureForm busy={false} onSave={onSave} reload={Effect.void} />);

const fill = Effect.gen(function* fillSignature() {
  yield* type('contract-signedBy', signature.signedBy);
  yield* type('contract-signedFileName', signature.signedFileName);
  yield* type('contract-signedReference', signature.signedReference);
  yield* type('contract-signedOn', signature.signedOn);
});

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sentDrafts.length = 0;
  answer = saved;
  navigation.proceeded = 0;
  navigation.status = 'idle';
});

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('manual signature', () => {
  it.effect('typing and Enter record nothing; one Uložit records the signature once, then the page leaves', () =>
    Effect.gen(function* recordOnce() {
      yield* mountForm();
      expect(navigation.shouldBlock()).toBe(false);
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);
      yield* fill;
      yield* Effect.promise(() =>
        act(async () => {
          field('contract-signedBy').form?.requestSubmit();
        }),
      );
      expect(sentDrafts).toHaveLength(0);
      expect(navigation.shouldBlock()).toBe(true);

      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      expect(sentDrafts).toEqual([signature]);
      expect(navigation.shouldBlock()).toBe(false);
    }),
  );

  it.effect('a refused save keeps the input and names the reason', () =>
    Effect.gen(function* refused() {
      answer = { _tag: 'Failed', reason: 'forbidden' };
      yield* mountForm();
      yield* fill;
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes('legal-agreements.demo.feedback.forbidden'));
      expect(field('contract-signedBy').value).toBe(signature.signedBy);
      expect(navigation.shouldBlock()).toBe(true);
    }),
  );

  it.effect('leaving with typed input asks; Zahodit změny leaves and records nothing', () =>
    Effect.gen(function* leave() {
      yield* mountForm();
      yield* type('contract-signedBy', signature.signedBy);
      expect(navigation.shouldBlock()).toBe(true);
      // The router holds a navigation away; the next render asks about it.
      navigation.status = 'blocked';
      yield* type('contract-signedFileName', signature.signedFileName);
      yield* click(button(labels.discard));
      expect(navigation.proceeded).toBe(1);
      expect(sentDrafts).toHaveLength(0);
    }),
  );

  it.effect('reads the required text of a required field in Czech', () =>
    Effect.gen(function* readRequired() {
      yield* mountForm();
      expect(document.body.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
      const label = document.querySelector('label[for="contract-signedBy"]');
      expect(label?.textContent ?? '').toContain(requiredLabelFor('cs'));
    }),
  );
});
