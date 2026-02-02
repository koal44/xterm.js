/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Explorer for measuring payload width in interactive apps (shells/TUIs).
 *
 * Width metrics:
 * - colWidth: column-space consumed by the app's rendering (wcwidth-like).
 * - movWidth: cursor traversal cost in keypresses; can feel sticky when movWidth > colWidth.
 * - delWidth: deletion cost in keypresses; 0 skips and eats next unit.
 *
 * Usage:
 * - Start an interactive app and select a profile (key bindings + init commands).
 * - Run a preset test, click a script, or sweep a Unicode range (start..end).
 * - Widths are inferred from the app's cursor motion and/or repaint traffic.
 *
 * Notes:
 * - Check line-editor bindings (pwsh: `Ctrl+Alt+?`, bash: `bind -P`, zsh: `bindkey`, fish: `bind`).
 * - Ramped colWidth can hide mixed widths (e.g. 0+2 cancel to 1).
 * - Per-range movWidth/delWidth are inferred from sparse probes and may be inaccurate.
 */

import { BaseWindow } from './baseWindow';
import type { Terminal } from '@xterm/xterm';
import type { AddonCollection } from 'types';

// choose ascii single char to avoid app splitting suffix across messages
const TEST_PREFIX = '«';
const TEST_SUFFIX = '»';
// const TEST_PREFIX = 'ABC';
// const TEST_SUFFIX = 'CBA';
const TESTS = [
  '🙂',
  '👨‍🌾',
  '👨‍👩‍👧‍👦',
  '🇺🇳',
  '͸',  // an unprintable char
  '͸͹', // two unprintable chars
];

const TURBO_COLS = 600; // widen columns for turbo mode

interface IKeymap { left: string, right: string, home: string, end: string, clearLine: string, clearScreen: string, del: string }
const DEFAULT_KEYMAP: IKeymap = {
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  clearLine: '\x15', // ^U
  clearScreen: '\x0c', // ^L
  del: '\x7f',
} as const;

type MessageAwaiter = (until: (m: string) => boolean, timeoutMs: number, reportTimeout?: boolean) => Promise<string | undefined>;
interface IUpkeepCmd { cmd: string, everyRuns: number, timeoutMs: number }

type AppId = 'bash' | 'zsh' | 'fish' | 'pwsh' | null;
interface IAppProfile {
  id: AppId;
  label: string;
  tableName: string;
  keys: IKeymap;
  clearLineNeedsEnd: boolean; // whether clear key needs an END before it to work properly
  init: string[]; // commands to run when switching into this profile
  upkeep?: IUpkeepCmd; // commands to run periodically to keep the line editor happy
}

export const APP_PROFILES: IAppProfile[] = [
  {
    id: 'bash',
    label: 'bash (GNU Readline)',
    tableName: 'bashCompatTable',
    keys: { ...DEFAULT_KEYMAP },
    clearLineNeedsEnd: true,
    init: [
      `exec bash --noprofile --norc`,
      `export PS1="> "`,
      `unset PROMPT_COMMAND`,
      `set +o history`,

      `bind '"\\e[D": backward-char'`,        // Left  (ESC [ D)
      `bind '"\\e[C": forward-char'`,         // Right (ESC [ C)
      `bind '"\\e[H": beginning-of-line'`,    // Home  (ESC [ H)
      `bind '"\\e[F": end-of-line'`,          // End   (ESC [ F)
      `bind '"\\C-u": unix-line-discard'`,    // Clear (Ctrl+U, 0x15)
      `bind '"\\C-?": backward-delete-char'`, // DEL/Backspace (0x7f)
      `bind '"\\C-l": clear-screen'`,         // Clear screen (Ctrl+L, 0x0c)
    ],
  },
  {
    id: 'zsh',
    label: 'zsh (Zsh Line Editor / ZLE)',
    tableName: 'zshCompatTable',
    keys: { ...DEFAULT_KEYMAP },
    clearLineNeedsEnd: false,
    init: [
      `exec zsh -f`,
      `precmd_functions=(); preexec_functions=(); chpwd_functions=(); PROMPT='> '; RPROMPT=''; PS1='> '`,
      `unset HISTFILE; HISTSIZE=0; SAVEHIST=0`,

      `setopt COMBINING_CHARS`,
      `zle_highlight=(none)`,

      `bindkey -e`,
      `bindkey '^[[D' backward-char`,        // \x1b[D
      `bindkey '^[[C' forward-char`,         // \x1b[C
      `bindkey '^[[H' beginning-of-line`,    // \x1b[H
      `bindkey '^[[F' end-of-line`,          // \x1b[F
      `bindkey '^U'   kill-whole-line`,      // \x15
      `bindkey '^?'   backward-delete-char`, // \x7f
      `bindkey '^L' clear-screen`,           // \x0c
    ],
    //   // zsh/ZLE private byte stash in 0xe000..0xe0ff for lossless round-tripping (ISO 10646)
  },
  {
    id: 'fish',
    label: 'fish (Command line editor)',
    tableName: 'fishCompatTable',
    keys: { ...DEFAULT_KEYMAP },
    clearLineNeedsEnd: true,
    init: [
      `exec fish --no-config --private`,
      `function fish_prompt; echo -n "> "; end`,
      `function fish_right_prompt; end`,
      `function fish_title; end`,
      // `set -gx XDG_DATA_HOME /dev/null`,
      `set -gx fish_history ""`,
      `set -g fish_autosuggestion_enabled 0`,
      `set -g fish_greeting "",`,

      `bind '\\e[D' backward-char`,          // \x1b[D
      `bind '\\e[C' forward-char`,           // \x1b[C
      `bind '\\e[H' beginning-of-line`,      // \x1b[H
      `bind '\\e[F' end-of-line`,            // \x1b[F
      // `bind '\\cU' backward-kill-line`,      // \x15
      `bind '\\cU' kill-line`,               // \x15
      `bind '\\x7f' backward-delete-char`,   // \x7f
      `bind '\\cL' clear-screen`,            // \x0c
    ],
    upkeep: { cmd: 'true\r', everyRuns: 100, timeoutMs: 800 },
  },
  {
    id: 'pwsh',
    label: 'pwsh (PSReadLine)',
    tableName: 'pwshCompatTable',
    keys: {
      ...DEFAULT_KEYMAP,
      clearLine: '\x1b', // ESC, undo line edits
    },
    clearLineNeedsEnd: false,
    init: [
      // Get-PSReadLineOption shows current options
      `function prompt { "> " }`,
      `Set-PSReadLineOption -PredictionSource None`,
      `Set-PSReadLineOption -HistorySaveStyle SaveNothing`,
      // `Set-PSReadLineOption -Colors @{Command="$([char]0x1b)[37m";}`,
      // `Set-PSReadLineOption -Colors @{Command='white';Default='white';`, ... doesn't work
      `Set-PSReadLineKeyHandler -Chord Ctrl+l -Function ClearScreen`,
    ],
  }
];

interface ISocketReporter {
  log: string[];
  logEnabled: boolean;
}

interface IMsgReaderTimeoutPolicy {
  shouldThrowOnTimeout: () => boolean;
}

export class WidthExplorerWindow extends BaseWindow {
  public readonly id = 'width-explorer';
  public readonly label = 'Width';

  private _sock: WebSocket | null = null;
  private _rep: ISocketReporter | undefined;
  private _profile: IAppProfile | undefined;
  private _showZwj = false;
  private _silentCb!: HTMLInputElement;

  private _useTestPrefix = false;
  private _useTestSuffix = false;
  private _isGenRunning = false;
  private _genButton: HTMLButtonElement | undefined;
  private _genStart = 0x0;
  private _genEnd = 0x10FFFF;
  private _genColBatching = false;
  private _genTermDetach = false;
  private _genLogPerf = false;
  private _genAudit = false;
  private _workingTable = new RangeTable('temp');
  private _store: BrowserStorage | undefined;

  private _measureStatusSpan!: HTMLSpanElement;
  private _measureColWidth = true;
  private _measureMovWidth = true;
  private _measureDelWidth = true;
  private _throwOnTimeout = false;
  private _msgTimeoutPolicy: IMsgReaderTimeoutPolicy = {
    shouldThrowOnTimeout: () => this._throwOnTimeout,
  };

  private _logEl!: HTMLPreElement;
  private _logFlushMs = 100;
  private _logMaxLines = 150;
  private _log = new CircularList(this._logMaxLines);
  private _logFlushScheduled = false;
  private _logFlushTimer: number | undefined;

  constructor(
    terminal: Terminal,
    addons: AddonCollection,
    private readonly _deps: { getSocket: () => WebSocket | null },
  ) {
    super(terminal, addons);
  }

