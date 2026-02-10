import { hexToStr } from 'components/window/widthExplorer/stringUtil';

export class MeasuredWidths {
  public col?: number;
  public mov?: number;
  public del?: number;

  constructor(col?: number, mov?: number, del?: number) {
    this.col = col;
    this.mov = mov;
    this.del = del;
  }

  public static equal(a?: MeasuredWidths, b?: MeasuredWidths): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (!Object.is(a.col, b.col)) return false;
    if (!Object.is(a.mov, b.mov)) return false;
    if (!Object.is(a.del, b.del)) return false;
    return true;
  }
}

export interface IMeasuredRange { start: number, end: number, widths?: MeasuredWidths }
export type CanMergeRangeFn = (last: IMeasuredRange, next: IMeasuredRange) => boolean;

export class MeasuredTable {
  public ranges: IMeasuredRange[] = [];
  private static _canMergeFn: CanMergeRangeFn = (last, next) => MeasuredWidths.equal(last.widths, next.widths);

  constructor(public label: string, initialRanges: IMeasuredRange[] = []) {
    for (const r of initialRanges) {
      this.addRange(r);
    }
  }

  // public get ranges(): ReadonlyArray<IMeasuredRange> { return this._ranges; }

  public clear(): void { this.ranges.length = 0; }

  public add(cp: number, m: MeasuredWidths = {}, canMergeAdjacent = MeasuredTable._canMergeFn): void {
    const last = this.ranges[this.ranges.length - 1];
    const next = { start: cp, end: cp, widths: { ...m } };
    if (!last) {
      this.ranges.push(next);
      return;
    }

    if (cp <= last.end) throw new Error(`RangeTable.add: ${cp} out-of-order or duplicate`);

    if (cp === last.end + 1 && canMergeAdjacent(last, next)) {
      last.end = cp;
      return;
    }
    this.ranges.push(next);
  }

  public addRange(next: IMeasuredRange, canMergeAdjacent = MeasuredTable._canMergeFn): void {
    const { start, end, widths: w } = next;
    if (start > end) throw new Error(`addRange invalid ${start}..${end}`);

    const last = this.ranges[this.ranges.length - 1];
    if (!last) {
      this.ranges.push({ start, end, widths: w ? { ...w } : undefined });
      return;
    }

    if (start <= last.end) throw new Error(`RangeTable.addRange: ${start}..${end} out-of-order or overlapping`);

    if (next.start === last.end + 1 && canMergeAdjacent(last, next)) {
      last.end = next.end;
      return;
    }

    this.ranges.push({ start, end, widths: w ? { ...w } : undefined });
  }

  public upsertRange(x: IMeasuredRange, canMergeAdjacent: CanMergeRangeFn = MeasuredTable._canMergeFn): void {
    const { start: xs, end: xe, widths: xw } = x;
    if (xs > xe) throw new Error(`upsertRange invalid ${xs}..${xe}`);

    const out: IMeasuredRange[] = [];
    let inserted = false;

    const push = (r: IMeasuredRange): void => {
      const last = out[out.length - 1];
      if (last && last.end + 1 === r.start && canMergeAdjacent(last, r)) {
        last.end = r.end; // merge
        return;
      }
      out.push({ start: r.start, end: r.end, widths: r.widths ? { ...r.widths } : undefined });
    };

    const paint: IMeasuredRange = { start: xs, end: xe, widths: xw ? { ...xw } : undefined };

    for (const r of this.ranges) {
      // r fully left of x
      if (r.end < xs) {
        push(r);
        continue;
      }

      // r fully right of x
      if (r.start > xe) {
        if (!inserted) {
          push(paint);
          inserted = true;
        }
        push(r);
        continue;
      }

      // overlap: keep left remainder
      if (r.start < xs) {
        push({ start: r.start, end: xs - 1, widths: r.widths });
      }

      // overlap: keep right remainder
      if (r.end > xe) {
        if (!inserted) {
          push(paint);
          inserted = true;
        }
        push({ start: xe + 1, end: r.end, widths: r.widths });
      }
      // fully covered middle is dropped (painted over)
    }

    if (!inserted) {
      push(paint);
    }

    // mutate in place
    this.ranges.length = 0;
    this.ranges.push(...out);
  }

  public toStr(): string {
    const out: string[] = [];

    const cpCount = this.ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    out.push(`// [ranges=${this.ranges.length}; codePoints=${cpCount}]`);
    out.push(`const ${this.label}: IMeasuredRange[] = [`);

    for (const { start, end, widths: m } of this.ranges) {
      const sHex = hexToStr(start);
      const eHex = hexToStr(end);

      const fields: string[] = [];
      if (m.col !== undefined) fields.push(`col: ${m.col}`);
      if (m.mov !== undefined) fields.push(`mov: ${m.mov}`);
      if (m.del !== undefined) fields.push(`del: ${m.del}`);

      const meas = fields.length ? `{ ${fields.join(', ')} }` : `{}`;
      out.push(`  { start: ${sHex}, end: ${eHex}, widths: ${meas} },`);
    }

    out.push('];');
    out.push('');
    return out.join('\n');
  }

  public has(cp?: number): boolean {
    if (!this.ranges.length || (cp === undefined)) {
      return false;
    }

    let lo = 0;
    let hi = this.ranges.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const { start, end } = this.ranges[mid];

      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return true;
    }

    return false;
  }
}

export const DEFAULT_MEASURED_TABLE: MeasuredTable = new MeasuredTable(
  'default',
  [{ start: 0x0, end: 0x10ffff, widths: { col: 1, mov: 1, del: 1 } }]
);