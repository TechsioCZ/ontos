# TASK 09: textová horní navigace

Uživatel schválil rozsah 22. 10. 2026 po commitu `691876af`.
[Issue #1307](https://github.com/TechsioCZ/ontos/issues/1307) bylo znovu přečtené:
horní lišta má obsahovat pouze textové stránky. Issue je otevřené, má pouze `bug`;
GitHub ani projektové statusy tento lokální krok nemění.

## Dohodnuté chování

- V horní liště a mobilní sekci „Informace“ je společných šest odkazů:
  Obchodní podmínky, O nás, Blog, Partnerský program, Reklamace, Kontakty.
- Odstraněné jsou tři kategoriové odkazy a „Domů“. Logo dál vede na úvod,
  přihlášení zůstává samostatnou akcí.
- Spojovací a hutní materiál mají nezměněný vstup v bočním a mobilním katalogu.
  Výroba zůstává ve „Speciální kategorie“ přes již existující `https://www.akroscz.cz/`.
  Nevzniká nová textová stránka ani změna katalogových rout.
- Stávající kit `LinkButton`, `Drawer`, tokeny, rozložení a přístupnost se zachovají.
  Není potřeba měnit CSS, tokeny ani přidávat komponentu.

## Ověření

- Browserové porovnání deploye potvrdilo původních deset odkazů včetně „Domů“
  a tří kategorií. Lokální lišta má schválených šest informačních odkazů.
- `npm run check` prošlo: formatter, lint, TypeScript, všech 178 testů ve 33 souborech
  a produkční build. Použito `VITEST_MAX_WORKERS=1` kvůli paměti stroje.
- Dvě existující komponentové kontroly byly přizpůsobeny novému zadání:
  úvod nemá aktivní informační odkaz, aktivní Blog se označí na desktopu i mobilu,
  kliknutí na aktuální informační URL stále zavře menu. Kontroly nebyly odstraněny.
- `npm run test:shared-ui` prošlo na 12 šířkách
  320/390/760/761/768/1023/1024/1100/1101/1280/1440/1920 px.
  Ověřeno přesných šest odkazů, samostatné přihlášení, obě katalogové kategorie
  a přístup k výrobě ve „Speciální kategorie“, Escape a návrat fokusu.
- Na 1920 a 390 px byl Enterem otevřen každý ze šesti textových odkazů i obě
  hlavní kategorie; ověřeny aktivní stránka, zavření menu a návrat domů přes logo.
  Zůstala zachovaná regrese hledání, footeru a spotřeby komponentových tokenů.
- V prohlížeči nevznikly runtime ani hydratační chyby. Ručně prohlédnuté screenshoty
  desktopové lišty a mobilního menu v `test-results/shared-ui/` jsou v pořádku.

Změna aplikace odstraňuje pouze čtyři položky ze společného seznamu. CSS, tokeny,
katalogový strom a routy se nemění. Lokálně dokončeno, zatím bez commitu a deploye.