  public build(container: HTMLElement): void {
    // hoisted elements
    let batchUi: ReturnType<typeof mkCheckbox> | undefined = undefined;
    const toggleBatchUi = (value: boolean): void => {
      if (this._isGenRunning) return;
      if (!batchUi) return;
      batchUi.input.checked = this._genColBatching = value;
    };

    const root = document.createElement('div');
    container.appendChild(root);

    // App profile
    addRow(root, 'profile: ',
      mkSelect(APP_PROFILES.map(p => ({ id: p.id as string, label: p.label })), null as AppId | null, id => this._setProfile(id as AppId), 'App profile (key sequences)'),
    );

    // Log options
    root.appendChild(document.createElement('hr'));
    const { label: silentLabel, input: silentInput } = mkCheckbox(
      'silent ', 'Suppress output during generation',
      true, // default to silent
      v => {
        this._setLogEnabled(!v);
      }
    );
    this._silentCb = silentInput;
    addRow(root, 'log: ',
      mkButton('↻', 'Clear the log output', () => this._clearLog()),
      silentLabel,
      mkCheckbox('zwj ', 'render ZWJ as {zwj} in trace?', this._showZwj, v => { this._showZwj = v; }).label,
    );

    // App input
    root.appendChild(document.createElement('hr'));
    addRow(root, 'app input:');

    const delN = mkNumericUpDown('DEL repeat count', 1, 64, 1, 1);
    delN.style.width = '30px';
    addRow(root, '',
      mkButton('⌧', 'Clear screen & redraw current line', () => {
        this._inject(this._profile?.keys.clearScreen);
      }),
      mkButton('⌫', 'Clear the current line', () => {
        if (this._profile?.clearLineNeedsEnd) this._inject(this._profile?.keys.end);
        this._inject(this._profile?.keys.clearLine);
      }),
      mkButton('←', 'Left', () => this._inject(this._profile?.keys.left)),
      mkButton('→', 'Right', () => this._inject(this._profile?.keys.right)),
      mkButton('⇤', 'Home', () => this._inject(this._profile?.keys.home)),
      mkButton('⇥', 'End', () => this._inject(this._profile?.keys.end)),
      mkButton('DEL×N', 'Send DEL × N', () => {
        const n = Math.max(1, Math.min(64, +delN.value));
        this._inject(this._profile?.keys.del.repeat(n));
      }),
      delN,
    );

    addRow(root, '',
      ...TESTS.map(t => mkButton(t, `Print "${formatCodePoints(t)}"`, () => this._inject((this._useTestPrefix ? TEST_PREFIX : '') + t + (this._useTestSuffix ? TEST_SUFFIX : '')))),
      mkCheckbox('prefix', `prefix test inputs with ${TEST_PREFIX}`, this._useTestPrefix, v => { this._useTestPrefix = v; }).label,
      mkCheckbox('suffix', `suffix test inputs with ${TEST_SUFFIX}`, this._useTestSuffix, v => { this._useTestSuffix = v; }).label,
    );

    // Generate tables / scripting
    root.appendChild(document.createElement('hr'));
    addRow(root, 'measure widths:');

    const colWidthUi = mkCheckbox('col ', 'Measure column widths', this._measureColWidth, v => { this._measureColWidth = v; if (!v) toggleBatchUi(false); });
    const movWidthUi = mkCheckbox('mov ', 'Measure move widths (# arrow key presses to step over the payload)', this._measureMovWidth, v => { this._measureMovWidth = v; if (v) toggleBatchUi(false); });
    const delWidthUi = mkCheckbox('del ', 'Measure delete widths (# of delete key presses to eat through the payload)', this._measureDelWidth, v => { this._measureDelWidth = v; if (v) toggleBatchUi(false); });
    addRow(root, '',
      colWidthUi.label,
      movWidthUi.label,
      delWidthUi.label,
    );

    // const { label: clearModeCtl } = mkRadioCycle(
    //   [ 'clear-line', 'clear-screen' ],
    //   this._clearMode === 'line' ? 'clear-line' : 'clear-screen',
    //   'cycle clear modes (line/screen)',
    //   v => { this._clearMode = v === 'clear-line' ? 'line' : 'screen'; }
    // );
    // addRow(root, 'opts: ',
    //   mkCheckbox('throw ', 'Throw on message timeout', this._throwOnTimeout, v => { this._throwOnTimeout = v; }).label,
    //   clearModeCtl,
    // );

    addRow(root, '',
      ...TESTS.map(t => mkButton(t, `Measure "${formatCodePoints(t)}"`, () => this._probeString(t))),
    );

    const startUi = mkLabeledInput(
      'start:', 'Start code point (hex)', '60px',
      hexToStr(this._genStart),
      v => {
        const n = parseInt(v.trim().replace(/^0x/i, ''), 16);
        if (Number.isNaN(n)) return;
        this._genStart = n;
        if (this._genStart > this._genEnd) {
          this._genEnd = this._genStart;
          endUi.input.value = hexToStr(this._genEnd);
        }
        startUi.input.value = hexToStr(this._genStart);
      },
      { 'marginLeft': '4px' },
    );

    const endUi = mkLabeledInput(
      'end:', 'End code point (hex)', '60px',
      hexToStr(this._genEnd),
      v => {
        const n = parseInt(v.trim().replace(/^0x/i, ''), 16);
        if (Number.isNaN(n)) return;
        this._genEnd = n;
        if (this._genEnd < this._genStart) {
          this._genStart = this._genEnd;
          startUi.input.value = hexToStr(this._genStart);
        }
        endUi.input.value = hexToStr(this._genEnd);
      },
      { 'marginLeft': '4px' },
    );

    this._genButton = mkButton(
      'run', 'Generate tables for range of cps',
      () => {
        if (!this._profile) {
          this._appendLog('[dev] no app profile selected\n');
          return;
        }
        if (this._isGenRunning) {
          this._isGenRunning = false;
          this._genButton!.textContent = 'run';
          this._appendLog('[dev] generation aborted by user\n');
          return;
        }
        this._isGenRunning = true;
        this._genButton!.textContent = 'stop';
        void this._genTables();
      }
    );
    addRow(root, '',
      this._genButton,
      startUi.label,
      endUi.label,
      mkButton('L', 'Load compat table from browser storage',
        async () => {
          if (!this._store || !this._profile) return;
          const storedRanges = this._store.loadRanges() ?? [];
          this._workingTable = new RangeTable(this._profile.tableName, storedRanges);
          this._genStart = storedRanges.at(-1)?.end ?? this._genStart;
          startUi.input.value = hexToStr(this._genStart);
          this._clearLog();
          this._appendLog(`[dev] loaded ${storedRanges.length} stored ranges\n`);
        },
        { marginLeft: '4px' }
      ),
      mkButton('S', 'Save generated compat table to browser storage',
        async () => {
          if (!this._store || !this._profile) return;

          const newRanges = this._workingTable._ranges;
          const existing = this._store.loadRanges() ?? [];

          // only save when data has full measurements
          for (const r of newRanges) {
            const w = r.widths;
            if (w === undefined || w.col === undefined || w.mov === undefined || w.del === undefined) {
              this._clearLog();
              this._appendLog(`[dev] aborting save: incomplete measurements in range 0x${hexToStr(r.start)}..0x${hexToStr(r.end)}\n`);
              return;
            }
          }

          // Merge: existing + newRanges
          const merged = new RangeTable('merged', existing);
          for (const r of newRanges) merged.upsertRange(r);

          this._store.saveRanges(merged._ranges);

          this._clearLog();
          this._appendLog(
            `[dev] saved (merge) new=${newRanges.length} storedWas=${existing.length} merged=${merged._ranges.length}\n`
          );
        }
      ),
      mkButton('C', 'Clear active compat table',
        async () => {
          this._workingTable.clear();
          this._clearLog();
          this._appendLog('[dev] cleared active table (storage unchanged)\n');
        }
      ),
    );

    const detachUi = mkCheckbox('detach ', 'Detach terminal during generation', this._genTermDetach, v => { if (this._isGenRunning) return; this._genTermDetach = v; });
    batchUi = mkCheckbox(
      'batch ', 'Much faster!! Batch payload & widen cols (col only)', this._genColBatching,
      v => {
        if (this._isGenRunning) return;
        this._genColBatching = v;
        if (v) {
          // detachUi.input.checked = true;
          // this._genTermDetach = true;
          colWidthUi.input.checked = true;
          this._measureColWidth = true;
          movWidthUi.input.checked = false;
          this._measureMovWidth = false;
          delWidthUi.input.checked = false;
          this._measureDelWidth = false;
        }
        // if (v) this._setLogEnabled(!v);
      },
    );

    addRow(root, '',
      mkCheckbox('throw ', 'Throw on message timeout', this._throwOnTimeout, v => { this._throwOnTimeout = v; }).label,
      batchUi.label,
      detachUi.label,
      mkCheckbox('audit ', 'Audit/fix generated table for potential bad measurements', this._genAudit, v => { this._genAudit = v; }).label,
      mkCheckbox('log-perf ', 'Log measurement performance during generation', this._genLogPerf, v => { this._genLogPerf = v; }).label,
    );

    this._measureStatusSpan = document.createElement('span');
    addRow(root, 'status: ', this._measureStatusSpan);

    // Output
    const pre = document.createElement('pre');
    pre.textContent = this._profile?.id ? `[dev] app profile = ${this._profile.id}\n` : '[dev] no app profile selected\n';
    this._logEl = pre;
    root.appendChild(pre);

    // first, early attempt at installing the reporter (socket creation is async)
    // alternatively, use mutation observer on visibility
    setTimeout(() => this._tryInstallReporter(), 500);
  }

  private async _setProfile(id: AppId): Promise<void> {
    const oldId = this._profile?.id;
    this._profile = APP_PROFILES.find(p => p.id === id)!;
    if (oldId === this._profile.id) return;
    await this._initProfile();
    this._appendLog(`[dev] app profile = ${this._profile.id}\n`);
    this._store = new BrowserStorage(this._profile);
    this._workingTable = new RangeTable(this._profile.tableName);
  }

  private async _initProfile(): Promise<void> {
    const cmds = this._profile?.init ?? [];

    const s = this._sock ?? this._deps.getSocket();
    if (!s) { this._appendLog('[dev] no socket\n'); return; }

    for (const c of cmds) {
      s.send(c + '\r');
      await new Promise(r => setTimeout(r, 30));
    }
    await new Promise(r => setTimeout(r, 500));

    this._clearLog();
    this._tryInstallReporter();
    this._setLogEnabled(true);
  }

  private _setLogEnabled(enabled: boolean): void {
    if (this._rep) this._rep.logEnabled = enabled;
    this._silentCb.checked = !enabled;
  }

  private _drainLog(): void {
    const lines = this._rep?.log.splice(0);
    if (lines?.length) this._appendLog(lines.join('\n') + '\n');
  }

  private _tryInstallReporter(): void {
    if (this._rep) return;

    this._sock ??= this._deps.getSocket();
    const socket = this._sock;
    if (!socket) return;

    try { socket.binaryType = 'arraybuffer'; } catch {}

    const rep: ISocketReporter = {
      log: [],
      logEnabled: !this._silentCb.checked,
    };

    const origSend = socket.send.bind(socket);
    socket.send = ((data: any) => {
      if (rep.logEnabled) this._logSock(rep, '<<< ', data);
      origSend(data);
    });

    socket.addEventListener('message', (ev: MessageEvent) => {
      if (rep.logEnabled) this._logSock(rep, '>>> ', ev.data);
    });

    this._rep = rep;
  }

  private _inject(data?: string | Uint8Array): void {
    if (!data) return;
    this._tryInstallReporter();
    if (!this._rep) { this._appendLog('[dev] no reporter\n'); return; }
    if (!this._rep.logEnabled) { this._setLogEnabled(true); }
    if (!this._sock) { this._appendLog('[dev] no socketyy\n'); return; }
    if (!this._profile) { this._appendLog('[dev] no profile\n'); return; }

    this._sock.send(data);
  }

  private _appendLog(line: string): void {
    this._log.push(line);

    if (!this._logFlushScheduled) {
      this._logFlushScheduled = true;
      this._logFlushTimer = window.setTimeout(() => this._flushLogNow(), this._logFlushMs);
    }
  }

  private _flushLogNow(): void {
    this._logFlushScheduled = false;
    if (this._logFlushTimer !== undefined) {
      clearTimeout(this._logFlushTimer);
      this._logFlushTimer = undefined;
    }

    this._logEl.textContent = this._log.toString();
  }

  private _clearLog(): void {
    this._log.clear();

    this._logFlushScheduled = false;
    if (this._logFlushTimer !== undefined) {
      clearTimeout(this._logFlushTimer);
      this._logFlushTimer = undefined;
    }

    this._logEl.textContent = '';
  }

  private _logSock(rep: ISocketReporter, prefix: '<<< ' | '>>> ', data: unknown): void {
    const s = escapeForLog(decodeData(data), { zwj: this._showZwj });
    rep.log.push(prefix + s);
    this._drainLog();
  }

  private async _probeString(s: string): Promise<void> {
    if (!this._profile) { this._appendLog('[dev] no profile\n'); return; }
    this._tryInstallReporter();
    if (!this._sock) { this._appendLog('[dev] no socketzz\n'); return; }

    this._clearLog();
    this._appendLog(`[dev] probing "${s}" (${formatCodePoints(s)})\n`);
    this._measureStatusSpan!.textContent = '';

    if (!this._measureColWidth && !this._measureMovWidth && !this._measureDelWidth) {
      this._appendLog('[dev] nothing to measure');
      return;
    }

    const measurer = new Measurer(this._sock, this._profile, this._msgTimeoutPolicy, TEST_PREFIX, TEST_SUFFIX);
    const bar = '----------------------------\n';

    try {
      if (this._measureColWidth) {
        const w = await measurer.run(s, { col: true }, this._genLogPerf);
        this._appendLog(`${bar}col-width: ${w.col}\n${bar}`);
        this._measureStatusSpan.textContent += `col-width: ${w.col}`;
      }

      if (this._measureMovWidth) {
        const w = await measurer.run(s, { mov: true }, this._genLogPerf);
        this._appendLog(`${bar}mov-width: ${w.mov}\n${bar}`);
        if (this._measureColWidth) this._measureStatusSpan.textContent += ', ';
        this._measureStatusSpan.textContent += `mov-width: ${w.mov}`;
      }

      if (this._measureDelWidth) {
        const w = await measurer.run(s, { del: true }, this._genLogPerf);
        this._appendLog(`${bar}del-width: ${w.del}\n${bar}`);
        if (this._measureColWidth || this._measureMovWidth) this._measureStatusSpan.textContent += ', ';
        this._measureStatusSpan.textContent += `del-width: ${w.del}`;
      }
    } finally {
      await measurer.dispose();
    }
  }

