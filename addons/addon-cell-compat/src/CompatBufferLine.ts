/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// TODO: Move cluster visWidth ownership to the visual root to avoid end-scan/tail skipping.

import { IAttributeData, IBufferLine, ICellData, IExtendedAttrs } from 'common/Types';
import { AppCellData } from './AppCellData';
import { Attributes, BgFlags, NULL_CELL_CHAR, NULL_CELL_CODE, NULL_CELL_WIDTH, TAIL_CELL_CODE, TAIL_CELL_WIDTH, WHITESPACE_CELL_CHAR, WHITESPACE_CELL_WIDTH } from 'common/buffer/Constants';
import { stringFromCodePoint } from 'common/input/TextDecoder';
import { RenderCell } from 'common/buffer/RenderCell';
import { DEFAULT_ATTR_DATA } from 'common/buffer/AttributeData';
import * as abi from 'abi';
import { UcWidthState, ucWidthStep } from 'vendor/uc-width/src';
import { UcVerCompatProvider } from 'UcVerCompatProvider';

/**
 * Buffer memory layout
 *
 * 3 consecutive uint32:
 *
 * CONTENT := _data[i*3 + 0]
 * FG      := _data[i*3 + 1]
 * BG      := _data[i*3 + 2]
 *
 *
 * CONTENT
 *
 *     31     30       29..28     27..26     25..24     23..22     21      20..0
 *  +-----+---------+----------+----------+----------+----------+------+-----------+
 *  | RSV | visJoin | visWidth | delWidth | movWidth | appWidth | comb | codepoint |
 *  +-----+---------+----------+----------+----------+----------+------+-----------+
 *
 * - visJoin: whether this cell is the root of a visual cluster (e.g. UC17 grapheme root)
 * - visWidth: visual width used by the renderer (0..2; 3 reserved)
 * - delWidth: number of DEL keystrokes to delete this cell (0..2; 3 => sideloaded)
 * - movWidth: number of cursor moves to traverse this cell (0..2; 3 => sideloaded)
 * - appWidth: width the backend application assigns to this cell (wcwidth-aligned)
 * - comb: whether the cell contains a combined string (chars stored out-of-band in `_combined`)
 * - codepoint: UTF-32 codepoint for single-char cells (0 if empty or combined)
 */

/** typed array slots taken by one cell */
const CELL_SIZE = 3;

/**
 * Cell member indices.
 *
 * Direct access:
 *    `content = data[column * CELL_SIZE + Cell.CONTENT];`
 *    `fg = data[column * CELL_SIZE + Cell.FG];`
 *    `bg = data[column * CELL_SIZE + Cell.BG];`
 */
const enum Cell {
  CONTENT = 0,
  FG = 1, // currently simply holds all known attrs
  BG = 2  // currently unused
}

/** Factor when to cleanup underlying array buffer after shrinking. */
const CLEANUP_THRESHOLD = 2;

/**
 * Typed array based bufferline implementation.
 *
 * There are 2 ways to insert data into the cell buffer:
 * - `setCellFromCodepoint` + `addCodepointToCell`
 *   Use these for data that is already UTF32.
 *   Used during normal input in `InputHandler` for faster buffer access.
 * - `setCell`
 *   This method takes a CellData object and stores the data in the buffer.
 *
 * To retrieve data from the buffer use either one of the primitive methods
 * (if only one particular value is needed) or `loadCell`. For `loadCell` in a loop
 * memory allocs / GC pressure can be greatly reduced by reusing the CellData object.
 */
export class CompatBufferLine implements IBufferLine {
  protected _data: Uint32Array;
  protected _combined: {[index: number]: string} = {};
  protected _extendedAttrs: {[index: number]: IExtendedAttrs | undefined} = {};
  public length: number;
  private _sideloadMovWidths: {[index: number]: number} = {};
  private _sideloadDelWidths: {[index: number]: number} = {};

