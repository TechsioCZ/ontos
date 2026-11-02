import { Effect } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { demoGuideFor, demoGuides } from '../../../src/demo-guide/demo-guide-registry.ts';

it.effect('links to the configured stage storefront without localhost destinations', () =>
  Effect.gen(function* stageStorefrontGuide() {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', 'https://ontos-stage-akros.web-revolution.cz');
        rs.resetModules();
      }),
      () =>
        Effect.sync(() => {
          rs.unstubAllGlobals();
          rs.resetModules();
        }),
    );
    const { akrosGuide } = yield* Effect.promise(() => import('../../../src/demo-guide/guides/akros.ts'));
    for (const chapter of akrosGuide.chapters) {
      for (const step of chapter.steps) {
        if (step.target.kind === 'external') {
          expect(step.target.url.startsWith('https://ontos-stage-akros.web-revolution.cz/')).toBe(true);
        }
      }
    }
  }),
);

/** Demo accounts of each company; a guide may only send the presenter to its own company's accounts. */
const personaDomains = new Map([
  ['akros', '@akros.demo'],
  ['hanak', '@hanak.demo'],
  ['obchod', '@demo.ontos'],
  ['siampark', '@najempark.demo'],
]);

const legalEntities = {
  akros: '71000000-0000-4000-8000-000000000024',
  hanak: '71000000-0000-4000-8000-000000000022',
  obchod: '71000000-0000-4000-8000-000000000020',
  siampark: '71000000-0000-4000-8000-000000000021',
} as const;

it('selects the guide of the current company only', () => {
  for (const [id, legalEntityId] of Object.entries(legalEntities)) {
    expect(demoGuideFor(legalEntityId)?.id).toBe(id);
  }
  expect(demoGuideFor()).toBeUndefined();
  // Kavárna Doma (legacy) has no guide.
  expect(demoGuideFor('71000000-0000-4000-8000-000000000023')).toBeUndefined();
});

it('uses Nájempark consistently in displayed copy and every rental persona login', () => {
  const guide = demoGuideFor(legalEntities.siampark);
  expect(guide?.companyName).toBe('Nájempark');
  const chapters = guide?.chapters ?? [];
  const steps = chapters.flatMap((chapter) => chapter.steps);
  const displayedCopy = [
    guide?.companyName,
    guide?.intro,
    ...Object.values(guide?.boundaries ?? {}).flat(),
    ...chapters.flatMap((chapter) => [chapter.title, chapter.summary]),
    ...steps.flatMap((step) => [step.title, step.click, step.say, step.persona?.role, step.persona?.email]),
  ].join(' ');
  expect(displayedCopy).not.toMatch(/siampark/iu);
  expect(steps.find((step) => step.id === 'siampark-uvod')?.click).toContain('firmu Nájempark');
  expect(steps.find((step) => step.id === 'siampark-externista-prace')?.click).toContain(
    'Prohlídka volného bytu A102 se zájemcem',
  );
  const operations = steps.find((step) => step.id === 'siampark-externista-provoz');
  expect(operations?.click).toContain('Nájempark přidělil');
  expect(operations?.say).toContain('Nájempark přidělil');
  const emails = [...new Set(steps.flatMap((step) => (step.persona === null ? [] : [step.persona.email])))];
  expect(emails.toSorted((left, right) => left.localeCompare(right))).toEqual([
    'external@najempark.demo',
    'finance@najempark.demo',
    'management@najempark.demo',
    'operations@najempark.demo',
  ]);
});

