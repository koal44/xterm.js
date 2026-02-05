import { type IUnicodeVersionProvider } from '@xterm/xterm';
import { UnicodeService } from 'common/services/UnicodeService';
import { CompatTable } from './CompatTable';

export class UcVerCompatProvider implements IUnicodeVersionProvider {
  public readonly version = 'compat';
  private _table?: CompatTable;

  public setTable(t: CompatTable): void { this._table = t; }

  public wcwidth(cp: number): 0 | 1 | 2 {
    const t = this._table;
    if (!t) return 1;
    return t.colWidth(cp);
  }

  public charProperties(cp: number, preceding: number): number {
    let width = this.wcwidth(cp);
    let shouldJoin = width === 0 && preceding !== 0;

    if (shouldJoin) {
      const oldWidth = UnicodeService.extractWidth(preceding);
      if (oldWidth === 0) {
        shouldJoin = false;
      } else if (oldWidth > width) {
        width = oldWidth;
      }
    }
    return UnicodeService.createPropertyValue(0, width, shouldJoin);
  }
}

