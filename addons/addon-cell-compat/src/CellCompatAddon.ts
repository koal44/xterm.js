import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { UcVerCompatProvider } from './UcVerCompatProvider';
import { CompatTable, CompatRange } from 'CompatTable';

type W3 = 0 | 1 | 2;

export class CellCompatAddon implements ITerminalAddon {
  private _provider?: UcVerCompatProvider;

  public activate(terminal: Terminal): void {
    if (!this._provider) {
      this._provider = new UcVerCompatProvider();
      terminal.unicode.register(this._provider);
    }
  }

  public dispose(): void { }

  public loadCompatTable(table: { ranges: { start: number, end: number, widths?: { col?: number, mov?: number, del?: number } }[] }): void {
    if (!this._provider) throw new Error('CellCompatAddon not activated');

    this._provider.setTable(new CompatTable(table.ranges.map(r => {
      const w = r.widths;

      const col = w?.col;
      const mov = w?.mov;
      const del = w?.del;

      const colW: W3 = col === undefined ? 1 : col <= 0 ? 0 : col === 1 ? 1 : 2;
      const movW: W3 = mov === undefined ? 1 : mov <= 0 ? 0 : mov === 1 ? 1 : 2;
      const delW: W3 = del === undefined ? 1 : del <= 0 ? 0 : del === 1 ? 1 : 2;

      return new CompatRange(
        r.start,
        r.end,
        { col: colW, mov: movW, del: delW }
      );
    })));
  }

}