  private async _genTables(): Promise<void> {
    if (!this._measureColWidth && !this._measureMovWidth && !this._measureDelWidth) {
      this._appendLog('[dev] nothing to measure\n');
      return;
    }

    if (!this._profile) { this._appendLog('[dev] no profile\n'); return; }

    this._tryInstallReporter();
    const sock = this._sock ?? this._deps.getSocket();
    if (!sock) { this._appendLog('[dev] no socket\n'); return; }

    let resizeLock: IResizeLock | undefined;
    let origSize: { cols: number, rows: number } | undefined;
    if (this._genTermDetach) {
      origSize = { cols: this._terminal.cols, rows: this._terminal.rows };
      this._toggleAttach(false);
      this._terminal.resize(TURBO_COLS, 24);
      resizeLock = installResizeLock(this._terminal);
      resizeLock.setLocked(true);
    }

    const measurer = new Measurer(sock, this._profile, this._msgTimeoutPolicy, TEST_PREFIX, TEST_SUFFIX);
    const compatTable = new RangeTable(this._profile.id + 'CompatTable');

    try {
      this._appendLog(`[dev] gen tables start range=${hexToStr(this._genStart)}..${hexToStr(this._genEnd)}\n`);
      const progress = new ProgressReport(this._genStart, this._genEnd, 1500, this._measureStatusSpan!);
      const skipTable = getSkipTable();
      const measureOpts = { col: this._measureColWidth, mov: this._measureMovWidth, del: this._measureDelWidth };

      if (this._genColBatching) { // col width only, ramped batches
        let width = 0;
        let rampLevel = 0;
        let rampMax = 6;
        const RAMP_LETHARGY = 0;
        const promptCols = 2;
        const marginCols = 2;
        const bookendCols = TEST_PREFIX.length + TEST_SUFFIX.length;
        const budget = TURBO_COLS - promptCols - bookendCols - marginCols;
        const maxBatch = Math.floor(budget / 2);
        rampMax = maxBatch >= 1 ? Math.floor(Math.log2(maxBatch)) : 0;

        for (let cp = this._genStart; cp <= this._genEnd;) {
          if (this._isGenRunning === false) break;
          if (cp > 0x10FFFF) break;
          if (skipTable.has(cp)) { cp++; continue; }

          const ramp = Math.min(Math.max(rampLevel - RAMP_LETHARGY, 0), rampMax);
          const batchSize = (rampLevel === 0) ? 1 : (1 << ramp);

          const { s, outCount, next } = cpBatch(cp, batchSize, this._genEnd);

          const widthTotal = (await measurer.run(s, { col: true }, this._genLogPerf)).col!;

          if (!Number.isFinite(widthTotal)) {
            if (rampLevel === 0) {
              this._appendLog(`[dev] cp=0x${hexToStr(cp)} END: invalid width after retries\n`);
              compatTable.add(cp, { col: NaN });
              cp++;
              progress.update(cp - 1);
            }
            width = 0;
            rampLevel = 0;
            continue;
          }

          if (rampLevel === 0) {
            width = widthTotal;
            rampLevel = 1;
          } else {
            const expectedWidth = width * outCount;
            if (widthTotal !== expectedWidth) {
              width = 0;
              rampLevel = 0;
              continue;
            }
          }

          compatTable.addRange({ start: cp, end: next - 1, widths: { col: width } });

          cp = next;
          progress.update(cp - 1);
          rampLevel = Math.min(rampLevel + 1, rampMax + RAMP_LETHARGY);
        }
      } else {
        for (let cp = this._genStart; cp <= this._genEnd; cp++) {
          if (this._isGenRunning === false) break;
          if (cp > 0x10FFFF) break;
          if (skipTable.has(cp)) continue;

          const measurements = await measurer.run(String.fromCodePoint(cp), measureOpts, this._genLogPerf);
          compatTable.add(cp, measurements);
          progress.update(cp);
        }
      }

      for (const r of compatTable._ranges) {
        this._workingTable.upsertRange(r);
      }

      if (this._genAudit) {
        const singletons: number[] = [];
        for (const r of this._workingTable._ranges) if (r.start === r.end) singletons.push(r.start);

        for (const cp of singletons) {
          // measure it until it's consistent 3x
          let lastWidths: IMeasuredWidths | undefined;
          let consistentCount = 0;
          for (let attempt = 0; attempt < 7; attempt++) {
            const widths = await measurer.run(String.fromCodePoint(cp), measureOpts, this._genLogPerf);
            if (widthsEqual(widths, lastWidths)) {
              consistentCount++;
              if (consistentCount >= 3) break;
            } else {
              lastWidths = widths;
              consistentCount = 1;
            }
          }
          if (consistentCount < 3) {
            this._appendLog(`[dev] audit: cp=0x${hexToStr(cp)} END: could not get consistent measurements\n`);
          } else {
            this._workingTable.upsertRange({ start: cp, end: cp, widths: lastWidths! });
          }
        }
      }

      this._appendLog(`[dev] gen tables complete\n`);
      console.log(this._workingTable.toStr());
      const compactTable = ignoreUnprintablesInTable(this._workingTable, this._profile.tableName + 'Compact');
      const warnStr = `// compact view hides unprintable codepoint islands (lossy, prolly shouldn't use as runtime table)`;
      console.log(`${warnStr}\n${compactTable.toStr()}`);

      if (this._genAudit) {
        let auditWarnings = 0;
        for (const r of this._workingTable._ranges) {
          const wStart = await measurer.run(String.fromCodePoint(r.start), measureOpts, this._genLogPerf);
          const wEnd   = await measurer.run(String.fromCodePoint(r.end), measureOpts, this._genLogPerf);
          if (!widthsEqual(r.widths, wStart)) {
            console.warn(`[audit] start mismatch @ 0x${hexToStr(r.start)} stored=${JSON.stringify(r.widths)} measured=${JSON.stringify(wStart)}`);
            auditWarnings++;
          }
          if (!widthsEqual(r.widths, wEnd)) {
            console.warn(`[audit] end mismatch @ 0x${hexToStr(r.end)} stored=${JSON.stringify(r.widths)} measured=${JSON.stringify(wEnd)}`);
            auditWarnings++;
          }
        }
        if (auditWarnings === 0) console.log('[audit] no issues found');
        else console.warn(`[audit] completed with ${auditWarnings} mismatches`);
      }


    } catch (e) {
      console.error('error during _genTables', e);
    } finally {
      this._isGenRunning = false;
      this._genButton!.textContent = 'run';
      await measurer.dispose();
      if (this._genTermDetach) {
        this._toggleAttach(true);
        resizeLock?.restore();
        if (origSize) {
          this._terminal.resize(origSize.cols, origSize.rows);
        }
      }
    }
  }

  private _toggleAttach(enable: boolean): void {
    if (enable) {
      if (this._addons.attach.instance) return; // assume already enabled
      const s = this._sock ?? this._deps.getSocket();
      if (!s) { this._appendLog('[dev] no socket for attach\n'); return; }
      const attach = new this._addons.attach.ctor(s);
      this._addons.attach.instance = attach;
      this._terminal.loadAddon(attach);
    } else {
      const attach = this._addons.attach.instance;
      attach?.dispose();
      this._addons.attach.instance = undefined;
    }
    this._appendLog(`[dev] attach addon ${enable ? 'enabled' : 'disabled'}\n`);
  }
}

function parseWidthFromCUFMsg(msg?: string, mode: 'sum' | 'last' = 'sum'): number {
  if (!msg) return NaN;

  // match CUF sequences; CR resets the accumulator
  const re = /\r|\x1b\[(\d*)C/g;

  let matched = false;
  let sum = 0;
  let last = NaN;

  for (let m; (m = re.exec(msg)) !== null;) {
    matched = true;

    // If this match is '\r', reset the segment accumulator.
    if (m[0] === '\r') {
      sum = 0;
      matched = false;
      last = NaN;
      continue;
    }

    // Empty means implicit 1 (bash/readline emits ESC[C repeatedly).
    const s = m[1];
    const n = s === '' ? 1 : Number(s);
    if (!Number.isFinite(n)) return NaN;

    sum += n;
    last = n;
  }

  if (!matched) return NaN;
  return mode === 'last' ? last : sum;
}

function parseWidthFromCUBMsg(msg?: string, mode: 'sum' | 'last' = 'sum'): number {
  if (!msg) return NaN;

  const re = /\x1b\[(\d*)D/g;

  let matched = false;
  let sum = 0;
  let last = NaN;

  for (let m; (m = re.exec(msg)) !== null;) {
    matched = true;

    // Empty means implicit 1.
    // should we treat 0 as 1 too?
    const s = m[1];
    const n = s === '' ? 1 : Number(s);
    if (!Number.isFinite(n)) return NaN;

    sum += n;
    last = n;
  }

  if (!matched) return NaN;
  return mode === 'last' ? last : sum;
}

// Count trailing BS (0x08) to get width.
// Note: intentionally ignores any earlier redraw noise; only the *suffix* matters.
function parseWidthFromBSMsg(msg?: string): number {
  if (!msg) return NaN;

  let n = 0;
  for (let i = msg.length - 1; i >= 0; i--) {
    if (msg.charCodeAt(i) === 0x08) n++;
    else break;
  }

  return n > 0 ? n : NaN;
}

const UTF8 = new TextDecoder('utf-8', { fatal: false });

function decodeData(data: unknown): string {
  let s: string;
  if (typeof data === 'string') {
    s = data;
  } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const u8 = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    s = UTF8.decode(u8);
  } else if (data instanceof Blob) {
    s = `<<blob:${data.size}B:${data.type || 'unknown'}>>`;
  } else {
    s = `<<unknown:${Object.prototype.toString.call(data)}>>`;
  }
  return s;
}

function escapeForLog(s: string, opts: { zwj?: boolean } = {}): string {
  // Make control characters visible, plus ZWJ marker.
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if      (cp === 0x0d) out += '\\r';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x09) out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `${hexToStr(cp, '\\x', 2)}`;
    else if (cp === 0x200D && opts.zwj) out += '{zwj}';
    else out += ch;
  }
  return out;
}

// --- HTML factories ---

function mkCheckbox(label: string, title: string, checked: boolean, onChange: (v: boolean) => void): { label: HTMLLabelElement, input: HTMLInputElement } {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = checked;
  i.title = title;
  i.onchange = () => onChange(i.checked);
  l.append(i, label);
  return { label: l, input: i };
}

function mkNumericUpDown(title: string, min: number, max: number, step: number, value: number, onChange?: (v: number) => void): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  i.title = title;
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  if (onChange) i.oninput = () => onChange(+i.value);
  return i;
}

function mkButton(text: string, title: string, onClick: () => void, style?: Partial<CSSStyleDeclaration> | string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  b.style.boxSizing = 'border-box';
  b.style.height = '22px';
  b.style.padding = '0 4px';
  b.style.lineHeight = '1';
  if (style) {
    if (typeof style === 'string') {
      b.style.cssText += (b.style.cssText ? ';' : '') + style;
    } else {
      Object.assign(b.style, style);
    }
  }
  return b;
}

function mkSelect<T extends string>(
  items: { id: T, label: string }[],
  selected: T | null,
  onChange: (id: T) => void,
  title: string,
  placeholder = '-- select --',
): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.title = title;
  sel.add(new Option(placeholder, '', selected === null, selected === null));
  sel.options[0].disabled = true;
  for (const { id, label } of items) sel.add(new Option(label, id, id === selected, id === selected));
  sel.value = selected ?? '';
  sel.onchange = () => onChange(sel.value as T);
  return sel;
}

function mkLabeledInput(label: string, title: string, size: string, value: string, onChange?: (v: string) => void, style?: Partial<CSSStyleDeclaration> | string): { label: HTMLLabelElement, input: HTMLInputElement } {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.title = title;
  i.style.width = size;
  i.value = value;
  if (onChange) i.onchange = () => onChange(i.value);
  l.append(label, i);
  if (style) {
    if (typeof style === 'string') {
      l.style.cssText += (l.style.cssText ? ';' : '') + style;
    } else {
      Object.assign(l.style, style);
    }
  }
  return { label: l, input: i };
}

export function mkRadioCycle(
  items: string[],
  selected: string,
  title: string,
  onChange: (value: string) => void,
): { label: HTMLLabelElement, input: HTMLInputElement } {
  const label = document.createElement('label');
  label.title = title;
  const input = document.createElement('input');
  input.type = 'radio';
  input.checked = true;
  const text = document.createTextNode('');
  let idx = items.indexOf(selected);
  if (idx < 0) idx = 0;
  const render = (): void => { text.nodeValue = `${items[idx]} `; };
  label.addEventListener('click', (e) => {
    e.preventDefault();
    idx = (idx + 1) % items.length;
    render();
    onChange(items[idx]);
  });
  label.append(input, text);
  render();
  return { label, input };
}

function addRow(root: HTMLElement, label: string, ...nodes: (Node | string)[]): void {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  if (label) row.append(label);
  for (const n of nodes) row.append(typeof n === 'string' ? document.createTextNode(n) : n);
  root.append(row);
}

function hexToStr(n?: number[] | number, prefix = '0x', padding = 4): string {
  if (n === undefined) return 'undefined';
  if (Array.isArray(n)) {
    return `[${n.map((x) => hexToStr(x)).join(', ')}]`;
  }
  return `${prefix}${n.toString(16).padStart(padding, '0')}`;
}

function formatCodePoints(s: string): string {
  const cps: string[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    cps.push(`{${hexToStr(cp)}}`);
  }
  return cps.join('');
}

interface IMeasuredWidths { col?: number, mov?: number, del?: number }
function widthsEqual(a?: IMeasuredWidths, b?: IMeasuredWidths): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (!Object.is(a.col, b.col)) return false;
  if (!Object.is(a.mov, b.mov)) return false;
  if (!Object.is(a.del, b.del)) return false;
  return true;
}

interface IMeasuredRange { start: number, end: number, widths?: IMeasuredWidths }
type CanMergeRangeFn = (last: IMeasuredRange, next: IMeasuredRange) => boolean;

class RangeTable {
  public _ranges: IMeasuredRange[] = [];
  private static _canMergeFn: CanMergeRangeFn = (last, next) => widthsEqual(last.widths, next.widths);

  constructor(public label: string, initialRanges: IMeasuredRange[] = []) {
    for (const r of initialRanges) {
      this.addRange(r);
    }
  }

  // public get ranges(): ReadonlyArray<IMeasuredRange> { return this._ranges; }

  public clear(): void { this._ranges.length = 0; }

  public add(cp: number, m: IMeasuredWidths = {}): void {
    const last = this._ranges[this._ranges.length - 1];
    if (!last) {
      this._ranges.push({ start: cp, end: cp, widths: { ...m } });
      return;
    }

    if (cp <= last.end) throw new Error(`RangeTable.add: ${cp} out-of-order or duplicate`);

    if (cp === last.end + 1 && widthsEqual(last.widths, m)) {
      last.end = cp;
      return;
    }
    this._ranges.push({ start: cp, end: cp, widths: { ...m } });
  }

  public addRange(next: IMeasuredRange, canMergeAdjacent = RangeTable._canMergeFn): void {
    const { start, end, widths: w } = next;
    if (start > end) throw new Error(`addRange invalid ${start}..${end}`);

    const last = this._ranges[this._ranges.length - 1];
    if (!last) {
      this._ranges.push({ start, end, widths: w ? { ...w } : undefined });
      return;
    }

    if (start <= last.end) throw new Error(`RangeTable.addRange: ${start}..${end} out-of-order or overlapping`);

    if (next.start === last.end + 1 && canMergeAdjacent(last, next)) {
      last.end = next.end;
      return;
    }

    this._ranges.push({ start, end, widths: w ? { ...w } : undefined });
  }

