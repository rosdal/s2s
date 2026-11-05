/** A point in the keyframe walk: a time step at the top of the page, or a scroll step. */
export interface Keyframe {
  /** `t0`, `t1000`, `s1`, … — also the file name under `raw/webgl/<page>/<viewport>/`. */
  id: string;
  kind: "time" | "scroll";
  /** Milliseconds after the walk's base time, or the scroll step (viewport heights). */
  value: number;
}

export const DEFAULT_TIME_STEPS = [0, 1000, 3000];
export const DEFAULT_MAX_KEYFRAMES = 24;

export class KeyframeSpecError extends Error {
  override name = "KeyframeSpecError";
}

/**
 * `auto` (time steps 0, 1 and 3 s at the top, then one scroll step per viewport height) or a
 * comma-separated list such as `t0,t500,s1,s2`. Scroll steps beyond the page are dropped later.
 */
export function parseKeyframes(spec: string | undefined): Keyframe[] | "auto" {
  if (spec === undefined || spec.trim() === "" || spec.trim() === "auto") return "auto";
  const out: Keyframe[] = [];
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    const m = /^([ts])(\d+)$/.exec(part);
    if (!m)
      throw new KeyframeSpecError(
        `--keyframes takes "auto" or a list like "t0,t1000,s1,s2" (t = milliseconds at the top, s = scroll steps of one viewport height); got "${part}"`,
      );
    const kind = m[1] === "t" ? "time" : "scroll";
    const value = Number(m[2]);
    if (!out.some((k) => k.id === part)) out.push({ id: part, kind, value });
  }
  // Time steps run first, in order, then scroll steps from the top down.
  return [
    ...out.filter((k) => k.kind === "time").sort((a, b) => a.value - b.value),
    ...out.filter((k) => k.kind === "scroll").sort((a, b) => a.value - b.value),
  ];
}

/** The concrete walk for one page, given how many viewport heights it scrolls. */
export function planKeyframes(
  spec: Keyframe[] | "auto",
  scrollSteps: number,
  max = DEFAULT_MAX_KEYFRAMES,
): Keyframe[] {
  const plan =
    spec === "auto"
      ? [
          ...DEFAULT_TIME_STEPS.map((t): Keyframe => ({ id: `t${t}`, kind: "time", value: t })),
          ...Array.from(
            { length: scrollSteps },
            (_, i): Keyframe => ({
              id: `s${i + 1}`,
              kind: "scroll",
              value: i + 1,
            }),
          ),
        ]
      : spec.filter((k) => k.kind === "time" || k.value <= scrollSteps);
  return plan.slice(0, Math.max(1, max));
}
