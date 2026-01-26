/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Explorer for measuring payload width in interactive apps (shells/TUIs).
 *
 * Width metrics:
 * - colWidth: column-space consumed by the app's rendering (wcwidth-like).
 * - movWidth: cursor traversal cost in keypresses; can feel "sticky" in some apps.
 * - delWidth: deletion cost in keypresses.
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

const TEST_PREFIX = '«';
const TEST_SUFFIX = '»';
const TESTS = [
  '🙂',
  '👨‍🌾',
  '👨‍👩‍👧‍👦',
  '🇺🇳',
  '͸',  // an unprintable char
  '͸͹', // two unprintable chars
];

const TURBO_COLS = 600; // widen columns for turbo mode

const RE_CUB = /\x1b\[(\d*)D/;                  // CUB: cursor back n
const RE_CUF = /\x1b\[(\d*)C/;                  // CUF: cursor forward n
const RE_CUF_NOT_ONE = /\x1b\[(?!1C)(\d+)C/;    // CUF: cursor forward more than 1
const RE_CR_CUF_ONLY = /^\r(?:\x1b\[(\d*)C)+$/; // CR + CUF only
const RE_TAIL_CR_CUF = /\r(?:\x1b\[(\d*)C)+$/;  // tail CR + CUF only
const RE_CUP = /\x1b\[(\d+);(\d+)H/;            // CUP: cursor position r;c
const RE_BS_ONLY = /^\x08+$/;                   // BS: only backspaces

interface IKeymap { left: string, right: string, home: string, end: string, clear: string, del: string }
const DEFAULT_KEYMAP: IKeymap = {
  left:  '\x1b[D',
  right: '\x1b[C',
  home:  '\x1b[H',
  end:   '\x1b[F',
  clear: '\x15',
  del:   '\x7f',
} as const;

type MessageAwaiter = (until: (m: string) => boolean, timeoutMs: number, reportTimeout?: boolean) => Promise<string | undefined>;
type MeasureWidthFn = (
  this: IAppProfile,
  socket: WebSocket,
  readUntil: MessageAwaiter,
  payload: string,
  prefix: string,
  suffix: string,
) => Promise<number>;

interface IWidthBucket {
  label: string;
  annotateMovWidth: boolean;
  annotateDelWidth: boolean;
  match: (width: number) => boolean;
}

const DEFAULT_WIDTH_BUCKETS: IWidthBucket[] = [
  { label: 'width_0', annotateMovWidth: true, annotateDelWidth: true, match: w => w === 0 },
  { label: 'width_1', annotateMovWidth: true, annotateDelWidth: true, match: w => w === 1 },
  { label: 'width_2', annotateMovWidth: true, annotateDelWidth: true, match: w => w === 2 },
  { label: 'width_review', annotateMovWidth: false, annotateDelWidth: false, match: _ => true },
] as const;

type AppId = 'bash' | 'zsh' | 'fish' | 'pwsh' | null;
interface IAppProfile {
  id: AppId;
  label: string;
  keys: IKeymap;
  init: string[]; // commands to run when switching into this profile
  widthBuckets: IWidthBucket[];
  measureColWidth: MeasureWidthFn;
  measureMovWidth: MeasureWidthFn;
  measureDelWidth: MeasureWidthFn;
}

const SHELL_PROFILES: IAppProfile[] = [
  {
    id: 'bash',
    label: 'bash (GNU Readline)',
    keys: { ...DEFAULT_KEYMAP },
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
    ],
    widthBuckets: DEFAULT_WIDTH_BUCKETS,
    async measureColWidth(socket, readUntil, payload, prefix, suffix) {
      let ack: string | undefined;

      socket.send(this.keys.clear);
      await readUntil(() => true, 80, false);

      socket.send(prefix + payload + suffix);
      ack = await readUntil(m => m.includes(suffix), 1000);
      if (!ack) return NaN;

      socket.send(this.keys.home);
      ack = await readUntil(m => RE_CUF.test(m) || RE_BS_ONLY.test(m), 1100);
      if (!ack) return NaN;

      socket.send(this.keys.end);
      ack = await readUntil(m => RE_CUF.test(m), 1200);
      if (!ack) return NaN;

      const n = parseWidthFromCUFMsg(ack);
      if (!Number.isFinite(n)) return NaN;

      return n - (prefix.length + suffix.length);
    },
    async measureMovWidth(socket, readUntil, payload, prefix, suffix) {
      socket.send(this.keys.clear);
      await readUntil(() => true, 120, false);

      socket.send(payload + suffix);
      let ack = await readUntil(m => m.includes(suffix), 1000);
      if (!ack) return NaN;

      let rightRepeat = 0;
      const MAX_RIGHT = 15;

      while (rightRepeat <= MAX_RIGHT) {
        socket.send(this.keys.home);
        ack = await readUntil(m => RE_CUF.test(m) || RE_BS_ONLY.test(m), 900);
        if (!ack) return NaN;

        for (let i = 0; i < rightRepeat; i++) {
          socket.send(this.keys.right);
          ack = await readUntil(m => RE_CUF.test(m), 800);
          if (!ack) return NaN;
        }

        socket.send(this.keys.end);
        ack = await readUntil(m => RE_CUF.test(m), 700);
        if (!ack) return NaN;

        const n = parseWidthFromCUFMsg(ack);
        if (!Number.isFinite(n) || n < suffix.length) return NaN;
        if (n === suffix.length) return rightRepeat;

        rightRepeat++;
      }

      return NaN;
    },
    async measureDelWidth(socket, readUntil, payload, prefix, suffix) { return NaN; },
  },
  {
    id: 'zsh',
    label: 'zsh (Zsh Line Editor / ZLE)',
    keys: { ...DEFAULT_KEYMAP },
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
    ],
    widthBuckets: [
      { label: 'width_unprintable', annotateMovWidth: false, annotateDelWidth: false, match: w => w === 6 || w === 10 },
      ...DEFAULT_WIDTH_BUCKETS,
    ],
    async measureColWidth(socket, readUntil, payload, prefix, suffix) {
      let ack: string | undefined;

      socket.send(this.keys.clear);
      await readUntil(() => true, 80, false);

      socket.send(prefix + payload + suffix);
      ack = await readUntil(m => m.includes(suffix), 1000);
      if (!ack) return NaN;

      socket.send(this.keys.home);
      ack = await readUntil(m => RE_CUB.test(m) || m.includes('\x08'), 900); // || RE_BS_ONLY.test(m), 900);
      if (!ack) return NaN;

      // const n = RE_CUB.test(ack) ? parseWidthFromCUBMsg(ack) : parseWidthFromBSMsg(ack);
      // if (!Number.isFinite(n)) return NaN;

      // return n - (prefix.length + suffix.length);

      socket.send(this.keys.end);
      ack = await readUntil(m => RE_CUF.test(m), 800);

      const n = parseWidthFromCUFMsg(ack);
      if (!Number.isFinite(n)) return NaN;

      return n - (prefix.length + suffix.length);
    },
    async measureMovWidth(socket, readUntil, payload, prefix, suffix) {
      socket.send(this.keys.clear);
      await readUntil(() => true, 120, false);

      socket.send(prefix + payload + suffix);
      let ack = await readUntil(m => m.includes(suffix), 1000);
      if (!ack) return NaN;

      /* ZLE key width is context-sensitive. a prefix anchors the line so
       * zw controls collapse instead of behaving like cursor units. */
      let rightRepeat = 1; // use prefix and start at 1
      const MAX_RIGHT = 15;

      while (rightRepeat <= MAX_RIGHT) {
        socket.send(this.keys.home);
        ack = await readUntil(m => RE_CUB.test(m) || m.includes('\x08'), 900);
        if (!ack) return NaN;

        for (let i = 0; i < rightRepeat; i++) {
          socket.send(this.keys.right);
          ack = await readUntil(m => RE_CUF.test(m), 800);
          if (!ack) return NaN;
        }

        socket.send(this.keys.end);
        ack = await readUntil(m => RE_CUF.test(m), 800);
        if (!ack) return NaN;

        const n = parseWidthFromCUFMsg(ack);
        if (!Number.isFinite(n) || n < suffix.length) return NaN;

        if (n === suffix.length) {
          // subtract prefix traversal
          return rightRepeat - 1;
        }

        rightRepeat++;
      }

      return NaN;
    },
    async measureDelWidth(socket, readUntil, payload, prefix, suffix) { return NaN; },
  },
  {
    id: 'fish',
    label: 'fish (Command line editor)',
    keys: { ...DEFAULT_KEYMAP },
    init: [
      `exec fish --no-config --private`,
      `function fish_prompt; echo -n "> "; end`,
      `function fish_right_prompt; end`,
      `set -gx fish_history ""`,
      // `set -gx XDG_DATA_HOME /dev/null`,
      `set -g fish_autosuggestion_enabled 0`,


      `bind '\\e[D' backward-char`,          // \x1b[D
      `bind '\\e[C' forward-char`,           // \x1b[C
      `bind '\\e[H' beginning-of-line`,      // \x1b[H
      `bind '\\e[F' end-of-line`,            // \x1b[F
      // `bind '\\cU' backward-kill-line`,      // \x15
      `bind '\\cU' kill-line`,               // \x15
      `bind '\\x7f' backward-delete-char`,   // \x7f
    ],
    widthBuckets: DEFAULT_WIDTH_BUCKETS,
    async measureColWidth(socket, readUntil, payload, prefix, suffix) {
      let ack: string | undefined;

      // fish is bugged? need to go to end before clearing
      // (it's acting like backward-kill-line rather than kill-line)
      socket.send(this.keys.end);
      await readUntil(() => true, 80, false);

      socket.send(this.keys.clear);
      await readUntil(() => true, 80, false);

      socket.send(prefix + payload + suffix);
      ack = await readUntil(m => m.includes(suffix), 1000);
      if (!ack) return NaN;

      socket.send(this.keys.home);
      ack = await readUntil(() => true, 600);
      if (!ack) return NaN;

      let promptCols: number | undefined;
      if (RE_CR_CUF_ONLY.test(ack)) {
        promptCols = parseWidthFromCUFMsg(ack);
        if (!Number.isFinite(promptCols)) return NaN;
      }

      socket.send(this.keys.end);
      ack = await readUntil(m => RE_CUF.test(m), 800);
      if (!ack) return NaN;

      const n = parseWidthFromCUFMsg(ack);
      if (!Number.isFinite(n)) return NaN;

      if (RE_CR_CUF_ONLY.test(ack)) {
        if (promptCols === undefined) return NaN;
        return n - (prefix.length + suffix.length + promptCols);
      }

      return n - (prefix.length + suffix.length);
    },
    async measureMovWidth(socket, readUntil, payload, prefix, suffix) {
      // fish is bugged? need to go to end before clearing
      // (it's acting like backward-kill-line rather than kill-line)
      socket.send(this.keys.end);
      await readUntil(() => true, 80, false);

      socket.send(this.keys.clear);
      await readUntil(() => true, 80, false);

      socket.send(prefix + payload + suffix);
      let ack = await readUntil(m => m.includes(suffix), 1000);
      if (!ack) return NaN;

      socket.send(this.keys.home);
      ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 900);
      if (!ack) return NaN;

      socket.send(this.keys.end);
      ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 800);
      if (!ack) return NaN;

      const totalCols = parseWidthFromCUFMsg(ack);
      const doneCol = totalCols - suffix.length;
      if (!Number.isFinite(totalCols)) return NaN;

      // go back to home
      socket.send(this.keys.home);
      ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 900);
      if (!ack) return NaN;

      // move past the prefix
      for (let i = 0; i < prefix.length; i++) {
        socket.send(this.keys.right);
        ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 800);
        if (!ack) return NaN;
      }

      let rightRepeat = prefix.length; // use prefix and start at 1
      const MAX_RIGHT = 15;

      while (rightRepeat <= MAX_RIGHT) {
        socket.send(this.keys.right);
        ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 800);
        if (!ack) return NaN;

        const currCol = parseWidthFromCUFMsg(ack);
        if (!Number.isFinite(currCol)) return NaN;
        if (currCol > doneCol) return NaN;
        if (currCol === doneCol) return rightRepeat;
        rightRepeat++;
      }

      return NaN;
    },
    async measureDelWidth(socket, readUntil, payload, prefix, suffix) {
      socket.send(this.keys.end);
      await readUntil(() => true, 80, false);

      socket.send(this.keys.clear);
      await readUntil(() => true, 80, false);

      socket.send(prefix + payload + suffix);
      let ack = await readUntil(m => m.includes(suffix), 1000);
      if (!ack) return NaN;

      socket.send(this.keys.home);
      ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 900);
      if (!ack) return NaN;

      const promptCol = parseWidthFromCUFMsg(ack);
      if (!Number.isFinite(promptCol)) return NaN;

      const doneCol = promptCol + prefix.length;

      socket.send(this.keys.end);
      ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 800);
      if (!ack) return NaN;

      // Phase A: delete suffix (not counted)
      let col = parseWidthFromCUFMsg(ack);
      if (!Number.isFinite(col)) return NaN;

      for (let i = 0; i < suffix.length; i++) {
        socket.send(this.keys.del);
        ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 800);
        if (!ack) return NaN;

        col = parseWidthFromCUFMsg(ack);
        if (!Number.isFinite(col)) return NaN;

        // after stripping suffix, we must still be at/after the prefix-end target
        if (col < doneCol) return NaN;
      }

      // already at target after suffix stripping?
      if (col === doneCol) return 0;

      // Phase B: delete payload (counted)
      let nDel = 0;
      const MAX_DEL = 15;

      while (nDel < MAX_DEL) {
        socket.send(this.keys.del);
        ack = await readUntil(m => RE_TAIL_CR_CUF.test(m), 800);
        if (!ack) return NaN;

        col = parseWidthFromCUFMsg(ack);
        if (!Number.isFinite(col)) return NaN;

        nDel++;

        if (col === doneCol) return nDel;
        if (col < doneCol) return NaN;
      }

      return NaN;
    },
  },
  {
    id: 'pwsh',
    label: 'pwsh (PSReadLine)',
    keys: {
      ...DEFAULT_KEYMAP,
      clear: '\x1b', // ESC, undo line edits
    },
    init: [
      `function prompt { "> " }`,
      `Set-PSReadLineOption -PredictionSource None`,
      `Set-PSReadLineOption -HistorySaveStyle SaveNothing`,
    ],
    widthBuckets: DEFAULT_WIDTH_BUCKETS,
    async measureColWidth(socket, readUntil, payload, prefix, suffix) {
      socket.send(this.keys.clear);
      await readUntil(m => true, 200);

      socket.send(prefix + payload + suffix);
      await readUntil(m => m.includes(suffix), 1000);

      let endMsg: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        socket.send(this.keys.home);
        const homeMsg = await readUntil(m => RE_CUP.test(m), 900);
        if (!homeMsg) continue;

        socket.send(this.keys.end);
        endMsg = await readUntil(m => RE_CUF.test(m) || RE_CUP.test(m), 800);
        if (endMsg && RE_CUF.test(endMsg)) break;
      }

      return parseWidthFromCUFMsg(endMsg) - (prefix.length + suffix.length);
    },
    async measureMovWidth(socket, readUntil, payload, prefix, suffix) {
      socket.send(this.keys.clear);
      await readUntil(() => true, 200);

      socket.send(payload + suffix);
      await readUntil(m => m.includes(suffix), 1000);

      let rightRepeat = 0;
      const MAX_RIGHT = 15;
      while (rightRepeat <= MAX_RIGHT) {
        socket.send(this.keys.home);
        let ack = await readUntil(m => RE_CUP.test(m), 900);
        if (!ack) return NaN;

        if (rightRepeat) {
          for (let i = 0; i < rightRepeat; i++) {
            socket.send(this.keys.right);
            ack = await readUntil(m => RE_CUF.test(m), 800);
            if (!ack) return NaN;
          }
        }

        socket.send(this.keys.end);
        ack = await readUntil(m => RE_CUF_NOT_ONE.test(m), 800);
        if (!ack) return NaN;

        const n = parseWidthFromCUFMsg(ack);
        if (!Number.isFinite(n) || n < suffix.length) return NaN;
        if (n === suffix.length) return rightRepeat;
        rightRepeat++;
      }
    },
    async measureDelWidth(socket, readUntil, payload, prefix, suffix) { return NaN; },
  }
];

