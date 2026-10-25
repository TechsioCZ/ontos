import { defineOntosMcpContribution } from '@app/core-runtime';

export const partyRegistryMcpContribution = defineOntosMcpContribution({
  actions: {
    // Commerce's enrollment workload accepts verified retail evidence; never an agent tool.
    'accept-retail-enrollment-evidence': 'hidden',
    'add-contact-point': { title: { cs: 'Přidat kontakt subjektu', en: 'Add a party contact' } },
    'add-party-official-identifier': {
      title: { cs: 'Přidat úřední identifikátor subjektu', en: 'Add a party official identifier' },
    },
    'archive-organization-engagement': {
      title: { cs: 'Archivovat spolupráci s firmou', en: 'Archive an organization engagement' },
    },
    'archive-party': { title: { cs: 'Archivovat subjekt', en: 'Archive a party' } },
    'archive-person-engagement': { title: { cs: 'Archivovat spolupráci s osobou', en: 'Archive a person engagement' } },
    'attach-organization-engagement': {
      title: { cs: 'Založit spolupráci s firmou', en: 'Attach an organization engagement' },
    },
    'attach-person-engagement': { title: { cs: 'Založit spolupráci s osobou', en: 'Attach a person engagement' } },
    'confirm-duplicate-parties': { title: { cs: 'Potvrdit duplicitní subjekty', en: 'Confirm duplicate parties' } },
    'correct-party-fact': { title: { cs: 'Opravit údaj subjektu', en: 'Correct a party fact' } },
    'counterparty-create': { title: { cs: 'Založit obchodního partnera', en: 'Create a counterparty' } },
    'counterparty-customer-onboard': {
      title: { cs: 'Zaregistrovat partnera jako zákazníka', en: 'Onboard a counterparty as a customer' },
    },
    'counterparty-role-add': { title: { cs: 'Přidat roli obchodního partnera', en: 'Add a counterparty role' } },
    'counterparty-role-end': {
      destructive: true,
      title: { cs: 'Ukončit roli obchodního partnera', en: 'End a counterparty role' },
    },
    'create-party': { title: { cs: 'Založit subjekt', en: 'Create a party' } },
    'create-party-relationship': { title: { cs: 'Vytvořit vztah mezi subjekty', en: 'Create a party relationship' } },
    'dismiss-duplicate-candidate': {
      title: { cs: 'Zamítnout podezření na duplicitní subjekt', en: 'Dismiss a duplicate candidate' },
    },
    'end-contact-point': {
      destructive: true,
      title: { cs: 'Ukončit platnost kontaktu subjektu', en: 'End a party contact' },
    },
    'end-party-official-identifier': {
      destructive: true,
      title: { cs: 'Ukončit platnost úředního identifikátoru', en: 'End a party official identifier' },
    },
    'end-party-relationship': {
      destructive: true,
      title: { cs: 'Ukončit vztah mezi subjekty', en: 'End a party relationship' },
    },
    'execute-privacy-measure': {
      title: {
        cs: 'Provést opatření ochrany osobních údajů (oprava, anonymizace, výmaz)',
        en: 'Execute a privacy measure',
      },
    },
    'mark-duplicate-candidate-needs-evidence': {
      title: {
        cs: 'Vyžádat důkazy k možnému duplicitnímu subjektu',
        en: 'Mark a duplicate candidate as needing evidence',
      },
    },
    'match-party': { title: { cs: 'Vyhledat shodu subjektu', en: 'Match a party' } },
    'request-search-rebuild': {
      title: { cs: 'Vyžádat obnovu vyhledávacího indexu subjektů', en: 'Request a party search index rebuild' },
    },
    'resolve-duplicate-candidate-create': {
      title: {
        cs: 'Vyřešit možnou duplicitu založením nového subjektu',
        en: 'Resolve a duplicate candidate by creating a party',
      },
    },
    'resolve-duplicate-candidate-match': {
      title: {
        cs: 'Vyřešit možnou duplicitu přiřazením k existujícímu subjektu',
        en: 'Resolve a duplicate candidate by matching a party',
      },
    },
    'unarchive-organization-engagement': {
      destructive: false,
      title: { cs: 'Obnovit archivovanou spolupráci s firmou', en: 'Restore an organization engagement' },
    },
    'unarchive-party': {
      destructive: false,
      title: { cs: 'Obnovit archivovaný subjekt', en: 'Restore an archived party' },
    },
    'unarchive-person-engagement': {
      destructive: false,
      title: { cs: 'Obnovit archivovanou spolupráci s osobou', en: 'Restore a person engagement' },
    },
    'update-contact-point': { title: { cs: 'Upravit kontakt subjektu', en: 'Update a party contact' } },
    'update-party': { title: { cs: 'Upravit subjekt', en: 'Update a party' } },
    'update-party-official-identifier': {
      title: { cs: 'Upravit úřední identifikátor subjektu', en: 'Update a party official identifier' },
    },
    'update-party-relationship': { title: { cs: 'Upravit vztah mezi subjekty', en: 'Update a party relationship' } },
  },
  approvals: true,
  commandFieldLabels: {
    handoff: 'Požadavek',
    partyId: 'Zákazník',
    reason: 'Důvod',
    value: 'Hodnota',
  },
  description: {
    cs: 'Zákazníci a partneři (firmy i osoby), kontakty, identifikátory a vztahy.',
    en: 'Customers and partners, organizations and people, contacts, identifiers and relationships.',
  },
  keywords:
    'zákazník zákazníci partner firma osoba subjekt kontakt telefon e-mail ičo dič ares vztah duplicita gdpr osobní údaje customer party company person',
  label: { cs: 'Registr subjektů', en: 'Party registry' },
  // Counterparty Actions check `manage_counterparty` on the company, which this relation grants.
  legalEntityWriteRelations: ['counterparty_manager'],
  page: '/contacts',
  reads: {
    'ares-lookup': { title: { cs: 'Vyhledání firmy v ARES', en: 'Company lookup in ARES' } },
    'counterparty-read': { title: { cs: 'Detail obchodního partnera', en: 'Counterparty details' } },
    'counterparty-role-history': {
      title: { cs: 'Historie rolí obchodního partnera', en: 'Counterparty role history' },
    },
    'customer-list': { title: { cs: 'Seznam zákazníků', en: 'Customer list' } },
    'duplicate-candidate-detail': {
      title: { cs: 'Detail možného duplicitního subjektu', en: 'Duplicate candidate details' },
    },
    'duplicate-candidate-list': {
      title: { cs: 'Seznam možných duplicitních subjektů', en: 'Duplicate candidate list' },
    },
    'guest-party-resolution': 'hidden',
    'organization-engagement-profile': {
      title: { cs: 'Profil spolupráce s firmou', en: 'Organization engagement profile' },
    },
    'party-contact-point-detail': { title: { cs: 'Detail kontaktu subjektu', en: 'Party contact details' } },
    'party-contact-points': { title: { cs: 'Kontakty subjektu', en: 'Party contacts' } },
    'party-correction': { title: { cs: 'Oprava údajů subjektu', en: 'Party fact corrections' } },
    'party-detail': { title: { cs: 'Detail subjektu', en: 'Party details' } },
    'party-match': { title: { cs: 'Vyhledání shody subjektu', en: 'Party match lookup' } },
    'party-match-decision': { title: { cs: 'Rozhodnutí o shodě subjektů', en: 'Party match decision' } },
    'party-merge-readiness': { title: { cs: 'Připravenost ke sloučení subjektů', en: 'Party merge readiness' } },
    'party-official-identifier-detail': {
      title: { cs: 'Detail úředního identifikátoru (IČO, DIČ)', en: 'Official identifier details' },
    },
    'party-official-identifier-history': {
      title: { cs: 'Historie úředních identifikátorů', en: 'Official identifier history' },
    },
    'party-relationship-detail': { title: { cs: 'Detail vztahu mezi subjekty', en: 'Party relationship details' } },
    'person-engagement-profile': { title: { cs: 'Profil spolupráce s osobou', en: 'Person engagement profile' } },
    'privacy-measure-execution': {
      title: { cs: 'Stav opatření ochrany osobních údajů', en: 'Privacy measure execution status' },
    },
  },
});
