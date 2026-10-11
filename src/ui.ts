/**
 * Terminal presentation. Everything here is silent unless stdout is a TTY, so
 * piping to a file, to jq, or running in CI produces exactly the same bytes it
 * always did.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DIM = "\x1b[2m", RESET = "\x1b[0m", BOLD = "\x1b[1m";
const BLUE = "\x1b[38;5;75m", GREY = "\x1b[38;5;244m", AMBER = "\x1b[38;5;214m";

export const isTty = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export function banner(version: string): string {
  if (!isTty()) return "";
  return [
    "",
    `  ${BLUE}▌${RESET}${BOLD} shadowjoin ${RESET}${GREY}v${version}${RESET}`,
    `  ${BLUE}▌${RESET}${DIM} the matches your join never told you it was losing${RESET}`,
    "",
  ].join("\n");
}

export function footer(version: string): string {
  if (!isTty()) return "";
  return `  ${GREY}shadowjoin v${version}  ·  MIT  ·  Harsh N. Chandak  ·  harsh-chandak.com${RESET}\n`;
}

/** A spinner that degrades to nothing when it isn't being watched by a human. */
export class Progress {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  private readonly started = Date.now();
  private readonly done: string[] = [];

  start(label: string): void {
    this.label = label;
    if (!isTty()) return;
    if (this.timer) return;
    this.timer = setInterval(() => this.paint(), 80);
    this.timer.unref?.();
    this.paint();
  }

  /** Mark the current step finished and begin the next one. */
  step(label: string): void {
    if (isTty()) {
      this.clear();
      process.stdout.write(`  ${BLUE}✓${RESET} ${DIM}${this.label}${RESET}\n`);
    }
    this.done.push(this.label);
    this.label = label;
    if (isTty()) this.paint();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!isTty()) return;
    this.clear();
    const ms = Date.now() - this.started;
    process.stdout.write(`  ${BLUE}✓${RESET} ${DIM}${this.label}${RESET}  ${GREY}${ms}ms${RESET}\n`);
  }

  /** Clear the spinner without claiming the step succeeded. */
  abort(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (isTty()) this.clear();
  }

  private clear(): void {
    process.stdout.write("\r\x1b[2K");
  }

  private paint(): void {
    const f = FRAMES[this.frame++ % FRAMES.length];
    process.stdout.write(`\r\x1b[2K  ${AMBER}${f}${RESET} ${this.label}`);
  }
}
