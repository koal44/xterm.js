/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IAttributeData, IBufferLine, ICellData, IExtendedAttrs } from 'common/Types';
import { DEFAULT_ATTR_DATA } from 'common/buffer/AttributeData';
import { CellData } from 'common/buffer/CellData';
import { Attributes, BgFlags, NULL_CELL_CHAR, NULL_CELL_CODE, NULL_CELL_WIDTH, TAIL_CELL_CODE, TAIL_CELL_WIDTH, WHITESPACE_CELL_CHAR, WHITESPACE_CELL_WIDTH } from 'common/buffer/Constants';
import { RenderCell } from 'common/buffer/RenderCell';
import { stringFromCodePoint } from 'common/input/TextDecoder';

/**
 * buffer memory layout:
 *
 *   |             uint32_t             |        uint32_t         |        uint32_t         |
 *   |             `content`            |          `FG`           |          `BG`           |
 *   | wcwidth(2) comb(1) codepoint(21) | flags(8) R(8) G(8) B(8) | flags(8) R(8) G(8) B(8) |
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

// Work variables to avoid garbage collection
let $startIndex = 0;

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
export class BufferLine implements IBufferLine {
  protected _data: Uint32Array;
  protected _combined: {[index: number]: string} = {};
  protected _extendedAttrs: {[index: number]: IExtendedAttrs | undefined} = {};
  public length: number;

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
    return CellData.width(this._getContent(index));
  }

  /** Test whether content has width. */
  public hasWidth(index: number): boolean {
    return !!CellData.width(this._getContent(index));
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
    return CellData.hasContent(this._getContent(index));
  }

  /** Test whether the cell contains a combined string. */
  public isCombined(index: number): boolean {
    return CellData.isCombined(this._getContent(index));
  }

  /**
   * Get codepoint of the cell.
   * To be in line with `code` in CharData this either returns
   * a single UTF32 codepoint or the last codepoint of a combined string.
   */
  public getCodePoint(index: number): number {
    const content = this._getContent(index);
    if (CellData.isCombined(content)) {
      return this._combined[index].charCodeAt(this._combined[index].length - 1);
    }
    return CellData.codepoint(content);
  }

  /** Returns the string content of the cell. */
  public getString(index: number): string {
    const content = this._getContent(index);
    if (CellData.isCombined(content)) {
      return this._combined[index];
    }
    const cp = CellData.codepoint(content);
    return cp ? stringFromCodePoint(cp) : '';
  }

  /**
   * Load data at `index` into `cell`. This is used to access cells in a way that's more friendly
   * to GC as it significantly reduced the amount of new objects/references needed.
   */
  public loadCell(index: number, cell: ICellData): ICellData {
    $startIndex = index * CELL_SIZE;
    cell.content = this._data[$startIndex + Cell.CONTENT];
    cell.fg = this._data[$startIndex + Cell.FG];
    cell.bg = this._data[$startIndex + Cell.BG];
    if (cell.isCombined()) {
      cell.combinedData = this._combined[index];
    }
    if (cell.bg & BgFlags.HAS_EXTENDED) {
      cell.extended = this._extendedAttrs[index]!;
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
    cell.visJoin = false;

    const content = this._data[i + Cell.CONTENT];
    const width = CellData.width(content);
    cell.width = width;
    cell.visWidth = width;
    const cp = CellData.codepoint(content);
    // cell.codepoint = cp;
    const isCombined = CellData.isCombined(content);
    const chars = isCombined ? (this._combined[index] ?? '') : (cp ? stringFromCodePoint(cp) : '');
    cell.chars = chars;
    cell.code = isCombined ? (chars ? chars.charCodeAt(chars.length - 1) : 0) : cp;
  }

  /**
   * Set data at `index` to `cell`.
   */
  public setCell(index: number, cell: ICellData): void {
    if (cell.isCombined()) {
      this._combined[index] = cell.combinedData;
    }
    if (cell.bg & BgFlags.HAS_EXTENDED) {
      this._extendedAttrs[index] = cell.extended;
    } else if (this._extendedAttrs[index]) {
      delete this._extendedAttrs[index];
    }
    this._data[index * CELL_SIZE + Cell.CONTENT] = cell.content;
    this._data[index * CELL_SIZE + Cell.FG] = cell.fg;
    this._data[index * CELL_SIZE + Cell.BG] = cell.bg;
  }

  public setCellToNull(index: number, attr: IAttributeData = DEFAULT_ATTR_DATA): void {
    this.setCellFromCodepoint(index, NULL_CELL_CODE, NULL_CELL_WIDTH, attr);
  }

  public setCellToTail(index: number, attr: IAttributeData = DEFAULT_ATTR_DATA): void {
    this.setCellFromCodepoint(index, TAIL_CELL_CODE, TAIL_CELL_WIDTH, attr);
  }

  /**
   * Set cell data from input handler.
   * Since the input handler see the incoming chars as UTF32 codepoints,
   * it gets an optimized access method.
   */
  public setCellFromCodepoint(index: number, codePoint: number, width: 0|1|2, attr: IAttributeData): void {
    if (attr.bg & BgFlags.HAS_EXTENDED) {
      this._extendedAttrs[index] = attr.extended;
    } else if (this._extendedAttrs[index]) {
      delete this._extendedAttrs[index];
    }
    this._data[index * CELL_SIZE + Cell.CONTENT] = CellData.packContent(codePoint, false, width);
    this._data[index * CELL_SIZE + Cell.FG] = attr.fg;
    this._data[index * CELL_SIZE + Cell.BG] = attr.bg;
  }

  /**
   * Add a codepoint to a cell from input handler.
   * During input stage combining chars with a width of 0 follow and stack
   * onto a leading char. Since we already set the attrs
   * by the previous `setDataFromCodePoint` call, we can omit it here.
   */
  public addCodepointToCell(index: number, codePoint: number, width: 0|1|2): void {
    const i = index * CELL_SIZE + Cell.CONTENT;
    // should not happen - we actually have no data in the cell yet
    if (this.isEmptyCell(index)) {
      this._data[i] = CellData.packContent(codePoint, false, 1);
      return;
    }
    const content = this._data[i];
    this._combined[index] = CellData.isCombined(content)
      ? this._combined[index] + stringFromCodePoint(codePoint)
      : stringFromCodePoint(CellData.codepoint(content)) + stringFromCodePoint(codePoint);
    const w = width ? width : CellData.width(content);
    this._data[i] = CellData.packContent(0, true, w);
  }

  public insertCells(pos: number, n: number, fillCellData: ICellData): void {
    pos %= this.length;

    // handle fullwidth at pos: reset cell one to the left if pos is second cell of a wide char
    if (pos && this.getWidth(pos - 1) === 2) {
      this.setCellFromCodepoint(pos - 1, 0, 1, fillCellData);
    }

    if (n < this.length - pos) {
      const cell = new CellData();
      for (let i = this.length - pos - n - 1; i >= 0; --i) {
        this.setCell(pos + n + i, this.loadCell(pos + i, cell));
      }
      for (let i = 0; i < n; ++i) {
        this.setCell(pos + i, fillCellData);
      }
    } else {
      for (let i = pos; i < this.length; ++i) {
        this.setCell(i, fillCellData);
      }
    }

    // handle fullwidth at line end: reset last cell if it is first cell of a wide char
    if (this.getWidth(this.length - 1) === 2) {
      this.setCellFromCodepoint(this.length - 1, 0, 1, fillCellData);
    }
  }

  public insertNullFill(pos: number, n: number, fillAttr: IAttributeData): void {
    const fill = this.getNullCell(fillAttr);
    this.insertCells(pos, n, fill);
  }

  public deleteCells(pos: number, n: number, fillCellData: ICellData): void {
    pos %= this.length;
    if (n < this.length - pos) {
      const cell = new CellData();
      for (let i = 0; i < this.length - pos - n; ++i) {
        this.setCell(pos + i, this.loadCell(pos + n + i, cell));
      }
      for (let i = this.length - n; i < this.length; ++i) {
        this.setCell(i, fillCellData);
      }
    } else {
      for (let i = pos; i < this.length; ++i) {
        this.setCell(i, fillCellData);
      }
    }

    // handle fullwidth at pos:
    // - reset pos-1 if wide char
    // - reset pos if width==0 (previous second cell of a wide char)
    if (pos && this.getWidth(pos - 1) === 2) {
      this.setCellFromCodepoint(pos - 1, 0, 1, fillCellData);
    }
    if (this.isTailCell(pos)) {
      this.setCellFromCodepoint(pos, 0, 1, fillCellData);
    }
  }

  public deleteNullFill(pos: number, n: number, fillAttr: IAttributeData): void {
    const fill = this.getNullCell(fillAttr);
    this.deleteCells(pos, n, fill);
  }

  public replaceCells(start: number, end: number, fillCellData: ICellData, respectProtect: boolean = false): void {
    // full branching on respectProtect==true, hopefully getting fast JIT for standard case
    if (respectProtect) {
      if (start && this.getWidth(start - 1) === 2 && !this.isProtected(start - 1)) {
        this.setCellFromCodepoint(start - 1, 0, 1, fillCellData);
      }
      if (end < this.length && this.getWidth(end - 1) === 2 && !this.isProtected(end)) {
        this.setCellFromCodepoint(end, 0, 1, fillCellData);
      }
      while (start < end  && start < this.length) {
        if (!this.isProtected(start)) {
          this.setCell(start, fillCellData);
        }
        start++;
      }
      return;
    }

    // handle fullwidth at start: reset cell one to the left if start is second cell of a wide char
    if (start && this.getWidth(start - 1) === 2) {
      this.setCellFromCodepoint(start - 1, 0, 1, fillCellData);
    }
    // handle fullwidth at last cell + 1: reset to empty cell if it is second part of a wide char
    if (end < this.length && this.getWidth(end - 1) === 2) {
      this.setCellFromCodepoint(end, 0, 1, fillCellData);
    }

    while (start < end  && start < this.length) {
      this.setCell(start++, fillCellData);
    }
  }

  public replaceNullFill(start: number, end: number, fillAttr: IAttributeData, respectProtect: boolean = false): void {
    const fill = this.getNullCell(fillAttr);
    this.replaceCells(start, end, fill, respectProtect);
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
  public copyFrom(line: BufferLine): void {
    if (this.length !== line.length) {
      this._data = new Uint32Array(line._data);
    } else {
      // use high speed copy if lengths are equal
      this._data.set(line._data);
    }
    this.length = line.length;
    this._combined = {};
    for (const el in line._combined) {
      this._combined[el] = line._combined[el];
    }
    this._extendedAttrs = {};
    for (const el in line._extendedAttrs) {
      this._extendedAttrs[el] = line._extendedAttrs[el];
    }
    this.isWrapped = line.isWrapped;
  }

  /** create a new clone */
  public clone(): IBufferLine {
    const newLine = new BufferLine(0);
    newLine._data = new Uint32Array(this._data);
    newLine.length = this.length;
    for (const el in this._combined) {
      newLine._combined[el] = this._combined[el];
    }
    for (const el in this._extendedAttrs) {
      newLine._extendedAttrs[el] = this._extendedAttrs[el];
    }
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

  public copyCellsFrom(src: BufferLine, srcCol: number, destCol: number, length: number, applyInReverse: boolean): void {
    const srcData = src._data;
    if (applyInReverse) {
      for (let cell = length - 1; cell >= 0; cell--) {
        for (let i = 0; i < CELL_SIZE; i++) {
          this._data[(destCol + cell) * CELL_SIZE + i] = srcData[(srcCol + cell) * CELL_SIZE + i];
        }
        if (srcData[(srcCol + cell) * CELL_SIZE + Cell.BG] & BgFlags.HAS_EXTENDED) {
          this._extendedAttrs[destCol + cell] = src._extendedAttrs[srcCol + cell];
        }
      }
    } else {
      for (let cell = 0; cell < length; cell++) {
        for (let i = 0; i < CELL_SIZE; i++) {
          this._data[(destCol + cell) * CELL_SIZE + i] = srcData[(srcCol + cell) * CELL_SIZE + i];
        }
        if (srcData[(srcCol + cell) * CELL_SIZE + Cell.BG] & BgFlags.HAS_EXTENDED) {
          this._extendedAttrs[destCol + cell] = src._extendedAttrs[srcCol + cell];
        }
      }
    }

    // Move any combined data over as needed, FIXME: repeat for extended attrs
    const srcCombinedKeys = Object.keys(src._combined);
    for (let i = 0; i < srcCombinedKeys.length; i++) {
      const key = parseInt(srcCombinedKeys[i], 10);
      if (key >= srcCol) {
        this._combined[key - srcCol + destCol] = src._combined[key];
      }
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
      const cp = CellData.codepoint(content);
      const chars = (CellData.isCombined(content)) ? this._combined[startCol] : (cp) ? stringFromCodePoint(cp) : WHITESPACE_CELL_CHAR;
      result += chars;
      if (outColumns) {
        for (let i = 0; i < chars.length; ++i) {
          outColumns.push(startCol);
        }
      }
      startCol += (CellData.width(content)) || 1; // always advance by at least 1
    }
    if (outColumns) {
      outColumns.push(startCol);
    }
    return result;
  }

  public createCell(attr?: IAttributeData): CellData {
    const cell = new CellData();
    if (attr) {
      cell.fg = attr.fg;
      cell.bg = attr.bg;
    }
    return cell;
  }

  public createNullCell(attr?: IAttributeData): CellData {
    const cell = this.createCell(attr);
    cell.setChars(NULL_CELL_CHAR, NULL_CELL_WIDTH);
    return cell;
  }

  public createWhitespaceCell(attr?: IAttributeData): CellData {
    const cell = this.createCell(attr);
    cell.setChars(WHITESPACE_CELL_CHAR, WHITESPACE_CELL_WIDTH);
    return cell;
  }

  public createAsciiCell(char: string, attr?: IAttributeData): CellData {
    const cell = this.createCell(attr);
    cell.setChars(char, 1);
    return cell;
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
  public isNullCell(col: number):  boolean { return this.isEmptyCell(col) && this.hasWidth(col); } // width==1
  public isTailCell(col: number):  boolean { return this.isEmptyCell(col) && !this.hasWidth(col); } // width==0

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

  public getVisWidth(index: number): number {
    return this.getWidth(index);
  }

  public getVisJoin(index: number): boolean {
    return false;
  }

  public repairVisualFromCol(col: number): void {
    // no-op
  }

  public visToAppIndex(visCol: number): [number, number] {
    return [visCol, visCol];
  }

  public appToVisIndex(appCol: number): number {
    return appCol;
  }

  public inspectVisual(col: number): { start: number, end: number, text: string, cells: string[] } {
    if (col < 0) col = 0;
    if (col >= this.length) col = this.length - 1;

    const tmp = new CellData();
    this.loadCell(col, tmp);

    const text = tmp.getChars();
    return {
      start: col,
      end: col,
      text,
      cells: [this.isTailCell(col) ? '<tail>' : tmp.inspect()]
    };
  }

  public burst(op: 'mov'|'del', dir: 'left'|'right', x: number): number {
    return 1;
  }
}
