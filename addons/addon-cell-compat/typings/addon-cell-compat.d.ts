/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Terminal, ITerminalAddon } from '@xterm/xterm';

declare module '@xterm/addon-cell-compat' {
  export class CellCompatAddon implements ITerminalAddon {
    constructor();
    public activate(terminal: Terminal): void;
    public dispose(): void;
    public loadCompatTable(table: { ranges: { start: number, end: number, widths?: { col?: number, mov?: number, del?: number } }[] }): void;
    public setEnable(enable: boolean, term: Terminal): void;
    public setUseUc17(enable: boolean): void;
  }
}
