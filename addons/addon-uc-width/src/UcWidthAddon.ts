import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { UcWidthProvider } from './UcWidthProvider';

export class UcWidthAddon implements ITerminalAddon {
  private _provider?: UcWidthProvider;

  public activate(terminal: Terminal): void {
    if (!this._provider) {
      this._provider = new UcWidthProvider();
      terminal.unicode.register(this._provider);
    }
  }

  public dispose(): void { }
}