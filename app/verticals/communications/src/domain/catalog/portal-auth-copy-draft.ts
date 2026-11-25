import { Effect, Schema } from 'effect';

import { PrepareTemplateRevisionPayloadSchema, TemplateLanguageSchema } from '../../../shared/template-revision.ts';
import type { TemplateScope } from '../../../shared/template-revision.ts';

/**
 * Czech and English SEED copy of the three Portal Auth e-mails (#1398, #1406), kept next to the approved message types
 * it is written for. It is content an authorised administrator MAY prepare and activate as an own Template Revision, and
 * nothing else: template resolution never uses it by itself, so an untouched Tenant has no text for these types (tenant
 * mode B and TPL-05 "no cs text, do not send" apply) until an administrator activates one (R-D1). The set is not a shared
 * or global registry: no Tenant, operator or runtime path can add, edit or publish an entry here, and it is read only by the
 * review Read and the review script.
 *
 * The wording is NOT confirmed. The text asserts security meaning that Auth owns (how long a link or a code is valid and
 * that it is single use), and neither the product owner's approval nor the Auth owner's confirmation is evidenced in the
 * repository, so every output that shows these texts says `PENDING-APPROVER`. Do not reword a text here: a change of any
 * word is a new version that needs the approver's confirmation.
 *
 * Each text carries exactly one placeholder: the secret slot Auth renders itself (`portalAuthOwnerRenderedSlotOf` in
 * the Portal Auth vocabulary; the end-to-end contract suite asserts both agree). No validity period, brand or sender
 * name and no support contact is part of the text: those are product values the product owner has not decided.
 */
/** The approval state of the wording: nobody who may approve it has confirmed it yet. */
export const PORTAL_AUTH_DEFAULT_COPY_APPROVAL = 'PENDING-APPROVER';
/** Version of this catalog's wording. Any change of a text is a new version and needs the approver's confirmation. */
export const PORTAL_AUTH_DEFAULT_COPY_VERSION = 1;

const PortalAuthCopyFlowSchema = Schema.Literals(['verify-email', 'reset-password', 'otp']);
type PortalAuthCopyFlow = typeof PortalAuthCopyFlowSchema.Type;
type PortalAuthCopyLanguage = typeof TemplateLanguageSchema.Type;

export interface PortalAuthCopyEntry {
  readonly body: string;
  /**
   * The Template Revision content digest of exactly this subject, body and declared placeholders
   * (`templateContentDigest`), kept as a value so the review needs no hashing; the catalog test proves it equals the
   * computed digest of the text.
   */
  readonly contentDigest: string;
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
  readonly contentDigest: string;
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
    contentDigest: texts[language].contentDigest,
    flow,
    language,
    messageType: `commerce.customer-context.portal-auth.${flow}-message`,
    ownerRenderedSlot,
    subject: texts[language].subject,
  }));