  constructor(cols: number, nullFillAttr?: IAttributeData, public isWrapped: boolean = false) {
    this._data = new Uint32Array(cols * CELL_SIZE);
    const cell = this.getNullCell(nullFillAttr);
    for (let i = 0; i < cols; ++i) {
      this.setCell(i, cell);
    }
    this.length = cols;
  }

  /**
   * primitive getters
   * use these when only one value is needed, otherwise use `loadCell`
   */

  private _getContent(index: number): number {
    return this._data[index * CELL_SIZE + Cell.CONTENT];
  }

  public getWidth(index: number): number {
    return AppCellData.appWidth(this._getContent(index));
  }

  /** Test whether content has width. */
  public hasWidth(index: number): boolean {
    return !!AppCellData.appWidth(this._getContent(index));
  }

  public getMovWidth(index: number): number {
    const content = this._getContent(index);
    const mw = AppCellData.movWidth(content);
    if (mw !== 3) return mw;

    const v = this._sideloadMovWidths[index];
    if (v === undefined) {
      // TODO: remove after testing
      throw new Error(`[CompatBufferLine] missing sideload movWidth at ${index} content=0x${content.toString(16)}`);
    }
    return v;
  }

  public getDelWidth(index: number): number {
    const content = this._getContent(index);
    const dw = AppCellData.delWidth(content);
    if (dw !== 3) return dw;

    const v = this._sideloadDelWidths[index];
    if (v === undefined) {
      // TODO: remove after testing
      throw new Error(`[CompatBufferLine] missing sideload delWidth at ${index} content=0x${content.toString(16)}`);
    }
    return v;
  }

  public getVisWidth(index: number): number {
    return AppCellData.visWidth(this._getContent(index));
  }

  public getVisJoin(index: number): boolean {
    return AppCellData.visJoin(this._getContent(index));
  }

  /** Get FG cell component. */
  public getFg(index: number): number {
    return this._data[index * CELL_SIZE + Cell.FG];
  }

  /** Get BG cell component. */
  public getBg(index: number): number {
    return this._data[index * CELL_SIZE + Cell.BG];
  }

  /** Get state of protected flag. */
  public isProtected(index: number): number {
    return this.getBg(index) & BgFlags.PROTECTED;
  }

  /**
   * Test whether contains any chars.
   * Basically an empty has no content, but other cells might differ in FG/BG
   * from real empty cells.
   */
  public hasContent(index: number): boolean {
    return AppCellData.hasContent(this._getContent(index));
  }

  /** Test whether the cell contains a combined string. */
  public isCombined(index: number): boolean {
    return AppCellData.isCombined(this._getContent(index));
  }

  /**
   * Get codepoint of the cell.
   * To be in line with `code` in CharData this either returns
   * a single UTF32 codepoint or the last codepoint of a combined string.
   */
  public getCodePoint(index: number): number {
    // TODO: returning sometimes utf16 and sometimes utf32 is surprising. fix?
    const content = this._getContent(index);
    if (AppCellData.isCombined(content)) {
      return this._combined[index].charCodeAt(this._combined[index].length - 1);
    }
    return AppCellData.codepoint(content);
  }

  /** Returns the string content of the cell. */
  public getString(index: number): string {
    const content = this._getContent(index);
    if (AppCellData.isCombined(content)) {
      return this._combined[index];
    }
    const cp = AppCellData.codepoint(content);
    return cp ? stringFromCodePoint(cp) : '';
  }

  /**
   * Load data at `index` into `cell`. This is used to access cells in a way that's more friendly
   * to GC as it significantly reduced the amount of new objects/references needed.
   */
  public loadCell(index: number, cell: ICellData): ICellData {
    const i = index * CELL_SIZE;
    cell.content = this._data[i + Cell.CONTENT];
    cell.fg = this._data[i + Cell.FG];
    cell.bg = this._data[i + Cell.BG];

    cell.combinedData = cell.isCombined() ? this._combined[index] : '';

    const ext = (cell.bg & BgFlags.HAS_EXTENDED) ? this._extendedAttrs[index]! : undefined;
    cell.extended.ext = ext ? ext.ext : 0;
    cell.extended.urlId = ext ? ext.urlId : 0;

    if (cell instanceof AppCellData) {
      cell.sideloadMovWidth = this.getMovWidth(index);
      cell.sideloadDelWidth = this.getDelWidth(index);
    }
    return cell;
  }

