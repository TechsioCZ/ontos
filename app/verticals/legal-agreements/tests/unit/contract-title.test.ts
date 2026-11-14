import { expect, it } from 'effect-rstest';
import { contractTitle } from '../../src/routes/[lang]/smlouvy/contract-title.ts';

it('keeps readable unit names for leases and subjects for commercial contracts', () => {
  expect(
    contractTitle({ kind: 'LEASE', subject: 'Nájem kanceláře' }, 'Kancelář R201', 'Ateliér Horák', 'Smlouva bez názvu'),
  ).toBe('Kancelář R201');
  expect(
    contractTitle(
      { kind: 'OTHER', subject: 'Rámcová dodavatelská smlouva' },
      undefined,
      'Dodavatel',
      'Smlouva bez názvu',
    ),
  ).toBe('Rámcová dodavatelská smlouva');
});

it('uses a readable lease subject or neutral fallback when its unit is unavailable', () => {
  expect(
    contractTitle({ kind: 'LEASE', subject: 'Nájem kanceláře' }, undefined, 'Ateliér Horák', 'Smlouva bez názvu'),
  ).toBe('Nájem kanceláře');
  expect(contractTitle({ kind: 'LEASE' }, undefined, 'Jana Nováková', 'Smlouva bez názvu')).toBe('Smlouva bez názvu');
  expect(contractTitle({ kind: 'OTHER' }, undefined, undefined, 'Smlouva bez názvu')).toBe('Smlouva bez názvu');
});
