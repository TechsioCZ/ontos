import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { makeActionTestHarness, bindActionTestServices } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { prepareTemplateRevisionAction } from '../../src/actions/prepare-template-revision.action.ts';
import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import {
  PORTAL_AUTH_DEFAULT_COPY_APPROVAL,
  PORTAL_AUTH_DEFAULT_COPY_VERSION,
  portalAuthDefaultCopy,
  portalAuthCopyPreparePayloads,
  portalAuthCopyReview,
} from '../../src/domain/catalog/portal-auth-copy-draft.ts';
import { decideMessageLanguage } from '../../src/services/language-selection.service.ts';
import {
  extractPlaceholders,
  resolveTemplatePin,
  templateContentDigest,
} from '../../src/services/template-revision-domain.service.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { makeInMemoryLanguagePolicyPort } from '../support/language-fixtures.ts';

/**
 * #1398 / #1406 / R-D1: the Portal Auth copy is SEED content with its pinned digest, pending the approver (the product
 * owner and the Auth owner have not confirmed it). It holds only the owner-rendered secret slot, it is never used unless an
 * administrator activates it, and a Tenant that prepares it through the governed Action stores an ordinary draft.
 */

const FLOW_SLOTS = [
  ['verify-email', 'verification_link'],
  ['reset-password', 'reset_link'],
  ['otp', 'otp_code'],
] as const;
/**
 * The seed text, pinned as subject and Template Revision content digest per flow and language: the very digest the
 * prepare Action returns and the review script prints, so a changed word fails here and needs the approver's confirmation.
 */