  public loadRenderCell(index: number, cell: RenderCell): void {
    const i = index * CELL_SIZE;

    const fg = this._data[i + Cell.FG];
    cell.fg = fg;
    const bg = this._data[i + Cell.BG];
    cell.bg = bg;
    const ext = (bg & BgFlags.HAS_EXTENDED) ? this._extendedAttrs[index] : undefined;
    cell.extended.ext = ext ? ext.ext : 0;
    cell.extended.urlId = ext ? ext.urlId : 0;

    cell.charJoined = false;

    const content = this._data[i + Cell.CONTENT];
    const width = AppCellData.appWidth(content);
    cell.width = width;
    cell.visWidth = AppCellData.visWidth(content);
    cell.visJoin = AppCellData.visJoin(content);
    const cp = AppCellData.codepoint(content);
    // cell.codepoint = cp;
    const isCombined = AppCellData.isCombined(content);
    const chars = isCombined ? (this._combined[index] ?? '') : (cp ? stringFromCodePoint(cp) : '');
    cell.chars = chars;
    cell.code = isCombined ? (chars ? chars.charCodeAt(chars.length - 1) : 0) : cp;
  }

  /**
   * Set data at `index` to `cell`.
   */
  public setCell(index: number, cell: ICellData): void {
    if (cell.isCombined()) this._combined[index] = cell.combinedData;
    else delete this._combined[index];

    if (cell.bg & BgFlags.HAS_EXTENDED) this._extendedAttrs[index] = cell.extended.clone();
    else delete this._extendedAttrs[index];

    if (cell instanceof AppCellData) {
      if (AppCellData.movWidth(cell.content) === 3) this._sideloadMovWidths[index] = cell.sideloadMovWidth;
      else delete this._sideloadMovWidths[index];

      if (AppCellData.delWidth(cell.content) === 3) this._sideloadDelWidths[index] = cell.sideloadDelWidth;
      else delete this._sideloadDelWidths[index];
    }

    const i = index * CELL_SIZE;
    this._data[i + Cell.CONTENT] = cell.content;
    this._data[i + Cell.FG] = cell.fg;
    this._data[i + Cell.BG] = cell.bg;
  }

  public setCellToNull(index: number, attr: IAttributeData = DEFAULT_ATTR_DATA): void {
    this.setCellFromCodepoint(index, NULL_CELL_CODE, NULL_CELL_WIDTH, attr, abi.NULL_CELL_PROPS);
  }

  public setCellToTail(index: number, attr: IAttributeData = DEFAULT_ATTR_DATA): void {
    this.setCellFromCodepoint(index, TAIL_CELL_CODE, TAIL_CELL_WIDTH, attr, abi.TAIL_CELL_PROPS);
  }

  /**
   * Set cell data from input handler.
   * Since the input handler see the incoming chars as UTF32 codepoints,
   * it gets an optimized access method.
   */
  public setCellFromCodepoint(index: number, cp: number, width: 0|1|2, attr: IAttributeData, props?: number): void {
    if (props === undefined) {
      throw new Error('props is required for setCellFromCodepoint in CompatBufferLine');
    }

    if (attr.bg & BgFlags.HAS_EXTENDED) this._extendedAttrs[index] = attr.extended;
    else delete this._extendedAttrs[index];

    delete this._combined[index];
    delete this._sideloadMovWidths[index];
    delete this._sideloadDelWidths[index];

    const content = AppCellData.packContent(
      cp,
      false, // combined
      abi.getAppWidth(props),
      abi.getMovWidth(props),
      abi.getDelWidth(props),
      abi.getVisWidth(props),
      abi.getVisJoin(props)
    );

    const i = index * CELL_SIZE;
    this._data[i + Cell.CONTENT] = content;
    this._data[i + Cell.FG] = attr.fg;
    this._data[i + Cell.BG] = attr.bg;
  }

