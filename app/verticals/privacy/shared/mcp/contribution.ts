import { defineOntosMcpContribution, OntosMcpHidden } from '@app/core-runtime/modules/mcp-contribution';

const consentSelfServiceTool = {
  destructive: true,
  title: { cs: 'Spravovat vlastní souhlasy se zpracováním', en: 'Manage own processing consents' },
} as const;

const noticeProvisionTool = {
  title: { cs: 'Zaznamenat poskytnutí informačního oznámení', en: 'Record privacy notice provision' },
} as const;

/**
 * Consent self-service and notice provision need an authority that a deployment's production API may not install
 * yet. A deployment without it hides both, so agents are not offered a tool whose every call fails.
 */
const privacyMcpContributionWith = (
  consentSelfService: typeof consentSelfServiceTool | typeof OntosMcpHidden,
  noticeProvision: typeof noticeProvisionTool | typeof OntosMcpHidden,
) =>
  defineOntosMcpContribution({
    actions: {
      'acknowledge-privacy-notice': 'hidden',
      'add-processing-purpose-version': {
        title: { cs: 'Přidat verzi účelu zpracování', en: 'Add a processing purpose version' },
      },
      'assign-dsr-resolver': {
        title: { cs: 'Přiřadit řešitele žádosti subjektu údajů', en: 'Assign a data subject request resolver' },
      },
      'assign-legal-basis': {
        title: { cs: 'Přiřadit právní základ zpracování', en: 'Assign a processing legal basis' },
      },
      'assign-privacy-responsibility': {
        destructive: false,
        title: { cs: 'Přiřadit odpovědnost za ochranu osobních údajů', en: 'Assign a privacy responsibility' },
      },
      'consent-self-service': consentSelfService,
      // Production installs no DSR intake receipt authority; every invocation fails until it is wired.
      'create-dsr-case': OntosMcpHidden,
      'create-notice-version': {
        title: { cs: 'Vytvořit verzi informačního oznámení', en: 'Create a privacy notice version' },
      },
      'create-privacy-subject': {
        destructive: false,
        title: { cs: 'Založit subjekt údajů', en: 'Create a data subject' },
      },
      'create-processing-activity': {
        title: { cs: 'Vytvořit činnost zpracování', en: 'Create a processing activity' },
      },
      'create-processing-purpose': { title: { cs: 'Vytvořit účel zpracování', en: 'Create a processing purpose' } },
      'dispatch-privacy-measure': {
        title: { cs: 'Předat opatření ochrany osobních údajů k provedení', en: 'Dispatch a privacy measure' },
      },
      'enqueue-retention-evaluation': {
        title: { cs: 'Vyžádat vyhodnocení doby uchování údajů', en: 'Request a retention evaluation' },
      },
      'evaluate-processing-eligibility': {
        title: { cs: 'Vyhodnotit přípustnost zpracování', en: 'Evaluate processing eligibility' },
      },
      // Production installs no DSR delivery access authority; every invocation fails until it is wired.
      'issue-dsr-delivery-access': OntosMcpHidden,
      // Production installs no anti-resurrection enforcement authority; every invocation fails until it is wired.
      'record-anti-resurrection-protection': OntosMcpHidden,
      'record-applicability-policy': {
        title: { cs: 'Zaznamenat pravidla použitelnosti ochrany údajů', en: 'Record a privacy applicability policy' },
      },
      'record-consent-decision': {
        destructive: true,
        title: { cs: 'Zaznamenat rozhodnutí o souhlasu', en: 'Record a consent decision' },
      },
      // Production installs no retention disposition authority; every invocation fails until it is wired.
      'record-disposition-decision': OntosMcpHidden,
      // Production installs no DSR deadline authority; every invocation fails until it is wired.
      'record-dsr-deadline': OntosMcpHidden,
      // Production installs no DSR delivery authority; every invocation fails until it is wired.
      'record-dsr-delivery-evidence': OntosMcpHidden,
      // Production installs no DSR owner inventory authority; every invocation fails until it is wired.
      'record-dsr-response': OntosMcpHidden,
      // Production installs no DSR substantive decision authority; every invocation fails until it is wired.
      'record-dsr-substantive-decision': OntosMcpHidden,
      // Production installs no DSR verification authority; every invocation fails until it is wired.
      'record-dsr-verification': OntosMcpHidden,
      'record-external-obligation': {
        title: {
          cs: 'Zaznamenat externí povinnost uchování údajů',
          en: 'Record an external data retention obligation',
        },
      },
      'record-legal-hold': { title: { cs: 'Zaznamenat právní pozastavení výmazu údajů', en: 'Record a legal hold' } },
      'record-notice-provision': noticeProvision,
      'record-owner-contribution': {
        title: { cs: 'Zaznamenat podklady vlastníka údajů', en: 'Record a data owner contribution' },
      },
      'record-owner-execution-outcome': 'hidden',
      'record-privacy-applicability': {
        destructive: false,
        title: { cs: 'Zaznamenat použitelnost ochrany osobních údajů', en: 'Record privacy applicability' },
      },
      'record-privacy-representation': {
        destructive: false,
        title: { cs: 'Zaznamenat zastoupení subjektu údajů', en: 'Record data subject representation' },
      },
      // Production installs no processing intervention authority; every invocation fails until it is wired.
      'record-processing-intervention': OntosMcpHidden,
      'record-retention-exception': {
        title: { cs: 'Zaznamenat výjimku z doby uchování údajů', en: 'Record a retention exception' },
      },
      'transition-processing-activity': {
        title: { cs: 'Změnit stav činnosti zpracování', en: 'Change a processing activity state' },
      },
      'update-dsr-case': { title: { cs: 'Upravit žádost subjektu údajů', en: 'Update a data subject request' } },
      // Production installs no DSR owner task authority; every invocation fails until it is wired.
      'upsert-dsr-owner-task': OntosMcpHidden,
      // Production installs no retention rule governance authority; every invocation fails until it is wired.
      'upsert-retention-rule': OntosMcpHidden,
      'upsert-temporary-dsr-export': {
        title: { cs: 'Uložit dočasný export pro subjekt údajů', en: 'Save a temporary data subject export' },
      },
    },
    approvals: false,
    description: {
      cs: 'Subjekty údajů, souhlasy, účely a právní základy zpracování, žádosti, doby uchování a ochranná opatření.',
      en: 'Data subjects, consents, processing purposes and legal bases, data subject requests, retention and privacy measures.',
    },
    keywords:
      'gdpr soukromí ochrana osobní údaje souhlas subjekt zpracování účel právní základ žádost výmaz uchování privacy consent data subject request retention legal basis',
    label: { cs: 'Ochrana osobních údajů', en: 'Privacy and data protection' },
    reads: {
      'applicability-decisions': {
        title: { cs: 'Rozhodnutí o použitelnosti ochrany údajů', en: 'Privacy applicability decisions' },
      },
      'current-consent': { title: { cs: 'Aktuální souhlasy se zpracováním', en: 'Current processing consents' } },
      'dsr-cases': { title: { cs: 'Žádosti subjektů údajů', en: 'Data subject requests' } },
      'legal-basis-assignments': {
        title: { cs: 'Přiřazené právní základy zpracování', en: 'Processing legal basis assignments' },
      },
      // Owner-to-owner or enrolled source-workload integration read; never a general agent tool.
      'measure-execution-eligibility': OntosMcpHidden,
      'notice-presentation': 'hidden',
      'notice-versions': { title: { cs: 'Verze informačních oznámení', en: 'Privacy notice versions' } },
      // Owner-to-owner or enrolled source-workload integration read; never a general agent tool.
      'organization-business-applicability': OntosMcpHidden,
      // Owner-to-owner or enrolled source-workload integration read; never a general agent tool.
      'organization-ico-applicability': OntosMcpHidden,
      // Owner-to-owner or enrolled source-workload integration read; never a general agent tool.
      'organization-profile-ico-applicability': OntosMcpHidden,
      'owner-inventory': { title: { cs: 'Přehled vlastníků osobních údajů', en: 'Personal data owner inventory' } },
      'privacy-subjects': { title: { cs: 'Subjekty údajů', en: 'Data subjects' } },
      'processing-activities': { title: { cs: 'Činnosti zpracování', en: 'Processing activities' } },
      'processing-eligibility': { title: { cs: 'Přípustnost zpracování', en: 'Processing eligibility' } },
      'processing-purposes': { title: { cs: 'Účely zpracování', en: 'Processing purposes' } },
      'responsibility-assignments': {
        title: { cs: 'Přiřazené odpovědnosti za ochranu údajů', en: 'Privacy responsibility assignments' },
      },
      'retention-rules': { title: { cs: 'Pravidla uchování údajů', en: 'Data retention rules' } },
      // Owner-to-owner or enrolled source-workload integration read; never a general agent tool.
      'source-processing-eligibility': OntosMcpHidden,
    },
  });

/** Every classified tool: for a deployment whose production API installs both authorities. */
export const privacyMcpContribution = privacyMcpContributionWith(consentSelfServiceTool, noticeProvisionTool);

/** The same contribution with consent self-service and notice provision hidden: neither authority is installed. */
export const privacyMcpContributionWithoutConsentAuthorities = privacyMcpContributionWith(
  OntosMcpHidden,
  OntosMcpHidden,
);