interface ISocketReporter {
  log: string[];
  logEnabled: boolean;
}

export class ShellExplorerWindow extends BaseWindow {
  public readonly id = 'shell-explorer';
  public readonly label = 'Shell';

  private _out: HTMLPreElement;
  private _outMaxChars = 15000;
  private _sock: WebSocket | undefined;
  private _rep: ISocketReporter | undefined;
  private _profile: IAppProfile | undefined;
  private _showZwj = false;
  private _silentCb: HTMLInputElement;

  private _useTestPrefix = false;
  private _useTestSuffix = false;
  private _genTableTurboMode = false;
  private _genStart = 0x0;
  private _genEnd = 0x10FFFF;
  private _measureStatusSpan!: HTMLSpanElement;
  private _measureColWidth = true;
  private _measureMovWidth = true;
  private _measureDelWidth = true;

  constructor(
    terminal: Terminal,
    addons: AddonCollection,
    private readonly _deps: { getSocket: () => WebSocket | undefined },
  ) {
    super(terminal, addons);
  }

  public build(container: HTMLElement): void {
    const root = document.createElement('div');
    container.appendChild(root);

    // Shell profile
    addRow(root, 'profile: ',
      mkSelect(SHELL_PROFILES, null as AppId | null, id => this._setProfile(id), 'Shell profile (key sequences)'),
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
      mkButton('CLEAR', 'Clear the log output', () => this._clearLog()),
      silentLabel,
      mkCheckbox('zwj ', 'render ZWJ as {zwj} in trace?', this._showZwj, v => { this._showZwj = v; }).label,
    );

    // Shell input
    root.appendChild(document.createElement('hr'));
    addRow(root, 'shell input:');

    const delN = mkNumericUpDown('DEL repeat count', 1, 64, 1, 1);
    delN.style.width = '30px';
    addRow(root, '',
      mkButton('CLEAR', 'Clear the current line', () => {
        this._inject(this._profile?.keys.clear);
      }),
      mkButton('←', 'Left (profile-specific)', () => this._inject(this._profile?.keys.left)),
      mkButton('→', 'Right (profile-specific)', () => this._inject(this._profile?.keys.right)),
      mkButton('HOME', 'Home (profile-specific)', () => this._inject(this._profile?.keys.home)),
      mkButton('END', 'End (profile-specific)', () => this._inject(this._profile?.keys.end)),
      mkButton('DEL × N', 'Send DEL × N', () => {
        const n = Math.max(1, Math.min(64, +delN.value));
        this._inject(this._profile?.keys.del.repeat(n));
      }),
      delN,
    );

    addRow(root, '',
      ...TESTS.map(t => mkButton(t, `Inject "${formatCodePoints(t)}"`, () => this._inject((this._useTestPrefix ? TEST_PREFIX : '') + t + (this._useTestSuffix ? TEST_SUFFIX : '')))),
      mkCheckbox('prefix', `prefix test inputs with ${TEST_PREFIX}`, this._useTestPrefix, v => { this._useTestPrefix = v; }).label,
      mkCheckbox('suffix', `suffix test inputs with ${TEST_SUFFIX}`, this._useTestSuffix, v => { this._useTestSuffix = v; }).label,
    );

    // Generate tables / scripting
    root.appendChild(document.createElement('hr'));
    addRow(root, 'measure widths:');

    addRow(root, '',
      mkCheckbox('col ', 'Measure col-reported widths', this._measureColWidth, v => { this._measureColWidth = v; }).label,
      mkCheckbox('mov ', 'Measure mov-reported widths', this._measureMovWidth, v => { this._measureMovWidth = v; }).label,
      mkCheckbox('del ', 'Measure del-reported widths', this._measureDelWidth, v => { this._measureDelWidth = v; }).label,
    );

    addRow(root, '',
      ...TESTS.map(t => mkButton(t, `Measure "${formatCodePoints(t)}"`, () => this._probeString(t))),
    );

    const { input: startInput, label: startLabel } = mkLabeledInput(
      'start:', 'Start code point (hex)', '60px',
      hexToStr(this._genStart),
      v => {
        const n = parseInt(v.trim().replace(/^0x/i, ''), 16);
        if (!Number.isNaN(n)) { this._genStart = n; startInput.value = hexToStr(n); }
      },
    );
    const { input: endInput, label: endLabel } = mkLabeledInput(
      'end:', 'End code point (hex)', '60px',
      hexToStr(this._genEnd),
      v => {
        const n = parseInt(v.trim().replace(/^0x/i, ''), 16);
        if (!Number.isNaN(n)) { this._genEnd = n; endInput.value = hexToStr(n); }
      },
    );

    addRow(root, '',
      mkButton('unicode', 'Generate tables for range of cps', () => { void this._genTables();}),
      ' ',
      startLabel,
      ' ',
      endLabel,
      mkCheckbox(
        'turbo ', 'Disable printing and widen columns for faster runs', this._genTableTurboMode,
        v => {
          this._genTableTurboMode = v;
          if (v) this._setLogEnabled(!v);
        },
      ).label,
    );

    this._measureStatusSpan = document.createElement('span');
    addRow(root, 'status: ', this._measureStatusSpan);

    // Output
    const pre = document.createElement('pre');
    pre.textContent = this._profile?.id ? `[dev] shell profile = ${this._profile.id}\n` : '[dev] no shell profile selected\n';
    this._out = pre;
    root.appendChild(pre);

    // first, early attempt at installing the reporter (socket creation is async)
    // alternatively, use mutation observer on visibility
    setTimeout(() => this._tryInstallReporter(), 500);
  }