  /**
   * Add a codepoint to a cell from input handler.
   * During input stage combining chars with a width of 0 follow and stack
   * onto a leading char. Since we already set the attrs
   * by the previous `setDataFromCodePoint` call, we can omit it here.
   */
  public addCodepointToCell(index: number, codePoint: number, width: 0|1|2, props?: number): void {
    if (props === undefined) {
      throw new Error('props is required for addCodepointToCell in CompatBufferLine');
    }

    if (this.isNullCell(index) || this.isTailCell(index)) {
      // Should have been handled in the print handler
      throw new Error(`[CompatBufferLine] addCodepointToCell on invalid cell at ${index} (null/tail)`);
    }

    const i = index * CELL_SIZE + Cell.CONTENT;
    const content = this._data[i];

    // Extend combined string (must exist if already combined).
    this._combined[index] = AppCellData.isCombined(content)
      ? this._combined[index] + stringFromCodePoint(codePoint)
      : stringFromCodePoint(AppCellData.codepoint(content)) + stringFromCodePoint(codePoint);

    // mov/del accumulate; app/vis are already carried forward by the provider in props.
    const nextMov = this.getMovWidth(index) + abi.getMovWidth(props);
    const nextDel = this.getDelWidth(index) + abi.getDelWidth(props);

    if (nextMov > 2) this._sideloadMovWidths[index] = nextMov;
    else delete this._sideloadMovWidths[index];

    if (nextDel > 2) this._sideloadDelWidths[index] = nextDel;
    else delete this._sideloadDelWidths[index];

    this._data[i] = AppCellData.packContent(
      0, // codepoint
      true, // combined
      abi.getAppWidth(props),
      nextMov > 2 ? 3 : nextMov,
      nextDel > 2 ? 3 : nextDel,
      abi.getVisWidth(props),
      AppCellData.visJoin(content),
    );
  }

  public insertNullFill(pos: number, n: number, fillAttr: IAttributeData): void {
    pos %= this.length;
    const fill = this.getNullCell(fillAttr);

    // handle fullwidth at pos: reset cell one to the left if pos is second cell of a wide char
    if (pos && this.getWidth(pos - 1) === 2) {
      this.setCell(pos - 1, fill);
    }

    if (n < this.length - pos) {
      const cell = new AppCellData();
      for (let i = this.length - pos - n - 1; i >= 0; --i) {
        this.setCell(pos + n + i, this.loadCell(pos + i, cell));
      }
      for (let i = 0; i < n; ++i) {
        this.setCell(pos + i, fill);
      }
    } else {
      for (let i = pos; i < this.length; ++i) {
        this.setCell(i, fill);
      }
    }

    // handle fullwidth at line end: reset last cell if it is first cell of a wide char
    if (this.getWidth(this.length - 1) === 2) {
      this.setCell(this.length - 1, fill);
    }
  }

  public deleteNullFill(pos: number, n: number, fillAttr: IAttributeData): void {
    pos %= this.length;
    const fill = this.getNullCell(fillAttr);

    if (n < this.length - pos) {
      const cell = new AppCellData();
      for (let i = 0; i < this.length - pos - n; ++i) {
        this.setCell(pos + i, this.loadCell(pos + n + i, cell));
      }
      for (let i = this.length - n; i < this.length; ++i) {
        this.setCell(i, fill);
      }
    } else {
      for (let i = pos; i < this.length; ++i) {
        this.setCell(i, fill);
      }
    }

    // handle fullwidth at pos:
    // - reset pos-1 if wide char
    // - reset pos if width==0 (previous second cell of a wide char)
    if (pos && this.getWidth(pos - 1) === 2) {
      this.setCell(pos - 1, fill);
    }
    if (this.isTailCell(pos)) {
      this.setCell(pos, fill);
    }
  }