const REVIEWED = [
  {
    digest: 'ada39fc70e202e9916c91fe422f32dcbdc068dcdd951f5ad56906ffe4e1287e8',
    flow: 'verify-email',
    language: 'cs',
    subject: 'Potvrďte svou e-mailovou adresu',
  },
  {
    digest: '6fbe6883420b43d53ac2399c77d5e0ee201b9bf7293f191f66a8c934d4eb4958',
    flow: 'verify-email',
    language: 'en',
    subject: 'Confirm your email address',
  },
  {
    digest: 'bb39f96170d67022c55e29d1ced180a6bd9246bd999ed1805556862725333865',
    flow: 'reset-password',
    language: 'cs',
    subject: 'Obnovení hesla',
  },
  {
    digest: 'c18accecd0fb28e2d147e17a69838a78cf757d2f67b5e51f96c6219757b5af9e',
    flow: 'reset-password',
    language: 'en',
    subject: 'Reset your password',
  },
  {
    digest: 'cb1fe22a30445d22b0672dac10a7d8f1bff5eeddb99172613872fce3ca63039f',
    flow: 'otp',
    language: 'cs',
    subject: 'Váš jednorázový kód',
  },
  {
    digest: 'bf195f673833fc7fd3216862a2836fe47533af8c1b5a56918f76d4ab737ee595',
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

describe('The approved default Portal Auth e-mail copy (#1398, #1406)', () => {
  it('is marked pending the approver, versioned, and holds exactly one Czech and one English text per Auth flow', () => {
    expect(PORTAL_AUTH_DEFAULT_COPY_APPROVAL).toBe('PENDING-APPROVER');
    expect(PORTAL_AUTH_DEFAULT_COPY_VERSION).toBe(1);
    expect(portalAuthDefaultCopy.map(({ flow, language }) => `${flow}/${language}`)).toEqual(
      REVIEWED.map(({ flow, language }) => `${flow}/${language}`),
    );
  });

  it.effect('is the seed wording, word for word, and the review marks every text as pending the approver', () =>
    Effect.gen(function* reviewed() {
      expect(portalAuthDefaultCopy.map(({ subject }) => subject)).toEqual(REVIEWED.map(({ subject }) => subject));
      const review = yield* portalAuthCopyReview();
      for (const { digest, flow, language } of REVIEWED) {
        expect(review).toContain(`## ${flow} / ${language}`);
        expect(review).toContain(`Content digest: ${digest}`);
      }
      for (const copy of portalAuthDefaultCopy) {
        expect(review).toContain(`Subject: ${copy.subject}\nBody:\n${copy.body}`);
        // the digest the catalog keeps is the computed digest of exactly this text and its placeholder declarations
        expect(copy.contentDigest).toBe(
          yield* templateContentDigest({
            body: copy.body,
            optionalPlaceholders: [],
            requiredPlaceholders: [copy.ownerRenderedSlot],
            subject: copy.subject,
          }),
        );
      }
      expect(review.startsWith('# Portal Auth e-mail seed copy, version 1: PENDING-APPROVER')).toBe(true);
      // one approval marker per text, and no claim of an approval anybody confirmed
      expect(review.match(/Approval: PENDING-APPROVER/gu)).toHaveLength(6);
      expect(review).not.toMatch(/APPROVED|ACTIVE-BY-DEFAULT/u);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it("belongs to the approved Portal Auth message type of its flow and carries exactly that flow's one owner-rendered slot", () => {
    for (const copy of portalAuthDefaultCopy) {
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
    for (const copy of portalAuthDefaultCopy) {
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
            body: portalAuthDefaultCopy[index]?.body,
            optionalPlaceholders: [],
            requiredPlaceholders: [portalAuthDefaultCopy[index]?.ownerRenderedSlot],
            scope: tenantScope,
          });
        }
        const refused = yield* Effect.flip(portalAuthCopyPreparePayloads({ reason: '', scope: tenantScope }));
        expect(Schema.isSchemaError(refused)).toBe(true);
      }),
  );

  it.effect(
    'prepared by a Tenant through the governed Action it is only an own draft: nothing is in force until an administrator activates it',
    () =>
      Effect.gen(function* preparedOnly() {
        const { memory, payloads, results } = yield* prepareDraftThroughAction;
        expect(results.map(({ contentDigest }) => contentDigest)).toEqual(REVIEWED.map(({ digest }) => digest));
        expect(memory.state.revisions).toHaveLength(6);
        expect(
          memory.state.revisions.every(({ createdByPrincipalId }) => createdByPrincipalId === principal.principalId),
        ).toBe(true);
        expect(memory.state.activations).toEqual([]);
        // drafts take nothing over: every identity still has no text, so no message of it can leave
        for (const payload of payloads) {
          expect(yield* Effect.flip(resolveTemplatePin(memory.port, payload))).toMatchObject({
            code: 'template_no_active_revision',
          });
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
          // no Czech text exists, so nothing is sent whatever the recipient asks for
          expect(yield* decide({ kind: 'not-established' })).toMatchObject({
            outcome: 'not-sent',
            reason: 'czech_revision_unavailable',
          });
          expect(yield* decide({ kind: 'trusted', language: 'en' })).toMatchObject({ outcome: 'not-sent' });
        }
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('is read by the seed list and the review script only, and the catalog itself activates and stores nothing', () => {
    const root = path.join(import.meta.dirname, '..', '..');
    const sources = ['src', 'shared', 'api', 'scripts'].flatMap((directory) => sourceFiles(path.join(root, directory)));
    const users = sources
      .filter((file) => !file.endsWith('portal-auth-copy-draft.ts'))
      .filter((file) => readFileSync(file, 'utf-8').includes('portal-auth-copy-draft'))
      .map((file) => path.relative(root, file));
    expect(users).toEqual([
      'src/domain/catalog/built-in-template-defaults.ts',
      'src/services/built-in-template-default-domain.service.ts',
      'scripts/review-portal-auth-copy-draft.mts',
    ]);
    for (const file of [
      'src/domain/catalog/portal-auth-copy-draft.ts',
      'src/domain/catalog/built-in-template-defaults.ts',
    ]) {
      expect(readFileSync(path.join(root, file), 'utf-8')).not.toMatch(
        /activateRevision|prepareRevision|appendRevision|appendActivation|ensureType/u,
      );
    }
  });
});
