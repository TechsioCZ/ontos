import type { DemoGuide, DemoGuidePersona } from '../demo-guide-types.ts';

const vedeni: DemoGuidePersona = { email: 'obchod@demo.ontos', role: 'Vedení firmy' };
const obchodnik: DemoGuidePersona = { email: 'obchodnik@demo.ontos', role: 'Obchodník' };
const ucetni: DemoGuidePersona = { email: 'ucetni@demo.ontos', role: 'Účetní' };
const sklad: DemoGuidePersona = { email: 'sklad@demo.ontos', role: 'Sklad' };

export const obchodGuide: DemoGuide = {
  chapters: [
    {
      id: 'prehled',
      steps: [
        {
          click: 'Ukažte pět karet na úvodní stránce a klikněte na Obnovit údaje.',
          id: 'obchod-prehled',
          persona: vedeni,
          say: 'Vedení vidí otevřené příležitosti, jejich hodnotu, neuhrazené faktury a otevřené i zpožděné úkoly. Každé číslo vychází z uložených záznamů.',
          target: { kind: 'app', path: '/' },
          title: 'Pět živých ukazatelů',
        },
      ],
      summary: 'Úvodní stránka ukazuje živé ukazatele z uložených záznamů.',
      title: 'Přehled firmy',
    },
    {
      id: 'obchod',
      steps: [
        {
          click:
            'Otevřete vyhranou nebo prohranou příležitost a ukažte, že změna fáze je zablokovaná s vysvětlením. Nic neukládejte.',
          id: 'obchod-prilezitosti',
          persona: obchodnik,
          say: 'Obchodník vede příležitosti po fázích. Uzavřenou příležitost nelze omylem vrátit do jiné fáze.',
          target: { kind: 'app', path: '/prodej/prilezitosti' },
          title: 'Obchodní příležitosti',
        },
        {
          click: 'Hromadně podle štítku → štítek VIP → ukažte náhled otevřených příležitostí → Zrušit.',
          id: 'obchod-hromadne-stitek',
          persona: vedeni,
          say: 'Hromadná změna se týká jen otevřených příležitostí a před uložením ukáže přesný náhled.',
          target: { kind: 'app', path: '/prodej/prilezitosti' },
          title: 'Hromadná změna podle štítku',
        },
        {
          click: 'Ukažte graf a tabulku fází → Stáhnout CSV.',
          id: 'obchod-statistiky',
          persona: vedeni,
          say: 'Statistiky počítají váženou hodnotu příležitostí ze stejných dat a export obsahuje přesně zobrazenou řadu.',
          target: { kind: 'app', path: '/prehledy/statistiky' },
          title: 'Statistiky obchodu',
        },
      ],
      summary: 'Obchod od nové příležitosti po statistiky s exportem.',
      title: 'Příležitosti a statistiky',
    },
    {
      id: 'faktury',
      steps: [
        {
          click: 'Otevřete fakturu FV-2026-0029 → Tisk. Nic nepotvrzujte ani neodesílejte.',
          id: 'obchod-faktura',
          persona: ucetni,
          say: 'Dodavatelem na faktuře i v tisku je vždy Obchodní firma podle přihlášení, ne podle adresy v prohlížeči. Koncept nese vodoznak NÁVRH.',
          target: { kind: 'app', path: '/siampark/finance' },
          title: 'Faktura a tisk',
        },
      ],
      summary: 'Účetní pracuje s doklady své firmy.',
      title: 'Faktury',
    },
    {
      id: 'sklad',
      steps: [
        {
          click: 'Karta Všechny → otevřete libovolný úkol a zavřete ho bez uložení.',
          id: 'obchod-sklad-ukoly',
          persona: sklad,
          say: 'Skladník vidí úkoly týmu, ale pole z obchodu a personalistiky, ke kterým nemá přístup, se mu nezobrazí.',
          target: { kind: 'app', path: '/siampark/work' },
          title: 'Úkoly skladu',
        },
        {
          click: 'Otevřete odkaz přímo: zobrazí se české odmítnutí přístupu.',
          id: 'obchod-sklad-zakaz',
          persona: sklad,
          say: 'Omezení neplatí jen v menu: přímý odkaz na finance skladník neotevře.',
          target: { kind: 'app', path: '/siampark/finance' },
          title: 'Finance skladu nepatří',
        },
      ],
      summary: 'Skladník vidí svou práci, ne finance ani obchod.',
      title: 'Sklad a úkoly',
    },
    {
      id: 'ai',
      steps: [
        {
          click: 'Počkejte na tabulku zaměstnanců a odrolujte pod ni do sekce AI aktivita.',
          id: 'obchod-ai-a',
          persona: vedeni,
          say: 'Úroveň A smí jen číst. Když se pokusí zapsat, backend ji odmítne a pokus zůstane v auditu.',
          target: { kind: 'app', path: '/prodej/zamestnanci' },
          title: 'Úroveň A jen čte',
        },
        {
          click: 'Karta Všechny → do Hledat úkol napište „AI: zavolat zákazníkovi kvůli nabídce“ → ukažte stav Zrušený.',
          id: 'obchod-ai-b',
          persona: vedeni,
          say: 'Úroveň B smí navíc založit úkol pro zaměstnance a nic jiného. Důkazový úkol vznikl přes MCP a byl zrušen řízenou akcí, historie zůstala.',
          target: { kind: 'app', path: '/siampark/work' },
          title: 'Úroveň B založí úkol',
        },
        {
          click: 'Zůstaňte v sekci AI aktivita.',
          id: 'obchod-ai-hranice',
          persona: vedeni,
          say: 'Ukazujeme skutečné MCP rozhraní a jeho oprávnění, ne vestavěný chat ani hodnocení jazykového modelu.',
          target: { kind: 'app', path: '/prodej/zamestnanci' },
          title: 'Co AI v ukázce je a není',
        },
      ],
      summary: 'Úroveň A jen čte, úroveň B smí navíc založit úkol.',
      title: 'AI agent A / B',
    },
  ],
  companyName: 'Obchodní firma',
  id: 'obchod',
  intro:
    'Obchodní firma s přehledem, příležitostmi, fakturami a skladem, kde každá role vidí jen svou agendu, a AI agent s úrovněmi A a B.',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
};
