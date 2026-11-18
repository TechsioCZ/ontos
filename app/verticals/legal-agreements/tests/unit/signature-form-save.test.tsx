// @rstest-environment happy-dom
// The manual signature form as a person uses it: typing and Enter record nothing, the one Uložit records the
// signature once, a refusal keeps the input with its reason, and leaving with typed input asks first.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { AnyRouter } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import type { AgreementOutcome } from '../../src/routes/[lang]/smlouvy/agreements-command.ts';
import { SignatureForm } from '../../src/routes/[lang]/smlouvy/signature-form.tsx';
import type { SignatureDraft } from '../../src/routes/[lang]/smlouvy/signature-form.tsx';
import { act } from 'react';
import { button, buttons, click, field, text, type } from '../support/agreement-form.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

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

const mountForm = () =>
  mountInRoute(<SignatureForm busy={false} onSave={onSave} reload={Effect.void} />, {
    path: 'smlouvy',
    url: '/cs/smlouvy',
  });

/** A real attempted departure exposes the router's decision and the person's choice to stay. */
const expectBlocked = (router: AnyRouter) =>
  Effect.gen(function* blockedDeparture() {
    const previous = router.state.location.href;
    yield* acted(() => {
      void router.navigate({ to: '/cs' });
    });
    yield* waitUntil(() => buttons(labels.discard).length === 1);
    expect(router.state.location.href).toBe(previous);
    expect(buttons(labels.discard)).toHaveLength(1);
    yield* click(button(labels.stay));
    yield* waitUntil(() => buttons(labels.discard).length === 0);
  });

const expectAllowed = (router: AnyRouter, destination: string) =>
  Effect.gen(function* allowedNavigation() {
    yield* acted(() => {
      void router.navigate({ to: destination });
    });
    yield* waitUntil(() => router.state.location.href === destination);
    expect(router.state.location.href).toBe(destination);
    expect(buttons(labels.discard)).toHaveLength(0);
  });

const fill = Effect.gen(function* fillSignature() {
  yield* type('contract-signedBy', signature.signedBy);
  yield* type('contract-signedFileName', signature.signedFileName);
  yield* type('contract-signedReference', signature.signedReference);
  yield* type('contract-signedOn', signature.signedOn);
});

beforeEach(() => {
  sentDrafts.length = 0;
  answer = saved;
});

afterEach(() => {
  unmountAll();
});

describe('manual signature', () => {
  it.live('typing and Enter record nothing; one Uložit records the signature once, then the page leaves', () =>
    Effect.gen(function* recordOnce() {
      const { router } = yield* mountForm();
      yield* expectAllowed(router, '/cs/smlouvy?clean=1');
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);
      yield* fill;
      yield* Effect.promise(() =>
        act(async () => {
          field('contract-signedBy').form?.requestSubmit();
        }),
      );
      expect(sentDrafts).toHaveLength(0);
      yield* expectBlocked(router);

      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      expect(sentDrafts).toEqual([signature]);
      yield* expectAllowed(router, '/cs');
    }),
  );

  it.live('a refused save keeps the input and names the reason', () =>
    Effect.gen(function* refused() {
      answer = { _tag: 'Failed', reason: 'forbidden' };
      const { router } = yield* mountForm();
      yield* fill;
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(moduleText('cs')('legal-agreements.demo.feedback.forbidden')));
      expect(field('contract-signedBy').value).toBe(signature.signedBy);
      yield* expectBlocked(router);
    }),
  );

  it.live('leaving with typed input asks; Zahodit změny leaves and records nothing', () =>
    Effect.gen(function* leave() {
      const { router } = yield* mountForm();
      yield* type('contract-signedBy', signature.signedBy);
      yield* expectBlocked(router);
      yield* type('contract-signedFileName', signature.signedFileName);
      yield* acted(() => {
        void router.navigate({ to: '/cs' });
      });
      yield* waitUntil(() => buttons(labels.discard).length === 1);
      yield* click(button(labels.discard));
      yield* waitUntil(() => router.state.location.pathname === '/cs');
      expect(router.state.location.pathname).toBe('/cs');
      expect(sentDrafts).toHaveLength(0);
    }),
  );

  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* readRequired() {
      yield* mountForm();
      expect(document.body.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
      const label = document.querySelector('label[for="contract-signedBy"]');
      expect(label?.textContent ?? '').toContain(requiredLabelFor('cs'));
    }),
  );
});
