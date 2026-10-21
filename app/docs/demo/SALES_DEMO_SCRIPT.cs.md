# Sales demo: scénář pro vedoucí obchodu (15 minut)

Lokální demo. Nic se nenasazuje. Všechny cesty jsou na `localhost:3020`.

## 1. Příprava

- Z adresáře `app/` spusťte `./scripts/demo/up.sh` (první start i restart).
- Otevřete http://localhost:3020/cs/login.
- Účty (heslo `password1234`): `obchod@demo.ontos` (vedoucí obchodu, vše), `obchodnik@demo.ontos` (obchodník), `ucetni@demo.ontos` (účetní), `sklad@demo.ontos` (skladník).
- Reset dat: `up.sh` data při každém spuštění znovu naseeduje. Data ponechá `DEMO_RESET=0 ./scripts/demo/up.sh`. Zastavení: `./scripts/demo/down.sh`.
- MCP pro Claude: postup a příkaz `claude mcp add ontos-sales` jsou v `app/tools/ontos-agent-mcp/README.md`. Ověření: nástroj `whoami` vrátí `assertionObtained: true`.

## 2. Scénář

**1. Statistiky, přehled** · R6

- Klikněte: Statistiky → Ukazatel „Tržby z faktur“ → Období „12 měsíců“ → Načíst.
- Řekněte: „Čísla máte na jednom místě a výběr metriky i grafu změníte na dva kliky.“

**2. Zákazník s ARES** · R1

- Klikněte: Zákazníci → Nový zákazník → zadejte IČO (8 číslic) → Načíst z ARES → doplňte e-mail → Vytvořit zákazníka.
- Řekněte: „Firmu založíte z veřejného registru, údaje nepřepisujete ručně.“

**3. Štítky a hromadná úprava zákazníků** · R7b, R7c

- Klikněte: zaškrtněte několik zákazníků → Upravit hromadně → Přidat štítek (např. VIP) → Použít.
- Řekněte: „Jednu akci uděláte na celé skupině firem najednou.“

**4. Nová příležitost s produkty** · R3

- Klikněte: Příležitosti → Nová příležitost → zákazník, název, očekávané uzavření, položky (produkt a množství). Obchodníka nastavte volitelně.
- Řekněte: „Cena se při přidání položky zafixuje, pozdější změna ceníku obchod nezmění.“

**5. Přiřazení obchodníka** · R3

- Klikněte: u příležitosti Přiřadit obchodníka → vyberte obchodníka, poté „Nepřiřazeno“. Pro kontrolu použijte filtr Jen nepřiřazené.
- Řekněte: „Každý obchod má jasného vlastníka, nebo je vidět jako nepřiřazený.“

**6. Hromadně podle štítku** · R7b, R7c

- Klikněte: Příležitosti → Hromadně podle štítku → Typ štítku Zákazník → vyberte štítek → zkontrolujte náhled → Změnit fázi nebo Přiřadit obchodníka → Provést změnu.
- Řekněte: „Jeden štítek na zákaznících změní všechny jejich otevřené obchody.“

**7. Výhra vystaví fakturu** · R5

- Klikněte: u příležitosti Změnit fázi → Vyhraná. Dialog upozorní, že vznikne koncept faktury.
- Řekněte: „Výhra sama založí fakturu, účetní ji už jen zkontroluje.“

**8. Faktury: koncept, potvrzení, ruční faktura, tisk** · R2, R5

- Klikněte: Faktury (/cs/finance) → najděte koncept se zdrojem Příležitost → otevřete → Potvrdit fakturu. Potom Nová faktura → zákazník, položka, splatnost → Vytvořit koncept → Potvrdit → Tisk.
- Řekněte: „Faktura vzniká z obchodu i ručně, potvrdíte ji a vytisknete. E-mail se neodesílá.“

**9. Sklad a změna ceny** · R7, R7d

- Klikněte: Produkty a sklad → Příjem zboží (příjem) → u produktu záložka Pohyby → typ Výdej (výdej).
- Klikněte: vyberte produkt, který je na faktuře z kroku 8 → Změnit cenu o % (např. +5 %).
- Klikněte: otevřete fakturu z kroku 8.
- Řekněte: „Cena se změnila pro nové prodeje. Faktura a tržby zůstaly stejné.“

**10. Objednávky a štítky** · R7b

- Klikněte: Objednávky → vyberte několik objednávek → Štítky → přidejte štítek (např. velká objednávka).
- Řekněte: „Objednávky nesou štítky jako zákazníci, takže je filtrujete i měníte hromadně.“

**11. Úkol pro zaměstnance** · R4

- Klikněte: Úkoly (/cs/ukoly) → Nový úkol → název, Řešitel (obchodník), termín, priorita, zákazník a příležitost.
- Řekněte: „Úkol má konkrétního řešitele a termín, takže je jasné, kdo co dělá.“

**12. Zaměstnanci: štítky, role, oprávnění** · R7b, R7c, R10

- Klikněte: Zaměstnanci (/cs/prodej/zamestnanci) → vyberte více lidí → Štítky, případně Změnit roli. Otevřete sekci Oprávnění.
- Řekněte: „Každý člověk má roli a rozsah práce. Tabulka rolí ukazuje, co která smí.“

**13. Obchodník nemůže potvrdit fakturu** · R10

