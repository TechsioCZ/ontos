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
          target: { kind: 'app', path: '/finance' },
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
          target: { kind: 'app', path: '/ukoly' },
          title: 'Úkoly skladu',
        },
        {
          click: 'Otevřete odkaz přímo: zobrazí se české odmítnutí přístupu.',
          id: 'obchod-sklad-zakaz',
          persona: sklad,
          say: 'Omezení neplatí jen v menu: přímý odkaz na finance skladník neotevře.',
          target: { kind: 'app', path: '/finance' },
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
          click:
            'Otevřete Nastavení › Aktivita agentů, ve filtru Agent vyberte AI agenta A a ve filtru Výsledek „Odmítnuto oprávněním“.',
          id: 'obchod-ai-a',
          persona: vedeni,
          say: 'Úroveň A smí jen číst. Když se pokusí zapsat, backend ji odmítne a pokus zůstane v auditu.',
          target: { kind: 'app', path: '/sprava/aktivita-agentu' },
          title: 'Úroveň A jen čte',
        },
        {
          click:
            'Karta Všechny → zapněte Zobrazit skryté úkoly → do Hledat úkol napište „AI: zavolat zákazníkovi kvůli nabídce“ → otevřete nejnovější úkol ve stavu Zrušený a ukažte jeho Historii změn.',
          id: 'obchod-ai-b',
          persona: vedeni,
          say: 'Úroveň B smí navíc založit úkol pro zaměstnance a nic jiného. Každá zkouška přes MCP založila jeden důkazový úkol, který byl řízenou akcí zrušen a skryt ze seznamu; historie zůstala.',
          target: { kind: 'app', path: '/ukoly' },
          title: 'Úroveň B založí úkol',
        },
        {
          click: 'Zůstaňte na stránce Aktivita agentů.',
          id: 'obchod-ai-hranice',
          persona: vedeni,
          say: 'Ukazujeme skutečné MCP rozhraní a jeho oprávnění, ne vestavěný chat ani hodnocení jazykového modelu.',
          target: { kind: 'app', path: '/sprava/aktivita-agentu' },
          title: 'Co AI v ukázce je a není',
        },
        {
          click:
            'Otevřete Nastavení › Ke schválení a ukažte čekající dávku AI agenta C: nový úkol a změnu ceny produktu.',
          id: 'obchod-ai-c',
          persona: vedeni,
          say: 'Jedno místo pro návrhy AI ze všech modulů. Schválením se změna provede vaším jménem a s vašimi oprávněními a celou dávku lze vrátit tlačítkem Vrátit vše.',
          target: { kind: 'app', path: '/sprava/ke-schvaleni' },
          title: 'Ke schválení: návrhy ze všech modulů',
        },
      ],
      summary: 'Úroveň A jen čte, úroveň B smí navíc založit úkol a úroveň C navrhuje změny ke schválení.',
      title: 'AI agent A / B / C',
    },
    {
      id: 'pripojeni-ai',
      steps: [
        {
          click: 'Menu účtu › Můj profil › Připojené aplikace › Jak připojit › Kopírovat adresu.',
          id: 'obchod-mcp-adresa',
          persona: obchodnik,
          say: 'Do ChatGPT nebo Claude se vkládá jen adresa serveru, žádný klíč ani token. Přihlášení a souhlas proběhnou v OntOS.',
          target: { kind: 'app', path: '/profil' },
          title: 'Jedna adresa pro ChatGPT i Claude',
        },
        {
          click:
            'V Claude Code: claude mcp add --transport http ontos <adresa>, pak /mcp › Authenticate. Přihlaste se a na obrazovce Připojit zvolte firmu, Za mě a Navrhovat změny ke schválení.',
          id: 'obchod-mcp-souhlas',
          persona: obchodnik,
          say: 'Člověk sám zvolí firmu, za koho aplikace jedná, k jakým modulům má přístup a jestli změny jen navrhuje ke schválení.',
          target: { kind: 'app', path: '/profil' },
          title: 'Souhlas v češtině',
        },
        {
          click: 'U připojení Upravit přístup: zúžit moduly nebo přepnout na Jen čtení. Potom Odpojit.',
          id: 'obchod-mcp-upravit',
          persona: obchodnik,
          say: 'Přístup jde kdykoli zúžit nebo odebrat bez nového přihlášení. Aplikace ztratí přístup hned při dalším požadavku.',
          target: { kind: 'app', path: '/profil' },
          title: 'Upravit nebo odpojit',
        },
        {
          click:
            'Nastavení › Lidé a role › Agenti a jejich připojení › Kdo smí agenta připojit: vyberte člověka a Uložit.',
          id: 'obchod-mcp-agent',
          persona: vedeni,
          say: 'Agenta připojí jen člověk, kterému to správce povolí. Změny se zapíšou jako agent s poznámkou, kdo ho připojil.',
          target: { kind: 'app', path: '/sprava/lide' },
          title: 'Kdo smí připojit agenta',
        },
        {
          click: 'Nastavení › Připojené aplikace: dlaždice, filtry a u připojení Odpojit s důvodem.',
          id: 'obchod-mcp-prehled',
          persona: vedeni,
          say: 'Správce vidí všechna připojení ve firmě a jedním kliknutím je odpojí. Odpojení i důvod se zapíšou do auditu.',
          target: { kind: 'app', path: '/sprava/pripojene-aplikace' },
          title: 'Přehled připojení pro správce',
        },
      ],
      summary:
        'ChatGPT nebo Claude se připojí jednou adresou, přihlášením do OntOS a souhlasem, bez kopírování tokenů.',
      title: 'Připojení ChatGPT / Claude',
    },
  ],
  companyName: 'Obchodní firma',
  id: 'obchod',
  intro:
    'Obchodní firma s přehledem, příležitostmi, fakturami a skladem, kde každá role vidí jen svou agendu, a AI agent s úrovněmi A a B.',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
};