  // State / actions
  private async _setProfile(id: AppId): Promise<void> {
    const oldId = this._profile?.id;
    this._profile = SHELL_PROFILES.find(p => p.id === id)!;
    if (oldId === this._profile.id) return;
    await this._initProfile();
    this._appendLog(`[dev] shell profile = ${this._profile.id}\n`);
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
    if (!this._sock) { this._appendLog('[dev] no socketyy\n'); return; }
    if (!this._rep.logEnabled) { this._setLogEnabled(true); }

    this._sock.send(data);
  }

  private _clearLog(): void {
    this._out.textContent = '';
  }

  private _appendLog(s: string): void {
    if (this._out.textContent.length > this._outMaxChars) {
      this._clearLog();
    }
    this._out.textContent += s;
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

    const msgReader = new MessageReader(this._sock);
    const bar = '----------------------------\n';

    try {
      if (this._measureColWidth) {
        const w = await this._profile.measureColWidth(
          this._sock,
          msgReader.readUntil,
          s,
          TEST_PREFIX,
          TEST_SUFFIX
        );
        this._appendLog(`${bar}col-width: ${w}\n${bar}`);
        this._measureStatusSpan.textContent += `col-width: ${w}`;
      }

      if (this._measureMovWidth) {
        const w = await this._profile.measureMovWidth(
          this._sock,
          msgReader.readUntil,
          s,
          TEST_PREFIX,
          TEST_SUFFIX
        );
        this._appendLog(`${bar}mov-width: ${w}\n${bar}`);
        if (this._measureMovWidth) this._measureStatusSpan.textContent += ', ';
        this._measureStatusSpan.textContent += `mov-width: ${w}`;
      }

      if (this._measureDelWidth) {
        const w = await this._profile.measureDelWidth(
          this._sock,
          msgReader.readUntil,
          s,
          TEST_PREFIX,
          TEST_SUFFIX
        );
        this._appendLog(`${bar}del-width: ${w}\n${bar}`);
        if (this._measureDelWidth) this._measureStatusSpan.textContent += ', ';
        this._measureStatusSpan.textContent += `del-width: ${w}`;
      }
    } finally {
      msgReader.dispose();
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
    const origSize = { cols: this._terminal.cols, rows: this._terminal.rows };

    let resizeLock: IResizeLock | undefined;
    if (this._genTableTurboMode) {
      this._toggleAttach(false);
      this._terminal.resize(TURBO_COLS, 24);
      resizeLock = installResizeLock(this._terminal);
      resizeLock.setLocked(true);
    }

    const msgReader = new MessageReader(sock);

    try {
      this._appendLog(`[dev] gen tables start range=${hexToStr(this._genStart)}..${hexToStr(this._genEnd)}\n`);
      const progress = new ProgressReport(this._genStart, this._genEnd, 1500, this._measureStatusSpan!);
      const tables = this._profile.widthBuckets.map(b => ({
        bucket: b,
        table: new RangeTable(b.label),
      }));
      const skipTable = getSkipTable();

      let width = 0;
      let rampLevel = 0;
      let rampMax = 6;
      const RAMP_LETHARGY = 0;
      if (this._genTableTurboMode) {
        const promptCols = 2;
        const marginCols = 2;
        const bookendCols = TEST_PREFIX.length + TEST_SUFFIX.length;

        const budget = TURBO_COLS - promptCols - bookendCols - marginCols;
        const maxBatch = Math.floor(budget / 2);

        rampMax = maxBatch >= 1 ? Math.floor(Math.log2(maxBatch)) : 0;
      }

      if (this._measureColWidth) {
        for (let cp = this._genStart; cp <= this._genEnd;) {
          if (cp > 0x10FFFF) break;
          if (skipTable.has(cp)) { cp++; continue; }

          const ramp = Math.min(Math.max(rampLevel - RAMP_LETHARGY, 0), rampMax);
          const batchSize = (rampLevel === 0) ? 1 : (1 << ramp);

          const { s, outCount, next } = cpBatch(cp, batchSize, this._genEnd);

          const widthTotal = await this._profile.measureColWidth(sock, msgReader.readUntil, s, TEST_PREFIX, TEST_SUFFIX);

          if (!Number.isFinite(widthTotal)) {
            if (rampLevel === 0) {
              this._appendLog(`[dev] cp=0x${hexToStr(cp)} END: invalid width after retries\n`);
              tables.find(t => t.bucket.match(NaN))!.table.addCp(cp);
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

          // assign to appropriate table
          tables.find(t => t.bucket.match(width))!.table.addRange(cp, next - 1);

          cp = next;
          progress.update(cp - 1);
          rampLevel = Math.min(rampLevel + 1, rampMax + RAMP_LETHARGY);
        }
      } else if (this._measureMovWidth) {
        for (let cp = this._genStart; cp <= this._genEnd; cp++) {
          if (cp > 0x10FFFF) break;
          if (skipTable.has(cp)) continue;

          const movWidth = await this._profile.measureMovWidth(sock, msgReader.readUntil, String.fromCodePoint(cp), TEST_PREFIX, TEST_SUFFIX);
          tables.find(t => t.bucket.match(movWidth))!.table.addCp(cp);
          progress.update(cp);
        }
      } else if (this._measureDelWidth) {
        for (let cp = this._genStart; cp <= this._genEnd; cp++) {
          if (cp > 0x10FFFF) break;
          if (skipTable.has(cp)) continue;

          const delWidth = await this._profile?.measureDelWidth(sock, msgReader.readUntil, String.fromCodePoint(cp), TEST_PREFIX, TEST_SUFFIX);
          tables.find(t => t.bucket.match(delWidth))!.table.addCp(cp);
          progress.update(cp);
        }
      }

      // clear line
      sock.send(this._profile.keys.clear);
      await msgReader.readUntil(m => true, 40);

      // annotate with movWidths if requested
      if (this._measureColWidth && this._measureMovWidth) {
        for (const t of tables.filter(t => t.bucket.annotateMovWidth).map(t => t.table)) {
          for (const r of t._ranges) {
            const samples = [r.start, r.end, Math.floor((r.start + r.end) / 2)];
            const sampleWidths: number[] = [];
            for (const sampleCp of samples) {
              const s = String.fromCodePoint(sampleCp);
              const movWidth = await this._profile.measureMovWidth(sock, msgReader.readUntil, s, TEST_PREFIX, TEST_SUFFIX);
              sampleWidths.push(movWidth);
            }
            if (sampleWidths.every(w => w === sampleWidths[0])) {
              r.movWidth = sampleWidths[0];
            } else {
              r.movWidth = NaN; // inconsistent
            }
          }
        }
      }

      // annotate with delWidths if requested
      if (this._measureColWidth && this._measureDelWidth) {
        for (const t of tables.filter(t => t.bucket.annotateDelWidth).map(t => t.table)) {
          for (const r of t._ranges) {
            const samples = [r.start, r.end, Math.floor((r.start + r.end) / 2)];
            const sampleWidths: number[] = [];
            for (const sampleCp of samples) {
              const s = String.fromCodePoint(sampleCp);
              const delWidth = await this._profile.measureDelWidth(sock, msgReader.readUntil, s, TEST_PREFIX, TEST_SUFFIX);
              sampleWidths.push(delWidth);
            }
            if (sampleWidths.every(w => w === sampleWidths[0])) {
              r.delWidth = sampleWidths[0];
            } else {
              r.delWidth = NaN; // inconsistent
            }
          }
        }
      }

      for (const { table: t } of tables) {
        console.log(t.printRanges());
      }
    } catch (e) {
      console.error('error during _genTables', e);
    } finally {
      msgReader.dispose();
      if (this._genTableTurboMode) {
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


// function parseWidthFromCUBMsg(msg?: string, mode: 'sum' | 'last' = 'sum'): number {
//   if (!msg) return NaN;

//   const re = /\x1b\[(\d*)D/g;

//   let matched = false;
//   let sum = 0;
//   let last = NaN;

//   for (let m; (m = re.exec(msg)) !== null;) {
//     matched = true;

//     // Empty means implicit 1.
//     const s = m[1];
//     const n = s === '' ? 1 : Number(s);
//     if (!Number.isFinite(n)) return NaN;

//     sum += n;
//     last = n;
//   }

//   if (!matched) return NaN;
//   return mode === 'last' ? last : sum;
// }

// function parseWidthFromBSMsg(msg?: string): number {
//   if (!msg) return NaN;
//   if (!RE_BS_ONLY.test(msg)) return NaN;

//   // Each '\x08' is one column left
//   return msg.length;
// }

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

function mkButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function mkSelect<T extends string>(
  items: ReadonlyArray<{ id: T, label: string }>,
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

function mkLabeledInput(label: string, title: string, size: string, value: string, onChange?: (v: string) => void): { label: HTMLLabelElement, input: HTMLInputElement } {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.title = title;
  i.style.width = size;
  i.value = value;
  if (onChange) i.onchange = () => onChange(i.value);
  l.append(label, i);
  return { label: l, input: i };
}

function addRow(root: HTMLElement, label: string, ...nodes: (Node | string)[]): void {
  root.append(label, ...nodes, document.createElement('br'));
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

interface IRange { start: number, end: number, movWidth?: number, delWidth?: number }

class RangeTable {
  public _ranges: IRange[] = [];

  constructor(private _label: string) {}

  public addCp(cp: number): void {
    const last = this._ranges[this._ranges.length - 1];
    if (!last) {
      this._ranges.push({ start: cp, end: cp });
      return;
    }
    if (cp <= last.end) {
      console.warn(`RangeTable.addCp: ${cp} out-of-order or duplicate`);
      return;
    }
    if (cp === last.end + 1) {
      last.end = cp;
      return;
    }
    this._ranges.push({ start: cp, end: cp });
  }

  public addRange(start: number, end: number): void {
    if (start > end) throw new Error(`addRange invalid ${start}..${end}`);

    const last = this._ranges[this._ranges.length - 1];
    if (!last) { this._ranges.push({ start, end }); return; }

    if (start <= last.end + 1) {
      if (end > last.end) last.end = end;
      return;
    }

    this._ranges.push({ start, end });
  }

  public printRanges(): string {
    const out: string[] = [];

    const cpCount = this._ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    out.push(`// [ranges=${this._ranges.length}; codePoints=${cpCount}]`);

    out.push(`const ${this._label}: IRange[] = [`);
    for (const { start, end, movWidth, delWidth } of this._ranges) {
      const sHex = hexToStr(start);
      const eHex = hexToStr(end);

      const movWidthStr = movWidth !== undefined ? `, movWidth: ${movWidth}` : '';
      const delWidthStr  = delWidth  !== undefined ? `, delWidth: ${delWidth}`   : '';

      out.push(`  { start: ${sHex}, end: ${eHex}${movWidthStr}${delWidthStr} },`);
    }
    out.push(']');
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
  const t = new RangeTable('skip'); // label irrelevant if you never print it
  t.addRange(0x0000, 0x001F); // C0
  t.addRange(0x007F, 0x009F); // DEL + C1
  t.addRange(0xD800, 0xDFFF); // surrogates

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

class MessageReader {
  private _pending?: { until: (msg: string) => boolean, resolve: (msg: string | undefined) => void, timer: number };

  constructor(private readonly _socket: WebSocket) {
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
          throw new Error(`timeout waiting for socket message (${timeoutMs}ms)`);
          console.error(`timeout waiting for socket message (${timeoutMs}ms)`);
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
