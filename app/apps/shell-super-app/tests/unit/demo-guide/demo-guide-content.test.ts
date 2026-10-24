import { Effect } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { demoGuideFor, demoGuides } from '../../../src/demo-guide/demo-guide-registry.ts';

it.effect('links to the configured stage storefront without localhost destinations', () =>
  Effect.gen(function* stageStorefrontGuide() {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', 'https://ontos-stage-akros.bleeding.dev');
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
          expect(step.target.url.startsWith('https://ontos-stage-akros.bleeding.dev/')).toBe(true);
        }
      }
    }
  }),
);

/** Demo accounts of each company; a guide may only send the presenter to its own company's accounts. */
const personaDomains: Readonly<Record<string, string>> = {
  akros: '@akros.demo',
  hanak: '@hanak.demo',
  obchod: '@demo.ontos',
  siampark: '@siampark.demo',
};

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
  expect(demoGuideFor(undefined)).toBeUndefined();
  // Kavárna Doma (legacy) has no guide.
  expect(demoGuideFor('71000000-0000-4000-8000-000000000023')).toBeUndefined();
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
      expect(step.persona.email.endsWith(personaDomains[id] ?? '-')).toBe(true);
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
    expect(chapter?.steps.some((step) => step.target.kind === 'app' && step.target.path === '/sprava/lide')).toBe(true);
  }
});

it('describes authenticated owner-backed checkout without unsupported payment or local-only promises', () => {
  const guide = demoGuideFor(legalEntities.akros);
  const steps = guide?.chapters.flatMap((chapter) => chapter.steps) ?? [];
  const checkout = steps.find((step) => step.id === 'akros-objednavka');
  expect(checkout?.click).toContain('nejprve přihlaste zákaznickým účtem');
  expect(checkout?.click).toContain('PPL nebo Českou poštu');
  expect(checkout?.target).toEqual(expect.objectContaining({ kind: 'external', url: 'http://localhost:3070/kosik' }));
  const boundaries = Object.values(guide?.boundaries ?? {})
    .flat()
    .join(' ');
  expect(boundaries).toContain('před zadáním dopravy a adresy');
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
