export class PaginationError extends Error {}

export interface Capacity {
  first: number;
  rest: number;
}

/** Greedy fill. Items are never split; splitting a long section by bullets is a later plan. */
export function paginate(heights: number[], cap: Capacity): number[][] {
  const pages: number[][] = [[]];
  let used = 0;
  let limit = cap.first;
  heights.forEach((h, i) => {
    if (!(h >= 0)) throw new PaginationError(`Item ${i} has an invalid height: ${h}`);
    if (used + h > limit && pages[pages.length - 1].length > 0) {
      pages.push([]);
      used = 0;
      limit = cap.rest;
    }
    if (h > limit) {
      throw new PaginationError(`Item ${i} is ${Math.round(h)}px tall but a page holds ${Math.round(limit)}px`);
    }
    pages[pages.length - 1].push(i);
    used += h;
  });
  return pages;
}
