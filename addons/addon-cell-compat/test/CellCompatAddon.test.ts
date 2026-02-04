/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import test, { expect } from '@playwright/test';
import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { ITestContext, createTestContext, openTerminal } from '../../../test/playwright/TestUtils';

interface ITestWindow {
  term: Terminal & {
    _core: {
      unicodeService: { getStringCellWidth(s: string): number };
    };
  };
  cellCompat?: ITerminalAddon;
  CellCompatAddon: new () => ITerminalAddon;
}

type Cluster = [cps: number[], width: number];

type TermOp =
  | { k: 'versions' }
  | { k: 'activeVersion' }
  | { k: 'strWidth', s: string }
  | { k: 'write', data: string }
  | { k: 'cursorX' }
  | { k: 'dumpClusters' };

async function termEval<R>(op: TermOp): Promise<R> {
  const result = await ctx.page.evaluate(async (op) => {
    const w = window as unknown as ITestWindow;
    const term = w.term;

    switch (op.k) {
      case 'versions': {
        return term.unicode.versions;
      }
      case 'activeVersion': {
        return term.unicode.activeVersion;
      }
      case 'strWidth': {
        return term._core.unicodeService.getStringCellWidth(op.s);
      }
      case 'write': {
        // subscribe first (avoid missing the event)
        const parsed = new Promise<void>((resolve) => {
          const d = term.onWriteParsed(() => {
            d.dispose();
            resolve();
          });
        });

        // enqueue + wait for write callback
        await new Promise<void>((resolve) => term.write(op.data, resolve));

        // wait for parser completion signal (for THIS write)
        await parsed;
        return undefined;
      }
      case 'cursorX': {
        return term.buffer.active.cursorX;
      }
      case 'dumpClusters': {
        const cursorY = term.buffer.active.cursorY;
        if (cursorY !== 0) throw new Error('assumed single-line output');

        const line = term.buffer.active.getLine(0);
        if (!line) throw new Error('dumpClusters expected buffer line 0 to exist');

        const end = term.buffer.active.cursorX;
        const out: Cluster[] = [];

        for (let x = 0; x < end; x++) {
          const cell = line.getCell(x);
          if (!cell) {
            throw new Error(`dumpClusters expected cell at x=${x} to exist`);
          }

          const cw = cell.getWidth();
          const chars = cell.getChars();

          if (cw === 0) {
            if (chars.length !== 0) {
              throw new Error(`Unexpected content in width-0 stub at x=${x}: ${JSON.stringify(chars)}`);
            }
            continue; // questionable...
          }

          const cps: number[] = [];
          for (const ch of chars) cps.push(ch.codePointAt(0)!);

          out.push([cps, cw]);
        }

        return out;
      }
    }
  }, op);

  return result as R;
}

const versions = () => termEval<string[]>({ k: 'versions' });
const activeVersion = () => termEval<string>({ k: 'activeVersion' });
// const strWidth = (s: string) => termEval<number>({ k: 'strWidth', s });
// const write = (data: string) => termEval<void>({ k: 'write', data });
// const cursorX = () => termEval<number>({ k: 'cursorX' });
// const dumpClusters = () => termEval<Cluster[]>({ k: 'dumpClusters' });

let ctx: ITestContext;
const VERSION = 'compat';

test.beforeAll(async ({ browser }) => {
  ctx = await createTestContext(browser);
  await openTerminal(ctx);
});

test.afterAll(async () => {
  await ctx.page.close();
});

test.describe('CellCompatAddon', () => {
  test.beforeEach(async () => {
    await ctx.page.evaluate((ver) => {
      const w = window as unknown as ITestWindow;
      w.term.reset();
      w.cellCompat?.dispose();
      w.cellCompat = new w.CellCompatAddon();
      w.term.loadAddon(w.cellCompat);
      w.term.unicode.activeVersion = ver;
    }, VERSION);
  });

  test('registers version', async () => {
    expect(await versions()).toContain(VERSION);
    expect(await activeVersion()).toBe(VERSION);
  });

});
