import type { APIRequestContext } from "playwright-core";
import robotsParserModule from "robots-parser";

export const ROBOTS_AGENT = "s2s";

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
}
type RobotsParser = (url: string, contents: string) => Robot;

// robots-parser is CommonJS (`module.exports = fn`) but its types declare a default export, so
// TypeScript sees a namespace where Node hands over the function itself.
const robotsParser: RobotsParser =
  (robotsParserModule as unknown as { default?: RobotsParser }).default ??
  (robotsParserModule as unknown as RobotsParser);

/** robots.txt per origin, fetched once through the capture's own request context. */
export class RobotsCache {
  readonly #request: APIRequestContext;
  readonly #byOrigin = new Map<string, Promise<Robot | undefined>>();

  constructor(request: APIRequestContext) {
    this.#request = request;
  }

  #load(origin: string): Promise<Robot | undefined> {
    let entry = this.#byOrigin.get(origin);
    if (!entry) {
      const robotsUrl = `${origin}/robots.txt`;
      entry = this.#request
        .get(robotsUrl, { timeout: 10_000, maxRedirects: 5, failOnStatusCode: false })
        .then(async (response) =>
          // A missing or erroring robots.txt means no rules apply.
          response.ok() ? robotsParser(robotsUrl, await response.text()) : undefined,
        )
        .catch(() => undefined);
      this.#byOrigin.set(origin, entry);
    }
    return entry;
  }

  async isAllowed(url: string): Promise<boolean> {
    const robot = await this.#load(new URL(url).origin);
    return robot?.isAllowed(url, ROBOTS_AGENT) ?? true;
  }

  /** Crawl-delay for the origin in milliseconds, if robots.txt sets one. */
  async crawlDelayMs(url: string): Promise<number | undefined> {
    const robot = await this.#load(new URL(url).origin);
    const seconds = robot?.getCrawlDelay(ROBOTS_AGENT);
    return seconds === undefined ? undefined : seconds * 1000;
  }
}