  public upsertRange(x: IMeasuredRange, canMergeAdjacent: CanMergeRangeFn = RangeTable._canMergeFn): void {
    const { start: xs, end: xe, widths: xw } = x;
    if (xs > xe) throw new Error(`upsertRange invalid ${xs}..${xe}`);

    const out: IMeasuredRange[] = [];
    let inserted = false;

    const push = (r: IMeasuredRange): void => {
      const last = out[out.length - 1];
      if (last && last.end + 1 === r.start && canMergeAdjacent(last, r)) {
        last.end = r.end; // merge
        return;
      }
      out.push({ start: r.start, end: r.end, widths: r.widths ? { ...r.widths } : undefined });
    };

    const paint: IMeasuredRange = { start: xs, end: xe, widths: xw ? { ...xw } : undefined };

    for (const r of this._ranges) {
      // r fully left of x
      if (r.end < xs) {
        push(r);
        continue;
      }

      // r fully right of x
      if (r.start > xe) {
        if (!inserted) {
          push(paint);
          inserted = true;
        }
        push(r);
        continue;
      }

      // overlap: keep left remainder
      if (r.start < xs) {
        push({ start: r.start, end: xs - 1, widths: r.widths });
      }

      // overlap: keep right remainder
      if (r.end > xe) {
        if (!inserted) {
          push(paint);
          inserted = true;
        }
        push({ start: xe + 1, end: r.end, widths: r.widths });
      }
      // fully covered middle is dropped (painted over)
    }

    if (!inserted) {
      push(paint);
    }

    // mutate in place
    this._ranges.length = 0;
    this._ranges.push(...out);
  }

  public toStr(): string {
    const out: string[] = [];

    const cpCount = this._ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    out.push(`// [ranges=${this._ranges.length}; codePoints=${cpCount}]`);
    out.push(`const ${this.label}: IMeasuredRange[] = [`);

    for (const { start, end, widths: m } of this._ranges) {
      const sHex = hexToStr(start);
      const eHex = hexToStr(end);

      const fields: string[] = [];
      if (m?.col !== undefined) fields.push(`col: ${m.col}`);
      if (m?.mov !== undefined) fields.push(`mov: ${m.mov}`);
      if (m?.del !== undefined) fields.push(`del: ${m.del}`);

      const meas = fields.length ? `{ ${fields.join(', ')} }` : `{}`;
      out.push(`  { start: ${sHex}, end: ${eHex}, widths: ${meas} },`);
    }

    out.push('];');
    out.push('');
    return out.join('\n');
  }

  public has(cp?: number): boolean {
    if (!this._ranges.length || (cp === undefined)) {
      return false;
    }

    let lo = 0;
    let hi = this._ranges.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const { start, end } = this._ranges[mid];

      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return true;
    }

    return false;
  }
}

let skipTable: RangeTable | undefined;
function getSkipTable(): RangeTable {
  if (skipTable) return skipTable;
  const t = new RangeTable('skip');
  t.addRange({ start: 0x0000, end: 0x001F }); // C0
  t.addRange({ start: 0x007F, end: 0x009F }); // DEL + C1
  t.addRange({ start: 0xD800, end: 0xDFFF }); // surrogates

  skipTable = t;
  return t;
}

function cpBatch(start: number, wantCount: number, end: number): { s: string, outCount: number, next: number } {
  if (start > 0x10FFFF) return { s: '', outCount: 0, next: start };

  const skipTable = getSkipTable();
  if (skipTable.has(start)) {
    throw new Error(`cpBatch invalid start in skip table: ${hexToStr(start)}`);
  }

  let cp = start;
  let outCount = 0;
  const out: string[] = [];

  while (outCount < wantCount && cp <= end && cp <= 0x10ffff) {
    out.push(String.fromCodePoint(cp));
    outCount++;
    cp++;
    if (skipTable.has(cp)) break;
  }
  return { s: out.join(''), outCount, next: cp };
}

function cpRangeCount(start: number, end: number): number {
  if (end < start) return 0;

  let count = end - start + 1;
  for (const r of getSkipTable()._ranges) {
    const ovStart = Math.max(start, r.start);
    const ovEnd = Math.min(end, r.end);
    const overlap = ovStart <= ovEnd ? (ovEnd - ovStart + 1) : 0;
    count -= overlap;
  }

  return count;
}

class CircularList {
  private _buf: string[] = [];
  private _head = 0;

  constructor(private readonly _max: number) {}

  public push(s: string): void {
    this._buf.push(s);

    const live = this._buf.length - this._head;
    const over = live - this._max;
    if (over > 0) this._head += over;

    // Compact occasionally
    if (this._head > 1024 && this._head * 2 > this._buf.length) {
      this._buf = this._buf.slice(this._head);
      this._head = 0;
    }
  }

  public clear(): void {
    this._buf.length = 0;
    this._head = 0;
  }

  public toString(): string {
    return this._buf.slice(this._head).join('');
  }
}

class ProgressReport {
  private _t0 = performance.now();
  private _lastRenderT = 0;
  private _total: number;

  constructor(
    private _start: number,
    private _end: number,
    private _updateEveryMs: number,
    private _el: HTMLElement,
  ) {
    this._total = cpRangeCount(this._start, this._end);
  }

  public update(cp: number): void {
    const now = performance.now();
    if ((now - this._lastRenderT) >= this._updateEveryMs || cp === this._end) {
      this._lastRenderT = now;
      const done = cpRangeCount(this._start, cp);
      const elapsed = now - this._t0;

      const report = done === this._total
        ? `${done}/${this._total} in ${ProgressReport.formatElapsed(elapsed)} (check console!)`
        : `${done}/${this._total} (${ProgressReport.formatElapsed(elapsed)})`;
      this._el.textContent = report;
    }
  }

