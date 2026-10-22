import { defineOntosMcpContribution } from '@app/core-runtime';

export const commerceCustomerContextMcpContribution = defineOntosMcpContribution({
  actions: {
    'add-saved-address': {
      title: {
        cs: 'Přidat uloženou adresu',
        en: 'Add a saved address',
      },
    },
    'administer-commerce-quantity-rule': {
      title: {
        cs: 'Spravovat pravidlo nákupního množství',
        en: 'Manage a purchasing quantity rule',
      },
    },
    'administer-market-bootstrap-policy': {
      title: {
        cs: 'Spravovat výchozí pravidla trhu',
        en: 'Manage default market policies',
      },
    },
    'administer-payment-term-policy': {
      title: {
        cs: 'Spravovat pravidla platebních podmínek',
        en: 'Manage payment term policies',
      },
    },
    'administer-purchase-currency-policy': {
      title: {
        cs: 'Spravovat pravidla měny nákupu',
        en: 'Manage purchasing currency policies',
      },
    },
    'archive-customer-group': {
      title: {
        cs: 'Archivovat zákaznickou skupinu',
        en: 'Archive a customer group',
      },
    },
    'archive-customer-profile': {
      title: {
        cs: 'Archivovat zákaznický profil',
        en: 'Archive a customer profile',
      },
    },
    'assign-commerce-quantity-rule': {
      title: {
        cs: 'Přiřadit pravidlo nákupního množství',
        en: 'Assign a purchasing quantity rule',
      },
    },
    'assign-counterparty-price-group': {
      title: {
        cs: 'Přiřadit partnerovi cenovou skupinu',
        en: 'Assign a partner price group',
      },
    },
    'assign-customer-group': {
      title: {
        cs: 'Zařadit zákazníka do skupiny',
        en: 'Assign a customer to a group',
      },
    },
    'assign-customer-price-group': {
      title: {
        cs: 'Přiřadit zákazníkovi cenovou skupinu',
        en: 'Assign a customer price group',
      },
    },
    'attribute-guest-retail-customer': {
      title: {
        cs: 'Přiřadit hosta k zákazníkovi',
        en: 'Attribute a guest to a retail customer',
      },
    },
    'bind-retail-portal-profile': {
      title: {
        cs: 'Propojit portálový účet se zákazníkem',
        en: 'Link a retail portal account to a customer',
      },
    },
    'bootstrap-counterparty-access-administrator': {
      title: {
        cs: 'Nastavit správce přístupu partnera',
        en: 'Set up a partner access administrator',
      },
    },
    'change-counterparty-purchase-limit': {
      title: {
        cs: 'Změnit limit nákupu partnera',
        en: 'Change a partner purchase limit',
      },
    },
    'change-customer-payment-terms': {
      title: {
        cs: 'Změnit platební podmínky zákazníka',
        en: 'Change customer payment terms',
      },
    },
    'change-principal-purchase-limit-override': {
      title: {
        cs: 'Změnit individuální limit nákupu uživatele',
        en: 'Change a user purchase limit override',
      },
    },
    'change-retail-payment-term-preference': {
      title: {
        cs: 'Změnit preferované platební podmínky zákazníka',
        en: 'Change a retail customer payment term preference',
      },
    },
    'claim-counterparty-access-invitation': {
      title: {
        cs: 'Přijmout pozvánku partnera',
        en: 'Accept a partner access invitation',
      },
    },
    'claim-portal-enrollment-transition': 'hidden',
    'clear-default-billing-address': {
      title: {
        cs: 'Zrušit výchozí fakturační adresu',
        en: 'Clear the default billing address',
      },
    },
    'clear-default-delivery-destination': {
      title: {
        cs: 'Zrušit výchozí doručovací adresu',
        en: 'Clear the default delivery address',
      },
    },
    'consume-purchase-approval': 'hidden',
    'create-approval-hierarchy': {
      title: {
        cs: 'Vytvořit schvalovací hierarchii',
        en: 'Create an approval hierarchy',
      },
    },
    'create-counterparty-access-invitation': {
      title: {
        cs: 'Pozvat partnera do e-shopu',
        en: 'Invite a partner to the storefront',
      },
    },
    'create-counterparty-purchasing-profile': {
      title: {
        cs: 'Vytvořit nákupní profil partnera',
        en: 'Create a partner purchasing profile',
      },
    },
    'create-customer-group': {
      title: {
        cs: 'Vytvořit zákaznickou skupinu',
        en: 'Create a customer group',
      },
    },
    'create-purchase-proposal-revision': {
      title: {
        cs: 'Vytvořit novou verzi návrhu nákupu',
        en: 'Create a purchase proposal revision',
      },
    },
    'decide-purchase-approval-request': {
      title: {
        cs: 'Rozhodnout žádost o schválení nákupu',
        en: 'Decide a purchase approval request',
      },
    },
    'ensure-retail-customer-profile': {
      title: {
        cs: 'Zajistit profil maloobchodního zákazníka',
        en: 'Ensure a retail customer profile exists',
      },
    },
    'execute-privacy-measure': {
      title: {
        cs: 'Provést opatření ochrany osobních údajů (oprava, anonymizace, výmaz)',
        en: 'Execute a privacy measure',
      },
    },
    'grant-counterparty-commerce-access': {
      title: {
        cs: 'Udělit partnerovi přístup do e-shopu',
        en: 'Grant a partner storefront access',
      },
    },
    'migrate-counterparty-price-group': {
      title: {
        cs: 'Převést partnera do jiné cenové skupiny',
        en: 'Move a partner to another price group',
      },
    },
    'migrate-customer-price-group': {
      title: {
        cs: 'Převést zákazníka do jiné cenové skupiny',
        en: 'Move a customer to another price group',
      },
    },
    'open-profile-reconciliation': {
      title: {
        cs: 'Zahájit sladění zákaznických profilů',
        en: 'Start customer profile reconciliation',
      },
    },
    'reactivate-customer-group': {
      title: {
        cs: 'Znovu aktivovat zákaznickou skupinu',
        en: 'Reactivate a customer group',
      },
    },
    'reactivate-customer-profile': {
      title: {
        cs: 'Znovu aktivovat zákaznický profil',
        en: 'Reactivate a customer profile',
      },
    },
    'record-portal-enrollment-outcome': 'hidden',
    'recover-retail-portal-profile-binding': {
      title: {
        cs: 'Obnovit propojení portálového účtu',
        en: 'Restore a retail portal profile link',
      },
    },
    'remove-counterparty-price-group': {
      title: {
        cs: 'Odebrat partnerovi cenovou skupinu',
        en: 'Remove a partner price group',
      },
    },
    'remove-customer-group': {
      title: {
        cs: 'Vyřadit zákazníka ze skupiny',
        en: 'Remove a customer from a group',
      },
    },
    'remove-customer-payment-term': {
      title: {
        cs: 'Odebrat zákazníkovi platební podmínku',
        en: 'Remove a customer payment term',
      },
    },
    'remove-customer-price-group': {
      title: {
        cs: 'Odebrat zákazníkovi cenovou skupinu',
        en: 'Remove a customer price group',
      },
    },
    'remove-saved-address': {
      title: {
        cs: 'Odebrat uloženou adresu',
        en: 'Remove a saved address',
      },
    },
    'repeat-counterparty-order': {
      title: {
        cs: 'Zopakovat objednávku partnera',
        en: 'Repeat a partner order',
      },
    },
    'repeat-retail-order': {
      title: {
        cs: 'Zopakovat objednávku zákazníka',
        en: 'Repeat a retail customer order',
      },
    },
    'reroute-purchase-approval-request': {
      title: {
        cs: 'Přesměrovat žádost o schválení nákupu',
        en: 'Reroute a purchase approval request',
      },
    },
    'resend-counterparty-access-invitation': {
      title: {
        cs: 'Znovu poslat pozvánku partnerovi',
        en: 'Resend a partner access invitation',
      },
    },
    'reserve-market-retirement': {
      title: {
        cs: 'Připravit ukončení trhu',
        en: 'Prepare market retirement',
      },
    },
    'reserve-payment-term-retirement': {
      title: {
        cs: 'Připravit ukončení platební podmínky',
        en: 'Prepare payment term retirement',
      },
    },
    'resolve-profile-reconciliation': {
      title: {
        cs: 'Dokončit sladění zákaznických profilů',
        en: 'Resolve customer profile reconciliation',
      },
    },
    'revalidate-purchase-approval': {
      title: {
        cs: 'Znovu ověřit schválení nákupu',
        en: 'Revalidate a purchase approval',
      },
    },
    'revoke-counterparty-access-invitation': {
      title: {
        cs: 'Zrušit pozvánku partnera',
        en: 'Revoke a partner access invitation',
      },
    },
    'revoke-counterparty-commerce-access': {
      title: {
        cs: 'Odebrat partnerovi přístup do e-shopu',
        en: 'Revoke a partner storefront access',
      },
    },
    'revoke-retail-portal-profile-binding': {
      title: {
        cs: 'Zrušit propojení portálového účtu',
        en: 'Revoke a retail portal profile link',
      },
    },
    'set-default-billing-address': {
      title: {
        cs: 'Nastavit výchozí fakturační adresu',
        en: 'Set the default billing address',
      },
    },
    'set-default-delivery-destination': {
      title: {
        cs: 'Nastavit výchozí doručovací adresu',
        en: 'Set the default delivery address',
      },
    },
    'start-portal-enrollment': {
      title: {
        cs: 'Zahájit registraci do portálu',
        en: 'Start portal enrollment',
      },
    },
    'submit-purchase-approval-request': {
      title: {
        cs: 'Odeslat žádost o schválení nákupu',
        en: 'Submit a purchase approval request',
      },
    },
    'suspend-customer-profile': {
      title: {
        cs: 'Pozastavit zákaznický profil',
        en: 'Suspend a customer profile',
      },
    },
    'terminate-portal-enrollment': {
      title: {
        cs: 'Ukončit registraci do portálu',
        en: 'Terminate portal enrollment',
      },
    },
    'trigger-purchase-approval': {
      title: {
        cs: 'Spustit schválení nákupu',
        en: 'Start purchase approval',
      },
    },
    'update-customer-group': {
      title: {
        cs: 'Upravit zákaznickou skupinu',
        en: 'Update a customer group',
      },
    },
    'update-saved-address': {
      title: {
        cs: 'Upravit uloženou adresu',
        en: 'Update a saved address',
      },
    },
  },
  approvals: true,
  description: {
    cs: 'Zákaznické profily, skupiny, přístupy, adresy, nákupní pravidla a schvalování nákupů.',
    en: 'Customer profiles, groups, access, addresses, purchasing policies and purchase approvals.',
  },
  keywords:
    'zákazník skupina adresa doručení cenová skupina platební podmínky limit nákupu schválení portál e-shop customer group address access purchasing approval',
  label: {
    cs: 'Zákaznický kontext e-shopu',
    en: 'Commerce customer context',
  },
  reads: {
    'commerce-quantity-policy-current': {
      title: {
        cs: 'Aktuální pravidla množství v e-shopu',
        en: 'Current commerce quantity policies',
      },
    },
    'commerce-quantity-resolution': 'hidden',
    'counterparty-access-invitation-read': {
      title: {
        cs: 'Pozvánka partnera do e-shopu',
        en: 'Partner storefront invitation',
      },
    },
    'counterparty-all-customer-archive': {
      title: {
        cs: 'Archiv všech zákazníků partnera',
        en: 'All partner customer records',
      },
    },
    'counterparty-all-order-history': {
      title: {
        cs: 'Všechny objednávky partnera',
        en: 'All partner orders',
      },
    },
    'counterparty-all-order-history-detail': {
      title: {
        cs: 'Detail objednávky ze všech objednávek partnera',
        en: 'Partner order details across all customers',
      },
    },
    'counterparty-commerce-access-check': {
      title: {
        cs: 'Kontrola přístupu partnera do e-shopu',
        en: 'Check partner storefront access',
      },
    },
    'counterparty-commerce-access-detail': {
      title: {
        cs: 'Detail přístupu partnera do e-shopu',
        en: 'Partner storefront access details',
      },
    },
    'counterparty-commerce-access-list': {
      title: {
        cs: 'Přístupy partnerů do e-shopu',
        en: 'Partner storefront access list',
      },
    },
    'counterparty-customer-group-memberships': {
      title: {
        cs: 'Zákaznické skupiny partnera',
        en: 'Partner customer group memberships',
      },
    },
    'counterparty-order-history': {
      title: {
        cs: 'Historie objednávek partnera',
        en: 'Partner order history',
      },
    },
    'counterparty-order-history-detail': {
      title: {
        cs: 'Detail objednávky partnera',
        en: 'Partner order details',
      },
    },
    'customer-archive': {
      title: {
        cs: 'Archiv zákazníků',
        en: 'Customer archive',
      },
    },
    'customer-group-detail': {
      title: {
        cs: 'Detail zákaznické skupiny',
        en: 'Customer group details',
      },
    },
    'customer-group-history': {
      title: {
        cs: 'Historie zákaznické skupiny',
        en: 'Customer group history',
      },
    },
    'customer-group-members': {
      title: {
        cs: 'Členové zákaznické skupiny',
        en: 'Customer group members',
      },
    },
    'customer-payment-term-entitlement-read': {
      title: {
        cs: 'Nárok zákazníka na platební podmínky',
        en: 'Customer payment term entitlements',
      },
    },
    'customer-price-group-assignment-read': {
      title: {
        cs: 'Přiřazení cenové skupiny zákazníka',
        en: 'Customer price group assignment',
      },
    },
    'customer-price-group-resolution': 'hidden',
    'customer-profile-read': {
      title: {
        cs: 'Profil zákazníka',
        en: 'Customer profile',
      },
    },
    'customer-profile-trading-gate': {
      title: {
        cs: 'Smí zákazník nakupovat',
        en: 'Check whether a customer may trade',
      },
    },
    'customer-record-visibility': 'hidden',
    'delivery-destination-resolution': 'hidden',
    'effective-customer-group-membership-set-v1': 'hidden',
    'effective-customer-group-memberships': {
      title: {
        cs: 'Seznam platných členství v zákaznických skupinách',
        en: 'Effective customer group memberships',
      },
    },
    'guest-attribution-status': {
      title: {
        cs: 'Stav přiřazení hosta k zákazníkovi',
        en: 'Guest customer attribution status',
      },
    },
    'guest-payment-terms-resolution': 'hidden',
    'invoice-recipient-resolution': 'hidden',
    'market-affected-use-assessment': {
      title: {
        cs: 'Dopad změny trhu',
        en: 'Market change impact',
      },
    },
    'market-bootstrap-policy-current': {
      title: {
        cs: 'Aktuální výchozí pravidla trhu',
        en: 'Current default market policies',
      },
    },
    'market-bootstrap-resolution': 'hidden',
    'market-subject-restrictions-current': {
      title: {
        cs: 'Aktuální omezení subjektů na trhu',
        en: 'Current market subject restrictions',
      },
    },
    'payment-term-affected-use-assessment': {
      title: {
        cs: 'Dopad změny platebních podmínek',
        en: 'Payment term change impact',
      },
    },
    'payment-term-policy-current': {
      title: {
        cs: 'Aktuální pravidla platebních podmínek',
        en: 'Current payment term policies',
      },
    },
    'payment-terms-resolution': 'hidden',
    'pricing-purchase-context-verification': 'hidden',
    'privacy-measure-execution': {
      title: {
        cs: 'Stav opatření ochrany osobních údajů',
        en: 'Privacy measure execution status',
      },
    },
    'profile-reconciliation-read': {
      title: {
        cs: 'Sladění zákaznických profilů',
        en: 'Customer profile reconciliation',
      },
    },
    'purchase-currency-policy-current': {
      title: {
        cs: 'Aktuální pravidla měny nákupu',
        en: 'Current purchasing currency policies',
      },
    },
    'purchase-currency-resolution': 'hidden',
    'purchase-limit-evaluation': {
      title: {
        cs: 'Vyhodnocení limitu nákupu',
        en: 'Purchase limit assessment',
      },
    },
    'purchase-limit-policy-read': {
      title: {
        cs: 'Pravidla limitů nákupu',
        en: 'Purchase limit policies',
      },
    },
    'repeat-order-preparation': {
      title: {
        cs: 'Příprava opakované objednávky',
        en: 'Repeat order preparation',
      },
    },
    'retail-access-decision': {
      title: {
        cs: 'Rozhodnutí o přístupu maloobchodního zákazníka',
        en: 'Retail customer access decision',
      },
    },
    'retail-order-history': {
      title: {
        cs: 'Historie objednávek maloobchodního zákazníka',
        en: 'Retail customer order history',
      },
    },
    'retail-order-history-detail': {
      title: {
        cs: 'Detail objednávky maloobchodního zákazníka',
        en: 'Retail customer order details',
      },
    },
    'retail-portal-profile-binding-read': {
      title: {
        cs: 'Propojení portálového účtu se zákazníkem',
        en: 'Retail portal profile link',
      },
    },
    'retail-principal-resolution': 'hidden',
    'retail-purchasing-subject-current-v1': 'hidden',
    'saved-address-defaults': {
      title: {
        cs: 'Výchozí uložené adresy',
        en: 'Default saved addresses',
      },
    },
    'saved-address-detail': {
      title: {
        cs: 'Detail uložené adresy',
        en: 'Saved address details',
      },
    },
    'saved-address-list': {
      title: {
        cs: 'Uložené adresy',
        en: 'Saved addresses',
      },
    },
    'verify-effective-customer-group-membership-set-v1': 'hidden',
    'verify-retail-purchasing-subject-current-v1': 'hidden',
  },
});
