import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { makeActionTestHarness, bindActionTestServices } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { prepareTemplateRevisionAction } from '../../src/actions/prepare-template-revision.action.ts';
import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import {
  PORTAL_AUTH_COPY_DRAFT_APPROVAL,
  PORTAL_AUTH_COPY_DRAFT_VERSION,
  portalAuthCopyDraft,
  portalAuthCopyPreparePayloads,
  portalAuthCopyReview,
} from '../../src/domain/catalog/portal-auth-copy-draft.ts';
import { decideMessageLanguage } from '../../src/services/language-selection.service.ts';
import { extractPlaceholders, resolveTemplatePin } from '../../src/services/template-revision-domain.service.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { makeInMemoryLanguagePolicyPort } from '../support/language-fixtures.ts';

/**
 * #1398 / #1406: the DRAFT Portal Auth copy is ready for an approver and is nothing more. It is the reviewed text, it holds
 * only the owner-rendered secret slot, and preparing it through the governed Action leaves every revision a draft, so each
 * Portal Auth message still stops with its typed no-template reason until an approver activates a revision.
 */

const FLOW_SLOTS = [
  ['verify-email', 'verification_link'],
  ['reset-password', 'reset_link'],
  ['otp', 'otp_code'],
] as const;
/**
 * The reviewed draft (2026-11-22), pinned as subject and Template Revision content digest per flow and language: the very
 * digest the prepare Action returns and the review script prints, so a changed word fails here and needs a new review.
 */
const REVIEWED = [
  {
    digest: '5c1f1f96466aece909321c52fb671082b9727d93107c6a7b97809fb4027e5ab5',
    flow: 'verify-email',
    language: 'cs',
    subject: 'Potvrďte svou e-mailovou adresu',
  },
  {
    digest: '21459c0a7ab8b187a2157193e0a1bcf76fc945a246a807a00041c25c58cff0d2',
    flow: 'verify-email',
    language: 'en',
    subject: 'Confirm your email address',
  },
  {
    digest: '959ca4cb818fe89b7eaca3d92e5959f1a45d36df01fe82400bd684999c7e792c',
    flow: 'reset-password',
    language: 'cs',
    subject: 'Obnovení hesla',
  },
  {
    digest: '25a2c61d3c5715439784c0438bd2b042a0ea0ad183be0602f510cb4585f98d97',
    flow: 'reset-password',
    language: 'en',
    subject: 'Reset your password',
  },
  {
    digest: '7bb975b19ed3a22b6734cd968471f0afb4dac4653601932beacb3ee3e03e7ce4',
    flow: 'otp',
    language: 'cs',
    subject: 'Váš jednorázový kód',
  },
  {
    digest: '7ec875abacd3fb22f2bc3b6efc732536ae77e72046ceb9775fe07eb90da41c0a',
    flow: 'otp',
    language: 'en',
    subject: 'Your one-time code',
  },
] as const;

const tenantId = '11111111-1111-4111-8111-111111111111';
const principal = {
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:communications-portal-auth-copy',
  authMethod: 'session' as const,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
};
const tenantScope = { kind: 'tenant' } as const;

/** Prepares all six draft revisions through the REAL prepare Action in the Core Action runtime, as an operator would. */
const prepareDraftThroughAction = Effect.gen(function* prepareDraft() {
  const memory = makeInMemoryTemplatePort();
  const harness = yield* makeActionTestHarness({
    access: 'allowed',
    ownerRegistration: communicationsRegistration,
    services: [bindActionTestServices(prepareTemplateRevisionAction, memory.port)],
  });
  const payloads = yield* portalAuthCopyPreparePayloads({
    reason: 'Portal Auth copy v1 for review',
    scope: tenantScope,
  });
  const results = yield* Effect.forEach(
    payloads,
    (payload, index) =>
      harness.runtime.runAction({
        payload,
        principal,
        registration: prepareTemplateRevisionAction,
        transport: { correlationId: `portal-auth-copy-${index}`, idempotencyKey: `portal-auth-copy-${index}` },
      }),
    { concurrency: 1 },
  );
  return { memory, payloads, results };
});

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) {
      return sourceFiles(file);
    }
    return /\.m?ts$/u.test(file) ? [file] : [];
  });

