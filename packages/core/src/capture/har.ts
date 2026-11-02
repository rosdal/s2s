import type { BodyStore } from "./body-store.js";
import type { RequestRecord } from "./request-log.js";

const TEXT_MIME =
  /^(text\/|application\/(?:javascript|json|xml|.*\+json|.*\+xml|x-javascript|ecmascript))/;
const MAX_EMBED = 2 * 1024 * 1024;

const headerList = (headers: Record<string, string>) =>
  Object.entries(headers).map(([name, value]) => ({ name, value }));

/**
 * Build a HAR 1.2 log from the request records. Text bodies up to 2 MB are embedded; every entry
 * also carries `_bodyHash` pointing into `raw/bodies/`.
 */
export async function buildHar(
  records: RequestRecord[],
  store: BodyStore,
  creatorVersion: string,
): Promise<unknown> {
  const entries = [];
  for (const record of records) {
    let text: string | undefined;
    if (
      record.bodyHash &&
      record.mimeType &&
      TEXT_MIME.test(record.mimeType) &&
      (record.size ?? 0) <= MAX_EMBED
    ) {
      text = (await store.read(record.bodyHash).catch(() => undefined))?.toString("utf8");
    }
    const url = new URL(record.url);
    entries.push({
      pageref: record.page ? `${record.page}@${record.viewport ?? "none"}` : undefined,
      startedDateTime: record.timing.startedAt,
      time: record.timing.durationMs ?? 0,
      request: {
        method: record.method,
        url: record.url,
        httpVersion: "HTTP/1.1",
        headers: headerList(record.requestHeaders),
        queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
        cookies: [],
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: record.status,
        statusText: "",
        httpVersion: "HTTP/1.1",
        headers: headerList(record.responseHeaders),
        cookies: [],
        content: {
          size: record.size ?? 0,
          mimeType: record.mimeType ?? "",
          ...(text !== undefined ? { text } : {}),
        },
        redirectURL: record.redirectedTo ?? "",
        headersSize: -1,
        bodySize: record.size ?? -1,
        ...(record.failure ? { _error: record.failure } : {}),
      },
      cache: {},
      timings: { send: 0, wait: record.timing.durationMs ?? 0, receive: 0 },
      _phase: record.phase,
      _origin: record.origin,
      _bodyHash: record.bodyHash,
    });
  }
  const pages = [
    ...new Set(records.flatMap((r) => (r.page ? [`${r.page}@${r.viewport ?? "none"}`] : []))),
  ].map((id) => ({
    id,
    title: id,
    startedDateTime: records.find((r) => `${r.page}@${r.viewport ?? "none"}` === id)?.timing
      .startedAt,
    pageTimings: {},
  }));
  return {
    log: { version: "1.2", creator: { name: "s2s", version: creatorVersion }, pages, entries },
  };
}
