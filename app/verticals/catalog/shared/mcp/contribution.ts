import { defineOntosMcpContribution } from '@app/core-runtime';

export const catalogMcpContribution = defineOntosMcpContribution({
  actions: {
    'activate-local-override': {
      title: {
        cs: 'Aktivovat místní přepsání katalogových údajů',
        en: 'Activate a local catalog override',
      },
    },
    'activate-package-definition': {
      title: {
        cs: 'Aktivovat definici balení',
        en: 'Activate a package definition',
      },
    },
    'activate-package-option': {
      title: {
        cs: 'Aktivovat možnost balení',
        en: 'Activate a package option',
      },
    },
    'add-product-category-assignment': {
      title: {
        cs: 'Zařadit produkt do kategorie',
        en: 'Assign a product to a category',
      },
    },
    'assert-size-equivalence': {
      title: {
        cs: 'Potvrdit rovnocennost velikostí',
        en: 'Assert size equivalence',
      },
    },
    'assign-catalog-media': {
      title: {
        cs: 'Přiřadit média ke katalogové položce',
        en: 'Assign catalog media',
      },
    },
    'assign-sku': {
      title: {
        cs: 'Přiřadit SKU',
        en: 'Assign an SKU',
      },
    },
    'change-local-override': {
      title: {
        cs: 'Změnit místní přepsání katalogových údajů',
        en: 'Change a local catalog override',
      },
    },
    'change-product-manufacturer': {
      title: {
        cs: 'Změnit výrobce produktu',
        en: 'Change a product manufacturer',
      },
    },
    'change-product-relationship': {
      title: {
        cs: 'Změnit vztah mezi produkty',
        en: 'Change a product relationship',
      },
    },
    'change-variant': {
      title: {
        cs: 'Změnit variantu produktu',
        en: 'Change a product variant',
      },
    },
    'confirm-gtin': {
      title: {
        cs: 'Potvrdit identifikátor GTIN',
        en: 'Confirm a GTIN identifier',
      },
    },
    'confirm-variant-combination': {
      title: {
        cs: 'Potvrdit kombinaci varianty',
        en: 'Confirm a variant combination',
      },
    },
    'correct-gtin': {
      title: {
        cs: 'Opravit identifikátor GTIN',
        en: 'Correct a GTIN identifier',
      },
    },
    'correct-product': {
      title: {
        cs: 'Opravit údaje produktu',
        en: 'Correct a product',
      },
    },
    'correct-sku': {
      title: {
        cs: 'Opravit SKU',
        en: 'Correct an SKU',
      },
    },
    'create-attribute-definition': {
      title: {
        cs: 'Vytvořit definici atributu',
        en: 'Create an attribute definition',
      },
    },
    'create-brand': {
      title: {
        cs: 'Vytvořit značku',
        en: 'Create a brand',
      },
    },
    'create-configuration-unit': {
      title: {
        cs: 'Vytvořit konfigurační jednotku',
        en: 'Create a configuration unit',
      },
    },
    'create-controlled-attribute-value': {
      title: {
        cs: 'Vytvořit číselníkovou hodnotu atributu',
        en: 'Create a controlled attribute value',
      },
    },
    'create-package-definition': {
      title: {
        cs: 'Vytvořit definici balení',
        en: 'Create a package definition',
      },
    },
    'create-product': {
      title: {
        cs: 'Vytvořit produkt',
        en: 'Create a product',
      },
    },
    'create-product-category': {
      title: {
        cs: 'Vytvořit kategorii produktů',
        en: 'Create a product category',
      },
    },
    'create-product-relationship': {
      title: {
        cs: 'Vytvořit vztah mezi produkty',
        en: 'Create a product relationship',
      },
    },
    'create-product-type': {
      title: {
        cs: 'Vytvořit typ produktu',
        en: 'Create a product type',
      },
    },
    'create-product-unit': {
      title: {
        cs: 'Vytvořit jednotku produktu',
        en: 'Create a product unit',
      },
    },
    'create-set-composition': {
      title: {
        cs: 'Vytvořit složení sady',
        en: 'Create a set composition',
      },
    },
    'create-variant': {
      title: {
        cs: 'Vytvořit variantu produktu',
        en: 'Create a product variant',
      },
    },
    'decide-product-type-unnecessary': {
      title: {
        cs: 'Označit typ produktu jako nepotřebný',
        en: 'Mark a product type as unnecessary',
      },
    },
    'govern-product-attribute-applicability': {
      title: {
        cs: 'Spravovat použitelnost atributů produktu',
        en: 'Manage product attribute applicability',
      },
    },
    'govern-variant-allowed-values': {
      title: {
        cs: 'Spravovat povolené hodnoty variant',
        en: 'Manage allowed variant values',
      },
    },
    'govern-variant-axes': {
      title: {
        cs: 'Spravovat osy variant produktu',
        en: 'Manage product variant axes',
      },
    },
    'import-source-assertion': {
      title: {
        cs: 'Importovat zdrojové údaje katalogu',
        en: 'Import a catalog source assertion',
      },
    },
    'mark-gtin-unresolved': {
      title: {
        cs: 'Označit identifikátor GTIN jako nevyřešený',
        en: 'Mark a GTIN identifier as unresolved',
      },
    },
    'move-product-category': {
      title: {
        cs: 'Přesunout kategorii produktů',
        en: 'Move a product category',
      },
    },
    'promote-package-definition': {
      title: {
        cs: 'Povýšit definici balení',
        en: 'Promote a package definition',
      },
    },
    'publish-product-configuration': {
      title: {
        cs: 'Zveřejnit konfiguraci produktu',
        en: 'Publish a product configuration',
      },
    },
    'reactivate-brand': {
      title: {
        cs: 'Znovu aktivovat značku',
        en: 'Reactivate a brand',
      },
    },
    'reactivate-controlled-attribute-value': {
      title: {
        cs: 'Znovu aktivovat číselníkovou hodnotu atributu',
        en: 'Reactivate a controlled attribute value',
      },
    },
    'reactivate-product': {
      title: {
        cs: 'Znovu aktivovat produkt',
        en: 'Reactivate a product',
      },
    },
    'reactivate-variant': {
      title: {
        cs: 'Znovu aktivovat variantu produktu',
        en: 'Reactivate a product variant',
      },
    },
    'release-local-override': {
      destructive: true,
      title: {
        cs: 'Zrušit místní přepsání katalogových údajů',
        en: 'Release a local catalog override',
      },
    },
    'remove-catalog-media': {
      title: {
        cs: 'Odebrat média z katalogové položky',
        en: 'Remove catalog media',
      },
    },
    'remove-product-attribute-values': {
      title: {
        cs: 'Odebrat hodnoty atributů produktu',
        en: 'Remove product attribute values',
      },
    },
    'remove-product-category-assignment': {
      title: {
        cs: 'Vyřadit produkt z kategorie',
        en: 'Remove a product category assignment',
      },
    },
    'remove-product-localized-facts': {
      title: {
        cs: 'Odebrat jazykovou verzi údajů produktu',
        en: 'Remove localized product details',
      },
    },
    'remove-product-manufacturer': {
      title: {
        cs: 'Odebrat výrobce produktu',
        en: 'Remove a product manufacturer',
      },
    },
    'remove-product-relationship': {
      title: {
        cs: 'Odebrat vztah mezi produkty',
        en: 'Remove a product relationship',
      },
    },
    'remove-variant-attribute-override': {
      title: {
        cs: 'Zrušit přepsání atributu varianty',
        en: 'Remove a variant attribute override',
      },
    },
    'remove-variant-localized-facts': {
      title: {
        cs: 'Odebrat jazykovou verzi údajů varianty',
        en: 'Remove localized variant details',
      },
    },
    'rename-attribute-definition': {
      title: {
        cs: 'Přejmenovat definici atributu',
        en: 'Rename an attribute definition',
      },
    },
    'rename-brand': {
      title: {
        cs: 'Přejmenovat značku',
        en: 'Rename a brand',
      },
    },
    'rename-controlled-attribute-value': {
      title: {
        cs: 'Přejmenovat číselníkovou hodnotu atributu',
        en: 'Rename a controlled attribute value',
      },
    },
    'rename-product-category': {
      title: {
        cs: 'Přejmenovat kategorii produktů',
        en: 'Rename a product category',
      },
    },
    'rename-sku': {
      title: {
        cs: 'Přejmenovat SKU',
        en: 'Rename an SKU',
      },
    },
    'reorder-catalog-media': {
      title: {
        cs: 'Změnit pořadí médií katalogové položky',
        en: 'Reorder catalog media',
      },
    },
    'replace-product-sizes': {
      title: {
        cs: 'Nahradit velikosti produktu',
        en: 'Replace product sizes',
      },
    },
    'retire-brand': {
      destructive: true,
      title: {
        cs: 'Vyřadit značku',
        en: 'Retire a brand',
      },
    },
    'retire-configuration-unit': {
      destructive: true,
      title: {
        cs: 'Vyřadit konfigurační jednotku',
        en: 'Retire a configuration unit',
      },
    },
    'retire-controlled-attribute-value': {
      destructive: true,
      title: {
        cs: 'Vyřadit číselníkovou hodnotu atributu',
        en: 'Retire a controlled attribute value',
      },
    },
    'retire-gtin': {
      destructive: true,
      title: {
        cs: 'Vyřadit identifikátor GTIN',
        en: 'Retire a GTIN identifier',
      },
    },
    'retire-package-definition': {
      destructive: true,
      title: {
        cs: 'Vyřadit definici balení',
        en: 'Retire a package definition',
      },
    },
    'retire-package-option': {
      destructive: true,
      title: {
        cs: 'Vyřadit možnost balení',
        en: 'Retire a package option',
      },
    },
    'retire-product': {
      destructive: true,
      title: {
        cs: 'Vyřadit produkt',
        en: 'Retire a product',
      },
    },
    'retire-product-category': {
      destructive: true,
      title: {
        cs: 'Vyřadit kategorii produktů',
        en: 'Retire a product category',
      },
    },
    'retire-product-unit': {
      destructive: true,
      title: {
        cs: 'Vyřadit jednotku produktu',
        en: 'Retire a product unit',
      },
    },
    'retire-variant': {
      destructive: true,
      title: {
        cs: 'Vyřadit variantu produktu',
        en: 'Retire a product variant',
      },
    },
    'revise-attribute-definition': {
      title: {
        cs: 'Upravit definici atributu',
        en: 'Revise an attribute definition',
      },
    },
    'revise-configuration-unit': {
      title: {
        cs: 'Upravit konfigurační jednotku',
        en: 'Revise a configuration unit',
      },
    },
    'revise-package-definition': {
      title: {
        cs: 'Upravit definici balení',
        en: 'Revise a package definition',
      },
    },
    'revise-product-type': {
      title: {
        cs: 'Upravit typ produktu',
        en: 'Revise a product type',
      },
    },
    'revise-product-unit': {
      title: {
        cs: 'Upravit jednotku produktu',
        en: 'Revise a product unit',
      },
    },
    'revise-set-composition': {
      title: {
        cs: 'Upravit složení sady',
        en: 'Revise a set composition',
      },
    },
    'set-product-attribute-values': {
      title: {
        cs: 'Nastavit hodnoty atributů produktu',
        en: 'Set product attribute values',
      },
    },
    'set-product-brand': {
      title: {
        cs: 'Nastavit značku produktu',
        en: 'Set a product brand',
      },
    },
    'set-product-localized-facts': {
      title: {
        cs: 'Nastavit jazykovou verzi údajů produktu',
        en: 'Set localized product details',
      },
    },
    'set-product-manufacturer': {
      title: {
        cs: 'Nastavit výrobce produktu',
        en: 'Set a product manufacturer',
      },
    },
    'set-product-type': {
      title: {
        cs: 'Nastavit typ produktu',
        en: 'Set a product type',
      },
    },
    'set-product-unit-target-divisibility': {
      title: {
        cs: 'Nastavit dělitelnost jednotky varianty nebo balení',
        en: 'Set variant or package unit divisibility',
      },
    },
    'set-variant-attribute-override': {
      title: {
        cs: 'Nastavit přepsání atributu varianty',
        en: 'Set a variant attribute override',
      },
    },
    'set-variant-localized-facts': {
      title: {
        cs: 'Nastavit jazykovou verzi údajů varianty',
        en: 'Set localized variant details',
      },
    },
    'update-product': {
      title: {
        cs: 'Upravit produkt',
        en: 'Update a product',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Produkty, varianty, značky, kategorie, atributy, identifikátory, balení, sady, média a historie změn.',
    en: 'Products, variants, brands, categories, attributes, identifiers, packaging, sets, media and change history.',
  },
  keywords:
    'katalog produkt varianta značka výrobce kategorie atribut velikost barva SKU GTIN balení sada média product catalog variant brand category attribute package media',
  label: {
    cs: 'Katalog produktů',
    en: 'Product catalog',
  },
  reads: {
    'activate-local-override-recovery': 'hidden',
    'activate-package-definition-recovery': 'hidden',
    'activate-package-option-recovery': 'hidden',
    'add-product-category-assignment-recovery': 'hidden',
    'assert-size-equivalence-recovery': 'hidden',
    'assign-catalog-media-recovery': 'hidden',
    'assign-sku-recovery': 'hidden',
    'assortment-product-classification-v1': 'hidden',
    'assortment-selection-assessment-v1': 'hidden',
    'assortment-set-composition-v1': 'hidden',
    'brand-current': {
      title: {
        cs: 'Aktuální značky',
        en: 'Current brands',
      },
    },
    'brand-history': {
      title: {
        cs: 'Historie značky',
        en: 'Brand history',
      },
    },
    'catalog-document-current': {
      title: {
        cs: 'Aktuální dokumenty katalogu',
        en: 'Current catalog documents',
      },
    },
    'catalog-media-current': {
      title: {
        cs: 'Aktuální média katalogu',
        en: 'Current catalog media',
      },
    },
    'catalog-source-resolution': 'hidden',
    'change-local-override-recovery': 'hidden',
    'change-product-manufacturer-recovery': 'hidden',
    'change-product-relationship-recovery': 'hidden',
    'change-variant-recovery': 'hidden',
    'color-current': {
      title: {
        cs: 'Aktuální barvy',
        en: 'Current colors',
      },
    },
    'color-history': {
      title: {
        cs: 'Historie barvy',
        en: 'Color history',
      },
    },
    'confirm-gtin-recovery': 'hidden',
    'confirm-variant-combination-recovery': 'hidden',
    'correct-gtin-recovery': 'hidden',
    'correct-product-recovery': 'hidden',
    'correct-sku-recovery': 'hidden',
    'create-attribute-definition-recovery': 'hidden',
    'create-brand-recovery': 'hidden',
    'create-configuration-unit-recovery': 'hidden',
    'create-controlled-attribute-value-recovery': 'hidden',
    'create-package-definition-recovery': 'hidden',
    'create-product-category-recovery': 'hidden',
    'create-product-recovery': 'hidden',
    'create-product-relationship-recovery': 'hidden',
    'create-product-type-recovery': 'hidden',
    'create-product-unit-recovery': 'hidden',
    'create-set-composition-recovery': 'hidden',
    'create-variant-recovery': 'hidden',
    'decide-product-type-unnecessary-recovery': 'hidden',
    'effective-attribute-values-current': {
      title: {
        cs: 'Aktuální účinné hodnoty atributů',
        en: 'Current effective attribute values',
      },
    },
    'external-target-resolution': 'hidden',
    'govern-product-attribute-applicability-recovery': 'hidden',
    'govern-variant-allowed-values-recovery': 'hidden',
    'govern-variant-axes-recovery': 'hidden',
    'gtin-current': {
      title: {
        cs: 'Aktuální identifikátory GTIN',
        en: 'Current GTIN identifiers',
      },
    },
    'gtin-history': {
      title: {
        cs: 'Historie identifikátoru GTIN',
        en: 'GTIN identifier history',
      },
    },
    'import-source-assertion-recovery': 'hidden',
    'list-recorded-variants': {
      title: {
        cs: 'Seznam evidovaných variant',
        en: 'Recorded variants',
      },
    },
    'manufacturer-relation-current': {
      title: {
        cs: 'Aktuální vazby na výrobce',
        en: 'Current manufacturer relations',
      },
    },
    'manufacturer-relation-history': {
      title: {
        cs: 'Historie vazby na výrobce',
        en: 'Manufacturer relation history',
      },
    },
    'mark-gtin-unresolved-recovery': 'hidden',
    'move-product-category-recovery': 'hidden',
    'package-definition-history': {
      title: {
        cs: 'Historie definice balení',
        en: 'Package definition history',
      },
    },
    'package-option-history': {
      title: {
        cs: 'Historie možnosti balení',
        en: 'Package option history',
      },
    },
    'pricing-purpose-equivalence': 'hidden',
    'product-brand-current': {
      title: {
        cs: 'Aktuální značka produktu',
        en: 'Current product brand',
      },
    },
    'product-brand-history': {
      title: {
        cs: 'Historie značky produktu',
        en: 'Product brand history',
      },
    },
    'product-category-classification': {
      title: {
        cs: 'Zařazení produktu do kategorií',
        en: 'Product category classification',
      },
    },
    'product-category-history': {
      title: {
        cs: 'Historie kategorie produktu',
        en: 'Product category history',
      },
    },
    'product-detail': {
      title: {
        cs: 'Detail produktu',
        en: 'Product details',
      },
    },
    'product-history': {
      title: {
        cs: 'Historie produktu',
        en: 'Product history',
      },
    },
    'product-relationship-current': {
      title: {
        cs: 'Aktuální vztahy mezi produkty',
        en: 'Current product relationships',
      },
    },
    'product-relationship-history': {
      title: {
        cs: 'Historie vztahů mezi produkty',
        en: 'Product relationship history',
      },
    },
    'product-size-current': {
      title: {
        cs: 'Aktuální velikosti produktu',
        en: 'Current product sizes',
      },
    },
    'product-variant-snapshot': {
      title: {
        cs: 'Přehled variant produktu',
        en: 'Product variant snapshot',
      },
    },
    'promote-package-definition-recovery': 'hidden',
    'publish-product-configuration-recovery': 'hidden',
    'quantity-basis-compatibility': 'hidden',
    'quantity-preparation': 'hidden',
    'reactivate-brand-recovery': 'hidden',
    'reactivate-controlled-attribute-value-recovery': 'hidden',
    'reactivate-product-recovery': 'hidden',
    'reactivate-variant-recovery': 'hidden',
    'release-local-override-recovery': 'hidden',
    'remove-catalog-media-recovery': 'hidden',
    'remove-product-attribute-values-recovery': 'hidden',
    'remove-product-category-assignment-recovery': 'hidden',
    'remove-product-localized-facts-recovery': 'hidden',
    'remove-product-manufacturer-recovery': 'hidden',
    'remove-product-relationship-recovery': 'hidden',
    'remove-variant-attribute-override-recovery': 'hidden',
    'remove-variant-localized-facts-recovery': 'hidden',
    'rename-attribute-definition-recovery': 'hidden',
    'rename-brand-recovery': 'hidden',
    'rename-controlled-attribute-value-recovery': 'hidden',
    'rename-product-category-recovery': 'hidden',
    'rename-sku-recovery': 'hidden',
    'reorder-catalog-media-recovery': 'hidden',
    'replace-product-sizes-recovery': 'hidden',
    'retire-brand-recovery': 'hidden',
    'retire-configuration-unit-recovery': 'hidden',
    'retire-controlled-attribute-value-recovery': 'hidden',
    'retire-gtin-recovery': 'hidden',
    'retire-package-definition-recovery': 'hidden',
    'retire-package-option-recovery': 'hidden',
    'retire-product-category-recovery': 'hidden',
    'retire-product-recovery': 'hidden',
    'retire-product-unit-recovery': 'hidden',
    'retire-variant-recovery': 'hidden',
    'revise-attribute-definition-recovery': 'hidden',
    'revise-configuration-unit-recovery': 'hidden',
    'revise-package-definition-recovery': 'hidden',
    'revise-product-type-recovery': 'hidden',
    'revise-product-unit-recovery': 'hidden',
    'revise-set-composition-recovery': 'hidden',
    'selection-evidence': 'hidden',
    'set-composition-current': {
      title: {
        cs: 'Aktuální složení sady',
        en: 'Current set composition',
      },
    },
    'set-composition-history': {
      title: {
        cs: 'Historie složení sady',
        en: 'Set composition history',
      },
    },
    'set-product-attribute-values-recovery': 'hidden',
    'set-product-brand-recovery': 'hidden',
    'set-product-localized-facts-recovery': 'hidden',
    'set-product-manufacturer-recovery': 'hidden',
    'set-product-type-recovery': 'hidden',
    'set-product-unit-target-divisibility-recovery': 'hidden',
    'set-variant-attribute-override-recovery': 'hidden',
    'set-variant-localized-facts-recovery': 'hidden',
    'sku-lookup': {
      title: {
        cs: 'Vyhledat položku podle SKU',
        en: 'Look up an item by SKU',
      },
    },
    'update-product-recovery': 'hidden',
    'variant-history': {
      title: {
        cs: 'Historie varianty',
        en: 'Variant history',
      },
    },
  },
});
