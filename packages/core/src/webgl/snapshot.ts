/** What the init script's `snapshot()` returns, and how s2s stores and compares it. */

export interface SnapshotMaterial {
  type: string | null;
  name: string | null;
  color: number | null;
  emissive: number | null;
  roughness: number | null;
  metalness: number | null;
  opacity: number | null;
  transparent: boolean;
  visible: boolean;
  maps: Record<string, number | null>;
  shader?: boolean;
}

export interface SnapshotNode {
  path: string;
  name: string | null;
  type: string | null;
  parent: string | null;
  visible: boolean;
  position: number[];
  quaternion: number[];
  scale: number[];
  geometry?: {
    type: string | null;
    vertices: number;
    triangles: number;
    bounds: [number[], number[]] | null;
    hash: string | null;
    morphTargets: number;
  } | null;
  material?: (SnapshotMaterial | null)[];
  frustum?: boolean | null;
  skinned?: { bones: number };
  instances?: number;
  source?: string;
  light?: Record<string, unknown>;
  camera?: Record<string, unknown>;
}

export interface SnapshotScene {
  name: string;
  background: { color?: number; texture?: number | null } | null;
  environment: number | null;
  fog: Record<string, unknown> | null;
  r3f: boolean;
  camera: { name: string | null; type: string; path: string | null } | null;
  nodes: SnapshotNode[];
}

export interface SceneSnapshot {
  revision: string | null;
  renderer: Record<string, unknown> | null;
  /** The main canvas in CSS pixels: left, top, width, height. */
  canvas: number[] | null;
  camera: string | null;
  scenes: SnapshotScene[];
  textures: {
    name: string | null;
    type: string;
    url: string | null;
    width: number | null;
    height: number | null;
  }[];
}

/** A keyframe file: a full snapshot, or the nodes that changed since the walk's first keyframe. */
export type StoredSnapshot =
  | ({ keyframe: string; full: true } & SceneSnapshot)
  | {
      keyframe: string;
      full: false;
      base: string;
      revision: string | null;
      renderer: SceneSnapshot["renderer"];
      canvas: SceneSnapshot["canvas"];
      camera: string | null;
      textures: SceneSnapshot["textures"];
      scenes: {
        name: string;
        background: SnapshotScene["background"];
        environment: number | null;
        fog: SnapshotScene["fog"];
        r3f: boolean;
        camera: SnapshotScene["camera"];
        changed: SnapshotNode[];
        removed: string[];
        /** Node order, as paths, when it differs from the base. */
        order?: string[];
      }[];
    };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function encodeSnapshot(
  keyframe: string,
  snap: SceneSnapshot,
  base?: { keyframe: string; snapshot: SceneSnapshot },
): StoredSnapshot {
  if (!base) return { keyframe, full: true, ...snap };
  return {
    keyframe,
    full: false,
    base: base.keyframe,
    revision: snap.revision,
    renderer: snap.renderer,
    canvas: snap.canvas,
    camera: snap.camera,
    textures: snap.textures,
    scenes: snap.scenes.map((scene, i) => {
      const before = sameScene(base.snapshot.scenes, snap.scenes, i);
      const old = new Map((before?.nodes ?? []).map((n) => [n.path, n]));
      const changed = scene.nodes.filter((n) => !same(old.get(n.path), n));
      const paths = new Set(scene.nodes.map((n) => n.path));
      const removed = [...old.keys()].filter((p) => !paths.has(p));
      const order = scene.nodes.map((n) => n.path);
      const rebuilt = rebuildOrder(before?.nodes ?? [], changed, removed);
      return {
        name: scene.name,
        background: scene.background,
        environment: scene.environment,
        fog: scene.fog,
        r3f: scene.r3f,
        camera: scene.camera,
        changed,
        removed,
        ...(same(rebuilt, order) ? {} : { order }),
      };
    }),
  };
}

// New nodes are appended after the base order unless the stored order says otherwise.
function rebuildOrder(baseNodes: SnapshotNode[], changed: SnapshotNode[], removed: string[]) {
  const gone = new Set(removed);
  const order = baseNodes.map((n) => n.path).filter((p) => !gone.has(p));
  const known = new Set(order);
  for (const n of changed) if (!known.has(n.path)) order.push(n.path);
  return order;
}

