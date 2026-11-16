/**
 * The question balloon the companion shows while it waits: a speech bubble with a "?", drawn from a grid of cells so it keeps
 * the room's pixel grain at any scale. `.` is clear, `#` the outline, `w` the paper and `b` the mark.
 */
const GLYPH = [".bbb.", "b...b", "....b", "...b.", "..b..", ".....", "..b.."] as const;
const BUBBLE = [
  "..#########..",
  ".#wwwwwwwww#.",
  ...Array<string>(9).fill("#wwwwwwwwwww#"),
  ".#wwwwwwwww#.",
  "..###ww####..",
  "....#w#......",
  ".....#.......",
] as const;

export const BALLOON_COLOURS = { "#": "#1e2b45", w: "#ffffff", b: "#2d5aa8" } as const;

/** The balloon's rows, with the "?" stamped on the middle of the bubble. */
export const BALLOON: readonly string[] = BUBBLE.map((row, y) => {
  const g = y - 3;
  if (g < 0 || g >= GLYPH.length) return row;
  return `${row.slice(0, 4)}${GLYPH[g]!.replaceAll(".", "w")}${row.slice(9)}`;
});

export const BALLOON_CELLS = { width: BALLOON[0]!.length, height: BALLOON.length } as const;

/**
 * Where the balloon sits against the companion's painted cell, as shares of the cell's height: its left edge from the cell's
 * middle, its width, and where its tail's tip is below the cell's top. Measured on the mockup's balloon over the rail companion.
 */
export const BALLOON_AT = { left: 0.053, width: 0.268, tip: 0.135 } as const;