  public static formatElapsed(ms: number): string {
    // coarse, readable
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;

    const m = Math.floor(s / 60);
    const ss = s % 60;
    if (m < 60) return `${m}m ${ss.toString().padStart(2, '0')}s`;

    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm.toString().padStart(2, '0')}m`;
  }
}

interface IResizeLock { setLocked(v: boolean): void, restore(): void }

function installResizeLock(term: Terminal): IResizeLock {
  let lock = false;

  const origResize = term.resize.bind(term);

  term.resize = ((cols: number, rows: number) => {
    if (lock) return;
    origResize(cols, rows);
  });

  return {
    setLocked(v: boolean) { lock = v; },
    restore() { term.resize = origResize; }
  };
}

class MessageReader {
  private _pending?: { until: (msg: string) => boolean, resolve: (msg: string | undefined) => void, timer: number };

  constructor(private readonly _socket: WebSocket, private _policy: IMsgReaderTimeoutPolicy) {
    _socket.addEventListener('message', this._msgHandler);
  }

  private _msgHandler = (ev: MessageEvent): void => {
    const msg = decodeData(ev.data);
    if (this._pending?.until(msg)) {
      const w = this._pending;
      this._pending = undefined;
      window.clearTimeout(w.timer);
      w.resolve(msg);
    }
  };

  public readUntil: MessageAwaiter = (until, timeoutMs, reportTimeout = true) => {
    if (this._pending) {
      throw new Error('MessageReader.readUntl called while another waiter is pending');
    }

    return new Promise<string | undefined>((resolve) => {
      const timer = window.setTimeout(() => {
        this._pending = undefined;
        if (reportTimeout) {
          const msg = `timeout waiting for socket message (${timeoutMs}ms)`;
          if (this._policy.shouldThrowOnTimeout()) throw new Error(msg);
          console.error(msg);
        }
        resolve(undefined);
      }, timeoutMs);

      this._pending = { until, resolve, timer };
    });
  };

  public dispose(): void {
    this._socket.removeEventListener('message', this._msgHandler);

    if (this._pending) {
      this._pending.resolve(undefined);
      window.clearTimeout(this._pending.timer);
      this._pending = undefined;
    }
  }
}

const RE_CUB = /\x1b\[(\d*)D/;                  // CUB: cursor back n
const RE_CUF = /\x1b\[(\d*)C/;                  // CUF: cursor forward n
const RE_TAIL_CR_CUF = /\r(?:\x1b\[(\d*)C)+$/;  // tail CR + CUF only
const RE_CUP = /\x1b\[(\d+);(\d+)H/;            // CUP: cursor position r;c
const RE_BS_ONLY = /^\x08+$/;                   // BS: only backspaces
const RE_TRAILING_BS = /\x08+$/;                // backspaces at end of msg
const RE_CUV = /\x1b\[(\d*)[AB]/;               // any vertical movement (CUU/CUD)

interface IMeasureState {
  promptWidth?: number;
  homeOffset?: number;   // expect 0 when HOME ack succeeds
  endOffset?: number;    // measured after END
  content?: string;
}

interface IMeasureOpt { col?: boolean, mov?: boolean, del?: boolean }
type MeasureFn = (payload: string) => Promise<number>;

class Measurer {
  private _msgReader: MessageReader;
  private _readUntil: MessageAwaiter;
  private _state: IMeasureState = {};
  private _runAttempts = 5;
  private _runCount = 0;

  constructor(
    private _socket: WebSocket,
    private _profile: IAppProfile,
    private _timeoutPolicy: IMsgReaderTimeoutPolicy,
    private _prefix: string,
    private _suffix: string,
  ) {
    this._msgReader = new MessageReader(this._socket, this._timeoutPolicy);
    this._readUntil = this._msgReader.readUntil;

    for (const ch of this._prefix + this._suffix) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || cp > 0xff || (cp >= 0x7f && cp <= 0x9f)) {
        throw new Error(`Measurer: marker chars must be in [0x20..0xFF] excluding [0x7F..0x9F]; got ${hexToStr(cp)}`);
      }
    }
  }

  public async run(payload: string, measure: IMeasureOpt, logPerf: boolean): Promise<IMeasuredWidths> {
    if (logPerf) this._runPerfLogger();
    await this._runUpkeep();

    const m: IMeasuredWidths = {};
    if (measure.col) m.col = await this._retry(this._runAttempts, () => this._measureColWidth(payload));
    if (measure.mov) m.mov = await this._retry(this._runAttempts, () => this._measureMovWidth(payload));
    if (measure.del) m.del = await this._retry(this._runAttempts, () => this._measureDelWidth(payload));

    this._runCount++;
    return m;
  }

  private _lastReject?: { attempt: number, value: number };
  private async _retry(maxAttempts: number, fn: () => Promise<number>): Promise<number> {
    this._lastReject = undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fn();
      if (Number.isFinite(res) && res >= 0) return res;
      this._lastReject = { attempt, value: res };
      this._invalidateState();
    }
    return NaN;
  }

  public async dispose(): Promise<void> {
    try {
      await this._clearLine();
    } catch { } finally {
      this._msgReader.dispose();
    }
  }

  private async _runUpkeep(): Promise<void> {
    const upkeep = this._profile.upkeep;
    if (!upkeep) return;
    if ((this._runCount % upkeep.everyRuns) !== 0) return;
    await this._clearLine(); // ensure upkeepCmd is performed on clean line
    this._socket.send(upkeep.cmd);
    this._invalidateState(); // don't trust upkeep to preserve state
    await this._readUntil(() => true, upkeep.timeoutMs, false); // assume some ack
    await this._clearScreen(); // ensure clean slate after upkeep
    await this._readUntil(() => true, 30, false); // wait for some clearscreen ack
  }

  private _runPerfLogger(): void {
    const REC_EVERY = 1000;
    const self = this as any; // stash state on instance without touching class fields
    if (!self.__rec) self.__rec = { t0: performance.now(), lastT: performance.now(), lastN: 0 };
    const rec = self.__rec;
    const n = this._runCount;

    if (n > 0 && (n % REC_EVERY) === 0) {
      const now = performance.now();
      const dt = (now - rec.lastT) / 1000;
      const dN = n - rec.lastN;
      const total = (now - rec.t0) / 1000;
      const rps = dN / dt;
      const msPer = (now - rec.lastT) / dN;
      console.log(`[meas] n=${n}  +${dN} in ${dt.toFixed(1)}s  rps=${rps.toFixed(1)}  ms/run=${msPer.toFixed(2)}  t=${total.toFixed(1)}s`);
      rec.lastT = now;
      rec.lastN = n;
    }
  }

  private static _isHomeAck(msg: string): boolean {
    const isCursorMove = RE_CUB.test(msg) || RE_TRAILING_BS.test(msg) || RE_CUP.test(msg) || RE_TAIL_CR_CUF.test(msg) || RE_CUV.test(msg);
    if (!isCursorMove) return false;
    // if (msg.includes(TEST_PREFIX) || msg.includes(TEST_SUFFIX)) return false;
    // if (/[^\x00-\x7f]/.test(msg)) return false;
    return true;
  }

  private static _isEndAck(msg: string): boolean {
    const isCursorMove = RE_CUF.test(msg) || RE_CUP.test(msg) || RE_TAIL_CR_CUF.test(msg);
    if (!isCursorMove) return false;
    // if (msg.includes(TEST_PREFIX) || msg.includes(TEST_SUFFIX)) return false;
    // if (/[^\x00-\x7f]/.test(msg)) return false;
    return true;
  }

  private static _isLeftAck(msg: string): boolean {
    return Measurer._isHomeAck(msg);
  }

  private static _isDeleteAck(msg: string): boolean {
    return (
      msg.includes('\x08') ||            // BS anywhere (covers BS+EL, BS+spaces+BS, etc.)
      RE_CUB.test(msg) ||
      RE_CUF.test(msg) ||
      RE_CUP.test(msg) ||
      RE_TAIL_CR_CUF.test(msg) ||
      /\x1b\[K/.test(msg) ||            // EL (erase to line end)
      /\x1b\[\d*P/.test(msg)            // DCH (delete char) variants
    );
  }

  private static _isClearScreenAck(m: string): boolean {
    return (
      /\x1b\[\d*J/.test(m) ||
      /\x1b\[\d*H/.test(m) ||
      /\r/.test(m)
    );
  }

  private _invalidateState(): void {
    this._state.content = undefined;
    this._state.homeOffset = undefined;
    this._state.endOffset = undefined;
    // this._state.promptWidth = undefined; // keep promptWidth if known
  }

  private async _clearLine(): Promise<void> {
    if (this._state.content === '') return;

    if (this._profile.clearLineNeedsEnd && this._state.endOffset !== 0) {
      this._socket.send(this._profile.keys.end);
      await this._readUntil(() => true, 20, false);
    }

    this._socket.send(this._profile.keys.clearLine);
    await this._readUntil(() => true, 300, false);

    this._state.content = '';
    this._state.homeOffset = 0;
    this._state.endOffset = 0;
  }

  private async _clearScreen(): Promise<{ ok: boolean }> {
    this._socket.send(this._profile.keys.clearScreen);
    if (this._state.content) {
      const ack = await this._readUntil(m => m.includes(this._suffix), 1500);
      if (!ack) { this._invalidateState(); return { ok: false }; }
    } else {
      const ack = await this._readUntil(Measurer._isClearScreenAck, 1500);
      if (!ack) { this._invalidateState(); return { ok: false };}
    }
    return { ok: true };
  }

  private async _input(payload: string, prefix: string, suffix: string): Promise<{ok: boolean}> {
    const content = prefix + payload + suffix;
    if (this._state.content === content) return { ok: true };
    if (this._state.content !== '') await this._clearLine();

    this._socket.send(content);
    const ack = await this._readUntil(m => m.includes(suffix), 1000);
    if (!ack) {
      this._invalidateState(); return { ok: false };
    }

    this._state.endOffset = 0;
    this._state.homeOffset = undefined;
    this._state.content = content;
    return { ok: true };
  }

  private async _home(): Promise<{ ok: boolean }> {
    if (this._state.homeOffset === 0) return { ok: true };

    // Send HOME
    this._socket.send(this._profile.keys.home);
    const ack = await this._readUntil(Measurer._isHomeAck, 1100);
    if (!ack || RE_CUV.test(ack)) { // CUU on HOME when ramping means wrapping occurred
      this._invalidateState(); return { ok: false };
    }

    // HOME defines homeOffset
    const prevHomeOffset = this._state.homeOffset;
    this._state.homeOffset = 0;

    // learn promptWidth if we can
    const cup = ack.match(RE_CUP);
    if (cup) {
      const col = Number.parseInt(cup[2], 10);
      this._state.promptWidth = Number.isFinite(col) ? col - 1 : undefined;
    } else if (RE_TAIL_CR_CUF.test(ack)) {
      const n = parseWidthFromCUFMsg(ack);
      this._state.promptWidth = Number.isFinite(n) ? n : undefined;
    }

    // If we are not anchored to end, we can't update endOffset in this coordinate scheme.
    if (this._state.endOffset === undefined) {
      return { ok: true };
    }

    // How far did we move left from the previous position to reach HOME?
    const deltaLeft =
      RE_CUB.test(ack) ? parseWidthFromCUBMsg(ack)
        : RE_BS_ONLY.test(ack) ? parseWidthFromBSMsg(ack)
          : prevHomeOffset !== undefined ? prevHomeOffset
            : NaN;

    if (!Number.isFinite(deltaLeft)) {
      // can happen if HOME ack is absolute and we don't have previous info
      this._state.endOffset = undefined;
      return { ok: true };
    }

    this._state.endOffset += deltaLeft;
    return { ok: true };
  }

  private async _end(): Promise<{ ok: boolean }> {
    if (this._state.endOffset === 0) return { ok: true };

    // Send END
    this._socket.send(this._profile.keys.end);
    const ack = await this._readUntil(Measurer._isEndAck, 1200);
    if (!ack) return { ok: false };

    // END defines endOffset
    const prevEndOffset = this._state.endOffset;
    this._state.endOffset = 0;

    // How far did we move right from the previous position to reach END?
    let deltaRight: number = NaN;
    if (this._state.homeOffset === undefined) { // can't update without homeOffset
      return { ok: true };
    }

    // ABSOLUTE position
    let absCol: number | undefined;
    const cup = ack.match(RE_CUP);
    if (cup) {
      absCol = Number.parseInt(cup[2], 10);
    } else if (RE_TAIL_CR_CUF.test(ack)) {
      absCol = parseWidthFromCUFMsg(ack) + 1;
    }

    // Compute deltaRight from absolute or relative movement
    if (absCol !== undefined) {
      if (this._state.promptWidth === undefined) { // need promptWidth to compute homeOffset
        this._invalidateState(); return { ok: false };
      }
      const newHomeOffset = (absCol - 1) - this._state.promptWidth;
      deltaRight = newHomeOffset - this._state.homeOffset;
    } else if (RE_CUF.test(ack)) {
      deltaRight = parseWidthFromCUFMsg(ack);
    } else if (prevEndOffset !== undefined) {
      deltaRight = prevEndOffset;
    }

    // Update homeOffset from deltaRight
    if (!Number.isFinite(deltaRight)) { this._invalidateState(); return { ok: false }; }
    this._state.homeOffset += deltaRight;
    return { ok: true };
  }

  private async _left(): Promise<{ ok: boolean }> {
    this._socket.send(this._profile.keys.left);
    const ack = await this._readUntil(Measurer._isLeftAck, 900);
    if (!ack) return { ok: false };

    // If neither coordinate is known, we can't update anything.
    if (this._state.homeOffset === undefined && this._state.endOffset === undefined) {
      return { ok: false };
    }

    let deltaLeft: number = NaN;

    // ABSOLUTE position
    let absCol: number | undefined;
    const cup = ack.match(RE_CUP);
    if (cup) {
      absCol = Number.parseInt(cup[2], 10);
    } else if (RE_TAIL_CR_CUF.test(ack)) {
      absCol = parseWidthFromCUFMsg(ack) + 1;
    }

    // Compute deltaLeft from absolute or relative movement
    if (absCol !== undefined) {
      if (this._state.promptWidth === undefined) { // need promptWidth to compute homeOffset
        this._invalidateState(); return { ok: false };
      }
      if (this._state.homeOffset === undefined) { // shouldn't happen if we have abs pos
        this._invalidateState(); return { ok: false };
      }
      const newHomeOffset = (absCol - 1) - this._state.promptWidth;
      deltaLeft = this._state.homeOffset - newHomeOffset;
    } else {
      deltaLeft =
        RE_CUF.test(ack) ? -parseWidthFromCUFMsg(ack)
          : RE_CUB.test(ack) ? +parseWidthFromCUBMsg(ack)
            : RE_BS_ONLY.test(ack) ? +parseWidthFromBSMsg(ack)
              : NaN;
    }

    if (!Number.isFinite(deltaLeft) || deltaLeft < 0) { // something went wrong
      this._invalidateState(); return { ok: false };
    }

    // Update coordinates
    if (this._state.homeOffset !== undefined) this._state.homeOffset -= deltaLeft;
    if (this._state.endOffset !== undefined) this._state.endOffset += deltaLeft;
    return { ok: true };
  }

  private async _delete(): Promise<{ ok: boolean }> {
    this._socket.send(this._profile.keys.del);
    const ack = await this._readUntil(Measurer._isDeleteAck, 900);
    if (!ack) {
      this._invalidateState(); return { ok: false };
    }

    this._invalidateState();
    return { ok: true };
  }

  private async _ensureHomeOffset(): Promise<{ ok: boolean }> {
    if (this._state.homeOffset !== undefined) return { ok: true };
    return await this._home();
  }

  private async _ensureEndOffset(): Promise<{ ok: boolean }> {
    if (this._state.endOffset !== undefined) return { ok: true };
    return await this._end();
  }

  private _measureColWidth: MeasureFn = async (payload: string): Promise<number> => {
    let res = await this._input(payload, this._prefix, this._suffix);
    if (!res.ok) return NaN;

    res = await this._ensureHomeOffset(); if (!res.ok) return NaN;
    res = await this._ensureEndOffset(); if (!res.ok) return NaN;

    if (this._state.homeOffset !== undefined && this._state.endOffset !== undefined) {
      return this._state.homeOffset + this._state.endOffset - (this._prefix.length + this._suffix.length);
    }

    return NaN;
  };

  private _measureMovWidth: MeasureFn = async (payload: string): Promise<number> => {
    let res = await this._input(payload, this._prefix, this._suffix);
    if (!res.ok) return NaN;

    res = await this._ensureHomeOffset(); if (!res.ok) return NaN;
    res = await this._end(); if (!res.ok) return NaN;

    // We need total width as homeOffset so we can walk it down to 0 via LEFT presses.
    if (this._state.homeOffset === undefined) return NaN;

    let leftCount = 0;
    const MAX_LEFT = 10 * this._state.content!.length; // large enough for even zsh 8 hex + 2 <>
    while (this._state.homeOffset !== 0 && leftCount < MAX_LEFT) {
      // console.log(`measureState before LEFT #${leftCount + 1}:`, state);

      res = await this._left(); if (!res.ok) return NaN;

      if (this._state.homeOffset === undefined) return NaN; // lost coord
      if (this._state.homeOffset < 0) return NaN; // overshot

      leftCount++;
    }

    if (this._state.homeOffset !== 0) return NaN;

    // Subtract the ASCII scaffolding.
    return leftCount - (this._prefix.length + this._suffix.length);
  };

  private _measureDelWidth: MeasureFn = async (payload: string): Promise<number> => {
    const prefixNorm = this._prefix.length === 1 ? this._prefix + this._prefix : this._prefix;

    let res = await this._input(payload, prefixNorm, this._suffix);
    if (!res.ok) return NaN;

    res = await this._ensureHomeOffset(); if (!res.ok) return NaN;
    res = await this._end(); if (!res.ok) return NaN;

    if (this._state.homeOffset === undefined) return NaN;

    let nDel = 0;
    const MAX_DEL = 10 * this._state.content!.length; // large enough for even zsh 8 hex + 2 <>
    while (nDel < MAX_DEL) {
      // console.log(`measureState before DEL #${nDel + 1}:`, state);
      res = await this._delete(); if (!res.ok) return NaN;
      nDel++;

      // re-anchor HOME then END
      res = await this._home(); if (!res.ok) return NaN;
      res = await this._end(); if (!res.ok) return NaN;

      if (this._state.homeOffset === undefined) return NaN; // lost coord somehow
      if (this._state.homeOffset === prefixNorm.length - 1) {
        return nDel - ((prefixNorm.length - 1) + this._suffix.length);
      }
      if (this._state.homeOffset < 0) {
        return NaN; // overshot somehow
      }
    }

    return NaN;
  };
}

