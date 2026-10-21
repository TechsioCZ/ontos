// Ordered product gallery edits; the first image is the main one the storefront shows.

/** Moves one gallery image to a new position; position 0 is the main image the storefront shows first. */
export const moveImage = (images: readonly string[], from: number, to: number): readonly string[] => {
  const moved = images[from];
  if (moved === undefined || to < 0 || to >= images.length || from === to) {
    return images;
  }
  const rest = images.filter((_, position) => position !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
};
