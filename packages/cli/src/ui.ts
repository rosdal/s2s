/**
 * The terminal look shared by every command: a small palette, status symbols, ANSI-aware padding,
 * bars, boxes, and a stage list that redraws in place on a terminal and prints plain lines
 * everywhere else (CI, pipes, tests).
 */

export type ColorDepth = 1 | 4 | 8 | 24;

type Paint = (text: string) => string;

export interface Theme {
  accent: Paint;
  info: Paint;
  warn: Paint;
  error: Paint;
  /** Labels, timings, secondary text. */
  dim: Paint;
  /** Descriptions: lighter than `dim`, quieter than the default. */
  muted: Paint;
  /** Tree lines and box borders. */
  rule: Paint;
  bold: Paint;
  /** The `s2s` badge: dark text on the accent. */
  badge: Paint;
  /** A one-word label in a colored block, such as a confidence level. */
  tag: (color: "accent" | "info" | "warn" | "error", text: string) => string;
  depth: ColorDepth;
}

const HEX = {
  accent: "#B7F25A",
  info: "#6CCFF6",
  warn: "#F5C45E",
  error: "#FF8A7A",
  dim: "#7C818B",
  muted: "#9A9EA8",
  rule: "#3A3D45",
  ink: "#111216",
} as const;

const BASIC = {
  accent: 92,
  info: 96,
  warn: 93,
  error: 91,
  dim: 90,
  muted: 37,
  rule: 90,
} as const;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ansi256([r, g, b]: [number, number, number]): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

/** `depth` 1 means no color at all: the output is the plain text. */
export function createTheme(depth: ColorDepth): Theme {
  const wrap =
    (open: string, close: string): Paint =>
    (text) =>
      depth === 1 || text === "" ? text : `\x1b[${open}m${text}\x1b[${close}m`;
  const fg = (name: keyof typeof BASIC): Paint => {
    if (depth === 24) return wrap(`38;2;${rgb(HEX[name]).join(";")}`, "39");
    if (depth === 8) return wrap(`38;5;${ansi256(rgb(HEX[name]))}`, "39");
    return wrap(String(BASIC[name]), "39");
  };
  const bg = (hex: string, basic: number): string =>
    depth === 24
      ? `48;2;${rgb(hex).join(";")}`
      : depth === 8
        ? `48;5;${ansi256(rgb(hex))}`
        : String(basic + 10);
  const ink = depth === 24 ? `38;2;${rgb(HEX.ink).join(";")}` : "30";
  const tag = (color: "accent" | "info" | "warn" | "error", text: string) =>
    depth === 1 ? `[${text}]` : wrap(`1;${ink};${bg(HEX[color], BASIC[color])}`, "0")(` ${text} `);
  return {
    accent: fg("accent"),
    info: fg("info"),
    warn: fg("warn"),
    error: fg("error"),
    dim: fg("dim"),
    muted: fg("muted"),
    rule: fg("rule"),
    bold: wrap("1", "22"),
    badge: (text) => tag("accent", text),
    tag,
    depth,
  };
}

export const symbols = {
  done: "✓",
  failed: "✗",
  waiting: "○",
  skipped: "–",
  warning: "!",
  prompt: "❯",
  branch: "├",
  last: "└",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleLength(text))) + text;
}

/** Cut plain (uncolored) text to `width` characters, ending in `…` when it was longer. */
export function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** Rows of cells padded to their column's widest cell; the last column is left ragged. */
export function columns(rows: string[][], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : pad(cell, (widths[i] ?? 0) + gap)))
      .join("")
      .trimEnd(),
  );
}

/** A horizontal bar: `share` of `width` filled. On a plain terminal, `#` and `.`. */
export function bar(t: Theme, share: number, width: number, paint: Paint = t.accent): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  if (t.depth === 1) return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
  return paint("━".repeat(filled)) + t.rule("━".repeat(width - filled));
}

/** Segments that add up to at most 1, drawn as one bar `total` columns wide. */
export function stackedBar(t: Theme, segments: [number, Paint][], total: number): string {
  let used = 0;
  let out = "";
  const plain = t.depth === 1;
  const width = plain ? total - 2 : total;
  const marks = ["#", "=", "-"];
  segments.forEach(([share, paint], i) => {
    const cells = Math.min(width - used, Math.round(share * width));
    if (cells <= 0) return;
    out += plain ? (marks[i] ?? "+").repeat(cells) : paint("━".repeat(cells));
    used += cells;
  });
  const rest = width - used;
  return plain ? `[${out}${".".repeat(rest)}]` : out + t.rule("━".repeat(rest));
}