const unprintableRanges = [
  { start: 0x0001, end: 0x001f },
  { start: 0x007f, end: 0x009f },
  { start: 0x0378, end: 0x0379 },
  { start: 0x0380, end: 0x0383 },
  { start: 0x038b, end: 0x038b },
  { start: 0x038d, end: 0x038d },
  { start: 0x03a2, end: 0x03a2 },
  { start: 0x0530, end: 0x0530 },
  { start: 0x0557, end: 0x0558 },
  { start: 0x058b, end: 0x058c },
  { start: 0x0590, end: 0x0590 },
  { start: 0x05c8, end: 0x05cf },
  { start: 0x05eb, end: 0x05ee },
  { start: 0x05f5, end: 0x05ff },
  { start: 0x070e, end: 0x070e },
  { start: 0x074b, end: 0x074c },
  { start: 0x07b2, end: 0x07bf },
  { start: 0x07fb, end: 0x07fc },
  { start: 0x082e, end: 0x082f },
  { start: 0x083f, end: 0x083f },
  { start: 0x085c, end: 0x085d },
  { start: 0x085f, end: 0x085f },
  { start: 0x086b, end: 0x086f },
  { start: 0x088f, end: 0x088f },
  { start: 0x0892, end: 0x0897 },
  { start: 0x0984, end: 0x0984 },
  { start: 0x098d, end: 0x098e },
  { start: 0x0991, end: 0x0992 },
  { start: 0x09a9, end: 0x09a9 },
  { start: 0x09b1, end: 0x09b1 },
  { start: 0x09b3, end: 0x09b5 },
  { start: 0x09ba, end: 0x09bb },
  { start: 0x09c5, end: 0x09c6 },
  { start: 0x09c9, end: 0x09ca },
  { start: 0x09cf, end: 0x09d6 },
  { start: 0x09d8, end: 0x09db },
  { start: 0x09de, end: 0x09de },
  { start: 0x09e4, end: 0x09e5 },
  { start: 0x09ff, end: 0x0a00 },
  { start: 0x0a04, end: 0x0a04 },
  { start: 0x0a0b, end: 0x0a0e },
  { start: 0x0a11, end: 0x0a12 },
  { start: 0x0a29, end: 0x0a29 },
  { start: 0x0a31, end: 0x0a31 },
  { start: 0x0a34, end: 0x0a34 },
  { start: 0x0a37, end: 0x0a37 },
  { start: 0x0a3a, end: 0x0a3b },
  { start: 0x0a3d, end: 0x0a3d },
  { start: 0x0a43, end: 0x0a46 },
  { start: 0x0a49, end: 0x0a4a },
  { start: 0x0a4e, end: 0x0a50 },
  { start: 0x0a52, end: 0x0a58 },
  { start: 0x0a5d, end: 0x0a5d },
  { start: 0x0a5f, end: 0x0a65 },
  { start: 0x0a77, end: 0x0a80 },
  { start: 0x0a84, end: 0x0a84 },
  { start: 0x0a8e, end: 0x0a8e },
  { start: 0x0a92, end: 0x0a92 },
  { start: 0x0aa9, end: 0x0aa9 },
  { start: 0x0ab1, end: 0x0ab1 },
  { start: 0x0ab4, end: 0x0ab4 },
  { start: 0x0aba, end: 0x0abb },
  { start: 0x0ac6, end: 0x0ac6 },
  { start: 0x0aca, end: 0x0aca },
  { start: 0x0ace, end: 0x0acf },
  { start: 0x0ad1, end: 0x0adf },
  { start: 0x0ae4, end: 0x0ae5 },
  { start: 0x0af2, end: 0x0af8 },
  { start: 0x0b00, end: 0x0b00 },
  { start: 0x0b04, end: 0x0b04 },
  { start: 0x0b0d, end: 0x0b0e },
  { start: 0x0b11, end: 0x0b12 },
  { start: 0x0b29, end: 0x0b29 },
  { start: 0x0b31, end: 0x0b31 },
  { start: 0x0b34, end: 0x0b34 },
  { start: 0x0b3a, end: 0x0b3b },
  { start: 0x0b45, end: 0x0b46 },
  { start: 0x0b49, end: 0x0b4a },
  { start: 0x0b4e, end: 0x0b54 },
  { start: 0x0b58, end: 0x0b5b },
  { start: 0x0b5e, end: 0x0b5e },
  { start: 0x0b64, end: 0x0b65 },
  { start: 0x0b78, end: 0x0b81 },
  { start: 0x0b84, end: 0x0b84 },
  { start: 0x0b8b, end: 0x0b8d },
  { start: 0x0b91, end: 0x0b91 },
  { start: 0x0b96, end: 0x0b98 },
  { start: 0x0b9b, end: 0x0b9b },
  { start: 0x0b9d, end: 0x0b9d },
  { start: 0x0ba0, end: 0x0ba2 },
  { start: 0x0ba5, end: 0x0ba7 },
  { start: 0x0bab, end: 0x0bad },
  { start: 0x0bba, end: 0x0bbd },
  { start: 0x0bc3, end: 0x0bc5 },
  { start: 0x0bc9, end: 0x0bc9 },
  { start: 0x0bce, end: 0x0bcf },
  { start: 0x0bd1, end: 0x0bd6 },
  { start: 0x0bd8, end: 0x0be5 },
  { start: 0x0bfb, end: 0x0bff },
  { start: 0x0c0d, end: 0x0c0d },
  { start: 0x0c11, end: 0x0c11 },
  { start: 0x0c29, end: 0x0c29 },
  { start: 0x0c3a, end: 0x0c3b },
  { start: 0x0c45, end: 0x0c45 },
  { start: 0x0c49, end: 0x0c49 },
  { start: 0x0c4e, end: 0x0c54 },
  { start: 0x0c57, end: 0x0c57 },
  { start: 0x0c5b, end: 0x0c5c },
  { start: 0x0c5e, end: 0x0c5f },
  { start: 0x0c64, end: 0x0c65 },
  { start: 0x0c70, end: 0x0c76 },
  { start: 0x0c8d, end: 0x0c8d },
  { start: 0x0c91, end: 0x0c91 },
  { start: 0x0ca9, end: 0x0ca9 },
  { start: 0x0cb4, end: 0x0cb4 },
  { start: 0x0cba, end: 0x0cbb },
  { start: 0x0cc5, end: 0x0cc5 },
  { start: 0x0cc9, end: 0x0cc9 },
  { start: 0x0cce, end: 0x0cd4 },
  { start: 0x0cd7, end: 0x0cdc },
  { start: 0x0cdf, end: 0x0cdf },
  { start: 0x0ce4, end: 0x0ce5 },
  { start: 0x0cf0, end: 0x0cf0 },
  { start: 0x0cf3, end: 0x0cff },
  { start: 0x0d0d, end: 0x0d0d },
  { start: 0x0d11, end: 0x0d11 },
  { start: 0x0d45, end: 0x0d45 },
  { start: 0x0d49, end: 0x0d49 },
  { start: 0x0d50, end: 0x0d53 },
  { start: 0x0d64, end: 0x0d65 },
  { start: 0x0d80, end: 0x0d80 },
  { start: 0x0d84, end: 0x0d84 },
  { start: 0x0d97, end: 0x0d99 },
  { start: 0x0db2, end: 0x0db2 },
  { start: 0x0dbc, end: 0x0dbc },
  { start: 0x0dbe, end: 0x0dbf },
  { start: 0x0dc7, end: 0x0dc9 },
  { start: 0x0dcb, end: 0x0dce },
  { start: 0x0dd5, end: 0x0dd5 },
  { start: 0x0dd7, end: 0x0dd7 },
  { start: 0x0de0, end: 0x0de5 },
  { start: 0x0df0, end: 0x0df1 },
  { start: 0x0df5, end: 0x0e00 },
  { start: 0x0e3b, end: 0x0e3e },
  { start: 0x0e5c, end: 0x0e80 },
  { start: 0x0e83, end: 0x0e83 },
  { start: 0x0e85, end: 0x0e85 },
  { start: 0x0e8b, end: 0x0e8b },
  { start: 0x0ea4, end: 0x0ea4 },
  { start: 0x0ea6, end: 0x0ea6 },
  { start: 0x0ebe, end: 0x0ebf },
  { start: 0x0ec5, end: 0x0ec5 },
  { start: 0x0ec7, end: 0x0ec7 },
  { start: 0x0ece, end: 0x0ecf },
  { start: 0x0eda, end: 0x0edb },
  { start: 0x0ee0, end: 0x0eff },
  { start: 0x0f48, end: 0x0f48 },
  { start: 0x0f6d, end: 0x0f70 },
  { start: 0x0f98, end: 0x0f98 },
  { start: 0x0fbd, end: 0x0fbd },
  { start: 0x0fcd, end: 0x0fcd },
  { start: 0x0fdb, end: 0x0fff },
  { start: 0x10c6, end: 0x10c6 },
  { start: 0x10c8, end: 0x10cc },
  { start: 0x10ce, end: 0x10cf },
  { start: 0x1249, end: 0x1249 },
  { start: 0x124e, end: 0x124f },
  { start: 0x1257, end: 0x1257 },
  { start: 0x1259, end: 0x1259 },
  { start: 0x125e, end: 0x125f },
  { start: 0x1289, end: 0x1289 },
  { start: 0x128e, end: 0x128f },
  { start: 0x12b1, end: 0x12b1 },
  { start: 0x12b6, end: 0x12b7 },
  { start: 0x12bf, end: 0x12bf },
  { start: 0x12c1, end: 0x12c1 },
  { start: 0x12c6, end: 0x12c7 },
  { start: 0x12d7, end: 0x12d7 },
  { start: 0x1311, end: 0x1311 },
  { start: 0x1316, end: 0x1317 },
  { start: 0x135b, end: 0x135c },
  { start: 0x137d, end: 0x137f },
  { start: 0x139a, end: 0x139f },
  { start: 0x13f6, end: 0x13f7 },
  { start: 0x13fe, end: 0x13ff },
  { start: 0x169d, end: 0x169f },
  { start: 0x16f9, end: 0x16ff },
  { start: 0x1716, end: 0x171e },
  { start: 0x1737, end: 0x173f },
  { start: 0x1754, end: 0x175f },
  { start: 0x176d, end: 0x176d },
  { start: 0x1771, end: 0x1771 },
  { start: 0x1774, end: 0x177f },
  { start: 0x17de, end: 0x17df },
  { start: 0x17ea, end: 0x17ef },
  { start: 0x17fa, end: 0x17ff },
  { start: 0x181a, end: 0x181f },
  { start: 0x1879, end: 0x187f },
  { start: 0x18ab, end: 0x18af },
  { start: 0x18f6, end: 0x18ff },
  { start: 0x191f, end: 0x191f },
  { start: 0x192c, end: 0x192f },
  { start: 0x193c, end: 0x193f },
  { start: 0x1941, end: 0x1943 },
  { start: 0x196e, end: 0x196f },
  { start: 0x1975, end: 0x197f },
  { start: 0x19ac, end: 0x19af },
  { start: 0x19ca, end: 0x19cf },
  { start: 0x19db, end: 0x19dd },
  { start: 0x1a1c, end: 0x1a1d },
  { start: 0x1a5f, end: 0x1a5f },
  { start: 0x1a7d, end: 0x1a7e },
  { start: 0x1a8a, end: 0x1a8f },
  { start: 0x1a9a, end: 0x1a9f },
  { start: 0x1aae, end: 0x1aaf },
  { start: 0x1acf, end: 0x1aff },
  { start: 0x1b4d, end: 0x1b4f },
  { start: 0x1b7f, end: 0x1b7f },
  { start: 0x1bf4, end: 0x1bfb },
  { start: 0x1c38, end: 0x1c3a },
  { start: 0x1c4a, end: 0x1c4c },
  { start: 0x1c89, end: 0x1c8f },
  { start: 0x1cbb, end: 0x1cbc },
  { start: 0x1cc8, end: 0x1ccf },
  { start: 0x1cfb, end: 0x1cff },
  { start: 0x1f16, end: 0x1f17 },
  { start: 0x1f1e, end: 0x1f1f },
  { start: 0x1f46, end: 0x1f47 },
  { start: 0x1f4e, end: 0x1f4f },
  { start: 0x1f58, end: 0x1f58 },
  { start: 0x1f5a, end: 0x1f5a },
  { start: 0x1f5c, end: 0x1f5c },
  { start: 0x1f5e, end: 0x1f5e },
  { start: 0x1f7e, end: 0x1f7f },
  { start: 0x1fb5, end: 0x1fb5 },
  { start: 0x1fc5, end: 0x1fc5 },
  { start: 0x1fd4, end: 0x1fd5 },
  { start: 0x1fdc, end: 0x1fdc },
  { start: 0x1ff0, end: 0x1ff1 },
  { start: 0x1ff5, end: 0x1ff5 },
  { start: 0x1fff, end: 0x1fff },
  { start: 0x2028, end: 0x2029 },
  { start: 0x2065, end: 0x2065 },
  { start: 0x2072, end: 0x2073 },
  { start: 0x208f, end: 0x208f },
  { start: 0x209d, end: 0x209f },
  { start: 0x20c1, end: 0x20cf },
  { start: 0x20f1, end: 0x20ff },
  { start: 0x218c, end: 0x218f },
  { start: 0x2427, end: 0x243f },
  { start: 0x244b, end: 0x245f },
  { start: 0x2b74, end: 0x2b75 },
  { start: 0x2b96, end: 0x2b96 },
  { start: 0x2cf4, end: 0x2cf8 },
  { start: 0x2d26, end: 0x2d26 },
  { start: 0x2d28, end: 0x2d2c },
  { start: 0x2d2e, end: 0x2d2f },
  { start: 0x2d68, end: 0x2d6e },
  { start: 0x2d71, end: 0x2d7e },
  { start: 0x2d97, end: 0x2d9f },
  { start: 0x2da7, end: 0x2da7 },
  { start: 0x2daf, end: 0x2daf },
  { start: 0x2db7, end: 0x2db7 },
  { start: 0x2dbf, end: 0x2dbf },
  { start: 0x2dc7, end: 0x2dc7 },
  { start: 0x2dcf, end: 0x2dcf },
  { start: 0x2dd7, end: 0x2dd7 },
  { start: 0x2ddf, end: 0x2ddf },
  { start: 0x2e5e, end: 0x2e7f },
  { start: 0x2e9a, end: 0x2e9a },
  { start: 0x2ef4, end: 0x2eff },
  { start: 0x2fd6, end: 0x2fef },
  { start: 0x2ffc, end: 0x2fff },
  { start: 0x3040, end: 0x3040 },
  { start: 0x3097, end: 0x3098 },
  { start: 0x3100, end: 0x3104 },
  { start: 0x3130, end: 0x3130 },
  { start: 0x318f, end: 0x318f },
  { start: 0x31e4, end: 0x31ef },
  { start: 0x321f, end: 0x321f },
  { start: 0xa48d, end: 0xa48f },
  { start: 0xa4c7, end: 0xa4cf },
  { start: 0xa62c, end: 0xa63f },
  { start: 0xa6f8, end: 0xa6ff },
  { start: 0xa7cb, end: 0xa7cf },
  { start: 0xa7d2, end: 0xa7d2 },
  { start: 0xa7d4, end: 0xa7d4 },
  { start: 0xa7da, end: 0xa7f1 },
  { start: 0xa82d, end: 0xa82f },
  { start: 0xa83a, end: 0xa83f },
  { start: 0xa878, end: 0xa87f },
  { start: 0xa8c6, end: 0xa8cd },
  { start: 0xa8da, end: 0xa8df },
  { start: 0xa954, end: 0xa95e },
  { start: 0xa97d, end: 0xa97f },
  { start: 0xa9ce, end: 0xa9ce },
  { start: 0xa9da, end: 0xa9dd },
  { start: 0xa9ff, end: 0xa9ff },
  { start: 0xaa37, end: 0xaa3f },
  { start: 0xaa4e, end: 0xaa4f },
  { start: 0xaa5a, end: 0xaa5b },
  { start: 0xaac3, end: 0xaada },
  { start: 0xaaf7, end: 0xab00 },
  { start: 0xab07, end: 0xab08 },
  { start: 0xab0f, end: 0xab10 },
  { start: 0xab17, end: 0xab1f },
  { start: 0xab27, end: 0xab27 },
  { start: 0xab2f, end: 0xab2f },
  { start: 0xab6c, end: 0xab6f },
  { start: 0xabee, end: 0xabef },
  { start: 0xabfa, end: 0xabff },
  { start: 0xd7a4, end: 0xd7af },
  { start: 0xd7c7, end: 0xd7ca },
  { start: 0xd7fc, end: 0xdfff },
  { start: 0xfa6e, end: 0xfa6f },
  { start: 0xfada, end: 0xfaff },
  { start: 0xfb07, end: 0xfb12 },
  { start: 0xfb18, end: 0xfb1c },
  { start: 0xfb37, end: 0xfb37 },
  { start: 0xfb3d, end: 0xfb3d },
  { start: 0xfb3f, end: 0xfb3f },
  { start: 0xfb42, end: 0xfb42 },
  { start: 0xfb45, end: 0xfb45 },
  { start: 0xfbc3, end: 0xfbd2 },
  { start: 0xfd90, end: 0xfd91 },
  { start: 0xfdc8, end: 0xfdce },
  { start: 0xfdd0, end: 0xfdef },
  { start: 0xfe1a, end: 0xfe1f },
  { start: 0xfe53, end: 0xfe53 },
  { start: 0xfe67, end: 0xfe67 },
  { start: 0xfe6c, end: 0xfe6f },
  { start: 0xfe75, end: 0xfe75 },
  { start: 0xfefd, end: 0xfefe },
  { start: 0xff00, end: 0xff00 },
  { start: 0xffbf, end: 0xffc1 },
  { start: 0xffc8, end: 0xffc9 },
  { start: 0xffd0, end: 0xffd1 },
  { start: 0xffd8, end: 0xffd9 },
  { start: 0xffdd, end: 0xffdf },
  { start: 0xffe7, end: 0xffe7 },
  { start: 0xffef, end: 0xfff8 },
  { start: 0xfffe, end: 0xffff },
  { start: 0x1000c, end: 0x1000c },
  { start: 0x10027, end: 0x10027 },
  { start: 0x1003b, end: 0x1003b },
  { start: 0x1003e, end: 0x1003e },
  { start: 0x1004e, end: 0x1004f },
  { start: 0x1005e, end: 0x1007f },
  { start: 0x100fb, end: 0x100ff },
  { start: 0x10103, end: 0x10106 },
  { start: 0x10134, end: 0x10136 },
  { start: 0x1018f, end: 0x1018f },
  { start: 0x1019d, end: 0x1019f },
  { start: 0x101a1, end: 0x101cf },
  { start: 0x101fe, end: 0x1027f },
  { start: 0x1029d, end: 0x1029f },
  { start: 0x102d1, end: 0x102df },
  { start: 0x102fc, end: 0x102ff },
  { start: 0x10324, end: 0x1032c },
  { start: 0x1034b, end: 0x1034f },
  { start: 0x1037b, end: 0x1037f },
  { start: 0x1039e, end: 0x1039e },
  { start: 0x103c4, end: 0x103c7 },
  { start: 0x103d6, end: 0x103ff },
  { start: 0x1049e, end: 0x1049f },
  { start: 0x104aa, end: 0x104af },
  { start: 0x104d4, end: 0x104d7 },
  { start: 0x104fc, end: 0x104ff },
  { start: 0x10528, end: 0x1052f },
  { start: 0x10564, end: 0x1056e },
  { start: 0x1057b, end: 0x1057b },
  { start: 0x1058b, end: 0x1058b },
  { start: 0x10593, end: 0x10593 },
  { start: 0x10596, end: 0x10596 },
  { start: 0x105a2, end: 0x105a2 },
  { start: 0x105b2, end: 0x105b2 },
  { start: 0x105ba, end: 0x105ba },
  { start: 0x105bd, end: 0x105ff },
  { start: 0x10737, end: 0x1073f },
  { start: 0x10756, end: 0x1075f },
  { start: 0x10768, end: 0x1077f },
  { start: 0x10786, end: 0x10786 },
  { start: 0x107b1, end: 0x107b1 },
  { start: 0x107bb, end: 0x107ff },
  { start: 0x10806, end: 0x10807 },
  { start: 0x10809, end: 0x10809 },
  { start: 0x10836, end: 0x10836 },
  { start: 0x10839, end: 0x1083b },
  { start: 0x1083d, end: 0x1083e },
  { start: 0x10856, end: 0x10856 },
  { start: 0x1089f, end: 0x108a6 },
  { start: 0x108b0, end: 0x108df },
  { start: 0x108f3, end: 0x108f3 },
  { start: 0x108f6, end: 0x108fa },
  { start: 0x1091c, end: 0x1091e },
  { start: 0x1093a, end: 0x1093e },
  { start: 0x10940, end: 0x1097f },
  { start: 0x109b8, end: 0x109bb },
  { start: 0x109d0, end: 0x109d1 },
  { start: 0x10a04, end: 0x10a04 },
  { start: 0x10a07, end: 0x10a0b },
  { start: 0x10a14, end: 0x10a14 },
  { start: 0x10a18, end: 0x10a18 },
  { start: 0x10a36, end: 0x10a37 },
  { start: 0x10a3b, end: 0x10a3e },
  { start: 0x10a49, end: 0x10a4f },
  { start: 0x10a59, end: 0x10a5f },
  { start: 0x10aa0, end: 0x10abf },
  { start: 0x10ae7, end: 0x10aea },
  { start: 0x10af7, end: 0x10aff },
  { start: 0x10b36, end: 0x10b38 },
  { start: 0x10b56, end: 0x10b57 },
  { start: 0x10b73, end: 0x10b77 },
  { start: 0x10b92, end: 0x10b98 },
  { start: 0x10b9d, end: 0x10ba8 },
  { start: 0x10bb0, end: 0x10bff },
  { start: 0x10c49, end: 0x10c7f },
  { start: 0x10cb3, end: 0x10cbf },
  { start: 0x10cf3, end: 0x10cf9 },
  { start: 0x10d28, end: 0x10d2f },
  { start: 0x10d3a, end: 0x10e5f },
  { start: 0x10e7f, end: 0x10e7f },
  { start: 0x10eaa, end: 0x10eaa },
  { start: 0x10eae, end: 0x10eaf },
  { start: 0x10eb2, end: 0x10eff },
  { start: 0x10f28, end: 0x10f2f },
  { start: 0x10f5a, end: 0x10f6f },
  { start: 0x10f8a, end: 0x10faf },
  { start: 0x10fcc, end: 0x10fdf },
  { start: 0x10ff7, end: 0x10fff },
  { start: 0x1104e, end: 0x11051 },
  { start: 0x11076, end: 0x1107e },
  { start: 0x110c3, end: 0x110cc },
  { start: 0x110ce, end: 0x110cf },
  { start: 0x110e9, end: 0x110ef },
  { start: 0x110fa, end: 0x110ff },
  { start: 0x11135, end: 0x11135 },
  { start: 0x11148, end: 0x1114f },
  { start: 0x11177, end: 0x1117f },
  { start: 0x111e0, end: 0x111e0 },
  { start: 0x111f5, end: 0x111ff },
  { start: 0x11212, end: 0x11212 },
  { start: 0x1123f, end: 0x1127f },
  { start: 0x11287, end: 0x11287 },
  { start: 0x11289, end: 0x11289 },
  { start: 0x1128e, end: 0x1128e },
  { start: 0x1129e, end: 0x1129e },
  { start: 0x112aa, end: 0x112af },
  { start: 0x112eb, end: 0x112ef },
  { start: 0x112fa, end: 0x112ff },
  { start: 0x11304, end: 0x11304 },
  { start: 0x1130d, end: 0x1130e },
  { start: 0x11311, end: 0x11312 },
  { start: 0x11329, end: 0x11329 },
  { start: 0x11331, end: 0x11331 },
  { start: 0x11334, end: 0x11334 },
  { start: 0x1133a, end: 0x1133a },
  { start: 0x11345, end: 0x11346 },
  { start: 0x11349, end: 0x1134a },
  { start: 0x1134e, end: 0x1134f },
  { start: 0x11351, end: 0x11356 },
  { start: 0x11358, end: 0x1135c },
  { start: 0x11364, end: 0x11365 },
  { start: 0x1136d, end: 0x1136f },
  { start: 0x11375, end: 0x113ff },
  { start: 0x1145c, end: 0x1145c },
  { start: 0x11462, end: 0x1147f },
  { start: 0x114c8, end: 0x114cf },
  { start: 0x114da, end: 0x1157f },
  { start: 0x115b6, end: 0x115b7 },
  { start: 0x115de, end: 0x115ff },
  { start: 0x11645, end: 0x1164f },
  { start: 0x1165a, end: 0x1165f },
  { start: 0x1166d, end: 0x1167f },
  { start: 0x116ba, end: 0x116bf },
  { start: 0x116ca, end: 0x116ff },
  { start: 0x1171b, end: 0x1171c },
  { start: 0x1172c, end: 0x1172f },
  { start: 0x11747, end: 0x117ff },
  { start: 0x1183c, end: 0x1189f },
  { start: 0x118f3, end: 0x118fe },
  { start: 0x11907, end: 0x11908 },
  { start: 0x1190a, end: 0x1190b },
  { start: 0x11914, end: 0x11914 },
  { start: 0x11917, end: 0x11917 },
  { start: 0x11936, end: 0x11936 },
  { start: 0x11939, end: 0x1193a },
  { start: 0x11947, end: 0x1194f },
  { start: 0x1195a, end: 0x1199f },
  { start: 0x119a8, end: 0x119a9 },
  { start: 0x119d8, end: 0x119d9 },
  { start: 0x119e5, end: 0x119ff },
  { start: 0x11a48, end: 0x11a4f },
  { start: 0x11aa3, end: 0x11aaf },
  { start: 0x11af9, end: 0x11bff },
  { start: 0x11c09, end: 0x11c09 },
  { start: 0x11c37, end: 0x11c37 },
  { start: 0x11c46, end: 0x11c4f },
  { start: 0x11c6d, end: 0x11c6f },
  { start: 0x11c90, end: 0x11c91 },
  { start: 0x11ca8, end: 0x11ca8 },
  { start: 0x11cb7, end: 0x11cff },
  { start: 0x11d07, end: 0x11d07 },
  { start: 0x11d0a, end: 0x11d0a },
  { start: 0x11d37, end: 0x11d39 },
  { start: 0x11d3b, end: 0x11d3b },
  { start: 0x11d3e, end: 0x11d3e },
  { start: 0x11d48, end: 0x11d4f },
  { start: 0x11d5a, end: 0x11d5f },
  { start: 0x11d66, end: 0x11d66 },
  { start: 0x11d69, end: 0x11d69 },
  { start: 0x11d8f, end: 0x11d8f },
  { start: 0x11d92, end: 0x11d92 },
  { start: 0x11d99, end: 0x11d9f },
  { start: 0x11daa, end: 0x11edf },
  { start: 0x11ef9, end: 0x11faf },
  { start: 0x11fb1, end: 0x11fbf },
  { start: 0x11ff2, end: 0x11ffe },
  { start: 0x1239a, end: 0x123ff },
  { start: 0x1246f, end: 0x1246f },
  { start: 0x12475, end: 0x1247f },
  { start: 0x12544, end: 0x12f8f },
  { start: 0x12ff3, end: 0x12fff },
  { start: 0x1342f, end: 0x1342f },
  { start: 0x13439, end: 0x143ff },
  { start: 0x14647, end: 0x167ff },
  { start: 0x16a39, end: 0x16a3f },
  { start: 0x16a5f, end: 0x16a5f },
  { start: 0x16a6a, end: 0x16a6d },
  { start: 0x16abf, end: 0x16abf },
  { start: 0x16aca, end: 0x16acf },
  { start: 0x16aee, end: 0x16aef },
  { start: 0x16af6, end: 0x16aff },
  { start: 0x16b46, end: 0x16b4f },
  { start: 0x16b5a, end: 0x16b5a },
  { start: 0x16b62, end: 0x16b62 },
  { start: 0x16b78, end: 0x16b7c },
  { start: 0x16b90, end: 0x16e3f },
  { start: 0x16e9b, end: 0x16eff },
  { start: 0x16f4b, end: 0x16f4e },
  { start: 0x16f88, end: 0x16f8e },
  { start: 0x16fa0, end: 0x16fdf },
  { start: 0x16fe5, end: 0x16fef },
  { start: 0x16ff2, end: 0x16fff },
  { start: 0x187f8, end: 0x187ff },
  { start: 0x18cd6, end: 0x18cff },
  { start: 0x18d09, end: 0x1afef },
  { start: 0x1aff4, end: 0x1aff4 },
  { start: 0x1affc, end: 0x1affc },
  { start: 0x1afff, end: 0x1afff },
  { start: 0x1b123, end: 0x1b14f },
  { start: 0x1b153, end: 0x1b163 },
  { start: 0x1b168, end: 0x1b16f },
  { start: 0x1b2fc, end: 0x1bbff },
  { start: 0x1bc6b, end: 0x1bc6f },
  { start: 0x1bc7d, end: 0x1bc7f },
  { start: 0x1bc89, end: 0x1bc8f },
  { start: 0x1bc9a, end: 0x1bc9b },
  { start: 0x1bca4, end: 0x1ceff },
  { start: 0x1cf2e, end: 0x1cf2f },
  { start: 0x1cf47, end: 0x1cf4f },
  { start: 0x1cfc4, end: 0x1cfff },
  { start: 0x1d0f6, end: 0x1d0ff },
  { start: 0x1d127, end: 0x1d128 },
  { start: 0x1d1eb, end: 0x1d1ff },
  { start: 0x1d246, end: 0x1d2df },
  { start: 0x1d2f4, end: 0x1d2ff },
  { start: 0x1d357, end: 0x1d35f },
  { start: 0x1d379, end: 0x1d3ff },
  { start: 0x1d455, end: 0x1d455 },
  { start: 0x1d49d, end: 0x1d49d },
  { start: 0x1d4a0, end: 0x1d4a1 },
  { start: 0x1d4a3, end: 0x1d4a4 },
  { start: 0x1d4a7, end: 0x1d4a8 },
  { start: 0x1d4ad, end: 0x1d4ad },
  { start: 0x1d4ba, end: 0x1d4ba },
  { start: 0x1d4bc, end: 0x1d4bc },
  { start: 0x1d4c4, end: 0x1d4c4 },
  { start: 0x1d506, end: 0x1d506 },
  { start: 0x1d50b, end: 0x1d50c },
  { start: 0x1d515, end: 0x1d515 },
  { start: 0x1d51d, end: 0x1d51d },
  { start: 0x1d53a, end: 0x1d53a },
  { start: 0x1d53f, end: 0x1d53f },
  { start: 0x1d545, end: 0x1d545 },
  { start: 0x1d547, end: 0x1d549 },
  { start: 0x1d551, end: 0x1d551 },
  { start: 0x1d6a6, end: 0x1d6a7 },
  { start: 0x1d7cc, end: 0x1d7cd },
  { start: 0x1da8c, end: 0x1da9a },
  { start: 0x1daa0, end: 0x1daa0 },
  { start: 0x1dab0, end: 0x1deff },
  { start: 0x1df1f, end: 0x1dfff },
  { start: 0x1e007, end: 0x1e007 },
  { start: 0x1e019, end: 0x1e01a },
  { start: 0x1e022, end: 0x1e022 },
  { start: 0x1e025, end: 0x1e025 },
  { start: 0x1e02b, end: 0x1e0ff },
  { start: 0x1e12d, end: 0x1e12f },
  { start: 0x1e13e, end: 0x1e13f },
  { start: 0x1e14a, end: 0x1e14d },
  { start: 0x1e150, end: 0x1e28f },
  { start: 0x1e2af, end: 0x1e2bf },
  { start: 0x1e2fa, end: 0x1e2fe },
  { start: 0x1e300, end: 0x1e7df },
  { start: 0x1e7e7, end: 0x1e7e7 },
  { start: 0x1e7ec, end: 0x1e7ec },
  { start: 0x1e7ef, end: 0x1e7ef },
  { start: 0x1e7ff, end: 0x1e7ff },
  { start: 0x1e8c5, end: 0x1e8c6 },
  { start: 0x1e8d7, end: 0x1e8ff },
  { start: 0x1e94c, end: 0x1e94f },
  { start: 0x1e95a, end: 0x1e95d },
  { start: 0x1e960, end: 0x1ec70 },
  { start: 0x1ecb5, end: 0x1ed00 },
  { start: 0x1ed3e, end: 0x1edff },
  { start: 0x1ee04, end: 0x1ee04 },
  { start: 0x1ee20, end: 0x1ee20 },
  { start: 0x1ee23, end: 0x1ee23 },
  { start: 0x1ee25, end: 0x1ee26 },
  { start: 0x1ee28, end: 0x1ee28 },
  { start: 0x1ee33, end: 0x1ee33 },
  { start: 0x1ee38, end: 0x1ee38 },
  { start: 0x1ee3a, end: 0x1ee3a },
  { start: 0x1ee3c, end: 0x1ee41 },
  { start: 0x1ee43, end: 0x1ee46 },
  { start: 0x1ee48, end: 0x1ee48 },
  { start: 0x1ee4a, end: 0x1ee4a },
  { start: 0x1ee4c, end: 0x1ee4c },
  { start: 0x1ee50, end: 0x1ee50 },
  { start: 0x1ee53, end: 0x1ee53 },
  { start: 0x1ee55, end: 0x1ee56 },
  { start: 0x1ee58, end: 0x1ee58 },
  { start: 0x1ee5a, end: 0x1ee5a },
  { start: 0x1ee5c, end: 0x1ee5c },
  { start: 0x1ee5e, end: 0x1ee5e },
  { start: 0x1ee60, end: 0x1ee60 },
  { start: 0x1ee63, end: 0x1ee63 },
  { start: 0x1ee65, end: 0x1ee66 },
  { start: 0x1ee6b, end: 0x1ee6b },
  { start: 0x1ee73, end: 0x1ee73 },
  { start: 0x1ee78, end: 0x1ee78 },
  { start: 0x1ee7d, end: 0x1ee7d },
  { start: 0x1ee7f, end: 0x1ee7f },
  { start: 0x1ee8a, end: 0x1ee8a },
  { start: 0x1ee9c, end: 0x1eea0 },
  { start: 0x1eea4, end: 0x1eea4 },
  { start: 0x1eeaa, end: 0x1eeaa },
  { start: 0x1eebc, end: 0x1eeef },
  { start: 0x1eef2, end: 0x1efff },
  { start: 0x1f02c, end: 0x1f02f },
  { start: 0x1f094, end: 0x1f09f },
  { start: 0x1f0af, end: 0x1f0b0 },
  { start: 0x1f0c0, end: 0x1f0c0 },
  { start: 0x1f0d0, end: 0x1f0d0 },
  { start: 0x1f0f6, end: 0x1f0ff },
  { start: 0x1f1ae, end: 0x1f1e5 },
  { start: 0x1f203, end: 0x1f20f },
  { start: 0x1f23c, end: 0x1f23f },
  { start: 0x1f249, end: 0x1f24f },
  { start: 0x1f252, end: 0x1f25f },
  { start: 0x1f266, end: 0x1f2ff },
  { start: 0x1f6d8, end: 0x1f6dc },
  { start: 0x1f6ed, end: 0x1f6ef },
  { start: 0x1f6fd, end: 0x1f6ff },
  { start: 0x1f774, end: 0x1f77f },
  { start: 0x1f7d9, end: 0x1f7df },
  { start: 0x1f7ec, end: 0x1f7ef },
  { start: 0x1f7f1, end: 0x1f7ff },
  { start: 0x1f80c, end: 0x1f80f },
  { start: 0x1f848, end: 0x1f84f },
  { start: 0x1f85a, end: 0x1f85f },
  { start: 0x1f888, end: 0x1f88f },
  { start: 0x1f8ae, end: 0x1f8af },
  { start: 0x1f8b2, end: 0x1f8ff },
  { start: 0x1fa54, end: 0x1fa5f },
  { start: 0x1fa6e, end: 0x1fa6f },
  { start: 0x1fa75, end: 0x1fa77 },
  { start: 0x1fa7d, end: 0x1fa7f },
  { start: 0x1fa87, end: 0x1fa8f },
  { start: 0x1faad, end: 0x1faaf },
  { start: 0x1fabb, end: 0x1fabf },
  { start: 0x1fac6, end: 0x1facf },
  { start: 0x1fada, end: 0x1fadf },
  { start: 0x1fae8, end: 0x1faef },
  { start: 0x1faf7, end: 0x1faff },
  { start: 0x1fb93, end: 0x1fb93 },
  { start: 0x1fbcb, end: 0x1fbef },
  { start: 0x1fbfa, end: 0x1ffff },
  { start: 0x2a6e0, end: 0x2a6ff },
  { start: 0x2b739, end: 0x2b73f },
  { start: 0x2b81e, end: 0x2b81f },
  { start: 0x2cea2, end: 0x2ceaf },
  { start: 0x2ebe1, end: 0x2f7ff },
  { start: 0x2fa1e, end: 0x2ffff },
  { start: 0x3134b, end: 0xe0000 },
  { start: 0xe0002, end: 0xe001f },
  { start: 0xe0080, end: 0xe00ff },
  { start: 0xe01f0, end: 0xeffff },
  { start: 0xffffe, end: 0xfffff },
  { start: 0x10fffe, end: 0x10ffff },
];

