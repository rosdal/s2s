import { type Browser, chromium } from "playwright-core";

export class BrowserNotFoundError extends Error {
  constructor(cause: unknown) {
    super(
      [
        "No usable Chromium browser found.",
        "s2s uses an installed Google Chrome when it finds one. Either install Chrome, or download",
        "Playwright's Chromium once with:",
        "",
        "  npx playwright install chromium",
        "",
        "To use a specific browser binary, set S2S_CHROME_PATH to its path.",
      ].join("\n"),
      { cause },
    );
    this.name = "BrowserNotFoundError";
  }
}

export interface LaunchOptions {
  headless?: boolean;
  /** Explicit browser binary; defaults to `S2S_CHROME_PATH`. */
  executablePath?: string;
  /** Extra Chromium switches, such as software WebGL for deterministic rendering. */
  args?: string[];
}

function isMissingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|Chromium distribution .* is not found|not found at|ENOENT|Failed to launch/i.test(
    message,
  );
}

/**
 * Launch Chromium: an explicit binary if given, else the installed Google Chrome
 * (`channel: "chrome"`), else Playwright's own Chromium. Throws `BrowserNotFoundError` with
 * install instructions when none of them can start.
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const headless = options.headless ?? true;
  const args = options.args ?? [];
  const executablePath = options.executablePath ?? process.env.S2S_CHROME_PATH;
  if (executablePath) {
    try {
      return await chromium.launch({ headless, executablePath, args });
    } catch (error) {
      throw new BrowserNotFoundError(error);
    }
  }
  const attempts = [
    () => chromium.launch({ headless, channel: "chrome", args }),
    () => chromium.launch({ headless, args }),
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isMissingBrowser(error)) throw error;
    }
  }
  throw new BrowserNotFoundError(lastError);
}
