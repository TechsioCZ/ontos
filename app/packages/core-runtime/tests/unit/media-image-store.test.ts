import { expect, it } from 'effect-rstest';
import { detectImageMimeType } from '../../src/media/media-image-contract.ts';
import { displayFilenameOf } from '../../src/media/media-image-store.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);

it('detects accepted image types from content only', () => {
  expect(detectImageMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
  expect(detectImageMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
  expect(detectImageMimeType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38))).toBe(
    'image/webp',
  );
  // SVG (script-capable), PDF and unknown content are refused whatever the filename says.
  expect(detectImageMimeType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  expect(detectImageMimeType(new TextEncoder().encode('%PDF-1.7'))).toBeUndefined();
  expect(detectImageMimeType(bytes())).toBeUndefined();
});

it('keeps a recognisable display filename without paths or control characters', () => {
  expect(displayFilenameOf(String.raw`C:\fotky\šroub M8.jpg`)).toBe('šroub M8.jpg');
  expect(displayFilenameOf('../../etc/passwd')).toBe('passwd');
  expect(displayFilenameOf('a\u0000b.png')).toBe('ab.png');
  expect(displayFilenameOf('/')).toBe('obrazek');
});