let unprintableTable: RangeTable | undefined;
function getUnprintableTable(): RangeTable {
  if (unprintableTable) return unprintableTable;
  const t = new RangeTable('unprintables');
  for (const r of unprintableRanges) {
    t.addRange({ start: r.start, end: r.end });
  }
  unprintableTable = t;
  return t;
}

function ignoreUnprintablesInTable(table: RangeTable, label: string): RangeTable {
  const hideUnprintablesJoinFn: CanMergeRangeFn = (last, next) => {
    if (widthsEqual(last.widths, next.widths)) return true;
    for (let cp = next.start; cp <= next.end; cp++) {
      if (!getUnprintableTable().has(cp)) return false;
    }
    return true;
  };

  const out = new RangeTable(label);
  for (const r of table._ranges) {
    out.addRange(r, hideUnprintablesJoinFn);
  }
  return out;
}

class BrowserStorage {

  constructor(private _profile: IAppProfile) {}

  public saveRanges(ranges: IMeasuredRange[]): void {
    const key = this._getCompatStorageKey(this._profile.tableName);

    const normalized = ranges.map(r => ({
      start: r.start,
      end: r.end,
      widths: r.widths && {
        col: Number.isNaN(r.widths.col as any) ? null : r.widths.col ?? undefined,
        mov: Number.isNaN(r.widths.mov as any) ? null : r.widths.mov ?? undefined,
        del: Number.isNaN(r.widths.del as any) ? null : r.widths.del ?? undefined,
      }
    }));

    localStorage.setItem(key, JSON.stringify(normalized));
  }

