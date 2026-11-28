import type { TagColor } from '../../shared/apis/records.ts';

/** The kit's tag colour class behind each stored colour name. The UI shows the dot; the name is what is stored. */
export const tagColorClass = {
  blue: 'bg-tag-blue',
  gray: 'bg-tag-gray',
  green: 'bg-tag-green',
  orange: 'bg-tag-orange',
  pink: 'bg-tag-pink',
  purple: 'bg-tag-purple',
  red: 'bg-tag-red',
  yellow: 'bg-tag-yellow',
} satisfies Record<TagColor, string>;
