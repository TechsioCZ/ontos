import { Effect, Schema } from 'effect';

import { PrepareTemplateRevisionPayloadSchema, TemplateLanguageSchema } from '../../../shared/template-revision.ts';
import type { TemplateScope } from '../../../shared/template-revision.ts';
import { templateContentDigest } from '../../services/template-revision-domain.service.ts';

/**
 * DRAFT Czech and English copy of the three Portal Auth e-mails (#1398, #1406), kept next to the approved message types it
 * is written for. It is NOT approved copy: nothing in code submits, activates or sends it. An operator prepares it per
 * Tenant through the governed `prepare-template-revision` Action (see `portalAuthCopyPreparePayloads`), which leaves each
 * revision a draft; only an authorised approver's explicit `activate-template-revision` Action can make it usable. Until
 * then Communications keeps stopping every Portal Auth message with its typed no-template reason.
 *
 * Each text carries exactly one placeholder: the secret slot Auth renders itself (`portalAuthOwnerRenderedSlotOf` in the
 * Portal Auth vocabulary; the end-to-end contract suite asserts both agree). No validity period, brand or sender name and
 * no support contact is part of the text: those are product values the approver has not decided.
 */
export const PORTAL_AUTH_COPY_DRAFT_APPROVAL = 'DRAFT-NOT-APPROVED';
/** Version of this catalog's wording. Any change of a text is a new version and a new review. */
export const PORTAL_AUTH_COPY_DRAFT_VERSION = 1;

const PortalAuthCopyFlowSchema = Schema.Literals(['verify-email', 'reset-password', 'otp']);
type PortalAuthCopyFlow = typeof PortalAuthCopyFlowSchema.Type;
type PortalAuthCopyLanguage = typeof TemplateLanguageSchema.Type;

export interface PortalAuthCopyEntry {
  readonly body: string;
  readonly flow: PortalAuthCopyFlow;
  readonly language: PortalAuthCopyLanguage;
  /** The approved Transactional Message Type key a Template Revision of this text belongs to. */
  readonly messageType: string;
  /** The one secret placeholder of the text, completed by Auth and never by Communications. */
  readonly ownerRenderedSlot: string;
  readonly subject: string;
}

/** One language of a flow: its subject, and its body paragraphs before and after the secret placeholder. */
interface PortalAuthCopyText {
  readonly after: string;
  readonly before: readonly string[];
  readonly subject: string;
}

const CZECH_GREETING = 'Dobrý den,';
const ENGLISH_GREETING = 'Hello,';

/** Czech first: Czech is the default language while no trusted recipient locale exists. */
const flowCopy = (
  flow: PortalAuthCopyFlow,
  ownerRenderedSlot: string,
  texts: Readonly<Record<PortalAuthCopyLanguage, PortalAuthCopyText>>,
): readonly PortalAuthCopyEntry[] =>
  TemplateLanguageSchema.literals.map((language) => ({
    body: [...texts[language].before, `{{${ownerRenderedSlot}}}`, texts[language].after].join('\n\n'),
    flow,
    language,
    messageType: `commerce.customer-context.portal-auth.${flow}-message`,
    ownerRenderedSlot,
    subject: texts[language].subject,
  }));

export const portalAuthCopyDraft: readonly PortalAuthCopyEntry[] = [
  ...flowCopy('verify-email', 'verification_link', {
    cs: {
      after:
        'Odkaz platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste o registraci nežádali, tento e-mail ignorujte, nic se nestane.',
      before: [CZECH_GREETING, 'pro dokončení registrace potvrďte prosím svou e-mailovou adresu kliknutím na odkaz:'],
      subject: 'Potvrďte svou e-mailovou adresu',
    },
    en: {
      after:
        'The link is valid for a limited time and can be used only once. If you did not ask for this, ignore this email; nothing will happen.',
      before: [ENGLISH_GREETING, 'To finish creating your account, please confirm your email address using this link:'],
      subject: 'Confirm your email address',
    },
  }),
  ...flowCopy('reset-password', 'reset_link', {
    cs: {
      after:
        'Odkaz platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste o obnovení hesla nežádali, tento e-mail ignorujte; vaše heslo zůstává beze změny. Nikomu odkaz nepředávejte.',
      before: [CZECH_GREETING, 'obdrželi jsme žádost o obnovení hesla. Nové heslo nastavíte na tomto odkazu:'],
      subject: 'Obnovení hesla',
    },
    en: {
      after:
        'The link is valid for a limited time and can be used only once. If you did not ask for this, ignore this email; your password stays unchanged. Do not share the link with anyone.',
      before: [
        ENGLISH_GREETING,
        'We received a request to reset your password. You can choose a new one using this link:',
      ],
      subject: 'Reset your password',
    },
  }),
  ...flowCopy('otp', 'otp_code', {
    cs: {
      after:
        'Kód platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste se nepřihlašovali, tento e-mail ignorujte a kód nikomu nesdělujte.',
      before: [CZECH_GREETING, 'váš jednorázový kód pro přihlášení je:'],
      subject: 'Váš jednorázový kód',
    },
    en: {
      after:
        'The code is valid for a limited time and can be used only once. If you did not try to sign in, ignore this email and do not share the code with anyone.',
      before: [ENGLISH_GREETING, 'Your one-time sign-in code is:'],
      subject: 'Your one-time code',
    },
  }),
];

const decodePayloads = Schema.decodeUnknownEffect(Schema.Array(PrepareTemplateRevisionPayloadSchema));

/**
 * The six `prepare-template-revision` Action payloads of this draft for one Template scope. The scope and the reason are
 * the operator's inputs and have no default. The Tenant and the acting principal are NOT part of a payload: the governed
 * Action takes both from the operator's own authenticated operation context, so a payload can never name another Tenant
 * or approver. Each revision it prepares stays a draft until an approver activates it.
 */
export const portalAuthCopyPreparePayloads = (input: { readonly reason: string; readonly scope: TemplateScope }) =>
  decodePayloads(
    portalAuthCopyDraft.map((copy) => ({
      body: copy.body,
      channel: 'email',
      language: copy.language,
      messageType: copy.messageType,
      optionalPlaceholders: [],
      reason: input.reason,
      requiredPlaceholders: [copy.ownerRenderedSlot],
      scope: input.scope,
      subject: copy.subject,
    })),
  );

/**
 * The read-only review text of this draft: per flow and language the exact subject and body with the placeholder visible,
 * and the content digest the `prepare-template-revision` Action returns for exactly that text. The approver compares the
 * digest of each prepared revision with this one before activating it.
 */
export const portalAuthCopyReview = Effect.fn('PortalAuthCopyDraft.review')(function* review() {
  const sections = yield* Effect.forEach(
    portalAuthCopyDraft,
    (copy) =>
      Effect.map(templateContentDigest(copy.subject, copy.body), (digest) =>
        [
          `## ${copy.flow} / ${copy.language}${copy.language === 'cs' ? ' (default)' : ''}`,
          `Message type: ${copy.messageType}`,
          `Owner-rendered placeholder: {{${copy.ownerRenderedSlot}}}`,
          `Content digest: ${digest}`,
          `Subject: ${copy.subject}`,
          'Body:',
          copy.body,
        ].join('\n'),
      ),
    { concurrency: 1 },
  );
  return [
    `# Portal Auth e-mail copy, version ${PORTAL_AUTH_COPY_DRAFT_VERSION}: ${PORTAL_AUTH_COPY_DRAFT_APPROVAL}`,
    ...sections,
  ].join('\n\n');
});
