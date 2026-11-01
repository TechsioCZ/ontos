import { describe, expect, it } from 'effect-rstest';
import { technicalIdentifiersInText } from '../../src/visible-text.ts';

describe('visible technical identifiers', () => {
  it.each([
    'fbdd110f-e514-53e9-9832-20f6e4cb1f9d',
    '4DD2328A-01AF-53D2-BAA8-CBAEB3322B47',
    'siampark-asset-001',
    'najempark-meter-003',
    'sr_connection_123',
    'ak_demo_key',
    'a'.repeat(64),
  ])('detects the technical value %s inside human text', (value) => {
    expect(technicalIdentifiersInText(`Záznam: ${value}.`)).toEqual([value]);
  });

  it('preserves real business codes without a broad number or SKU heuristic', () => {
    expect(
      technicalIdentifiersInText(
        'OBJ-2026-0009, FA-2026-0012, IČO 25741136, DIČ CZ25741136, SKU AKROS_001, A101, R301, S01, AL-01, PARKOVA',
      ),
    ).toEqual([]);
  });

  it('does not classify a fragment of a UUID as an acceptable display label', () => {
    expect(technicalIdentifiersInText('záznam fbdd110f…')).toEqual([]);
    // Truncated IDs are removed at their display adapters, not guessed from arbitrary eight-character names.
  });
});
