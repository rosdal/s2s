import type * as t from "@babel/types";
import postcss, { type Root, type Rule } from "postcss";
import { end, parseCode, start, traverse } from "./ast.js";
import type { Draft } from "./types.js";

/** Every class selector in a stylesheet. */
export function classesOf(css: string): Set<string> {
  const out = new Set<string>();
  for (const match of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) if (match[1]) out.add(match[1]);
  return out;
}

export interface ClassMap {
  /** The module the map was found in. */
  draft: Draft;
  /** Hashed class (as shipped) → local name (as written). */
  classes: Map<string, string>;
  /** String indices of the object literal in the draft's code. */
  start: number;
  end: number;
  /** File stem for the `.module.css`, from the hashed names (`Card-module__card--x1` → `Card`). */
  name: string;
}

/**
 * CSS Module class maps in a module: object literals whose every value is a hashed class from the
 * captured CSS that contains its key (`{ card: "Card-module__card--O3qo5" }`), as css-loader,
 * Vite and Next.js emit them.
 */
export function findClassMaps(draft: Draft, cssClasses: Set<string>): ClassMap[] {
  let ast: t.File;
  try {
    ast = parseCode(draft.code);
  } catch {
    return [];
  }
  const maps: ClassMap[] = [];
  traverse(ast, {
    ObjectExpression(path) {
      const node = path.node;
      if (node.properties.length === 0) return;
      const classes = new Map<string, string>();
      for (const p of node.properties) {
        if (p.type !== "ObjectProperty" || p.computed || p.value.type !== "StringLiteral") return;
        const key =
          p.key.type === "Identifier"
            ? p.key.name
            : p.key.type === "StringLiteral"
              ? p.key.value
              : undefined;
        if (!key) return;
        const tokens = p.value.value.split(/\s+/).filter(Boolean);
        const own = tokens[0];
        if (
          !own ||
          own === key ||
          !own.includes(key) ||
          !looksHashed(own, key) ||
          !tokens.every((c) => cssClasses.has(c))
        )
          return;
        classes.set(own, key);
      }
      maps.push({
        draft,
        classes,
        start: start(node),
        end: end(node),
        name: moduleName([...classes.keys()]),
      });
      path.skip();
    },
  });
  return maps;
}

/**
 * A CSS Modules name, not a utility class that happens to contain its key (`text-sm` for `sm`):
 * css-loader's `Name__local--hash` or `Name_local__hash`, or Vite's `_local_hash_n`.
 */
function looksHashed(cls: string, key: string): boolean {
  const k = escapeRegExp(key);
  return (
    new RegExp(`(?:^|[_-])${k}__[\\w-]{4,}$`).test(cls) ||
    new RegExp(`__${k}(?:--|__|_)[\\w-]{4,}$`).test(cls) ||
    new RegExp(`^_${k}_[A-Za-z0-9]{4,}(?:_\\d+)?$`).test(cls)
  );
}

