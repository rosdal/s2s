/**
 * Runtime probe, evaluated in the page after it goes quiet. Kept as a string so the bundler can't
 * inject helpers into it. It must not throw and must return plain JSON.
 */
export const RUNTIME_PROBE = `(() => {
  const w = window;
  const safe = (fn) => { try { const v = fn(); return v === undefined ? null : v; } catch { return null; } };
  const frameworks = {};
  const set = (name, value) => { if (value !== null && value !== undefined && value !== false) frameworks[name] = value; };

  set("react", safe(() => w.React && { version: w.React.version || null }));
  set("reactDevtoolsRenderers", safe(() => {
    const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.renderers.size) return null;
    return [...hook.renderers.values()].map((r) => ({ version: r.version || null, rendererPackageName: r.rendererPackageName || null }));
  }));
  set("reactRoot", safe(() => {
    const el = document.querySelector("[data-reactroot]") ||
      [...document.querySelectorAll("body *")].slice(0, 200).find((node) => Object.keys(node).some((k) => k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$")));
    return el ? true : null;
  }));
  set("next", safe(() => {
    const data = w.__NEXT_DATA__;
    const appRouter = !!(w.__next_f || document.querySelector("script[src*='/_next/static/chunks/app/']"));
    if (!data && !appRouter && !w.next) return null;
    return {
      version: (w.next && w.next.version) || null,
      router: data ? "pages" : appRouter ? "app" : null,
      buildId: data ? data.buildId || null : null,
      page: data ? data.page || null : null,
      nextExport: data ? !!data.nextExport : null,
      assetPrefix: data ? data.assetPrefix || null : null,
    };
  }));
  set("remix", safe(() => w.__remixContext ? { routes: Object.keys((w.__remixManifest && w.__remixManifest.routes) || {}).length } : null));
  set("reactRouter", safe(() => w.__reactRouterContext || w.__reactRouterManifest ? { version: w.__reactRouterVersion || null } : null));
  set("nuxt", safe(() => w.__NUXT__ || w.useNuxtApp || w.$nuxt ? { version: (w.$nuxt && w.$nuxt.$root && w.$nuxt.$root.constructor && w.$nuxt.$root.constructor.version) || null } : null));
  set("vue", safe(() => {
    if (w.Vue && w.Vue.version) return { version: w.Vue.version };
    const app = document.querySelector("[data-v-app]");
    if (app && app.__vue_app__) return { version: app.__vue_app__.version || null };
    if (document.querySelector("[data-v-app]") || [...document.querySelectorAll("*")].slice(0, 500).some((el) => [...el.attributes].some((a) => a.name.startsWith("data-v-")))) return { version: null };
    return null;
  }));
  set("svelte", safe(() => {
    if (w.__svelte && w.__svelte.v) return { versions: [...w.__svelte.v] };
    return document.querySelector("[class*='svelte-']") ? { versions: [] } : null;
  }));
  set("angular", safe(() => {
    const el = document.querySelector("[ng-version]");
    if (el) return { version: el.getAttribute("ng-version") };
    return w.angular && w.angular.version ? { version: w.angular.version.full, legacy: true } : null;
  }));
  set("astro", safe(() => document.querySelector("astro-island, [data-astro-cid], [data-astro-source-file]") || [...document.querySelectorAll("*")].slice(0, 500).some((el) => [...el.attributes].some((a) => a.name.startsWith("data-astro-cid-"))) ? { islands: document.querySelectorAll("astro-island").length } : null));
  set("gatsby", safe(() => w.___gatsby || document.getElementById("___gatsby") ? {} : null));
  set("preact", safe(() => w.preact ? { version: w.preact.version || null } : null));
  set("solid", safe(() => w._$HY ? {} : null));
  set("qwik", safe(() => document.querySelector("[q\\\\:container]") ? { version: document.querySelector("[q\\\\:version]") ? document.querySelector("[q\\\\:version]").getAttribute("q:version") : null } : null));
  set("alpine", safe(() => w.Alpine ? { version: w.Alpine.version || null } : null));
  set("jquery", safe(() => w.jQuery && w.jQuery.fn ? { version: w.jQuery.fn.jquery || null } : null));
  set("lodash", safe(() => w._ && typeof w._.VERSION === "string" ? { version: w._.VERSION } : null));
  set("dayjs", safe(() => w.dayjs && w.dayjs.version ? { version: w.dayjs.version } : null));
  set("bootstrap", safe(() => w.bootstrap && w.bootstrap.Tooltip ? { version: w.bootstrap.Tooltip.VERSION || null } : null));
  set("webpack", safe(() => {
    const chunks = Object.keys(w).filter((k) => k.startsWith("webpackChunk") || k === "webpackJsonp");
    return chunks.length ? { chunkGlobals: chunks } : null;
  }));
  set("turbopack", safe(() => w.TURBOPACK || w.__TURBOPACK_PAGE_BOOTSTRAP ? {} : null));
  set("vite", safe(() => document.querySelector("script[type=module][src*='/assets/index-'], link[rel=modulepreload]") ? {} : null));

  const dataAttributes = {};
  for (const el of document.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (!attr.name.startsWith("data-")) continue;
      // Collapse hashed suffixes (data-v-1a2b3c, data-astro-cid-xyz) so they count as one family.
      const name = attr.name.replace(/-[a-z0-9]{6,}$/i, "-*");
      dataAttributes[name] = (dataAttributes[name] || 0) + 1;
    }
  }
  const topData = Object.fromEntries(Object.entries(dataAttributes).sort((a, b) => b[1] - a[1]).slice(0, 50));

  const styleSheets = [...document.styleSheets].map((sheet) => ({
    href: sheet.href,
    origin: sheet.href ? safe(() => new URL(sheet.href).origin) : "inline",
    rules: safe(() => sheet.cssRules.length),
  }));

  const generator = safe(() => document.querySelector("meta[name=generator]").getAttribute("content"));

  return { url: location.href, title: document.title, generator, frameworks, dataAttributes: topData, styleSheets };
})()`;