- Klikněte: odhlaste se → přihlaste `obchodnik@demo.ontos` → Faktury → otevřete fakturu → Potvrdit fakturu.
- Řekněte: „Obchodník vede své obchody, ale účetní potvrzení neudělá. Server akci odmítne.“
- Poznámka: tlačítko je viditelné, zamítnutí přijde ze serveru (hláška „Pro tuto operaci nemáte oprávnění.“).

**14. AI agent v Claude** · R8, R9, R11

- Klikněte: v Claude s připojeným `ontos-sales` pošlete čtyři prompty v tomto pořadí.
- Řekněte po každém: viz níže.

Prompt 1 (R8, čísla): „Jaké jsme měli fakturované tržby po měsících za posledních 12 měsíců? Který měsíc byl nejsilnější a kolik je teď otevřeno v pipeline ve fázi Vyjednávání?“

- Řekněte: „Agent čte stejná čísla jako statistiky.“

Prompt 2 (R9, úkol): „Vytvoř úkol pro obchodníka, který má na starosti největší příležitost ve vyjednávání: ať do pátku zavolá zákazníkovi kvůli nabídce. Priorita vysoká.“

- Řekněte: „Agent založí úkol konkrétnímu člověku. Ověřte v Úkolech, filtr Všechny.“

Prompt 3 (R9, příležitost): „Příležitost Wi-Fi pokrytí skladu pro Mosteckou energetiku vrať do fáze Nabídka, zákazník chce upravenou nabídku.“

- Řekněte: „Agent posune obchod ve fázi. Ověřte v Příležitostech, filtr Fáze.“

Prompt 4 (R11, štítky): „Otaguj podle pravidla: zákazníci s potvrzenými fakturami nad 200 000 Kč dostanou štítek VIP a objednávky nad 100 000 Kč štítek pro velké objednávky. Když vhodný štítek pro objednávky neexistuje, založ ho. Pak mi napiš, koho a co jsi označil.“

- Řekněte: „Pravidlo z chatu se provede samo. Ověřte v Nastavení → Štítky, počty a přiřazení.“

**15. Statistiky znovu** · R6, R8, R9

- Klikněte: Statistiky → Ukazatel „Vážená pipeline“ → Typ grafu Koláč → Seskupit podle Fáze → Načíst. Potom přepněte zpět na Tržby z faktur.
- Řekněte: „Všechno, co agent a vy jste změnili, se projeví v číslech bez dalšího exportu.“

## 3. Pokrytí požadavků

| Požadavek                               | Kde v demu                                                                                                                | Krok         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ |
| R1 Založit zákazníka                    | Zákazníci → Nový zákazník, Načíst z ARES                                                                                  | 2            |
| R2 Faktura (jednoduchá, bez e-mailu)    | Faktury → Nová faktura → koncept → potvrzení → tisk                                                                       | 8            |
| R3 Příležitost, volitelně s obchodníkem | Příležitosti → Nová příležitost, Přiřadit obchodníka                                                                      | 4, 5         |
| R4 Úkol pro zaměstnance                 | Úkoly → Nový úkol (a prompt 2)                                                                                            | 11, 14       |
| R5 Faktura při výhře                    | Změnit fázi → Vyhraná → koncept faktury                                                                                   | 7, 8         |
| R6 Statistiky (metriky, graf, období)   | Statistiky → Ukazatel, Typ grafu, Období, Seskupit podle                                                                  | 1, 15        |
| R7 Sklad přijímá a vydává               | Produkty a sklad → Příjem zboží, Pohyby                                                                                   | 9            |
| R7b Štítky a data podle štítku          | Štítky na zákaznících, objednávkách, produktech, zaměstnancích; Hromadně podle štítku                                     | 3, 6, 10, 12 |
| R7c Hromadná úprava                     | Upravit hromadně (zákazníci), Změnit cenu o % (produkty), Hromadně podle štítku (příležitosti), Změnit roli (zaměstnanci) | 3, 6, 9, 12  |
| R7d Změna ceny nemění faktury           | Změnit cenu o % → stejná faktura a tržby                                                                                  | 9            |
| R8 Agent čte čísla                      | MCP `get_metrics`, `list_opportunities` (prompt 1)                                                                        | 14           |
| R9 Agent mění úkoly a příležitosti      | MCP `create_task`, `update_opportunity` (prompty 2, 3)                                                                    | 14           |
| R10 Oddělená oprávnění lidí a botů      | Obchodník nepotvrdí fakturu; bot nemá zápis do faktur ani mazání štítků                                                   | 12, 13, 14   |
| R11 Agent taguje podle pravidla         | MCP `create_tag`, `assign_tags` (prompt 4)                                                                                | 14           |

## 4. Co je prototyp a známá omezení

- Produkty, sklad a objednávky jsou demo náhrada (merchandise) místo produkčních modulů pro katalog, ceny a sklad.
- Žádné odesílání e-mailů. Faktury se tisknou z prohlížeče.
- Účetní potvrzení a platby jsou simulované.
- Běh je jen lokální, bez nasazení.
- Segmenty zákazníků jsou jen pro čtení.
- Tabulka rolí v sekci Oprávnění je statický popis, ne živá data.
- ARES potřebuje internet. Když není dostupný, zadejte údaje ručně.
- Agent běží mimo produkt přes MCP server, není to funkce aplikace.
- Pokud se zobrazí „Přihlášené prostředí je dočasně nedostupné“, odhlaste se a přihlaste znovu.