function moduleName(hashed: string[]): string {
  for (const cls of hashed) {
    const match = /^([A-Za-z][\w-]*?)(?:[-_.]module)?__/.exec(cls);
    if (match?.[1]) return match[1];
  }
  return "module";
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rename `.hashed` class selectors to `.local` in a selector. */
function renameClasses(selector: string, classes: Map<string, string>): string {
  let out = selector;
  for (const [hashed, local] of classes)
    out = out.replace(new RegExp(`\\.${escapeRegExp(hashed)}(?![\\w-])`, "g"), `.${local}`);
  return out;
}

/**
 * Move the rules that use a class map's hashed classes out of the captured stylesheets into one
 * `.module.css` per map, with the hashed names renamed back to their local names. Rules inside
 * `@media` and other at-rules keep their wrapper. Returns the new files' CSS by map.
 */
export function extractModules(
  sheets: Root[],
  maps: ClassMap[],
): Map<ClassMap, { css: string; sheet: number }> {
  const out = new Map<ClassMap, Root>();
  const from = new Map<ClassMap, number>();
  const owner = (selector: string): ClassMap | undefined =>
    maps.find((m) =>
      [...m.classes.keys()].some((c) =>
        new RegExp(`\\.${escapeRegExp(c)}(?![\\w-])`).test(selector),
      ),
    );
  for (const [index, sheet] of sheets.entries()) {
    sheet.walkRules((rule: Rule) => {
      const map = owner(rule.selector);
      if (!map) return;
      if (!from.has(map)) from.set(map, index);
      const root = out.get(map) ?? postcss.root();
      out.set(map, root);
      // Rebuild the at-rule chain around the rule.
      let target: Root | postcss.AtRule = root;
      const chain: postcss.AtRule[] = [];
      for (let p = rule.parent; p && p.type === "atrule"; p = p.parent)
        chain.unshift(p as postcss.AtRule);
      for (const at of chain) {
        const existing: postcss.AtRule | undefined = target.nodes?.find(
          (n): n is postcss.AtRule =>
            n.type === "atrule" && n.name === at.name && n.params === at.params,
        );
        const next: postcss.AtRule =
          existing ?? postcss.atRule({ name: at.name, params: at.params });
        if (!existing) target.append(next);
        target = next;
      }
      const copy = rule.clone({ selector: renameClasses(rule.selector, map.classes) });
      target.append(copy);
      const parent = rule.parent;
      rule.remove();
      // Drop at-rules the move emptied.
      for (
        let p = parent;
        p && p.type === "atrule" && (p as postcss.AtRule).nodes?.length === 0;
      ) {
        const up = p.parent;
        p.remove();
        p = up as typeof p;
      }
    });
  }
  return new Map(
    [...out.entries()].map(([m, root]) => [m, { css: root.toString(), sheet: from.get(m) ?? 0 }]),
  );
}

export interface StylingSignal {
  detected: boolean;
  evidence: string[];
}

export interface StylingReport {
  tailwind: StylingSignal;
  cssModules: StylingSignal & { classMaps: number };
  styledComponents: StylingSignal;
  emotion: StylingSignal;
}

const TAILWIND_UTILITY =
  /^(?:[a-z]+:)*-?(?:m[trblxy]?|p[trblxy]?|w|h|min-w|max-w|min-h|max-h|text|bg|border|rounded|shadow|flex|grid|gap|items|justify|font|leading|tracking|space-[xy]|inset|top|left|right|bottom|z|opacity|overflow|col-span|row-span)-[\w./[\]-]+$|^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|container|truncate|uppercase|italic)$/;

/** Which styling approach the site uses, from its CSS and rendered DOM. */
export function detectStyling(input: {
  css: string[];
  dom: string[];
  classMaps: number;
}): StylingReport {
  const css = input.css.join("\n");
  const dom = input.dom.join("\n");
  const tokens = [...dom.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) =>
    (m[1] ?? "").split(/\s+/).filter(Boolean),
  );
  const utility = tokens.filter((c) => TAILWIND_UTILITY.test(c)).length;
  const twVars = css.match(/--tw-[\w-]+/g)?.length ?? 0;
  const tailwind: StylingSignal = { detected: false, evidence: [] };
  if (twVars > 0) tailwind.evidence.push(`${twVars} --tw- custom properties in the CSS`);
  if (tokens.length >= 20 && utility / tokens.length >= 0.3)
    tailwind.evidence.push(
      `${utility} of ${tokens.length} DOM classes look like Tailwind utilities`,
    );
  tailwind.detected = tailwind.evidence.length > 0;

  const hashed = [...classesOf(css)].filter((c) =>
    /^[A-Za-z][\w]*(?:[-_.]module)?__[\w]+--[\w-]{5}$|^_[\w]+_[\w]{5,}_\d+$/.test(c),
  );
  const cssModules = { detected: false, evidence: [] as string[], classMaps: input.classMaps };
  if (input.classMaps > 0) cssModules.evidence.push(`${input.classMaps} class map(s) in the JS`);
  if (hashed.length > 0) cssModules.evidence.push(`${hashed.length} hashed class names in the CSS`);
  cssModules.detected = input.classMaps > 0 || hashed.length >= 3;

  const sc = tokens.filter((c) => /^sc-[A-Za-z]+$/.test(c)).length;
  const styledComponents: StylingSignal = { detected: false, evidence: [] };
  if (sc > 0) styledComponents.evidence.push(`${sc} sc- classes in the DOM`);
  if (/data-styled/.test(dom)) styledComponents.evidence.push("data-styled style tags in the DOM");
  styledComponents.detected = styledComponents.evidence.length > 0;

  const em = tokens.filter((c) => /^css-[a-z0-9]{5,}(?:-[\w]+)?$/.test(c)).length;
  const emotion: StylingSignal = { detected: false, evidence: [] };
  if (em > 0) emotion.evidence.push(`${em} css- classes in the DOM`);
  if (/data-emotion/.test(dom)) emotion.evidence.push("data-emotion style tags in the DOM");
  emotion.detected = emotion.evidence.length > 0;

  return { tailwind, cssModules, styledComponents, emotion };
}

export { postcss };
