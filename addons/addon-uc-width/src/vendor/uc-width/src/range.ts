/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @stylistic/member-delimiter-style */
/* eslint-disable @typescript-eslint/array-type */
/* eslint-disable @typescript-eslint/consistent-type-definitions */

import { hexToStr } from './utils.js';

export type Range = { start: number; end: number; };

export function normalizeRanges(input: readonly Range[]): Range[] {
  if (input.length === 0) return [];

  // Sort by start (then end)
  const sorted = [...input].sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const merged: Range[] = [];

  let prevStart = sorted[0].start;
  let prevEnd = sorted[0].end;
  if (prevStart > prevEnd) throw new Error(`Invalid range: start=${prevStart} > end=${prevEnd}`);

  for (let i = 1; i < sorted.length; i++) {
    const { start, end } = sorted[i];
    if (start > end) throw new Error(`Invalid range: start=${start} > end=${end}`);

    if (start <= prevEnd + 1) {
      // Overlapping or adjacent
      if (end > prevEnd) prevEnd = end;
    } else {
      // Disjoint
      merged.push({ start: prevStart, end: prevEnd });

      prevStart = start;
      prevEnd = end;
    }
  }

  merged.push({ start: prevStart, end: prevEnd });

  return merged;
}

export function subtractRanges(base: readonly Range[], mask: readonly Range[]): Range[] {
  const result: Range[] = [];

  const baseNorm = normalizeRanges(base);
  const maskNorm = normalizeRanges(mask);

  let i = 0;
  let j = 0;

  while (i < baseNorm.length && j < maskNorm.length) {
    const bi = baseNorm[i];
    const mj = maskNorm[j];

    // mask completely before base range, skip it
    if (mj.end < bi.start) {
      j++;
      continue;
    }

    // base range completely before mask, so keep it as-is
    if (bi.end < mj.start) {
      result.push({ start: bi.start, end: bi.end });
      i++;
      continue;
    }

    // --- overlap exists ---

    if (bi.start < mj.start) {
      // keep left piece
      result.push({ start: bi.start, end: mj.start - 1 });
      // shrink base to the overlapping part; next iteration will deal with [mask.start..base.end]
      bi.start = mj.start;
      continue;
    }

    // here base.start >= mask.start and we know they overlap

    if (bi.end <= mj.end) {
      // mask eats the rest of this base interval, so drop it
      i++;
      continue;
    }

    // mask chops off part of base, leaving a tail
    bi.start = mj.end + 1;
    j++;
  }

  // anything left in base after we're done removing is kept as-is
  while (i < baseNorm.length) {
    result.push(baseNorm[i++]);
  }

  return result;
}

export function intersectRanges(a: readonly Range[], b: readonly Range[]): Range[] {
  const aNorm = normalizeRanges(a);
  const bNorm = normalizeRanges(b);

  const result: Range[] = [];
  let i = 0;
  let j = 0;

  while (i < aNorm.length && j < bNorm.length) {
    const ai = aNorm[i];
    const bj = bNorm[j];

    const start = Math.max(ai.start, bj.start);
    const end = Math.min(ai.end, bj.end);

    if (start <= end) {
      result.push({ start, end });
    }

    // Advance the one that ends first
    if (ai.end < bj.end) {
      i++;
    } else {
      j++;
    }
  }

  return result;
}

export class RangeTable {
  private _ranges: Range[] = [];
  private _minStart: number = Number.MAX_SAFE_INTEGER;
  private _maxEnd: number = Number.MIN_SAFE_INTEGER;

  constructor(ranges: readonly Range[]) {
    const sorted = [...ranges].sort((a, b) => (a.start - b.start) || (a.end - b.end));
    for (const { start, end } of sorted) {
      this.addRange(start, end);
    }
  }

  private addRange(start: number, end: number): void {
    if (start > end) {
      throw new Error(`Invalid range: start=${hexToStr(start)} > end=${hexToStr(end)}`);
    }

    // overlap
    if (start <= this._maxEnd) {
      // fully contained
      if (end <= this._maxEnd) return;

      // extend previous range
      this._ranges[this._ranges.length - 1].end = end;
      this._maxEnd = end;
      return;
    }

    this._ranges.push({ start, end });

    this._minStart = Math.min(this._minStart, start);
    this._maxEnd = Math.max(this._maxEnd, end);
  }

  public has(cp?: number): boolean {
    if (!this._ranges.length || (cp === undefined) || cp < this._minStart || cp > this._maxEnd) {
      return false;
    }

    let lo = 0;
    let hi = this._ranges.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const { start, end } = this._ranges[mid];

      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return true;
    }

    return false;
  }
}
