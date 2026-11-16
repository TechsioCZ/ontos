import type { TagColor } from '../../shared/apis/records.ts';

/** Hex values behind the stored colour names. The UI shows the dot; the name is what is stored. */
export const tagColorValue = {
  blue: '#2563eb',
  gray: '#6b7280',
  green: '#16a34a',
  orange: '#ea580c',
  pink: '#db2777',
  purple: '#9333ea',
  red: '#dc2626',
  yellow: '#ca8a04',
} satisfies Record<TagColor, string>;