/** A stored keyframe back to a full snapshot, given the walk's first (full) keyframe. */
export function decodeSnapshot(stored: StoredSnapshot, base?: SceneSnapshot): SceneSnapshot {
  if (stored.full) {
    const { keyframe: _k, full: _f, ...snap } = stored;
    return snap;
  }
  if (!base) throw new Error(`Keyframe ${stored.keyframe} needs its base ${stored.base}`);
  return {
    revision: stored.revision,
    renderer: stored.renderer,
    canvas: stored.canvas,
    camera: stored.camera,
    textures: stored.textures,
    scenes: stored.scenes.map((scene, i) => {
      const before = sameScene(base.scenes, stored.scenes, i);
      const byPath = new Map((before?.nodes ?? []).map((n) => [n.path, n]));
      for (const n of scene.changed) byPath.set(n.path, n);
      for (const p of scene.removed) byPath.delete(p);
      const order = scene.order ?? rebuildOrder(before?.nodes ?? [], scene.changed, scene.removed);
      return {
        name: scene.name,
        background: scene.background,
        environment: scene.environment,
        fog: scene.fog,
        r3f: scene.r3f,
        camera: scene.camera,
        nodes: order.map((p) => byPath.get(p)).filter((n): n is SnapshotNode => n !== undefined),
      };
    }),
  };
}

export interface SnapshotTolerance {
  /** Share of the scene's bounding-box diagonal a position may move. */
  position: number;
  /** Degrees a rotation may differ. */
  rotationDeg: number;
  scale: number;
}

export const DEFAULT_TOLERANCE: SnapshotTolerance = { position: 0.01, rotationDeg: 1, scale: 0.01 };

export interface SnapshotDiff {
  equal: boolean;
  /** Readable lines: `World/Hero/Body: position off by 0.42 (limit 0.12)`. */
  differences: string[];
  nodes: { compared: number; missing: number; extra: number; moved: number };
}

/** The diagonal of the box spanning every node position and mesh bound, for position tolerance. */
export function sceneExtent(snap: SceneSnapshot): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const add = (p: number[]) => {
    for (let i = 0; i < 3; i++) {
      const v = p[i] as number;
      if (!Number.isFinite(v)) continue;
      min[i] = Math.min(min[i] as number, v);
      max[i] = Math.max(max[i] as number, v);
    }
  };
  for (const scene of snap.scenes)
    for (const n of scene.nodes) {
      add(n.position);
      if (n.geometry?.bounds) {
        add(n.geometry.bounds[0]);
        add(n.geometry.bounds[1]);
      }
    }
  if (!Number.isFinite(min[0] as number)) return 1;
  return Math.max(1e-6, Math.hypot(...max.map((v, i) => v - (min[i] as number))));
}

const angleDeg = (a: number[], b: number[]) => {
  const dot = Math.abs(a.reduce((n, v, i) => n + v * (b[i] ?? 0), 0));
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
};
const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)));
const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

export interface DiffOptions {
  tolerance?: SnapshotTolerance;
  /** Node paths (or path prefixes) whose transforms are not compared, such as physics bodies. */
  ignoreTransforms?: string[];
  /** Compare geometry stats (triangles, hashes). False for proxy and clone assets. */
  geometry?: boolean;
  maxLines?: number;
}

/**
 * Compare a rebuilt snapshot with the captured one: hierarchy and names exactly, transforms and
 * camera pose within tolerance, camera FOV exactly, material slot count, lights.
 */
