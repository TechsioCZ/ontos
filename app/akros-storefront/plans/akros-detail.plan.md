---
name: akros-detail
overview: Doplnit modální detail, akce a oblíbené konkrétních variant podle původních TASK 03, 07, 08, 02 a 13.
todos:
  - id: task-03-07-variant-detail
    content: TASK 03 a 07 – dodat modální detail s popisem, hmotností, náhledem obrázku a hlídáním, dotazem i sdílením konkrétní varianty.
    status: completed
  - id: task-08-detail-information
    content: TASK 08 – ověřit a upravit rozmístění popisu a informací o dopravě v detailu.
    status: completed
  - id: task-02-favorite-state
    content: TASK 02 – výběr oblíbených variant v dialogu, skutečné ukládání a jednotný stav srdíčka.
    status: completed
  - id: task-13-favorites-page
    content: TASK 13 – zobrazit uložené varianty, umožnit jejich odebrání a otevřít přes odkaz správnou variantu.
    status: completed
isProject: false
---

# akros-detail

## Execution Notes

TASK 13 je nyní ověřený v celém průchodu na 14 šířkách včetně opravy čitelnosti
mobilních karet; výsledek a důkazy vlastní [review TASK 12–17](akros-tasks-12-17-review.md).

Navazuje na `akros-variants`. Jednotka kg pro zobrazení hmotnosti byla doložena 22. 10. 2026; `akros-weight` dále řeší přepočet pro košík z TASK 16. Mapování na issues
a rozhodnutí jsou v [hlavním plánu](../IMPLEMENTATION-PLAN.md). Modal a jeho akce
z TASK 03 a 07 se dodávají společně: potřebují tutéž identitu, data a návratový stav.
Zdroje a zbývající jednotkové otázky vlastní `akros-weight`.

Aktuální [rozbor TASK 02](akros-task-02-review.md) obsahuje uživatelův požadavek na
tabulku pro výběr variant po kliknutí na srdíčko a ověřený inventář komponent kitu.
Nové upřesnění z 21. 10. 2026 mění název akce „Poslat kamarádovi“ na „Sdílet“ a
přidává „Tisk“. Po souhlasu s realizací se implementuje potvrzování tlačítkem
„Uložit výběr“ a tisk produktového listu bez seznamu variant. Navazující TASK 03,
07 a 13 tím nejsou automaticky dokončené.

### TASK 03 + 07 – detail a akce varianty · #1301, #1305

Uživatelské upřesnění po TASK 02 dodává společný výběr pro hlídání, dotaz a sdílení
více variant, přesné odkazy a předvyplněný dotaz. Stav tohoto dílčího kroku je v
[záznamu akcí](akros-task-03-actions-review.md). Navazující implementace modalu,
popisu, obrázku a přímých akcí je v níže uvedeném rozboru. Společný úkol 03/07
je lokálně dokončený včetně zobrazení doložené hmotnosti v kg.

Uživatel schválil [konkrétní návrh a realizaci](akros-task-03-07-review.md).
Tento dokument vlastní otevření z názvu, obsah modalu, přímé akce, obrázkový náhled,
URL/historii, chybějící data a ověření. Hromadné akce zůstávají zachované;
váha se nedědí z kontejneru a přepočet kg pro košík je samostatný TASK 16.

- Požadovaný modální detail používá kit `Dialog` a vlastní přesnou URL identitu.
- Modal patří konkrétní variantě: název, SKU, obrázek, dostupné parametry, cena,
  ověřená hmotnost a popis. Váhu neuvádět na vícevariantovém kontejneru.
- Zpřístupnit i popis společného produktu; při chybějícím variantním popisu použít
  výslovně společný popis, ne prázdný blok. Váhu bez ověřeného zdroje nevymýšlet.
- Zahrnout dodatek GitHubu: najetí na variantu ukáže její obrázek, s fallbackem pro
  chybějící obrázek. Stejnou informaci zpřístupnit fokusem a otevřením detailu na dotyku.
- Hlídání ukládá a obnovuje stav konkrétní varianty; neoznačí sourozenecké varianty.
  Staré kontejnerové záznamy automaticky nerozšířit na všechny varianty.
- Dotaz nese identitu a SKU do cílového formuláře. Sdílení vytváří přesný odkaz,
  který po otevření vybere stejnou variantu; zachovat použitelné náhradní sdílení.
