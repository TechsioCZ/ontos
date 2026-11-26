// @rstest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, rs } from 'effect-rstest';
import {
  isChunkLoadFailure,
  recoverFromStaleBuild,
  reloadOnceForStaleBuild,
} from '../../src/routes/stale-build-recovery.tsx';

beforeEach(() => {
  globalThis.sessionStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  rs.restoreAllMocks();
  document.body.replaceChildren();
});

describe('stale build recovery', () => {
  it.each([
    new Error('Loading chunk 42 failed'),
    new TypeError('Failed to fetch dynamically imported module'),
    { name: 'ChunkLoadError' },
    { message: 'Federation Runtime: RUNTIME-001' },
    'Unable to preload CSS',
  ])('recognizes a browser chunk failure: %j', (failure) => {
    expect(isChunkLoadFailure(failure)).toBe(true);
  });

  it('rejects malformed error properties without coercing arbitrary objects', () => {
    const stringify = rs.fn(() => 'ChunkLoadError');
    expect(isChunkLoadFailure({ name: { toString: stringify } })).toBe(false);
    expect(stringify).not.toHaveBeenCalled();
    expect(isChunkLoadFailure(null)).toBe(false);
    expect(isChunkLoadFailure(new Error('Permission denied'))).toBe(false);
  });

  it('reloads only once within the guard window and permits recovery after it expires', () => {
    const reload = rs.spyOn(globalThis.location, 'reload').mockImplementation(() => {});
    expect(reloadOnceForStaleBuild()).toBe(true);
    expect(reloadOnceForStaleBuild()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    globalThis.sessionStorage.setItem('ontos:stale-build-reload-at', '0');
    expect(reloadOnceForStaleBuild()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('defers automatic recovery while a person is editing an input', () => {
    const reload = rs.spyOn(globalThis.location, 'reload').mockImplementation(() => {});
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    recoverFromStaleBuild();
    expect(reload).not.toHaveBeenCalled();
    input.remove();
    recoverFromStaleBuild();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
