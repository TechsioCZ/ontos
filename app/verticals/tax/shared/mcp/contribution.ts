/**
 * VAT tools offered to agents. Managing VAT rules and the seller's VAT regime gets typed tools; order finalization,
 * imports, evaluations and correction previews are system steps, reachable only through the generic tools
 * (`genericOnly`), so they do not crowd the connection's typed-tool budget. Rights are the same either way.
 */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const taxMcpContribution = defineOntosMcpContribution({
  actions: {
    'correct-tax-rule-revision': {
      description: {
        cs: 'Potvrzená oprava chybné revize: vznikne opravná revize, chybná zůstává dohledatelná v historii. expectedBasisFingerprint je basisFingerprint z historie daňového pravidla.',
        en: 'Confirmed correction of a wrong revision: a correcting revision is created and the wrong one stays in the history. expectedBasisFingerprint is basisFingerprint from the tax rule history.',
      },
      genericOnly: true,
      title: { cs: 'Opravit chybnou sazbu DPH', en: 'Correct a wrong VAT rate' },
    },
    'create-tax-rule': {
      description: {
        cs: 'Nové pravidlo sazby DPH pro jednu daňovou klasifikaci (taxClassificationCode, např. cz.vat.standard = základní sazba, cz.vat.reduced = snížená sazba) s první revizí: sazba v procentech jako desetinný text a platnost od (do).',
        en: 'A new VAT rate rule for one tax classification (taxClassificationCode, e.g. cz.vat.standard = standard rate, cz.vat.reduced = reduced rate) with its first revision: the rate percent as a decimal string and the validity from (to).',
      },
      title: { cs: 'Vytvořit pravidlo sazby DPH', en: 'Create a VAT rate rule' },
    },
    'create-tax-rule-revision': {
      description: {
        cs: 'Naplánuje novou sazbu DPH od zvoleného data (nová revize pravidla); předchozí revize zůstávají v historii. expectedBasisFingerprint je basisFingerprint z historie daňového pravidla.',
        en: 'Schedules a new VAT rate from a chosen date (a new rule revision); earlier revisions stay in the history. expectedBasisFingerprint is basisFingerprint from the tax rule history.',
      },
      title: { cs: 'Naplánovat změnu sazby DPH', en: 'Schedule a VAT rate change' },
    },
    'declare-seller-vat-regime': {
      description: {
        cs: 'Nastaví režim DPH firmy (VAT_PAYER = plátce, NON_PAYER = neplátce) od zvoleného data. expectedCurrentRevision je headRevision z režimu DPH firmy k datu (0 = zatím nic nastaveno).',
        en: 'Declares the company VAT regime (VAT_PAYER = payer, NON_PAYER = non-payer) from a chosen date. expectedCurrentRevision is headRevision from the company VAT regime read (0 = nothing declared yet).',
      },
      title: { cs: 'Nastavit režim DPH firmy', en: 'Declare the company VAT regime' },
    },
    'end-tax-rule-revision': {
      description: {
        cs: 'Ukončí platnost revize sazby DPH k zadanému datu. expectedBasisFingerprint je basisFingerprint z historie daňového pravidla.',
        en: 'Ends a VAT rate revision at the given date. expectedBasisFingerprint is basisFingerprint from the tax rule history.',
      },
      destructive: true,
      title: { cs: 'Ukončit platnost sazby DPH', en: 'End a VAT rate' },
    },
    'finalize-order-tax': {
      genericOnly: true,
      title: { cs: 'Uzavřít daň objednávky', en: 'Finalize order tax' },
    },
    'import-seller-vat-regime-declarations': {
      genericOnly: true,
      title: { cs: 'Importovat režimy DPH firem', en: 'Import company VAT regimes' },
    },
  },
  approvals: false,
  description: {
    cs: 'Sazby DPH podle daňové klasifikace (základní a snížená), jejich plánované změny a historie, režim DPH firmy a daň objednávek.',
    en: 'VAT rates by tax classification (standard and reduced), their scheduled changes and history, the company VAT regime and order tax.',
  },
  keywords:
    'daň daně DPH sazba sazby základní snížená klasifikace daňová režim plátce neplátce prodávající objednávka pravidlo změna oprava tax VAT rule rate standard reduced classification regime payer seller order correction',
  label: {
    cs: 'Daně a DPH',
    en: 'Tax and VAT',
  },
  reads: {
    'applicable-tax-rule-set': {
      description: {
        cs: 'Platná sazba DPH pro daňovou klasifikaci (taxClassificationCode, např. cz.vat.standard nebo cz.vat.reduced) k danému okamžiku (taxRelevantTime).',
        en: 'The VAT rate in force for a tax classification (taxClassificationCode, e.g. cz.vat.standard or cz.vat.reduced) at a given time (taxRelevantTime).',
      },
      title: { cs: 'Platná sazba DPH', en: 'VAT rate in force' },
    },
    'final-order-tax': {
      genericOnly: true,
      title: { cs: 'Konečná daň objednávky', en: 'Final order tax' },
    },
    'seller-vat-regime-at-instant': {
      description: {
        cs: 'Režim DPH firmy k zadanému okamžiku (instant) a headRevision pro jeho změnu.',
        en: 'The company VAT regime at a given time (instant) and headRevision for changing it.',
      },
      title: { cs: 'Režim DPH firmy', en: 'Company VAT regime' },
    },
    'seller-vat-regime-history': {
      genericOnly: true,
      title: { cs: 'Historie režimu DPH firmy', en: 'Company VAT regime history' },
    },
    'tax-correction-preview': {
      genericOnly: true,
      title: { cs: 'Náhled opravy daně', en: 'Tax correction preview' },
    },
    'tax-evaluation': {
      genericOnly: true,
      title: { cs: 'Výpočet daně', en: 'Tax evaluation' },
    },
    'tax-materiality-comparison': {
      genericOnly: true,
      title: { cs: 'Porovnání významnosti daňových změn', en: 'Tax materiality comparison' },
    },
    'tax-privacy-owner-coverage': 'hidden',
    'tax-rule-history': {
      description: {
        cs: 'Všechny revize pravidla sazby DPH (taxRuleRef z platné sazby DPH), jejich ukončení a opravy, a basisFingerprint pro další změnu.',
        en: 'Every revision of a VAT rate rule (taxRuleRef from the VAT rate in force), its end facts and corrections, and basisFingerprint for the next change.',
      },
      title: { cs: 'Historie sazby DPH', en: 'VAT rate history' },
    },
  },
});
