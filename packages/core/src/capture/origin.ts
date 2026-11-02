import { getDomain } from "tldts";
import type { OriginClass } from "./request-log.js";

/** Hosts (and their subdomains) that serve analytics, tag managers, ads and session replay. */
const ANALYTICS_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "googlesyndication.com",
  "googleadservices.com",
  "doubleclick.net",
  "adservice.google.com",
  "connect.facebook.net",
  "facebook.com",
  "hotjar.com",
  "hotjar.io",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "plausible.io",
  "clarity.ms",
  "bat.bing.com",
  "snap.licdn.com",
  "px.ads.linkedin.com",
  "analytics.tiktok.com",
  "static.ads-twitter.com",
  "analytics.twitter.com",
  "heapanalytics.com",
  "fullstory.com",
  "js-agent.newrelic.com",
  "nr-data.net",
  "browser-intake-datadoghq.com",
  "sentry.io",
  "sentry-cdn.com",
  "quantserve.com",
  "scorecardresearch.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "hs-analytics.net",
  "hs-scripts.com",
  "cookielaw.org",
  "onetrust.com",
  "cookiebot.com",
  "posthog.com",
  "matomo.cloud",
  "cloudflareinsights.com",
  "vercel-insights.com",
];

/** Hosts that serve web fonts and font stylesheets. */
const FONT_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "use.typekit.net",
  "p.typekit.net",
  "fonts.bunny.net",
  "use.fontawesome.com",
  "kit.fontawesome.com",
  "ka-f.fontawesome.com",
  "fast.fonts.net",
  "cloud.typography.com",
];

/** Public CDNs that serve npm packages and other libraries. */
const CDN_HOSTS = [
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.skypack.dev",
  "ajax.googleapis.com",
  "code.jquery.com",
  "stackpath.bootstrapcdn.com",
  "maxcdn.bootstrapcdn.com",
  "cdn.tailwindcss.com",
  "ga.jspm.io",
  "jspm.dev",
  "polyfill.io",
  "cdn.polyfill.io",
];

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Registrable domain (eTLD+1), or the bare host for IPs and `localhost`. */
export function registrableDomain(url: URL): string {
  return getDomain(url.hostname, { allowPrivateDomains: false }) ?? url.hostname;
}

export function isFirstParty(url: URL, target: URL): boolean {
  return registrableDomain(url) === registrableDomain(target);
}

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|$)/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|ogg|mp3|wav|m4a|mov)(\?|$)/i;
const MEDIA_TYPES = new Set(["image", "media"]);

export interface ClassifyInput {
  url: string;
  mimeType: string | null;
  resourceType: string;
}

/**
 * Tag a request with one origin class. Order matters: known analytics hosts first, then fonts and
 * media by type (wherever they are hosted), then first-party by registrable domain. Unknown
 * third-party scripts and styles count as `cdn-library`; other unknown third-party requests
 * (beacons, XHR, pixels) as `analytics-ads`.
 */
export function classifyOrigin(input: ClassifyInput, target: URL): OriginClass {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return "first-party";
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return "first-party";
  const host = url.hostname;
  const mime = input.mimeType ?? "";
  if (hostMatches(host, ANALYTICS_HOSTS)) return "analytics-ads";
  if (
    hostMatches(host, FONT_HOSTS) ||
    mime.startsWith("font/") ||
    mime.includes("font-woff") ||
    input.resourceType === "font" ||
    FONT_EXT.test(url.pathname)
  ) {
    return "fonts";
  }
  if (
    MEDIA_TYPES.has(input.resourceType) ||
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    MEDIA_EXT.test(url.pathname)
  ) {
    return "media";
  }
  if (isFirstParty(url, target)) return "first-party";
  if (hostMatches(host, CDN_HOSTS)) return "cdn-library";
  if (
    input.resourceType === "script" ||
    input.resourceType === "stylesheet" ||
    mime.includes("javascript") ||
    mime.startsWith("text/css")
  ) {
    return "cdn-library";
  }
  return "analytics-ads";
}
