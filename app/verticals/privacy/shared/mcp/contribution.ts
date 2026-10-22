import { defineOntosMcpContribution } from '@app/core-runtime';

export const privacyMcpContribution = defineOntosMcpContribution({
  actions: {
    'add-processing-purpose-version': {
      title: { cs: 'Přidat verzi účelu zpracování', en: 'Add a processing purpose version' },
    },
    'assign-dsr-resolver': {
      title: { cs: 'Přiřadit řešitele žádosti subjektu údajů', en: 'Assign a data subject request resolver' },
    },
    'assign-legal-basis': { title: { cs: 'Přiřadit právní základ zpracování', en: 'Assign a processing legal basis' } },
    'assign-privacy-responsibility': {
      destructive: false,
      title: { cs: 'Přiřadit odpovědnost za ochranu osobních údajů', en: 'Assign a privacy responsibility' },
    },
    'consent-self-service': {
      destructive: true,
      title: { cs: 'Spravovat vlastní souhlasy se zpracováním', en: 'Manage own processing consents' },
    },
    'create-dsr-case': { title: { cs: 'Založit žádost subjektu údajů', en: 'Create a data subject request' } },
    'create-notice-version': {
      title: { cs: 'Vytvořit verzi informačního oznámení', en: 'Create a privacy notice version' },
    },
    'create-privacy-subject': {
      destructive: false,
      title: { cs: 'Založit subjekt údajů', en: 'Create a data subject' },
    },
    'create-processing-activity': { title: { cs: 'Vytvořit činnost zpracování', en: 'Create a processing activity' } },
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
    'issue-dsr-delivery-access': {
      title: { cs: 'Vydat přístup k odpovědi na žádost subjektu údajů', en: 'Issue access to a data subject response' },
    },
    'record-anti-resurrection-protection': {
      title: {
        cs: 'Zaznamenat ochranu proti obnovení vymazaných údajů',
        en: 'Record protection against erased data resurrection',
      },
    },
    'record-applicability-policy': {
      title: { cs: 'Zaznamenat pravidla použitelnosti ochrany údajů', en: 'Record a privacy applicability policy' },
    },
    'record-consent-decision': {
      destructive: true,
      title: { cs: 'Zaznamenat rozhodnutí o souhlasu', en: 'Record a consent decision' },
    },
    'record-disposition-decision': {
      destructive: true,
      title: { cs: 'Zaznamenat rozhodnutí o naložení s údaji', en: 'Record a data disposition decision' },
    },
    'record-dsr-deadline': {
      title: { cs: 'Zaznamenat lhůtu žádosti subjektu údajů', en: 'Record a data subject request deadline' },
    },
    'record-dsr-delivery-evidence': {
      title: {
        cs: 'Zaznamenat doklad o doručení odpovědi subjektu údajů',
        en: 'Record data subject response delivery evidence',
      },
    },
    'record-dsr-response': {
      title: { cs: 'Zaznamenat odpověď na žádost subjektu údajů', en: 'Record a data subject response' },
    },
    'record-dsr-substantive-decision': {
      title: {
        cs: 'Zaznamenat věcné rozhodnutí o žádosti subjektu údajů',
        en: 'Record a substantive data subject request decision',
      },
    },
    'record-dsr-verification': {
      title: { cs: 'Zaznamenat ověření žádosti subjektu údajů', en: 'Record data subject request verification' },
    },
    'record-external-obligation': {
      title: { cs: 'Zaznamenat externí povinnost uchování údajů', en: 'Record an external data retention obligation' },
    },
    'record-legal-hold': { title: { cs: 'Zaznamenat právní pozastavení výmazu údajů', en: 'Record a legal hold' } },
    'record-notice-provision': {
      title: { cs: 'Zaznamenat poskytnutí informačního oznámení', en: 'Record privacy notice provision' },
    },
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
    'record-processing-intervention': {
      destructive: true,
      title: { cs: 'Zaznamenat zásah do zpracování údajů', en: 'Record a processing intervention' },
    },
    'record-retention-exception': {
      title: { cs: 'Zaznamenat výjimku z doby uchování údajů', en: 'Record a retention exception' },
    },
    'transition-processing-activity': {
      title: { cs: 'Změnit stav činnosti zpracování', en: 'Change a processing activity state' },
    },
    'update-dsr-case': { title: { cs: 'Upravit žádost subjektu údajů', en: 'Update a data subject request' } },
    'upsert-dsr-owner-task': {
      title: { cs: 'Uložit úkol vlastníka údajů k žádosti', en: 'Save a data owner request task' },
    },
    'upsert-retention-rule': { title: { cs: 'Uložit pravidlo uchování údajů', en: 'Save a retention rule' } },
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
    'notice-versions': { title: { cs: 'Verze informačních oznámení', en: 'Privacy notice versions' } },
    'owner-inventory': { title: { cs: 'Přehled vlastníků osobních údajů', en: 'Personal data owner inventory' } },
    'privacy-subjects': { title: { cs: 'Subjekty údajů', en: 'Data subjects' } },
    'processing-activities': { title: { cs: 'Činnosti zpracování', en: 'Processing activities' } },
    'processing-eligibility': { title: { cs: 'Přípustnost zpracování', en: 'Processing eligibility' } },
    'processing-purposes': { title: { cs: 'Účely zpracování', en: 'Processing purposes' } },
    'responsibility-assignments': {
      title: { cs: 'Přiřazené odpovědnosti za ochranu údajů', en: 'Privacy responsibility assignments' },
    },
    'retention-rules': { title: { cs: 'Pravidla uchování údajů', en: 'Data retention rules' } },
  },
});
