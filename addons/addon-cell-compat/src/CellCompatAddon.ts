import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { UcVerCompatProvider } from './UcVerCompatProvider';
import { CompatTable, CompatRange } from 'CompatTable';

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
      return new CompatRange(
        r.start,
        r.end,
        {
          col: r.widths?.col as 0|1|2|undefined ?? 1,
          mov: r.widths?.mov,
          del: r.widths?.del
        }
      );
    })));
  }
}