  public replaceNullFill(start: number, end: number, fillAttr: IAttributeData, respectProtect: boolean = false): void {
    const fill = this.getNullCell(fillAttr);

    // full branching on respectProtect==true, hopefully getting fast JIT for standard case
    if (respectProtect) {
      if (start && this.getWidth(start - 1) === 2 && !this.isProtected(start - 1)) {
        this.setCell(start - 1, fill);
      }
      if (end < this.length && this.getWidth(end - 1) === 2 && !this.isProtected(end)) {
        this.setCell(end, fill);
      }
      while (start < end && start < this.length) {
        if (!this.isProtected(start)) {
          this.setCell(start, fill);
        }
        start++;
      }
      return;
    }

    // handle fullwidth at start: reset cell one to the left if start is second cell of a wide char
    if (start && this.getWidth(start - 1) === 2) {
      this.setCell(start - 1, fill);
    }
    // handle fullwidth at last cell + 1: reset to empty cell if it is second part of a wide char
    if (end < this.length && this.getWidth(end - 1) === 2) {
      this.setCell(end, fill);
    }

    while (start < end && start < this.length) {
      this.setCell(start++, fill);
    }
  }


  /**
   * Resize BufferLine to `cols` filling excess cells with `fillCellData`.
   * The underlying array buffer will not change if there is still enough space
   * to hold the new buffer line data.
   * Returns a boolean indicating, whether a `cleanupMemory` call would free
   * excess memory (true after shrinking > CLEANUP_THRESHOLD).
   */
  public resize(cols: number, fillCellData: ICellData): boolean {
    if (cols === this.length) {
      return this._data.length * 4 * CLEANUP_THRESHOLD < this._data.buffer.byteLength;
    }
    const uint32Cells = cols * CELL_SIZE;
    if (cols > this.length) {
      if (this._data.buffer.byteLength >= uint32Cells * 4) {
        // optimization: avoid alloc and data copy if buffer has enough room
        this._data = new Uint32Array(this._data.buffer, 0, uint32Cells);
      } else {
        // slow path: new alloc and full data copy
        const data = new Uint32Array(uint32Cells);
        data.set(this._data);
        this._data = data;
      }
      for (let i = this.length; i < cols; ++i) {
        this.setCell(i, fillCellData);
      }
    } else {
      // optimization: just shrink the view on existing buffer
      this._data = this._data.subarray(0, uint32Cells);
      // Remove any cut off combined data
      const keys = Object.keys(this._combined);
      for (let i = 0; i < keys.length; i++) {
        const key = parseInt(keys[i], 10);
        if (key >= cols) {
          delete this._combined[key];
        }
      }
      // remove any cut off extended attributes
      const extKeys = Object.keys(this._extendedAttrs);
      for (let i = 0; i < extKeys.length; i++) {
        const key = parseInt(extKeys[i], 10);
        if (key >= cols) {
          delete this._extendedAttrs[key];
        }
      }

      // remove any cut off sideloaded widths
      const movKeys = Object.keys(this._sideloadMovWidths);
      for (let i = 0; i < movKeys.length; i++) {
        const key = parseInt(movKeys[i], 10);
        if (key >= cols) delete this._sideloadMovWidths[key];
      }
      const delKeys = Object.keys(this._sideloadDelWidths);
      for (let i = 0; i < delKeys.length; i++) {
        const key = parseInt(delKeys[i], 10);
        if (key >= cols) delete this._sideloadDelWidths[key];
      }
    }
    this.length = cols;
    return uint32Cells * 4 * CLEANUP_THRESHOLD < this._data.buffer.byteLength;
  }

  public resizeNullFill(cols: number, fillAttr: IAttributeData): boolean {
    const fill = this.getNullCell(fillAttr);
    return this.resize(cols, fill);
  }

