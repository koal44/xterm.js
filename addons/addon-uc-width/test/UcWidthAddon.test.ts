/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import test, { expect } from '@playwright/test';
import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { ITestContext, createTestContext, openTerminal } from '../../../test/playwright/TestUtils';

interface ISocketReporter {
  on: boolean;
  in: string[];
  out: string[];
  start(): void;
  stop(): void;
  clear(): void;
  snapshot(): { in: string[], out: string[] };
}

interface ITestWindow {
  term: Terminal & {
    _core: {
      unicodeService: { getStringCellWidth(s: string): number };
    };
  };
  unicode17?: ITerminalAddon;
  UcWidthAddon: new () => ITerminalAddon;
  sockReporter: ISocketReporter;
}

declare let window: ITestWindow;

type Cluster = [cps: number[], width: number];

type TermOp =
  | { k: 'versions' }
  | { k: 'activeVersion' }
  | { k: 'strWidth', s: string }
  | { k: 'write', data: string }
  | { k: 'cursorX' }
  | { k: 'dumpClusters' }
  | { k: 'hasSockRep' }
  | { k: 'sockRepStart' }
  | { k: 'sockRepSnapshot' };

async function termEval<R>(op: TermOp): Promise<R> {
  const result = await ctx.page.evaluate(async (op) => {
    const term = window.term;

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
            continue; // questionable...
          }

          const cps: number[] = [];
          for (const ch of chars) cps.push(ch.codePointAt(0)!);

          out.push([cps, cw]);
        }

        return out;
      }

      case 'hasSockRep': {
        return !!window.sockReporter;
      }
      case 'sockRepStart': {
        const r = window.sockReporter as ISocketReporter | undefined;
        if (!r) throw new Error('sockRep not installed');
        r.start();
        return undefined;
      }
      case 'sockRepSnapshot': {
        const r = window.sockReporter as ISocketReporter | undefined;
        if (!r) throw new Error('sockRep not installed');
        return r.snapshot();
      }
    }
  }, op);

  return result as R;
}

const versions = () => termEval<string[]>({ k: 'versions' });
const activeVersion = () => termEval<string>({ k: 'activeVersion' });
const strWidth = (s: string) => termEval<number>({ k: 'strWidth', s });
const write = (data: string) => termEval<void>({ k: 'write', data });
const cursorX = () => termEval<number>({ k: 'cursorX' });
const dumpClusters = () => termEval<Cluster[]>({ k: 'dumpClusters' });

const hasSocket = () => ctx.page.evaluate(() => typeof (window as any).socket !== 'undefined');
const hasSockRep = () => termEval<boolean>({ k: 'hasSockRep' });
const sockRepStart = () => termEval<void>({ k: 'sockRepStart' });
const sockRepSnapshot = () => termEval<{ in: string[], out: string[] }>({ k: 'sockRepSnapshot' });

let ctx: ITestContext;
const VERSION = '17';

test.beforeAll(async ({ browser }) => {
  ctx = await createTestContext(browser);
  await openTerminal(ctx);
});

test.afterAll(async () => {
  await ctx.page.close();
});

test.describe('UcWidthAddon', () => {
  test.beforeEach(async () => {
    await ctx.page.evaluate((ver) => {
      window.unicode17?.dispose();
      window.unicode17 = new window.UcWidthAddon();

      const term = window.term;
      term.reset();
      term.loadAddon(window.unicode17);
      term.unicode.activeVersion = ver;
    }, VERSION);
  });

  test('registers version and computes expected widths', async () => {
    expect(await versions()).toContain(VERSION);
    expect(await activeVersion()).toBe(VERSION);
    expect(await strWidth('🤣🤣🤣🤣🤣🤣🤣🤣🤣🤣')).toBe(20);
    expect(await strWidth('a\u0301')).toBe(1);
    expect(await strWidth('\u{1F468}\u{200D}\u{1F33E}')).toBe(2);
  });

  test('dumpClusters: ASCII "hello"', async () => {
    await write('hello');

    expect(await cursorX()).toBe(5);
    expect(await dumpClusters()).toEqual([
      [[0x68], 1], [[0x65], 1], [[0x6c], 1], [[0x6c], 1], [[0x6f], 1] ]);
  });

  test('dumpClusters: 👨‍🌾 (ZWJ sequence) yields one cluster width 2', async () => {
    const farmer = '👨‍🌾'; // '\u{1F468}\u{200D}\u{1F33E}'
    await write(farmer);

    expect(await cursorX()).toBe(2);
    expect(await dumpClusters()).toEqual([
      [[0x1F468, 0x200D, 0x1F33E], 2],
    ]);
  });

  test('socket reporter captures outbound sends', async () => {
    // console.log('hasSocket', await hasSocket());
    expect(await hasSocket()).toBe(true);
    expect(await hasSockRep()).toBe(true);


    await sockRepStart();
    await write('smoke test');

    const snap = await sockRepSnapshot();
    expect(snap.in.join('')).toContain('foo');
  });

  // test('dumpClusters: myanmar', async () => {
  //   const mya = '\u102c\u102c\u102c'; // three Myanmar Vowel Sign AA
  //   await write(mya);

  //   expect(await dumpClusters()).toEqual([
  //     [[0x102c, 0x102c, 0x102c], 3],
  //   ]);
  // });
});
