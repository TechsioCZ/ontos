import { describe, expect, it } from 'effect-rstest';
import {
  assertCategoryForest,
  categoryForestIssue,
  InvalidCategoryForest,
} from '../../shared/domain/category-forest.ts';

describe('category graph publication contract', () => {
  it('accepts empty and deep complete forests without recursive traversal', () => {
    expect(categoryForestIssue([], 'complete')).toBeUndefined();
    const links = Array.from({ length: 20_000 }, (_, index) => ({
      id: String(index),
      parentId: index === 0 ? null : String(index - 1),
    }));
    expect(categoryForestIssue(links, 'complete')).toBeUndefined();
  });

  it('rejects self-parenting, longer cycles and a cycle behind a valid component', () => {
    for (const links of [
      [{ id: 'a', parentId: 'a' }],
      [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ],
      [
        { id: 'root', parentId: null },
        { id: 'child', parentId: 'root' },
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'c' },
        { id: 'c', parentId: 'a' },
      ],
    ]) {
      expect(categoryForestIssue(links, 'complete')?.kind).toBe('cycle');
      expect(categoryForestIssue(links, 'projection')?.kind).toBe('cycle');
      expect(() => assertCategoryForest(links, 'projection')).toThrow(InvalidCategoryForest);
    }
  });

  it('permits omitted ancestors only in a projection, never a published complete graph', () => {
    const links = [{ id: 'child', parentId: 'omitted' }];
    expect(categoryForestIssue(links, 'projection')).toBeUndefined();
    expect(categoryForestIssue(links, 'complete')).toEqual({ categoryId: 'child', kind: 'missing-parent' });
  });

  it('rejects duplicate identity before a Map can conceal the malformed owner data', () => {
    const links = [
      { id: 'same', parentId: null },
      { id: 'same', parentId: 'same' },
    ];
    expect(categoryForestIssue(links, 'projection')).toEqual({ categoryId: 'same', kind: 'duplicate' });
  });
});