- Hlídání a dotaz umístit do detailu varianty. Lokální demo stav neprezentovat jako
  skutečně aktivované e-mailové notifikace nebo odeslaný požadavek bez daného backendu.
- Escape, tlačítko zavření, návrat fokusu, přímý odkaz, reload a historie prohlížeče
  fungují bez ztráty identifikace varianty nebo rozbití filtru původního seznamu.

Dokončeno: dvě varianty jednoho produktu mají nezávislé akce; odkaz a dotaz obsahují
správné SKU. Modal projde klávesnicí i dotykem, zobrazuje popis a správně zdrojenou váhu.

### TASK 08 – informační rozložení · #1306

Uživatel schválil [rozmístění a rozsah opravy](akros-task-08-review.md): celý popis
pod horním přehledem a dopravu pod akcemi. Součástí je oprava ztracených popisů,
nikoli přenastavení dopravních cen nebo odhad hmotnosti.

- Posoudit současný popis pod obrázky a před úpravou připravit konkrétní návrh
  rozmístění pro desktop i mobil. Ověřit jej vůči přesnému návrhu z D1.
- Prověřit blok dopravy pod „Sdílet“ (původně „Poslat kamarádovi“) nebo jinou srozumitelnou pozici.
  Prezentovat jen doložené informace; neslibovat skutečnou dostupnost dopravce.
- Zachovat dostupnost popisu a akcí i při dlouhém textu; nevytvářet dva rozdílné
  popisy varianty na stránce a v modalu.

Dokončeno: přijaté rozmístění je zapsané a vizuálně ověřené na požadovaných šířkách.

### TASK 02 – oblíbená varianta · #1300

Lokálně dokončeno a ověřeno 21. 10. 2026; implementace, testy a zbývající návaznosti
jsou v [záznamu TASK 02](akros-task-02-review.md#realizovaný-výsledek-a-ověření).

- Vycházet z [rozboru výběrového dialogu](akros-task-02-review.md): hledání, checkboxy,
  zachování výběru při filtrování, české popisky a mobilní kompozice řádků. Návrh
  hromadného potvrzení používá „Uložit výběr“ a zrušení bez zápisu.
- Doporučené základní napojení stránky oblíbených v tomto kroku pokrývá část TASK 13;
  přesné otevření varianty a finální prezentaci nadále vlastní TASK 13.
- Zavést skutečný seznam referencí na konkrétní prodejné položky; vícevariantový
  kontejner se neukládá místo vybrané varianty. Ošetřit opakované přidání.
- Stav srdíčka odpovídá téže variantě napříč výpisem, modalem a oblíbenými a obnoví
  se po reloadu. U kontejnerové karty bez výběru neslibovat stav všech variant.
- Použít kit ovládání s odpovídajícím přístupným názvem/stavem. Bez skutečného
  účtového backendu jde o lokální demo evidenci, nikoli zabezpečený serverový účet.

Dokončeno: přidání/odebrání varianty A neovlivní B, nevznikají duplicity a po reloadu
se zobrazí správný stav včetně bezpečného načtení poškozených/neznámých dat.

### TASK 13 – stránka oblíbených · #1311

- Nahradit šest pevných ukázkových produktů skutečně uloženými variantami.
- Odkaz otevře nebo jednoznačně vybere danou variantu i po změně filtrů a po reloadu.
- Odebrání ihned upraví seznam i související srdíčko. Vyřešit prázdný seznam,
  smazanou variantu a aktuálně nedostupnou položku bez falešné nákupní dostupnosti.

Dokončeno: načtení seznamu, přímé otevření, automatický výběr/zvýraznění a odebrání
fungují na desktopu i mobilu; nevyskytují se náhodné ukázkové položky.

## Constraints

Platí pravidla hlavního plánu. Neukládat ceny a sklad jako autoritativní součást
oblíbeného záznamu. Bez ověření D1 a D3 netvrdit shodu s Figmou ani správnost hmotnosti.

## Operator Guidance

Hlavní místa: produktová route, `product-purchase-form.tsx`,
`product-detail-actions.tsx`, `product-grid.tsx`, route `/oblibene`, katalogové helpery
a komponentové tokeny. Ověřit unit/component testy identity a stavů, browserově
modal, přímé odkazy, návrat fokusu a oblíbené na požadovaných šířkách.