  public loadRanges(): IMeasuredRange[] | undefined {
    const key = this._getCompatStorageKey(this._profile.tableName);
    const s = localStorage.getItem(key);
    if (!s) return undefined;

    let parsed: any;
    try { parsed = JSON.parse(s); } catch { return undefined; }

    return this._reviveRanges(parsed) ?? undefined;
  }

  public clearRanges(): void {
    const key = this._getCompatStorageKey(this._profile.tableName);
    localStorage.removeItem(key);
  }

  private _reviveNumber(v: unknown): number | undefined {
    if (v === null) return NaN;               // null came from NaN
    if (typeof v === 'number') return v;
    return undefined;                         // missing or garbage => undefined
  }

  private _reviveWidths(w: any): IMeasuredWidths | undefined {
    if (!w || typeof w !== 'object') return undefined;
    const col = this._reviveNumber(w.col);
    const mov = this._reviveNumber(w.mov);
    const del = this._reviveNumber(w.del);

    // If all are undefined, treat as absent
    if (col === undefined && mov === undefined && del === undefined) return undefined;

    const out: IMeasuredWidths = {};
    if (col !== undefined) out.col = col;
    if (mov !== undefined) out.mov = mov;
    if (del !== undefined) out.del = del;
    return out;
  }

  private _reviveRanges(raw: any): IMeasuredRange[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: IMeasuredRange[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const start = (r as any).start;
      const end = (r as any).end;
      if (typeof start !== 'number' || typeof end !== 'number') continue;

      const widths = this._reviveWidths((r as any).widths);
      out.push(widths ? { start, end, widths } : { start, end });
    }
    return out;
  }

  private _getCompatStorageKey(profileId: string): string {
    return `xterm-width-explorer:compat:${profileId}`;
  }
}
