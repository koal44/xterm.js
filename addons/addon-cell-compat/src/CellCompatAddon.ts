import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { UcVerCompatProvider } from './UcVerCompatProvider';

export class CellCompatAddon implements ITerminalAddon {
  private _provider?: UcVerCompatProvider;

  public activate(terminal: Terminal): void {
    if (!this._provider) {
      this._provider = new UcVerCompatProvider();
      terminal.unicode.register(this._provider);
    }
  }

  public dispose(): void { }
}