export function diffSnapshots(
  expected: SceneSnapshot,
  actual: SceneSnapshot,
  options: DiffOptions = {},
): SnapshotDiff {
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const limit = tol.position * sceneExtent(expected);
  const lines: string[] = [];
  const stats = { compared: 0, missing: 0, extra: 0, moved: 0 };
  const ignored = (p: string) =>
    (options.ignoreTransforms ?? []).some((q) => p === q || p.startsWith(`${q}/`));
  const pairs = pairScenes(expected.scenes, actual.scenes);
  for (const [i, scene] of expected.scenes.entries()) {
    const other = pairs.get(i);
    if (!other) {
      lines.push(`Scene ${scene.name}: missing`);
      stats.missing += scene.nodes.length;
      continue;
    }
    const got = new Map(other.nodes.map((n) => [n.path, n]));
    for (const want of scene.nodes) {
      const n = got.get(want.path);
      if (!n) {
        stats.missing++;
        lines.push(`${want.path}: missing`);
        continue;
      }
      stats.compared++;
      if (n.type !== want.type) lines.push(`${want.path}: type ${n.type}, expected ${want.type}`);
      if (n.visible !== want.visible)
        lines.push(
          `${want.path}: ${n.visible ? "visible" : "hidden"}, expected ${want.visible ? "visible" : "hidden"}`,
        );
      if (!ignored(want.path)) {
        const d = dist(n.position, want.position);
        if (d > limit) {
          stats.moved++;
          lines.push(`${want.path}: position off by ${fmt(d)} (limit ${fmt(limit)})`);
        }
        const a = angleDeg(n.quaternion, want.quaternion);
        if (a > tol.rotationDeg) {
          stats.moved++;
          lines.push(`${want.path}: rotation off by ${fmt(a)}° (limit ${tol.rotationDeg}°)`);
        }
        const s = dist(n.scale, want.scale);
        if (s > tol.scale * Math.max(1, Math.hypot(...want.scale)))
          lines.push(`${want.path}: scale off by ${fmt(s)}`);
      }
      if (want.camera) {
        const fov = want.camera.fov;
        if (fov !== undefined && n.camera?.fov !== fov)
          lines.push(`${want.path}: camera fov ${String(n.camera?.fov)}, expected ${String(fov)}`);
      }
      if (want.light) {
        if (!n.light) lines.push(`${want.path}: light missing`);
        else if (n.light.intensity !== want.light.intensity || n.light.color !== want.light.color)
          lines.push(
            `${want.path}: light ${String(n.light.color)} × ${String(n.light.intensity)}, expected ${String(want.light.color)} × ${String(want.light.intensity)}`,
          );
      }
      if (want.material && (n.material?.length ?? 0) !== want.material.length)
        lines.push(
          `${want.path}: ${n.material?.length ?? 0} material slot(s), expected ${want.material.length}`,
        );
      if (options.geometry && want.geometry && n.geometry?.triangles !== want.geometry.triangles)
        lines.push(
          `${want.path}: ${n.geometry?.triangles ?? 0} triangles, expected ${want.geometry.triangles}`,
        );
    }
    const wanted = new Set(scene.nodes.map((n) => n.path));
    for (const n of other.nodes)
      if (!wanted.has(n.path)) {
        stats.extra++;
        lines.push(`${n.path}: not in the capture`);
      }
  }
  const paired = new Set(pairs.values());
  for (const scene of actual.scenes)
    if (!paired.has(scene)) lines.push(`Scene ${scene.name}: not in the capture`);
  const max = options.maxLines ?? 50;
  const differences =
    lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more`] : lines;
  return { equal: lines.length === 0, differences, nodes: stats };
}

/**
 * The scene in `list` that is `scenes[i]`: same name, same occurrence among scenes of that name
 * (an R3F minimap renders a second, also unnamed, `Scene`). For keyframes of one walk.
 */
export function sameScene<T extends { name: string }, U extends { name: string }>(
  list: T[],
  scenes: U[],
  i: number,
): T | undefined {
  const name = scenes[i]?.name;
  const k = scenes.slice(0, i).filter((s) => s.name === name).length;
  return list.filter((s) => s.name === name)[k];
}

/**
 * Capture and rebuild scenes paired by name, and among scenes sharing one by the most node
 * paths in common, as a rebuild may register them in another order.
 */
export function pairScenes<T extends { name: string; nodes: { path: string }[] }>(
  expected: T[],
  actual: T[],
): Map<number, T> {
  const out = new Map<number, T>();
  const taken = new Set<T>();
  const overlap = (a: T, b: T) => {
    const paths = new Set(a.nodes.map((n) => n.path));
    return b.nodes.filter((n) => paths.has(n.path)).length;
  };
  const candidates = expected
    .flatMap((e, i) =>
      actual.filter((a) => a.name === e.name).map((a) => ({ i, a, score: overlap(e, a) })),
    )
    .sort((x, y) => y.score - x.score);
  for (const c of candidates) {
    if (out.has(c.i) || taken.has(c.a)) continue;
    out.set(c.i, c.a);
    taken.add(c.a);
  }
  return out;
}