it('keeps the rental guide identity and links the current stage records', () => {
  const guide = demoGuideFor(legalEntities.siampark);
  expect(guide?.id).toBe('siampark');
  expect(guide?.legalEntityId).toBe('71000000-0000-4000-8000-000000000021');
  const targets = guide?.chapters.flatMap((chapter) => chapter.steps.map((step) => step.target)) ?? [];
  expect(
    targets.flatMap((target) => (target.kind === 'app' && target.path.includes('?') ? [target.path] : [])),
  ).toEqual([
    '/nemovitosti?resourceId=528cd143-ef28-4b23-bebf-340ab530af8d',
    '/nemovitosti?resourceId=51d80e08-7be9-4f00-a1cb-6cc562df499a',
    '/najmy?resourceId=d2197c66-25a6-5113-86bf-14cb3c3c1b3e',
    '/smlouvy?resourceId=a0ac0359-d251-5b37-bed2-b9a0db201a77',
    '/finance?resourceId=8fdfcb33-7ec0-4402-b7cd-aafa1c34eb80',
    '/provoz/majetek?asset=siampark-asset-002',
    '/finance?resourceId=42813e23-ffd4-414c-9344-168f7024afde',
    '/finance?resourceId=3d2d16cf-21af-4fae-9c01-01911932b317',
    '/provoz/majetek?asset=siampark-asset-001',
  ]);
});

it('tells the rental finance story from the invoices Nájempark actually holds', () => {
  const chapter = demoGuideFor(legalEntities.siampark)?.chapters.find((item) => item.id === 'finance');
  expect(chapter?.steps.map((step) => step.id)).toEqual([
    'siampark-uhrazena-faktura',
    'siampark-po-splatnosti',
    'siampark-odpisy',
  ]);
  const [paid, overdue] = chapter?.steps ?? [];
  // FV-2026-0007 (R101) is fully paid by one manually confirmed payment; its tenant has paid all four invoices.
  expect(paid?.persona?.email).toBe('finance@najempark.demo');
  expect(paid?.target).toEqual({ kind: 'app', path: '/finance?resourceId=42813e23-ffd4-414c-9344-168f7024afde' });
  expect(paid?.click).toContain('FV-2026-0007');
  expect(paid?.click).toContain('Nic nezaznamenávejte');
  expect(paid?.say).toContain('ručně potvrzený záznam');
  // FV-2026-0011 (R201) is overdue and unpaid with no reminder yet; the presenter only shows the reminder button.
  expect(overdue?.persona?.email).toBe('finance@najempark.demo');
  expect(overdue?.target).toEqual({ kind: 'app', path: '/finance?resourceId=3d2d16cf-21af-4fae-9c01-01911932b317' });
  expect(overdue?.click).toContain('FV-2026-0011');
  expect(overdue?.click).toContain('Připravit upomínku');
  expect(overdue?.click).toContain('Na tlačítko neklikejte');
  expect(overdue?.say).toContain('zatím žádná neodešla');
  // No seeded or live rental invoice is partially paid and none has a sent reminder.
  const financeCopy = JSON.stringify(chapter);
  expect(financeCopy).not.toMatch(/částečn|odeslan[éá] e-mailem|c9f16710/iu);
});

it('shows the external agent only the agenda deadlines Nájempark assigned', () => {
  const steps = demoGuideFor(legalEntities.siampark)?.chapters.flatMap((chapter) => chapter.steps) ?? [];
  const agenda = steps.find((step) => step.id === 'siampark-externista-provoz');
  expect(agenda?.persona?.email).toBe('external@najempark.demo');
  expect(agenda?.target).toEqual({ kind: 'app', path: '/provoz/agenda' });
  expect(agenda?.click).toContain('Provoz › Moje agenda');
  expect(agenda?.click).toContain('Prohlídka volného bytu A102 se zájemcem');
  expect(agenda?.click).toContain('Připravit nabídku pronájmu skladu S01');
  expect(agenda?.click).toContain('Agendu máte jen pro čtení');
  // The seed has no R101 viewing event; the guide must not promise one.
  expect(JSON.stringify(steps)).not.toContain('Prohlídka R101');
});

