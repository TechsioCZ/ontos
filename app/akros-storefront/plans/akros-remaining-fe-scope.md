# TASK 12–17: rozsah FE storefrontu a návaznost backendu

Tento audit předcházel realizaci. Aktuální výsledek po následném souhlasu uživatele
vlastní [review FE TASK 12–17](akros-tasks-12-17-review.md), včetně živě ověřeného
napojení Smart Address. Níže uvedený původní stav není seznam současných chyb.

Ověřeno 22. 10. 2026 podle aktuálních těl a veřejných komentářů šesti otevřených
GitHub issues a lokálního zdrojového kódu. Jde o rozbor a opravu plánu, nikoli
implementaci, nové vizuální testování nebo změnu GitHub stavů.

Uživatel upřesnil, že dodáváme pouze FE storefront. Nepřidávat nové simulace
serverových funkcí, které by se po integraci musely odstranit. Dřívější návrh
archivu lokálních objednávek a plné simulace „Objednat znovu“ tím odpadá.
Předchozí otázka na variantu této simulace již nevyžaduje odpověď.

## Rozdělení zbývajících úkolů

| TASK / issue                                                                         | Co patří FE                                                                                                                                                                                           | Co potřebuje backend nebo dodaný kontrakt                                                                        | Zjištěný lokální stav a další smysluplný krok                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12 · [#1310](https://github.com/TechsioCZ/ontos/issues/1310) · Objednat znovu        | Akce u konkrétní objednávky, stav zpracování, zobrazení výsledku a omezení vrácených službou.                                                                                                         | Skutečné řádky objednávky, jejich vlastnictví, současná cena a dostupnost, pravidla přidání do aktivního košíku. | Historie je statická, detail zná pouze demo objednávky; poslední dokončený checkout má oddělený session snapshot. Akce zatím chybí. Nevytvářet archiv ani nové katalogové vazby demo objednávek jen kvůli napodobení služby. Umístění akce lze navrhnout, funkční napojení počká na kontrakt.     |
| 13 · [#1311](https://github.com/TechsioCZ/ontos/issues/1311) · Oblíbené varianty     | Seznam konkrétních variant, jejich cena a stav, správný odkaz/výběr, odebrání, prázdný a chybový stav.                                                                                                | Synchronizace oblíbených mezi účty/zařízeními, pokud bude požadovaná; tělo issue ji výslovně nepožaduje.         | `FavoritesList` už skládá kartu z konkrétní varianty a používá přesné `variantIds`; odebrání existuje přes srdíčko i u nenačteného záznamu. Nejbližší krok je ověřit celou cestu seznam → vybraná varianta → odebrání na desktopu a mobilu. Nepřepisovat tuto funkci ani přidávat další úložiště. |
| 14 · [#1312](https://github.com/TechsioCZ/ontos/issues/1312) · Osobní údaje a adresy | Formuláře, editace, validace, chybové stavy a správné zobrazení dodaných údajů.                                                                                                                       | Trvalé uložení a načtení zákazníka/adres, oprávnění a dostupnost mezi prohlížeči.                                | `AccountProfilePage` má kontaktní, firemní, fakturační a dodací pole, validaci a existující lokální demo uložení. Není zde víceadresový adresář. Nezakládat jeho simulaci. Prověřit jen skutečné mezery formulářů; rozšíření počtu adres vyžaduje konkrétní zadání.                               |
| 15 · [#1313](https://github.com/TechsioCZ/ontos/issues/1313) · Změna hesla           | Umístění v osobních údajích, pole a potvrzení, validace shody, oddělené odeslání, zobrazení výsledku skutečné operace.                                                                                | Ověření identity, změna hesla, serverová pravidla a relace.                                                      | Dvě heslová pole už existují, ale jejich vyplnění blokuje uložení celého profilu. Cílený FE krok je oddělit tuto akci od ostatních údajů a doplnit smysluplnou validaci. Bez kontraktu neslibovat úspěch, nevymýšlet serverovou politiku nebo ukládání hesel.                                     |
| 16 · [#1314](https://github.com/TechsioCZ/ontos/issues/1314) · Hmotnost košíku       | Zobrazení celkové hmotnosti v prvním kroku a reakce na změny. Výpočet na FE je možný, pokud dostane jednoznačnou hmotnost za prodejní jednotku; může také zobrazovat součet dodaný košíkovou službou. | Jednotkový význam váhy za kus/metr/balení a spolehlivá normalizovaná data, případně autoritativní součet.        | Zdrojové `sourceNetWeight` nyní stačí pro detail v kg, ale neurčuje bezpečně přepočet všech jednotek košíku. Celková hmotnost zatím chybí. Neodhadovat ji z rodiče ani velikosti balení; doplnit zobrazení po dodání jednoznačných dat. Není to úkol výhradně pro BE.                             |
| 17 · [#1315](https://github.com/TechsioCZ/ontos/issues/1315) · Adresní našeptávání   | Nabídka návrhů, výběr, rozdělení do polí, klávesnice, ruční oprava, načítání a chyby služby.                                                                                                          | Vybraný poskytovatel a jeho dostupné API: vlastní databáze nebo FoxEntry, přístup a tvar výsledků.               | Checkout má funkční ruční `AddressFields` a HTML `autoComplete` pro browser; vlastní adresní našeptávač není implementovaný. Nenahrazovat poskytovatele lokálním seznamem adres. Po dodání API bude potřeba skutečná FE integrační práce.                                                         |

## Komentáře nalezené na GitHubu

- **#1312, KaiUweCZE, 22. 10. 2026:** upozorňuje na nutnost BE persistence
  mezi prohlížeči a výslovně nedoporučuje přidávat FE mock této funkce.
- **#1313, KaiUweCZE, 22. 10. 2026:** očekává pouze FE část; samotnou změnu
  hesla přisuzuje BE. Neznamená to, že nemáme dokončit formulář a jeho validaci.
- **#1310, #1311, #1314, #1315:** veřejná stránka při kontrole obsahovala tělo
  issue a událost přidání labelu; další věcný komentář nebyl vidět.

Rozdělení FE/BE v tabulce je naše technické vyhodnocení v rámci uživatelova
upřesnění. Není vydáváno za komentář autora tam, kde žádný takový komentář není.
Obsah a pořadí sloupců projektu se neměnily.

## Doporučený další postup

Následné upřesnění: uživatel dodal konkrétní vlastní Smart Address službu pro
TASK 17. [Živé ověření a návrh integrace](akros-smart-address-integration.md)
nahrazují původní neznámý zdroj: API/SDK existuje, ale kontrolovaný deploy při
našeptávání vracel HTTP 503/Cloudflare 1102 a liší se od kontraktu README.
TASK 17 lze řešit jako napojení existující služby po ověření její funkční verze.

1. TASK 12 ponechat jako integrační návaznost; neimplementovat předchozí simulaci.
2. Ověřit TASK 13 proti všem čtyřem bodům issue; velká část byla dodaná společně
   s TASK 02/03. Teprve po ověření doporučit jeho FE část do review.
3. Projít společně formuláře TASK 14/15 a opravit jen konkrétní FE mezery.
   Samotná existence místního uložení nesplňuje účtovou persistenci.
4. U TASK 16 vyjasnit datový vstup; FE zobrazení zůstává práce storefrontu.
5. TASK 17 napojovat po výběru skutečného zdroje a dodání API. Ruční adresní pole
   ani automatické vyplnění browserem nejsou splněním vlastního našeptávače.

Tento audit mění pouze plánovací dokumentaci. Nemění ani nemaže existující demo
persistenci, checkout, košík či oblíbené a nezavádí nové endpointy, adaptéry nebo mocky.