  /**
   * Cleanup underlying array buffer.
   * A cleanup will be triggered if the array buffer exceeds the actual used
   * memory by a factor of CLEANUP_THRESHOLD.
   * Returns 0 or 1 indicating whether a cleanup happened.
   */
  public cleanupMemory(): number {
    if (this._data.length * 4 * CLEANUP_THRESHOLD < this._data.buffer.byteLength) {
      const data = new Uint32Array(this._data.length);
      data.set(this._data);
      this._data = data;
      return 1;
    }
    return 0;
  }

  /** fill a line with fillCellData */
  public fill(fillCellData: ICellData, respectProtect: boolean = false): void {
    // full branching on respectProtect==true, hopefully getting fast JIT for standard case
    if (respectProtect) {
      for (let i = 0; i < this.length; ++i) {
        if (!this.isProtected(i)) {
          this.setCell(i, fillCellData);
        }
      }
      return;
    }
    this._combined = {};
    this._extendedAttrs = {};
    this._sideloadMovWidths = {};
    this._sideloadDelWidths = {};
    for (let i = 0; i < this.length; ++i) {
      this.setCell(i, fillCellData);
    }
  }

  public fillToNull(fillAttr: IAttributeData, respectProtect: boolean = false): void {
    const fill = this.getNullCell(fillAttr);
    this.fill(fill, respectProtect);
  }

  public fillToAscii(char: string, fillAttr: IAttributeData, respectProtect: boolean = false): void {
    const fill = this.createAsciiCell(char, fillAttr);
    this.fill(fill, respectProtect);
  }

  /** alter to a full copy of line  */
  public copyFrom(line: CompatBufferLine): void {
    if (this.length !== line.length) {
      this._data = new Uint32Array(line._data);
    } else {
      // use high speed copy if lengths are equal
      this._data.set(line._data);
    }
    this.length = line.length;
    this._combined = { ...line._combined };
    this._extendedAttrs = { ...line._extendedAttrs };
    this._sideloadMovWidths = { ...line._sideloadMovWidths };
    this._sideloadDelWidths = { ...line._sideloadDelWidths };
    this.isWrapped = line.isWrapped;
  }

  /** create a new clone */
  public clone(): IBufferLine {
    const newLine = new CompatBufferLine(0);
    newLine._data = new Uint32Array(this._data);
    newLine.length = this.length;
    newLine._combined = { ...this._combined };
    newLine._extendedAttrs = { ...this._extendedAttrs };
    newLine._sideloadMovWidths = { ...this._sideloadMovWidths };
    newLine._sideloadDelWidths = { ...this._sideloadDelWidths };
    newLine.isWrapped = this.isWrapped;
    return newLine;
  }

  public getTrimmedLength(): number {
    for (let i = this.length - 1; i >= 0; --i) {
      if (this.hasContent(i)) {
        return i + this.getWidth(i);
      }
    }
    return 0;
  }

  public getNoBgTrimmedLength(): number {
    for (let i = this.length - 1; i >= 0; --i) {
      if (this.hasContent(i) || (this.getBg(i) & Attributes.CM_MASK)) {
        return i + this.getWidth(i);
      }
    }
    return 0;
  }

  public copyCellsFrom(src: CompatBufferLine, srcCol: number, destCol: number, length: number, applyInReverse: boolean): void {
    const srcData = src._data;

    const copyOne = (cell: number): void => {
      const s = srcCol + cell;
      const d = destCol + cell;

      // copy packed cell (CONTENT/FG/BG)
      const si = s * CELL_SIZE;
      const di = d * CELL_SIZE;
      for (let i = 0; i < CELL_SIZE; i++) {
        this._data[di + i] = srcData[si + i];
      }

      const content = this._data[di + Cell.CONTENT];
      const bg = this._data[di + Cell.BG];

      // extended attrs: copy or delete
      if (bg & BgFlags.HAS_EXTENDED) this._extendedAttrs[d] = src._extendedAttrs[s];
      else delete this._extendedAttrs[d];

      // combined: copy or delete
      if (AppCellData.isCombined(content)) this._combined[d] = src._combined[s];
      else delete this._combined[d];

      // sideload widths: copy or delete
      if (AppCellData.movWidth(content) === 3) this._sideloadMovWidths[d] = src._sideloadMovWidths[s];
      else delete this._sideloadMovWidths[d];

      if (AppCellData.delWidth(content) === 3) this._sideloadDelWidths[d] = src._sideloadDelWidths[s];
      else delete this._sideloadDelWidths[d];
    };

    if (applyInReverse) {
      for (let cell = length - 1; cell >= 0; cell--) copyOne(cell);
    } else {
      for (let cell = 0; cell < length; cell++) copyOne(cell);
    }
  }

