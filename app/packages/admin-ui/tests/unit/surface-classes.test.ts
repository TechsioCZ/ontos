import { describe, expect, it } from 'effect-rstest';
import {
  dividedListClassName,
  sidePanelSurfaceClassName,
  surfaceCardClassName,
  surfaceTileClassName,
} from '../../src/ui-kit-classes.ts';

const tokens = (value: string) => value.split(' ');
const flatten = ['[&_.ontos-card]:border-0', '[&_.ontos-card]:bg-transparent', '[&_.ontos-card]:p-0'];

describe('Calm surface classes', () => {
  it('outlines only the card level', () => {
    expect(tokens(surfaceCardClassName).includes('border')).toBe(true);
    expect(tokens(surfaceTileClassName).includes('border')).toBe(false);
  });

  it('flattens a card nested in a card or a side panel', () => {
    for (const value of [surfaceCardClassName, sidePanelSurfaceClassName]) {
      expect(flatten.every((token) => tokens(value).includes(token))).toBe(true);
    }
  });

  it('turns a tile inside a tile white', () => {
    expect(tokens(surfaceTileClassName).includes('[&_.ontos-tile]:bg-base')).toBe(true);
  });

  it('draws dividers as a light hairline', () => {
    expect(dividedListClassName).toBe('divide-y divide-border-primary/60');
  });
});
