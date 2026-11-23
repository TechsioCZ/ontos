import { Effect, Schema } from 'effect';

import { PrepareTemplateRevisionPayloadSchema, TemplateLanguageSchema } from '../../../shared/template-revision.ts';
import type { TemplateScope } from '../../../shared/template-revision.ts';

/**
 * Czech and English BUILT-IN DEFAULT copy of the three Portal Auth e-mails (#1398, #1406), kept next to the approved
 * message types it is written for. The product owner approved this TEXT on 2026-11-23 as the default wording, ACTIVE BY
 * DEFAULT for every Tenant: template resolution falls back to it as its last step for an exact message type, language
 * and scope the Tenant never took over with an own activated revision (`resolveTemplatePin`). A Tenant replaces it
 * through the ordinary `prepare-template-revision` and `activate-template-revision` Actions; only then is a revision
 * stored, attributed to the real person who made the change.
 *
 * GRAY AREA for the product owner to acknowledge in the PR: decision #1398 excludes a shared global template registry.
 * This is a fixed, versioned set of six texts in code for exactly the approved Portal Auth message types: no Tenant,
 * operator or runtime path can add, edit or publish an entry, and any wording change is a new version that needs a new
 * approval. It is therefore not a registry, but it is shared default content all Tenants receive until they replace it.
 *
 * Each text carries exactly one placeholder: the secret slot Auth renders itself (`portalAuthOwnerRenderedSlotOf` in
 * the Portal Auth vocabulary; the end-to-end contract suite asserts both agree). No validity period, brand or sender
 * name and no support contact is part of the text: those are product values the product owner has not decided.
 */
/** Approval of the TEXT: the product owner approved this wording as the Portal Auth default (2026-11-23). */
export const PORTAL_AUTH_DEFAULT_COPY_APPROVAL = 'APPROVED-DEFAULT-TEXT';
/** Who approved the text and when: the product owner, recorded with the decision of #1398 / #1406. */
export const PORTAL_AUTH_DEFAULT_COPY_APPROVED_ON = '2026-11-23';
/** In use for every Tenant until it replaces it with an own activated revision of the exact identity. */
export const PORTAL_AUTH_DEFAULT_COPY_ACTIVATION = 'ACTIVE-BY-DEFAULT';
/** Version of this catalog's wording. Any change of a text is a new version and needs a new product-owner approval. */
export const PORTAL_AUTH_DEFAULT_COPY_VERSION = 1;

const PortalAuthCopyFlowSchema = Schema.Literals(['verify-email', 'reset-password', 'otp']);
type PortalAuthCopyFlow = typeof PortalAuthCopyFlowSchema.Type;
type PortalAuthCopyLanguage = typeof TemplateLanguageSchema.Type;

export interface PortalAuthCopyEntry {
  readonly body: string;
  /**
   * The Template Revision content digest of exactly this subject and body (`templateContentDigest`), kept as a value so
   * resolving a pin needs no hashing; the catalog test proves it equals the computed digest of the text.
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
      contentDigest: '5c1f1f96466aece909321c52fb671082b9727d93107c6a7b97809fb4027e5ab5',
      subject: 'Potvrďte svou e-mailovou adresu',
    },
    en: {
      after:
        'The link is valid for a limited time and can be used only once. If you did not ask for this, ignore this email; nothing will happen.',
      before: [ENGLISH_GREETING, 'To finish creating your account, please confirm your email address using this link:'],
      contentDigest: '21459c0a7ab8b187a2157193e0a1bcf76fc945a246a807a00041c25c58cff0d2',
      subject: 'Confirm your email address',
    },
  }),
  ...flowCopy('reset-password', 'reset_link', {
    cs: {
      after:
        'Odkaz platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste o obnovení hesla nežádali, tento e-mail ignorujte; vaše heslo zůstává beze změny. Nikomu odkaz nepředávejte.',
      before: [CZECH_GREETING, 'obdrželi jsme žádost o obnovení hesla. Nové heslo nastavíte na tomto odkazu:'],
      contentDigest: '959ca4cb818fe89b7eaca3d92e5959f1a45d36df01fe82400bd684999c7e792c',
      subject: 'Obnovení hesla',
    },
    en: {
      after:
        'The link is valid for a limited time and can be used only once. If you did not ask for this, ignore this email; your password stays unchanged. Do not share the link with anyone.',
      before: [
        ENGLISH_GREETING,
        'We received a request to reset your password. You can choose a new one using this link:',
      ],
      contentDigest: '25a2c61d3c5715439784c0438bd2b042a0ea0ad183be0602f510cb4585f98d97',
      subject: 'Reset your password',
    },
  }),
  ...flowCopy('otp', 'otp_code', {
    cs: {
      after:
        'Kód platí jen omezenou dobu a lze jej použít jen jednou. Pokud jste se nepřihlašovali, tento e-mail ignorujte a kód nikomu nesdělujte.',
      before: [CZECH_GREETING, 'váš jednorázový kód pro přihlášení je:'],
      contentDigest: '7bb975b19ed3a22b6734cd968471f0afb4dac4653601932beacb3ee3e03e7ce4',
      subject: 'Váš jednorázový kód',
    },
    en: {
      after:
        'The code is valid for a limited time and can be used only once. If you did not try to sign in, ignore this email and do not share the code with anyone.',
      before: [ENGLISH_GREETING, 'Your one-time sign-in code is:'],
      contentDigest: '7ec875abacd3fb22f2bc3b6efc732536ae77e72046ceb9775fe07eb90da41c0a',
      subject: 'Your one-time code',
    },
  }),
];

const decodePayloads = Schema.decodeUnknownEffect(Schema.Array(PrepareTemplateRevisionPayloadSchema));

/**
 * The six `prepare-template-revision` Action payloads of this default copy for one Template scope. The scope and the
 * reason are the operator's inputs and have no default. The Tenant and the acting principal are NOT part of a payload:
 * the governed Action takes both from the operator's own authenticated operation context, so a payload can never name
 * another Tenant or approver. Each revision it prepares stays a draft until the Tenant's authorised user activates it;
 * a Tenant that took a text over and wants the built-in wording back stores it as its own revision this way.
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
 * The read-only review text of this default copy: per flow and language the exact subject and body with the placeholder
 * visible, and the content digest every message that used it records (and that the `prepare-template-revision` Action
 * returns for exactly that text when a Tenant stores it as its own revision).
 */
export const portalAuthCopyReview = () =>
  Effect.succeed(
    [
      `# Portal Auth e-mail copy, version ${PORTAL_AUTH_DEFAULT_COPY_VERSION}: ${PORTAL_AUTH_DEFAULT_COPY_APPROVAL} (product owner, ${PORTAL_AUTH_DEFAULT_COPY_APPROVED_ON}), ${PORTAL_AUTH_DEFAULT_COPY_ACTIVATION}`,
      'Czech (cs) is the default language while no trusted recipient locale exists.',
      ...portalAuthDefaultCopy.map((copy) =>
        [
          `## ${copy.flow} / ${copy.language}`,
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