export const portalAuthDefaultCopy: readonly PortalAuthCopyEntry[] = [
  ...flowCopy('verify-email', 'verification_link', {
    cs: {
      after:
        'Odkaz platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste o registraci nežádali, tento e-mail ignorujte, nic se nestane.',
      before: [CZECH_GREETING, 'pro dokončení registrace potvrďte prosím svou e-mailovou adresu kliknutím na odkaz:'],
      contentDigest: 'ada39fc70e202e9916c91fe422f32dcbdc068dcdd951f5ad56906ffe4e1287e8',
      subject: 'Potvrďte svou e-mailovou adresu',
    },
    en: {
      after:
        'The link is valid for a limited time and can be used only once. If you did not ask for this, ignore this email; nothing will happen.',
      before: [ENGLISH_GREETING, 'To finish creating your account, please confirm your email address using this link:'],
      contentDigest: '6fbe6883420b43d53ac2399c77d5e0ee201b9bf7293f191f66a8c934d4eb4958',
      subject: 'Confirm your email address',
    },
  }),
  ...flowCopy('reset-password', 'reset_link', {
    cs: {
      after:
        'Odkaz platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste o obnovení hesla nežádali, tento e-mail ignorujte; vaše heslo zůstává beze změny. Nikomu odkaz nepředávejte.',
      before: [CZECH_GREETING, 'obdrželi jsme žádost o obnovení hesla. Nové heslo nastavíte na tomto odkazu:'],
      contentDigest: 'bb39f96170d67022c55e29d1ced180a6bd9246bd999ed1805556862725333865',
      subject: 'Obnovení hesla',
    },
    en: {
      after:
        'The link is valid for a limited time and can be used only once. If you did not ask for this, ignore this email; your password stays unchanged. Do not share the link with anyone.',
      before: [
        ENGLISH_GREETING,
        'We received a request to reset your password. You can choose a new one using this link:',
      ],
      contentDigest: 'c18accecd0fb28e2d147e17a69838a78cf757d2f67b5e51f96c6219757b5af9e',
      subject: 'Reset your password',
    },
  }),
  ...flowCopy('otp', 'otp_code', {
    cs: {
      after:
        'Kód platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste se nepřihlašovali, tento e-mail ignorujte a kód nikomu nesdělujte.',
      before: [CZECH_GREETING, 'váš jednorázový kód pro přihlášení je:'],
      contentDigest: 'cb1fe22a30445d22b0672dac10a7d8f1bff5eeddb99172613872fce3ca63039f',
      subject: 'Váš jednorázový kód',
    },
    en: {
      after:
        'The code is valid for a limited time and can be used only once. If you did not try to sign in, ignore this email and do not share the code with anyone.',
      before: [ENGLISH_GREETING, 'Your one-time sign-in code is:'],
      contentDigest: 'bf195f673833fc7fd3216862a2836fe47533af8c1b5a56918f76d4ab737ee595',
      subject: 'Your one-time code',
    },
  }),
];

const decodePayloads = Schema.decodeUnknownEffect(Schema.Array(PrepareTemplateRevisionPayloadSchema));

/**
 * The six `prepare-template-revision` Action payloads of this seed copy for one Template scope. The scope and the
 * reason are the operator's inputs and have no default. The Tenant and the acting principal are NOT part of a payload:
 * the governed Action takes both from the operator's own authenticated operation context, so a payload can never name
 * another Tenant or approver. Each revision it prepares stays a draft until the Tenant's authorised user activates it.
 */
export const portalAuthCopyPreparePayloads = (input: { readonly reason: string; readonly scope: TemplateScope }) =>
  decodePayloads(
    portalAuthDefaultCopy.map((copy) => ({
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
 * The read-only review text of this seed copy: per flow and language the exact subject and body with the placeholder
 * visible, and the content digest every message that used it records (and that the `prepare-template-revision` Action
 * returns for exactly that text when a Tenant stores it as its own revision). Every text is marked as pending the
 * approver: neither the product owner nor the Auth owner has confirmed the wording, and none is in use until an
 * administrator activates it.
 */
export const portalAuthCopyReview = () =>
  Effect.succeed(
    [
      `# Portal Auth e-mail seed copy, version ${PORTAL_AUTH_DEFAULT_COPY_VERSION}: ${PORTAL_AUTH_DEFAULT_COPY_APPROVAL}`,
      'Not in use by itself: only a revision an authorised administrator prepared and activated is ever sent.',
      'Czech (cs) is the language while no trusted recipient locale exists.',
      ...portalAuthDefaultCopy.map((copy) =>
        [
          `## ${copy.flow} / ${copy.language}`,
          `Approval: ${PORTAL_AUTH_DEFAULT_COPY_APPROVAL} (product owner and Auth owner, wording and security meaning unconfirmed)`,
          `Message type: ${copy.messageType}`,
          `Owner-rendered placeholder: {{${copy.ownerRenderedSlot}}}`,
          `Content digest: ${copy.contentDigest}`,
          `Subject: ${copy.subject}`,
          'Body:',
          copy.body,
        ].join('\n'),
      ),
    ].join('\n\n'),
  );