describe('The DRAFT Portal Auth e-mail copy (#1398, #1406)', () => {
  it('is marked DRAFT-NOT-APPROVED, versioned, and holds exactly one Czech and one English text per Auth flow', () => {
    expect(PORTAL_AUTH_COPY_DRAFT_APPROVAL).toBe('DRAFT-NOT-APPROVED');
    expect(PORTAL_AUTH_COPY_DRAFT_VERSION).toBe(1);
    expect(portalAuthCopyDraft.map(({ flow, language }) => `${flow}/${language}`)).toEqual(
      REVIEWED.map(({ flow, language }) => `${flow}/${language}`),
    );
  });

  it.effect('is the reviewed draft wording, word for word', () =>
    Effect.gen(function* reviewed() {
      expect(portalAuthCopyDraft.map(({ subject }) => subject)).toEqual(REVIEWED.map(({ subject }) => subject));
      const review = yield* portalAuthCopyReview();
      for (const { digest, flow, language } of REVIEWED) {
        expect(review).toContain(`## ${flow} / ${language}`);
        expect(review).toContain(`Content digest: ${digest}`);
      }
      for (const copy of portalAuthCopyDraft) {
        expect(review).toContain(`Subject: ${copy.subject}\nBody:\n${copy.body}`);
      }
      expect(review.startsWith('# Portal Auth e-mail copy, version 1: DRAFT-NOT-APPROVED')).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it("belongs to the approved Portal Auth message type of its flow and carries exactly that flow's one owner-rendered slot", () => {
    for (const copy of portalAuthCopyDraft) {
      const type = approvedMessageTypes.find(({ typeId }) => typeId === copy.messageType);
      expect(type?.purpose).toBe(`commerce.customer-context.portal-auth.${copy.flow}`);
      expect(type?.sourceOwner).toBe('commerce.customer-context');
      const slot = FLOW_SLOTS.find(([flow]) => flow === copy.flow)?.[1];
      expect(copy.ownerRenderedSlot).toBe(slot);
      const subject = extractPlaceholders(copy.subject);
      const body = extractPlaceholders(copy.body);
      expect(subject).toEqual({ malformed: false, names: [] });
      expect(body).toEqual({ malformed: false, names: [slot] });
    }
  });

  it('contains no secret, address, link, number or other invented product value: only the placeholder stands for the secret', () => {
    for (const copy of portalAuthCopyDraft) {
      const text = `${copy.subject}\n${copy.body}`.replace(`{{${copy.ownerRenderedSlot}}}`, '');
      expect(text).not.toMatch(/[@{}<>]|:\/\/|www\.|\d/u);
    }
  });

  it.effect(
    'builds the prepare payloads only from an explicit scope and reason: no default, and no Tenant or principal field',
    () =>
      Effect.gen(function* payloads() {
        const prepared = yield* portalAuthCopyPreparePayloads({ reason: 'Portal Auth copy v1', scope: tenantScope });
        expect(prepared).toHaveLength(6);
        for (const [index, payload] of prepared.entries()) {
          expect(Object.keys(payload).toSorted()).toEqual([
            'body',
            'channel',
            'language',
            'messageType',
            'optionalPlaceholders',
            'reason',
            'requiredPlaceholders',
            'scope',
            'subject',
          ]);
          expect(payload).toMatchObject({
            body: portalAuthCopyDraft[index]?.body,
            optionalPlaceholders: [],
            requiredPlaceholders: [portalAuthCopyDraft[index]?.ownerRenderedSlot],
            scope: tenantScope,
          });
        }
        const refused = yield* Effect.flip(portalAuthCopyPreparePayloads({ reason: '', scope: tenantScope }));
        expect(Schema.isSchemaError(refused)).toBe(true);
      }),
  );

  it.effect(
    'prepared through the governed Action, every revision stays a draft and nothing is active: no pin resolves and both languages stop with a typed reason',
    () =>
      Effect.gen(function* preparedOnly() {
        const { memory, payloads, results } = yield* prepareDraftThroughAction;
        expect(results.map(({ contentDigest }) => contentDigest)).toEqual(REVIEWED.map(({ digest }) => digest));
        expect(memory.state.revisions).toHaveLength(6);
        expect(
          memory.state.revisions.every(({ createdByPrincipalId }) => createdByPrincipalId === principal.principalId),
        ).toBe(true);
        expect(memory.state.activations).toEqual([]);
        for (const payload of payloads) {
          const failure = yield* Effect.flip(resolveTemplatePin(memory.port, payload));
          expect(failure).toMatchObject({ code: 'template_no_active_revision' });
        }
        const policies = makeInMemoryLanguagePolicyPort();
        for (const [flow] of FLOW_SLOTS) {
          const base = {
            channel: 'email',
            messageType: `commerce.customer-context.portal-auth.${flow}-message`,
            scope: tenantScope,
          } as const;
          const decide = (recipient: Parameters<typeof decideMessageLanguage>[2]['recipient']) =>
            decideMessageLanguage(memory.port, policies.port, {
              base,
              ownerPermittedLanguages: ['cs', 'en'],
              recipient,
            });
          // the Czech default (no trusted locale exists) and a trusted English recipient both stop: nothing is active
          expect(yield* decide({ kind: 'not-established' })).toMatchObject({
            outcome: 'not-sent',
            reason: 'czech_revision_unavailable',
          });
          expect(yield* decide({ kind: 'trusted', language: 'en' })).toMatchObject({ outcome: 'not-sent' });
        }
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('is activated by no code path: nothing that uses the draft can reach the activate Action or the activation rule', () => {
    const root = path.join(import.meta.dirname, '..', '..');
    const users = ['src', 'shared', 'api', 'scripts']
      .flatMap((directory) => sourceFiles(path.join(root, directory)))
      .filter((file) => !file.endsWith('portal-auth-copy-draft.ts'))
      .filter((file) => readFileSync(file, 'utf-8').includes('portal-auth-copy-draft'));
    expect(users.map((file) => path.relative(root, file))).toEqual(['scripts/review-portal-auth-copy-draft.mts']);
    for (const file of [...users, path.join(root, 'src/domain/catalog/portal-auth-copy-draft.ts')]) {
      expect(readFileSync(file, 'utf-8')).not.toMatch(
        /activateRevision|activate-template-revision\.action|ActivateTemplateRevision/u,
      );
    }
  });
});
