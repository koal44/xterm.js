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
import type { AddonCollection } from 'types';
import type { Terminal } from '@xterm/xterm';
import { CellCompatAddon } from '@xterm/addon-cell-compat';
import { BrowserStorage } from 'components/window/widthExplorer/browserStorage';
import { addRow, mkButton, mkCheckbox, mkLabeledInput, mkNumericUpDown, mkSelect } from 'components/window/widthExplorer/domUtil';
import { Measurer } from 'components/window/widthExplorer/measurer';
import { MeasuredWidths, MeasuredTable, DEFAULT_MEASURED_TABLE } from 'components/window/widthExplorer/measuredTable';
import { ignoreUnprintablesInTable } from 'components/window/widthExplorer/unprintables';
import { decodeData, escapeForLog, formatCodePoints, hexToStr } from 'components/window/widthExplorer/stringUtil';
import { CircularList } from 'components/window/widthExplorer/circularList';
import { bashCompatRanges, fishCompatRanges, pwshCompatRanges, zshCompatRanges } from 'components/window/widthExplorer/compatTablePresets';
import { sendKey } from 'components/window/widthExplorer/keyboard';

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
  '\u0301\u0301A'
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

interface IUpkeepCmd { cmd: string, everyRuns: number, timeoutMs: number }

type AppId = 'bash' | 'zsh' | 'fish' | 'pwsh' | null;
export interface IAppProfile {
  id: AppId;
  label: string;
  tableName: string;
  keys: IKeymap;
  clearLineNeedsEnd: boolean; // whether clear key needs an END before it to work properly
  init: string[]; // commands to run when switching into this profile
  upkeep?: IUpkeepCmd; // commands to run periodically to keep the line editor happy
  compatPreset: MeasuredTable; // preset compatibility table
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
    compatPreset: new MeasuredTable('bashCompatTable', bashCompatRanges),
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
    compatPreset: new MeasuredTable('zshCompatTable', zshCompatRanges),
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
    compatPreset: new MeasuredTable('fishCompatTable', fishCompatRanges),
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
    compatPreset: new MeasuredTable('pwshCompatTable', pwshCompatRanges),
  }
];

interface ISocketReporter {
  log: string[];
  logEnabled: boolean;
}

export interface IMsgReaderTimeoutPolicy {
  shouldThrowOnTimeout: () => boolean;
}

export class WidthExplorerWindow extends BaseWindow {
  public readonly id = 'width-explorer';
  public readonly label = 'Width';

  private _sock: WebSocket | undefined;
  private _rep: ISocketReporter | undefined;
  private _profile: IAppProfile | undefined;
  private _showZwj = false;
  private _silentCb: HTMLInputElement;

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
  private _workingTable = new MeasuredTable('temp');
  private _store: BrowserStorage | undefined;

  private _measureStatusSpan!: HTMLSpanElement;
  private _measureColWidth = true;
  private _measureMovWidth = true;
  private _measureDelWidth = true;
  private _throwOnTimeout = false;
  private _msgTimeoutPolicy: IMsgReaderTimeoutPolicy = {
    shouldThrowOnTimeout: () => this._throwOnTimeout,
  };

  private _logEl: HTMLPreElement;
  private _logFlushMs = 100;
  private _logMaxLines = 150;
  private _log = new CircularList(this._logMaxLines);
  private _logFlushScheduled = false;
  private _logFlushTimer: number | undefined;

  private _cellCompatEnabled = false;
  private _cellCompat: CellCompatAddon | undefined;
  private _prevUcProvider: string | undefined;

  constructor(
    terminal: Terminal,
    addons: AddonCollection,
    private readonly _deps: { getSocket: () => WebSocket | undefined },
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
      mkSelect(APP_PROFILES, null as AppId | null, id => this._setProfile(id), 'App profile (key sequences)'),
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
      mkButton('⌧', 'Clear the log output', () => this._clearLog()),
      silentLabel,
      mkCheckbox('zwj ', 'render ZWJ as {zwj} in trace?', this._showZwj, v => { this._showZwj = v; }).label,
    );

    // App input
    root.appendChild(document.createElement('hr'));
    addRow(root, 'app input:');

    const delN = mkNumericUpDown('DEL repeat count', 1, 64, 1, 1);
    delN.style.width = '30px';
    addRow(root, '',
      mkButton('⎚', 'Clear screen & redraw current line', () => {
        this._inject(this._profile?.keys.clearScreen);
      }),
      mkButton('⌧', 'Clear the current line', () => {
        if (this._profile?.clearLineNeedsEnd) this._inject(this._profile?.keys.end);
        this._inject(this._profile?.keys.clearLine);
      }),
      mkButton('←', 'Left', () => sendKey(this._terminal, 'left')),
      mkButton('→', 'Right', () => sendKey(this._terminal, 'right')),
      mkButton('⇤', 'Home', () => sendKey(this._terminal, 'home')),
      mkButton('⇥', 'End', () => sendKey(this._terminal, 'end')),
      mkButton('⌫', 'Backspace', () => sendKey(this._terminal, 'backspace')),
      mkButton('⌦', 'Delete', () => sendKey(this._terminal, 'delete')),

      // mkButton('←', 'Left', () => this._inject(this._profile?.keys.left)),
      // mkButton('→', 'Right', () => this._inject(this._profile?.keys.right)),
      // mkButton('⇤', 'Home', () => this._inject(this._profile?.keys.home)),
      // mkButton('⇥', 'End', () => this._inject(this._profile?.keys.end)),
      // mkButton('DEL×N', 'Send DEL × N', () => {
      //   const n = Math.max(1, Math.min(64, +delN.value));
      //   this._inject(this._profile?.keys.del.repeat(n));
      // }),
      // delN,
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
          this._genButton.textContent = 'run';
          this._appendLog('[dev] generation aborted by user\n');
          return;
        }
        this._isGenRunning = true;
        this._genButton.textContent = 'stop';
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
          this._workingTable = new MeasuredTable(this._profile.tableName, storedRanges);
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