it.each(demoGuides.map((guide) => [guide.id, guide] as const))('guide %s is complete and well formed', (id, guide) => {
  expect(guide.chapters.length).toBeGreaterThanOrEqual(3);
  const steps = guide.chapters.flatMap((chapter) => chapter.steps);
  expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
  expect(new Set(guide.chapters.map((chapter) => chapter.id)).size).toBe(guide.chapters.length);
  for (const chapter of guide.chapters) {
    expect(chapter.steps.length).toBeGreaterThan(0);
  }
  for (const step of steps) {
    expect(step.id.startsWith(`${id}-`)).toBe(true);
    expect(step.title.length).toBeGreaterThan(0);
    expect(step.say.length).toBeGreaterThan(0);
    expect(step.say.length).toBeLessThanOrEqual(260);
    if (step.persona !== null) {
      expect(step.persona.email.endsWith(personaDomains.get(id) ?? '-')).toBe(true);
    }
    if (step.target.kind === 'app') {
      expect(step.target.path.startsWith('/')).toBe(true);
      expect(step.target.path.startsWith('/cs')).toBe(false);
      expect(step.target.path.includes('localhost')).toBe(false);
    } else {
      // Only the AKROS storefront is an external destination.
      expect(id).toBe('akros');
      expect(step.target.url.startsWith('http://localhost:3070/')).toBe(true);
    }
  }
});

it('has an AI agent chapter for Hanák and Obchodní firma', () => {
  expect(demoGuideFor(legalEntities.hanak)?.chapters.some((chapter) => chapter.id === 'ai')).toBe(true);
  expect(demoGuideFor(legalEntities.obchod)?.chapters.some((chapter) => chapter.id === 'ai')).toBe(true);
});

it('has a Připojení ChatGPT / Claude chapter for every company', () => {
  for (const legalEntityId of Object.values(legalEntities)) {
    const chapter = demoGuideFor(legalEntityId)?.chapters.find((item) => item.id === 'pripojeni-ai');
    expect(chapter).toBeDefined();
    expect(chapter?.steps.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(
      chapter?.steps.some((step) => step.target.kind === 'app' && step.target.path === '/sprava/pripojene-aplikace'),
    ).toBe(true);
  }
  for (const legalEntityId of [legalEntities.obchod, legalEntities.hanak]) {
    const chapter = demoGuideFor(legalEntityId)?.chapters.find((item) => item.id === 'pripojeni-ai');
    expect(
      chapter?.steps.some((step) => step.target.kind === 'app' && step.target.path === '/sprava/lide-a-role'),
    ).toBe(true);
  }
});

it('describes guest or account owner-backed checkout without unsupported payment or local-only promises', () => {
  const guide = demoGuideFor(legalEntities.akros);
  const steps = guide?.chapters.flatMap((chapter) => chapter.steps) ?? [];
  const checkout = steps.find((step) => step.id === 'akros-objednavka');
  expect(checkout?.click).toContain('Objednat bez registrace');
  expect(checkout?.click).toContain('PPL nebo Českou poštu');
  expect(checkout?.target).toEqual(expect.objectContaining({ kind: 'external', url: 'http://localhost:3070/kosik' }));
  const boundaries = Object.values(guide?.boundaries ?? {})
    .flat()
    .join(' ');
  expect(boundaries).toContain('objednávku bez registrace');
  expect(boundaries).toContain('bez online platby');
  expect(boundaries).not.toContain('bez napojení na OntOS');
  expect(boundaries).not.toContain('ukázka běží jen lokálně');
  expect(boundaries).not.toContain('nikdy skutečným adresátům');
});

it('describes real operations without simulated service promises', () => {
  for (const guide of demoGuides) {
    const text = JSON.stringify(guide);
    expect(text).not.toMatch(/simulac|simulov|simulated/iu);
  }
  const rentalGuide = demoGuideFor(legalEntities.siampark);
  expect(JSON.stringify(rentalGuide)).not.toMatch(/podepsan[áéý]|s podpisem/iu);
});