  /**
   * Translates the buffer line to a string.
   *
   * @param trimRight Whether to trim any empty cells on the right.
   * @param startCol The column to start the string (0-based inclusive).
   * @param endCol The column to end the string (0-based exclusive).
   * @param outColumns if specified, this array will be filled with column numbers such that
   * `returnedString[i]` is displayed at `outColumns[i]` column. `outColumns[returnedString.length]`
   * is where the character following `returnedString` will be displayed.
   *
   * When a single cell is translated to multiple UTF-16 code units (e.g. surrogate pair) in the
   * returned string, the corresponding entries in `outColumns` will have the same column number.
   */
  public translateToString(trimRight?: boolean, startCol?: number, endCol?: number, outColumns?: number[]): string {
    startCol = startCol ?? 0;
    endCol = endCol ?? this.length;
    if (trimRight) {
      endCol = Math.min(endCol, this.getTrimmedLength());
    }
    if (outColumns) {
      outColumns.length = 0;
    }
    let result = '';
    while (startCol < endCol) {
      const content = this._data[startCol * CELL_SIZE + Cell.CONTENT];
      const cp = AppCellData.codepoint(content);
      const chars = (AppCellData.isCombined(content)) ? this._combined[startCol] : (cp) ? stringFromCodePoint(cp) : WHITESPACE_CELL_CHAR;
      result += chars;
      if (outColumns) {
        for (let i = 0; i < chars.length; ++i) {
          outColumns.push(startCol);
        }
      }
      startCol += (AppCellData.appWidth(content)) || 1; // always advance by at least 1
    }
    if (outColumns) {
      outColumns.push(startCol);
    }
    return result;
  }

  public createCell(attr?: IAttributeData): AppCellData {
    return AppCellData.from('', 1, 1, 1, 1, false, attr);
  }

  public createNullCell(attr?: IAttributeData): AppCellData {
    return AppCellData.from(NULL_CELL_CHAR, NULL_CELL_WIDTH, 1, 1, 1, false, attr);
  }

  public createWhitespaceCell(attr?: IAttributeData): AppCellData {
    return AppCellData.from(WHITESPACE_CELL_CHAR, WHITESPACE_CELL_WIDTH, 1, 1, 1, false, attr);
  }

  public createAsciiCell(char: string, attr?: IAttributeData): AppCellData {
    return AppCellData.from(char, 1, 1, 1, 1, false, attr);
  }

  public snapRightToHeadCell(col: number): number {
    if (col >= this.length) return this.length;
    return this.isHeadCell(col) ? col : col + 1;
  }

  public snapLeftToHeadCell(col: number): number {
    if (col >= this.length) return this.length;
    return this.isHeadCell(col) ? col : col - 1;
  }

  public isHeadCell(col: number):  boolean { return this.hasWidth(col); } // width!=0
  public isEmptyCell(col: number): boolean { return !this.hasContent(col); }
  public isNullCell(col: number):  boolean { return this.isEmptyCell(col) && this.getWidth(col) === 1; }
  public isTailCell(col: number):  boolean { return this.isEmptyCell(col) && this.getWidth(col) === 0; }

  public countTrailingNullCells(): number {
    let n = 0;
    for (let i = this.length - 1; i >= 0 && this.isNullCell(i); --i) ++n;
    return n;
  }

