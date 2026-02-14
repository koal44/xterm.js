/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { BaseWindow } from './baseWindow';
import type { IControlWindow } from '../controlBar';

export class CellInspectorWindow extends BaseWindow implements IControlWindow {
  public readonly id = 'cell-inspector';
  public readonly label = 'Cell Inspector';

  private _container: HTMLElement;
  private _positionEl: HTMLElement;
  private _visualEl: HTMLElement;
  private _spanEl: HTMLElement;
  private _cellsEl: HTMLElement;

  public build(container: HTMLElement): void {
    this._container = container;

    const dl = document.createElement('dl');
    dl.style.fontFamily = 'monospace';
    dl.style.fontSize = '12px';

    this._positionEl = this._addRow(dl, 'Position');
    this._visualEl = this._addRow(dl, 'Visual');
    this._spanEl = this._addRow(dl, 'App span');
    this._cellsEl = this._addRow(dl, 'Cells');

    this._cellsEl.style.whiteSpace = 'pre';

    container.appendChild(dl);

    // Add mouse move listener
    this._setupMouseListener();
  }

  private _addRow(dl: HTMLElement, label: string): HTMLElement {
    const dt = document.createElement('dt');
    dt.textContent = label;
    dt.style.fontWeight = 'bold';
    dt.style.marginTop = '4px';
    dl.appendChild(dt);

    const dd = document.createElement('dd');
    dd.textContent = '-';
    dd.style.margin = '0 0 0 16px';
    dl.appendChild(dd);

    return dd;
  }

  private _setupMouseListener(): void {
    const terminal = this._terminal;
    if (!terminal.element) {
      return;
    }

    terminal.element.addEventListener('mousemove', (e: MouseEvent) => {
      const core = (terminal as any)._core;
      const coords = core._mouseService?.getCoords(e, core.screenElement, terminal.cols, terminal.rows);
      if (!coords) {
        this._clearDisplay();
        return;
      }

      const x = coords[0] - 1;
      const y = coords[1] - 1;
      const bufferY = terminal.buffer.active.viewportY + y;

      const line = terminal.buffer.active.getLine(bufferY);
      if (!line) {
        this._clearDisplay();
        return;
      }

      const lineRaw = (line as any)._line;
      if (!lineRaw?.inspectVisual) {
        console.warn('Line does not support inspectVisual');
        this._clearDisplay();
        return;
      }

      const appX = lineRaw?.visToAppIndex(x)[0] ?? x;

      const info = lineRaw.inspectVisual(appX) as { start: number, end: number, text: string, cells: string[] };
      if (!info) {
        this._clearDisplay();
        return;
      }

      this._updateDisplay(x, y, bufferY, appX, info);
    });

    terminal.element.addEventListener('mouseleave', () => {
      this._clearDisplay();
    });
  }

  private _clearDisplay(): void {
    this._positionEl.textContent = '-';
    this._visualEl.textContent = '-';
    this._spanEl.textContent = '-';
    this._cellsEl.textContent = '-';
  }

  private _updateDisplay(
    x: number,
    y: number,
    bufferY: number,
    appX: number,
    info: { start: number, end: number, text: string, cells: string[] }
  ): void {
    // Position
    this._positionEl.textContent = `x=${x}, y=${y} (buffer: ${bufferY}), appX=${appX}`;

    // Visual string
    this._visualEl.textContent = info.text && info.text.length > 0 ? `"${info.text}"` : '(empty)';

    // App span of the cluster
    this._spanEl.textContent = info.start === info.end ? `${info.start}` : `${info.start}..${info.end}`;

    // Per-cell dumps
    const sep = '\n---\n';
    this._cellsEl.textContent = info.cells.length ? info.cells.join(sep) : '(none)';
  }

}
