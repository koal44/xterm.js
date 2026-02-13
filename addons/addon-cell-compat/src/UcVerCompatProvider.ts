import { type IUnicodeVersionProvider } from '@xterm/xterm';
import { ucWidthOptions, ucWidthStep } from './vendor/uc-width/src/index';
import { CompatTable } from './CompatTable';
import { getAppWidth, getUc17State, getVisWidth, packProps, packUc17State, unpackUc17State } from 'abi';

export class UcVerCompatProvider implements IUnicodeVersionProvider {
  public readonly version = 'compat';

  public static ucWidthOpts = ucWidthOptions({ vs15: 2 });
  private _table?: CompatTable;

  public setTable(t: CompatTable): void {
    this._table = t;
  }

  public wcwidth(cp: number): 0|1|2 {
    const t = this._table;
    if (!t) return 1;
    return t.colWidth(cp);
  }

  public charProperties(cp: number, preceding: number): number {
    // --- Compat (app model) ---
    const r = this._table?.findRange(cp);
    let   appWidth: 0|1|2 = r?.widths.col ?? 1;
    const movWidth: 0|1|2 = r?.widths.mov ?? 1;
    const delWidth: 0|1|2 = r?.widths.del ?? 1;

    let appJoin = appWidth === 0 && preceding !== 0;

    if (appJoin) {
      const oldAppWidth = getAppWidth(preceding);
      if (oldAppWidth === 0) {
        appJoin = false;
      } else if (oldAppWidth > appWidth) {
        appWidth = oldAppWidth;
      }
    }

    // --- Visual (UC17 / uc-width model) ---
    const prevVisWidth = preceding ? getVisWidth(preceding) : 0;
    const prevUc17 = preceding ? getUc17State(preceding) : 0;

    const inState = unpackUc17State(prevUc17, prevVisWidth);
    const { shouldJoin: visJoin, clusterWidth: visWidth, state: nextState } =
      ucWidthStep(cp, UcVerCompatProvider.ucWidthOpts, inState);

    const uc17State = packUc17State(nextState);

    return packProps({
      appJoin,
      appWidth,
      movWidth,
      delWidth,
      visJoin,
      visWidth,
      uc17State,
    });
  }
}