  private _nullCell = this.createNullCell();
  public getNullCell(attr?: IAttributeData): ICellData {
    if (attr) {
      this._nullCell.fg = attr.fg;
      this._nullCell.bg = attr.bg;
      this._nullCell.extended.ext = attr.extended.ext;
      this._nullCell.extended.urlId = attr.extended.urlId;
    } else {
      this._nullCell.fg = 0;
      this._nullCell.bg = 0;
      this._nullCell.extended.ext = 0;
      this._nullCell.extended.urlId = 0;
    }
    return this._nullCell;
  }

  public snapToVisualLeft(col: number): number {
    if (col <= 0) return 0;
    if (col >= this.length) return this.length;
    while (col > 0 && this.getVisJoin(col)) col--;
    return col;
  }

  public snapToVisualRight(col: number): number {
    if (col < 0) return 0;
    if (col >= this.length) return this.length;
    while (col + 1 < this.length && this.getVisJoin(col + 1)) col++;
    return col;
  }

  private _setContent(index: number, content: number): void {
    this._data[index * CELL_SIZE + Cell.CONTENT] = content;
  }

  private _repairCell = new AppCellData();
  public repairVisualFromCol(col: number): void {
    let idx = this.snapToVisualLeft(col - 1);
    let state: UcWidthState | undefined;

    for (; idx < this.length; idx++) {
      if (this.isEmptyCell(idx)) {
        if (this.isNullCell(idx)) state = undefined;
        continue;
      }

      this.loadCell(idx, this._repairCell);

      let first = true;
      let cellVisJoin = false;
      let cellVisWidth: 0|1|2 = 0;

      for (const ch of this._repairCell.getChars()) {
        const cp = ch.codePointAt(0)!;
        const res = ucWidthStep(cp, UcVerCompatProvider.ucWidthOpts, state);

        if (first) {
          cellVisJoin = res.shouldJoin;
          first = false;
        }

        cellVisWidth = res.clusterWidth;
        state = res.state;
      }

      this._setContent(idx, AppCellData.patchVisual(this._getContent(idx), cellVisWidth, cellVisJoin));
    }
  }

  public visToAppIndex(visCol: number): [number, number] {
    if (visCol < 0) return [0, 0]; // shouldn't happen if caller is sane

    let visStart = 0;
    const n = this.length;

    for (let root = 0; root < n; root++) {
      if (this.getVisJoin(root)) continue; // roots only

      const w = this._clusterVisWidth(root);

      // cluster owns [visStart, visStart + w - 1]
      if (visCol < visStart + w) {
        const end = this._clusterEnd(root);
        return [root, end];
      }

      visStart += w;
    }

    // overshot, return EOL
    return [n, n];
  }

  public appToVisIndex(appCol: number): number {
    const root = this.snapToVisualLeft(appCol);

    let visStart = 0;
    for (let i = 0; i < root; i++) {
      if (this.getVisJoin(i)) continue;
      visStart += this._clusterVisWidth(i);
    }

    return visStart;
  }

  private _clusterEnd(col: number): number {
    let end = col;
    while (end + 1 < this.length && this.getVisJoin(end + 1)) end++;
    return end;
  }

  private _clusterVisWidth(col: number): number {
    let end = this._clusterEnd(col);
    if (this.isTailCell(end) && end > col) {
      end--;
    }
    return this.getVisWidth(end);
  }

  public inspectVisual(col: number): { start: number, end: number, text: string, cells: string[] } {
    if (col < 0) col = 0;
    if (col >= this.length) col = this.length - 1;

    const start = col;
    const end = this._clusterEnd(col);

    const tmp = new AppCellData();
    const cells: string[] = [];

    let text = '';
    for (let i = start; i <= end; i++) {
      if (this.isTailCell(i)) {
        cells.push('<tail>');
        continue;
      }

      this.loadCell(i, tmp);

      const ch = tmp.getChars();
      if (ch) text += ch;

      cells.push(tmp.inspect());
    }

    return { start, end, text, cells };
  }

}