          const newRanges = this._workingTable.ranges;
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
          const merged = new MeasuredTable('merged', existing);
          for (const r of newRanges) merged.upsertRange(r);

          this._store.saveRanges(merged.ranges);

          this._clearLog();
          this._appendLog(
            `[dev] saved (merge) new=${newRanges.length} storedWas=${existing.length} merged=${merged.ranges.length}\n`
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

    // CellCompat
    root.appendChild(document.createElement('hr'));
    addRow(root, 'compat addon:');

    const uc17Cb = mkCheckbox('uc17', 'Unicode 17 visual overlay', true, v => {
      if (!this._cellCompat) return;
      this._cellCompat.setUseUc17(v);
      // if (this._profile) this._inject(this._profile.keys.clearScreen);
    });
    uc17Cb.input.disabled = true;

    const atomicCb = mkCheckbox('atomic', 'Atomic editing of graphemes using burst keys', true, v => {
      if (!this._cellCompat) return;
      this._cellCompat.setAtomic(v, this._terminal);
    });
    atomicCb.input.disabled = true;

    addRow(root, '',
      mkCheckbox('enable', 'Enable CellCompatAddon', false, v => {
        // if (!this._profile) { this._appendLog('[dev] no profile\n'); return; }
        this._cellCompatEnabled = v;
        if (!this._cellCompat) {
          this._cellCompat = new CellCompatAddon();
          this._terminal.loadAddon(this._cellCompat);
        }

        if (this._cellCompatEnabled) {
          this._cellCompat.setEnable(true, this._terminal);
          this._prevUcProvider = this._terminal.unicode.activeVersion;
          this._cellCompat.loadCompatTable(this._profile?.compatPreset ?? DEFAULT_MEASURED_TABLE);
          this._terminal.unicode.activeVersion = 'compat';
        } else {
          this._cellCompat.setEnable(false, this._terminal);
          this._terminal.unicode.activeVersion = this._prevUcProvider || '6';
        }
        // clear screen to reprint line after bufferset.reset
        if (this._profile) {
          this._inject(this._profile?.keys.clearScreen);
        }
        uc17Cb.input.disabled = !this._cellCompatEnabled;
        atomicCb.input.disabled = !this._cellCompatEnabled;
      }).label,
      uc17Cb.label,
      atomicCb.label,
    );


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
    if (this._profile) {
      if (this._profile.clearLineNeedsEnd) this._inject(this._profile.keys.end);
      this._inject(this._profile.keys.clearLine);
      this._inject(this._profile.keys.clearScreen);
    }

    const oldId = this._profile?.id;
    this._profile = APP_PROFILES.find(p => p.id === id)!;
    if (oldId === this._profile.id) return;
    await this._initProfile();
    this._appendLog(`[dev] app profile = ${this._profile.id}\n`);
    this._store = new BrowserStorage(this._profile.tableName);
    this._workingTable = new MeasuredTable(this._profile.tableName);

    if (this._cellCompatEnabled && this._cellCompat) {
      this._cellCompat.loadCompatTable(this._profile.compatPreset);
    }
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
    const compatTable = new MeasuredTable(this._profile.id + 'CompatTable');

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

      for (const r of compatTable.ranges) {
        this._workingTable.upsertRange(r);
      }

      if (this._genAudit) {
        const singletons: number[] = [];
        for (const r of this._workingTable.ranges) if (r.start === r.end) singletons.push(r.start);

        for (const cp of singletons) {
          // measure it until it's consistent 3x
          let lastWidths: MeasuredWidths | undefined;
          let consistentCount = 0;
          for (let attempt = 0; attempt < 7; attempt++) {
            const widths = await measurer.run(String.fromCodePoint(cp), measureOpts, this._genLogPerf);
            if (MeasuredWidths.equal(widths, lastWidths)) {
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
        for (const r of this._workingTable.ranges) {
          const wStart = await measurer.run(String.fromCodePoint(r.start), measureOpts, this._genLogPerf);
          const wEnd   = await measurer.run(String.fromCodePoint(r.end), measureOpts, this._genLogPerf);
          if (!MeasuredWidths.equal(r.widths, wStart)) {
            console.warn(`[audit] start mismatch @ 0x${hexToStr(r.start)} stored=${JSON.stringify(r.widths)} measured=${JSON.stringify(wStart)}`);
            auditWarnings++;
          }
          if (!MeasuredWidths.equal(r.widths, wEnd)) {
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




let skipTable: MeasuredTable | undefined;
function getSkipTable(): MeasuredTable {
  if (skipTable) return skipTable;
  const t = new MeasuredTable('skip');
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
  for (const r of getSkipTable().ranges) {
    const ovStart = Math.max(start, r.start);
    const ovEnd = Math.min(end, r.end);
    const overlap = ovStart <= ovEnd ? (ovEnd - ovStart + 1) : 0;
    count -= overlap;
  }

  return count;
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
    return origResize(cols, rows);
  });

  return {
    setLocked(v: boolean) { lock = v; },
    restore() { term.resize = origResize; }
  };
}
