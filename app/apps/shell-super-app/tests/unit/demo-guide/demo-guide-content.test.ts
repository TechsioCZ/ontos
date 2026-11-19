import { Effect } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { demoGuideFor, demoGuides } from '../../../src/demo-guide/demo-guide-registry.ts';

it.effect('links to the configured stage storefront without localhost destinations', () =>
  Effect.gen(function* stageStorefrontGuide() {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        rs.stubGlobal('ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT', 'https://ontos-stage-shop.web-revolution.cz');
        rs.resetModules();
      }),
      () =>
        Effect.sync(() => {
          rs.unstubAllGlobals();
          rs.resetModules();
        }),
    );
    const { sroubshopGuide } = yield* Effect.promise(() => import('../../../src/demo-guide/guides/sroubshop.ts'));
    for (const chapter of sroubshopGuide.chapters) {
      for (const step of chapter.steps) {
        if (step.target.kind === 'external') {
          expect(step.target.url.startsWith('https://ontos-stage-shop.web-revolution.cz/')).toBe(true);
        }
      }
    }
  }),
);

/** Demo accounts of each company; a guide may only send the presenter to its own company's accounts. */
const personaDomains = new Map([
  ['hanak', '@hanak.demo'],
  ['obchod', '@demo.ontos'],
  ['siampark', '@najempark.demo'],
  ['sroubshop', '@sroubarna.demo'],
]);

const legalEntities = {
  hanak: '71000000-0000-4000-8000-000000000022',
  obchod: '71000000-0000-4000-8000-000000000020',
  siampark: '71000000-0000-4000-8000-000000000021',
  sroubshop: '71000000-0000-4000-8000-000000000024',
} as const;

it('selects the guide of the current company only', () => {
  for (const [id, legalEntityId] of Object.entries(legalEntities)) {
    expect(demoGuideFor(legalEntityId)?.id).toBe(id);
  }
  expect(demoGuideFor()).toBeUndefined();
  // Kavárna Doma (legacy) has no guide.
  expect(demoGuideFor('71000000-0000-4000-8000-000000000023')).toBeUndefined();
});

it('uses the rental company accounts for every rental persona login', () => {
  const guide = demoGuideFor(legalEntities.siampark);
  const steps = guide?.chapters.flatMap((chapter) => chapter.steps) ?? [];
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

it('links the rental finance persona to the current paid and overdue invoices', () => {
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
  // FV-2026-0011 (R201) is overdue and unpaid with no reminder yet; the presenter only shows the reminder button.
  expect(overdue?.persona?.email).toBe('finance@najempark.demo');
  expect(overdue?.target).toEqual({ kind: 'app', path: '/finance?resourceId=3d2d16cf-21af-4fae-9c01-01911932b317' });
});

it('links the rental external persona to its agenda', () => {
  const steps = demoGuideFor(legalEntities.siampark)?.chapters.flatMap((chapter) => chapter.steps) ?? [];
  const agenda = steps.find((step) => step.id === 'siampark-externista-provoz');
  expect(agenda?.persona?.email).toBe('external@najempark.demo');
  expect(agenda?.target).toEqual({ kind: 'app', path: '/provoz/agenda' });
});

it.each(demoGuides.map((guide) => [guide.id, guide] as const))(
  'guide %s has distinct progress keys and company-scoped destinations',
  (id, guide) => {
    const steps = guide.chapters.flatMap((chapter) => chapter.steps);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    expect(new Set(guide.chapters.map((chapter) => chapter.id)).size).toBe(guide.chapters.length);
    for (const step of steps) {
      expect(step.id.startsWith(`${id}-`)).toBe(true);
      if (step.persona !== null) {
        expect(step.persona.email.endsWith(personaDomains.get(id) ?? '-')).toBe(true);
      }
      if (step.target.kind === 'app') {
        expect(step.target.path.startsWith('/')).toBe(true);
        expect(step.target.path.startsWith('/cs')).toBe(false);
        expect(step.target.path.includes('localhost')).toBe(false);
      } else {
        // Only the ŠroubShop storefront is an external destination.
        expect(id).toBe('sroubshop');
        expect(step.target.url.startsWith('http://localhost:3070/')).toBe(true);
      }
    }
  },
);

it('links each company to connected apps and the staff guides to role management', () => {
  for (const legalEntityId of Object.values(legalEntities)) {
    const chapter = demoGuideFor(legalEntityId)?.chapters.find((item) => item.id === 'pripojeni-ai');
    expect(chapter).toBeDefined();
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

it('links storefront checkout to the cart', () => {
  const guide = demoGuideFor(legalEntities.sroubshop);
  const steps = guide?.chapters.flatMap((chapter) => chapter.steps) ?? [];
  const checkout = steps.find((step) => step.id === 'sroubshop-objednavka');
  expect(checkout?.target).toEqual(expect.objectContaining({ kind: 'external', url: 'http://localhost:3070/kosik' }));
});
