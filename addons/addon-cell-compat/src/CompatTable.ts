export interface ICompatWidths {
  col:  0 | 1 | 2;
  mov?: number;
  del?: number;
}

export class CompatRange {
  constructor(
    public start: number,
    public end: number,
    public widths: ICompatWidths
  ) {}
}

export class CompatTable {
  constructor(public readonly ranges: ReadonlyArray<CompatRange>) {}

  public findRange(cp: number): CompatRange | undefined {
    let lo = 0;
    let hi = this.ranges.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid];
      if (cp < r.start) hi = mid - 1;
      else if (cp > r.end) lo = mid + 1;
      else return r;
    }
    return undefined;
  }

  public colWidth(cp: number): 0 | 1 | 2 {
    return this.findRange(cp)?.widths.col ?? 1;
  }
}