/** Lines framed by a rounded border, `width` columns wide including the border. */
export function box(t: Theme, lines: string[], width: number, border: Paint = t.rule): string[] {
  const inner = width - 4;
  return [
    border(`╭${"─".repeat(width - 2)}╮`),
    ...lines.map((line) => `${border("│")} ${pad(line, inner)} ${border("│")}`),
    border(`╰${"─".repeat(width - 2)}╯`),
  ];
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** What a stage reports to whoever draws it. */
export interface StageReporter {
  /** A transient status: the spinner text on a terminal, an indented line elsewhere. */
  detail(text: string, plain?: string): void;
  /** A warning, kept under the stage once it finishes. */
  warn(message: string): void;
  /** A line of its own that stays (an explanation, a skipped stage's reason). */
  note(text: string): void;
  done(summary: string): void;
  skipped(summary: string): void;
  /** `details` (an error's full text, build output) is shown by whoever owns the list. */
  failed(summary: string, details?: string[]): void;
}

type StageState = "waiting" | "running" | "done" | "skipped" | "failed";

interface StageRow {
  name: string;
  state: StageState;
  text: string;
  ms: number | null;
  startedAt: number;
  warnings: string[];
  details: string[];
}

export interface Surface {
  /** Write a whole line of output. */
  line: (text: string) => void;
  /** Raw writes for redrawing; `undefined` means no live redraw. */
  write?: ((chunk: string) => void) | undefined;
  columns: number;
  theme: Theme;
}

/**
 * The list of stages with their state. On a live surface it keeps one block at the bottom of the
 * terminal up to date (spinner, timings, a footer); elsewhere each event is one printed line.
 */
export class StageList {
  private readonly rows: StageRow[];
  private readonly started = Date.now();
  private drawn = 0;
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private closed = false;
  footer: string | undefined;

  constructor(
    private readonly surface: Surface,
    names: string[],
  ) {
    this.rows = names.map((name) => ({
      name,
      state: "waiting",
      text: "waiting",
      ms: null,
      startedAt: 0,
      warnings: [],
      details: [],
    }));
  }

  get live(): boolean {
    return this.surface.write !== undefined;
  }

  get elapsedMs(): number {
    return Date.now() - this.started;
  }

  /** Name, state and time of each stage, for a summary drawn after the list. */
  get stages(): { name: string; state: StageState; ms: number | null }[] {
    return this.rows.map(({ name, state, ms }) => ({ name, state, ms }));
  }

  /** The stage that failed, with its summary and details. */
  get failure(): { name: string; summary: string; details: string[] } | undefined {
    const row = this.rows.find((r) => r.state === "failed");
    return row && { name: row.name, summary: row.text, details: row.details };
  }

  /** Draw the waiting stages at once, so the whole run is visible from the start. */
  show(): void {
    if (!this.live) return;
    this.redraw();
    this.timer = setInterval(() => {
      this.frame++;
      this.redraw();
    }, 80);
    this.timer.unref?.();
  }

  /** Stop redrawing; the last frame stays on screen without the footer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.live) return;
    // A stage still spinning here ended without a report (an exception): stop its spinner.
    for (const row of this.rows)
      if (row.state === "running") {
        row.state = "failed";
        row.text = "stopped";
        row.ms = Date.now() - row.startedAt;
      }
    this.footer = undefined;
    this.redraw();
    this.drawn = 0;
  }

  /** Print lines above the live block (or just print them). */
  print(lines: string[]): void {
    if (!this.live) {
      for (const line of lines) this.surface.line(line);
      return;
    }
    this.erase();
    for (const line of lines) this.surface.write?.(`${line}\n`);
    this.drawn = 0;
    this.redraw();
  }

  start(name: string): StageReporter {
    const row = this.rows.find((r) => r.name === name);
    if (!row) throw new Error(`Unknown stage ${name}`);
    row.state = "running";
    row.text = "";
    row.startedAt = Date.now();
    this.redraw();
    const t = this.surface.theme;
    const finish = (state: StageState, text: string) => {
      row.state = state;
      row.text = text;
      row.ms = Date.now() - row.startedAt;
      if (this.live) this.redraw();
      else this.surface.line(this.rowLine(row));
      if (!this.live) for (const w of row.warnings) this.surface.line(this.warningLine(w));
    };
    return {
      detail: (text, plain) => {
        row.text = text;
        if (this.live) return;
        this.surface.line(`  ${plain ?? text}`);
      },
      warn: (message) => {
        if (!row.warnings.includes(message)) row.warnings.push(message);
        this.redraw();
      },
      note: (text) => this.print([`  ${t.muted(text)}`]),
      done: (summary) => finish("done", summary),
      skipped: (summary) => finish("skipped", summary),
      failed: (summary, details = []) => {
        row.details = details;
        finish("failed", summary);
      },
    };
  }

  private nameWidth(): number {
    return Math.max(10, ...this.rows.map((r) => r.name.length + 2));
  }

  private rowLine(row: StageRow): string {
    const t = this.surface.theme;
    const mark =
      row.state === "done"
        ? t.accent(symbols.done)
        : row.state === "failed"
          ? t.error(symbols.failed)
          : row.state === "skipped"
            ? t.dim(symbols.skipped)
            : row.state === "running"
              ? t.info(symbols.spinner[this.frame % symbols.spinner.length] ?? "")
              : t.dim(symbols.waiting);
    const name =
      row.state === "running"
        ? t.bold(row.name)
        : row.state === "waiting" || row.state === "skipped"
          ? t.dim(row.name)
          : row.name;
    const ms = row.state === "running" ? Date.now() - row.startedAt : row.ms;
    const time = ms === null ? "" : t.dim(seconds(ms));
    const width = this.surface.columns;
    const room = Math.max(10, width - 4 - this.nameWidth() - 8);
    const text = this.live ? truncate(row.text, room) : row.text;
    const body =
      row.state === "running"
        ? text
        : row.state === "failed"
          ? t.error(text)
          : row.state === "waiting" || row.state === "skipped"
            ? t.dim(text)
            : t.muted(text);
    const left = `${mark} ${pad(name, this.nameWidth())}${body}`;
    if (!time) return left;
    return this.live ? `${pad(left, width - 8)}${padStart(time, 7)}` : `${left}  ${time}`;
  }

  private warningLine(message: string): string {
    const t = this.surface.theme;
    const text = this.live ? truncate(message, this.surface.columns - 8) : message;
    return `  ${t.rule(symbols.last)} ${t.warn(symbols.warning)} ${t.muted(text)}`;
  }

  private lines(): string[] {
    const t = this.surface.theme;
    const out: string[] = [];
    for (const row of this.rows) {
      out.push(this.rowLine(row));
      for (const w of row.warnings.slice(-3)) out.push(this.warningLine(w));
    }
    if (this.footer) {
      const elapsed = `elapsed ${seconds(this.elapsedMs)}`;
      out.push(
        "",
        `${pad(t.dim(this.footer), this.surface.columns - 1 - elapsed.length)}${t.dim(elapsed)}`,
      );
    }
    return out;
  }

  private erase(): void {
    if (this.drawn > 0) this.surface.write?.(`\x1b[${this.drawn}F\x1b[0J`);
  }

  private redraw(): void {
    if (!this.live) return;
    const lines = this.lines();
    this.erase();
    this.surface.write?.(`${lines.join("\n")}\n`);
    this.drawn = lines.length;
  }
}

export interface OutputIO {
  stderr: (line: string) => void;
  write?: ((chunk: string) => void) | undefined;
  live?: boolean | undefined;
  columns?: number | undefined;
  colors?: ColorDepth | undefined;
}

export function surfaceOf(io: OutputIO): Surface {
  return {
    line: io.stderr,
    write: io.live ? io.write : undefined,
    columns: Math.max(60, Math.min(io.columns ?? 100, 120)),
    theme: createTheme(io.colors ?? 1),
  };
}

/** Color depth for a stream, honoring NO_COLOR and FORCE_COLOR. */
export function colorDepth(
  stream: { isTTY?: boolean; getColorDepth?: (env?: NodeJS.ProcessEnv) => number },
  env: NodeJS.ProcessEnv = process.env,
): ColorDepth {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 1;
    if (force === "2") return 8;
    if (force === "3") return 24;
    if (!stream.isTTY) return 4;
  }
  if (!stream.isTTY || !stream.getColorDepth) return 1;
  const depth = stream.getColorDepth(env);
  return depth >= 24 ? 24 : depth >= 8 ? 8 : depth >= 4 ? 4 : 1;
}

/**
 * A one-stage list for a command run on its own. `close` stops the redraw and prints a failed
 * stage's details under it.
 */
export function ownStage(io: OutputIO, name: string): { stage: StageReporter; close: () => void } {
  const s = surfaceOf(io);
  const list = new StageList(s, [name]);
  list.show();
  const stage = list.start(name);
  return {
    stage,
    close: () => {
      list.close();
      for (const line of list.failure?.details ?? []) io.stderr(`  ${s.theme.muted(line)}`);
    },
  };
}
