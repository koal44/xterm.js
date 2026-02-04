import { IMeasuredRange, MeasuredWidths } from 'components/window/widthExplorer/measuredTable';

export class BrowserStorage {

  constructor(private _tableName: string) {}

  public saveRanges(ranges: IMeasuredRange[]): void {
    const key = this._getCompatStorageKey(this._tableName);

    const normalized = ranges.map(r => ({
      start: r.start,
      end: r.end,
      widths: r.widths && {
        col: Number.isNaN(r.widths.col as any) ? null : r.widths.col ?? undefined,
        mov: Number.isNaN(r.widths.mov as any) ? null : r.widths.mov ?? undefined,
        del: Number.isNaN(r.widths.del as any) ? null : r.widths.del ?? undefined,
      }
    }));

    localStorage.setItem(key, JSON.stringify(normalized));
  }

  public loadRanges(): IMeasuredRange[] | undefined {
    const key = this._getCompatStorageKey(this._tableName);
    const s = localStorage.getItem(key);
    if (!s) return undefined;

    let parsed: any;
    try { parsed = JSON.parse(s); } catch { return undefined; }

    return this._reviveRanges(parsed) ?? undefined;
  }

  public clearRanges(): void {
    const key = this._getCompatStorageKey(this._tableName);
    localStorage.removeItem(key);
  }

  private _reviveNumber(v: unknown): number | undefined {
    if (v === null) return NaN;               // null came from NaN
    if (typeof v === 'number') return v;
    return undefined;                         // missing or garbage => undefined
  }

  private _reviveWidths(w: any): MeasuredWidths | undefined {
    if (!w || typeof w !== 'object') return undefined;
    const col = this._reviveNumber(w.col);
    const mov = this._reviveNumber(w.mov);
    const del = this._reviveNumber(w.del);

    // If all are undefined, treat as absent
    if (col === undefined && mov === undefined && del === undefined) return undefined;

    const out: MeasuredWidths = new MeasuredWidths(col, mov, del);
    return out;
  }

  private _reviveRanges(raw: any): IMeasuredRange[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: IMeasuredRange[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const start = (r as any).start;
      const end = (r as any).end;
      if (typeof start !== 'number' || typeof end !== 'number') continue;

      const widths = this._reviveWidths((r as any).widths);
      out.push(widths ? { start, end, widths } : { start, end });
    }
    return out;
  }

  private _getCompatStorageKey(profileId: string): string {
    return `xterm-width-explorer:compat:${profileId}`;
  }
}