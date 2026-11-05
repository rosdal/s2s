/**
 * Browser-side WebGL instrumentation, added with `addInitScript` so it runs before page scripts.
 * Kept as a string so the bundler cannot inject helpers into it; it must never throw into the page.
 *
 * - counts WebGL, WebGL 2 and WebGPU contexts (the light probe every capture installs);
 * - defines `__THREE_DEVTOOLS__`, so three reports its scenes, renderers and loaders to it;
 * - records the final GLSL of every linked program;
 * - in deterministic mode, seeds `Math.random`;
 * - exposes `window.__s2sWebgl.summary()` and `.snapshot()` for capture and verify.
 */
export interface InitScriptOptions {
  /** Seed for `Math.random`; `null` leaves it alone. */
  seed: number | null;
  /** Record shaders and serve snapshots, not just count contexts. */
  full: boolean;
}

export const DEFAULT_SEED = 0x5232;

export function webglInitScript(options: InitScriptOptions): string {
  return `(${INIT.toString()})(${JSON.stringify(options)});`;
}

// Written as a real function for readability; only its source text is used.
function INIT(cfg: { seed: number | null; full: boolean }): void {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const w = window as any;
  if (w.__s2sWebgl) return;
  if (cfg.seed !== null) {
    let a = cfg.seed >>> 0;
    Math.random = function random() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: see above
  type Any = any;
  const state: Any = {
    contexts: { webgl: 0, webgl2: 0, webgpu: 0 },
    revision: null,
    scenes: [] as Any[],
    renderers: [] as Any[],
    rendered: new Map<Any, { camera: Any; at: number; renderer: Any }>(),
    urls: new WeakMap<object, string>(),
    shaderType: new WeakMap<object, number>(),
    shaderSource: new WeakMap<object, string>(),
    attached: new WeakMap<object, Any[]>(),
    programs: [] as { vertex: string; fragment: string }[],
    programKeys: new Set<string>(),
    gpuAdapters: 0,
  };
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  try {
    const proto = HTMLCanvasElement.prototype;
    const getContext = proto.getContext;
    const counted = (type: unknown) => {
      if (type === "webgl" || type === "experimental-webgl") state.contexts.webgl++;
      else if (type === "webgl2") state.contexts.webgl2++;
      else if (type === "webgpu") state.contexts.webgpu++;
    };
    proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: Any[]) {
      const ctx = (getContext as Any).call(this, type, ...rest);
      if (ctx) counted(type);
      return ctx;
    } as Any;
    if (typeof OffscreenCanvas !== "undefined") {
      const off = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function (this: Any, type: string, ...rest: Any[]) {
        const ctx = (off as Any).call(this, type, ...rest);
        if (ctx) counted(type);
        return ctx;
      } as Any;
    }
    const gpu = (navigator as Any).gpu;
    if (gpu && typeof gpu.requestAdapter === "function") {
      const request = gpu.requestAdapter.bind(gpu);
      gpu.requestAdapter = (...args: Any[]) => {
        state.gpuAdapters++;
        return request(...args);
      };
    }
  } catch {}

  if (cfg.full) {
    for (const Ctx of [w.WebGLRenderingContext, w.WebGL2RenderingContext]) {
      if (!Ctx) continue;
      const p = Ctx.prototype;
      const createShader = p.createShader;
      p.createShader = function (this: Any, type: number) {
        const shader = createShader.call(this, type);
        if (shader) state.shaderType.set(shader, type);
        return shader;
      };
      const shaderSource = p.shaderSource;
      p.shaderSource = function (this: Any, shader: Any, source: string) {
        try {
          state.shaderSource.set(shader, String(source));
        } catch {}
        return shaderSource.call(this, shader, source);
      };
      const attachShader = p.attachShader;
      p.attachShader = function (this: Any, program: Any, shader: Any) {
        try {
          const list = state.attached.get(program) ?? [];
          list.push(shader);
          state.attached.set(program, list);
        } catch {}
        return attachShader.call(this, program, shader);
      };
      const linkProgram = p.linkProgram;
      p.linkProgram = function (this: Any, program: Any) {
        try {
          let vertex = "";
          let fragment = "";
          for (const shader of state.attached.get(program) ?? []) {
            const type = state.shaderType.get(shader);
            const src = state.shaderSource.get(shader) ?? "";
            if (type === 0x8b31) vertex = src;
            else if (type === 0x8b30) fragment = src;
          }
          const key = `${vertex.length}:${fragment.length}:${vertex}\u0000${fragment}`;
          if (!state.programKeys.has(key) && state.programs.length < 500) {
            state.programKeys.add(key);
            state.programs.push({ vertex, fragment });
          }
        } catch {}
        return linkProgram.call(this, program);
      };
    }
  }

  const hookRenderer = (renderer: Any) => {
    if (state.renderers.includes(renderer)) return;
    state.renderers.push(renderer);
    const render = renderer.render;
    if (typeof render !== "function") return;
    renderer.render = function (this: Any, scene: Any, camera: Any, ...rest: Any[]) {
      try {
        if (scene?.isScene && camera?.isCamera)
          state.rendered.set(scene, { camera, at: now(), renderer: this });
      } catch {}
      return render.call(this, scene, camera, ...rest);
    };
  };
  const hookLoader = (loader: Any) => {
    const load = loader?.load;
    if (typeof load !== "function") return;
    loader.load = function (this: Any, url: Any, onLoad: Any, ...rest: Any[]) {
      let abs = String(url);
      try {
        abs = new URL(
          String(url),
          (this.path ? new URL(this.path, location.href) : location.href) as Any,
        ).href;
      } catch {}
      const wrapped =
        typeof onLoad === "function"
          ? (result: Any) => {
              try {
                const target = result?.scene ?? result;
                if (target && typeof target === "object") state.urls.set(target, abs);
                if (result?.scenes) for (const s of result.scenes) state.urls.set(s, abs);
              } catch {}
              return onLoad(result);
            }
          : onLoad;
      const out = load.call(this, url, wrapped, ...rest);
      try {
        if (out && typeof out === "object" && out.isTexture) state.urls.set(out, abs);
      } catch {}
      return out;
    };
  };
  try {
    const target = new EventTarget();
    target.addEventListener("observe", (event: Any) => {
      const o = event.detail;
      if (!o) return;
      if (o.isScene) state.scenes.push(o);
      else if (o.isWebGLRenderer || (typeof o.render === "function" && o.domElement))
        hookRenderer(o);
      else if (typeof o.load === "function" && "crossOrigin" in o) hookLoader(o);
    });
    target.addEventListener("register", (event: Any) => {
      if (event.detail?.revision) state.revision = String(event.detail.revision);
    });
    if (!("__THREE_DEVTOOLS__" in w))
      Object.defineProperty(w, "__THREE_DEVTOOLS__", {
        value: target,
        configurable: true,
        writable: true,
      });
  } catch {}

  const round = (n: unknown) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return n ?? null;
    const r = Math.round(n * 1e5) / 1e5;
    return Object.is(r, -0) ? 0 : r;
  };
  const vec = (v: Any, keys: string[]) => keys.map((k) => round(v?.[k]));
  const hex = (c: Any) => (c && typeof c.getHex === "function" ? c.getHex() : null);
  const fnv = (array: Any) => {
    if (!array?.buffer) return null;
    const bytes = new Uint8Array(array.buffer, array.byteOffset ?? 0, array.byteLength ?? 0);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i] as number), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const MAPS = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
    "alphaMap",
    "bumpMap",
    "displacementMap",
    "envMap",
    "lightMap",
    "specularMap",
    "matcap",
    "gradientMap",
  ];

  // Frustum planes (Gribb/Hartmann) from a camera, to tell whether a mesh is in view.
  const planesOf = (camera: Any) => {
    try {
      camera.updateMatrixWorld?.();
      const p = camera.projectionMatrix.elements;
      const v = camera.matrixWorldInverse.elements;
      const m = new Array(16).fill(0);
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
          for (let k = 0; k < 4; k++) m[c * 4 + r] += p[k * 4 + r] * v[c * 4 + k];
      const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
      const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)] as number[][];
      const planes = [] as number[][];
      for (const [a, s] of [
        [r0, 1],
        [r0, -1],
        [r1, 1],
        [r1, -1],
        [r2, 1],
        [r2, -1],
      ] as [number[], number][]) {
        const pl = (r3 as number[]).map((x, i) => x + s * (a[i] as number));
        const len = Math.hypot(pl[0] as number, pl[1] as number, pl[2] as number) || 1;
        planes.push(pl.map((x) => x / len));
      }
      return planes;
    } catch {
      return null;
    }
  };
  const inView = (planes: number[][] | null, obj: Any) => {
    try {
      const g = obj.geometry;
      if (!planes || !g) return null;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const s = g.boundingSphere;
      const e = obj.matrixWorld.elements;
      const c = s.center;
      const x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
      const y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
      const z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
      const scale = Math.max(
        Math.hypot(e[0], e[1], e[2]),
        Math.hypot(e[4], e[5], e[6]),
        Math.hypot(e[8], e[9], e[10]),
      );
      const r = s.radius * scale;
      return planes.every(
        (p) =>
          (p[0] as number) * x + (p[1] as number) * y + (p[2] as number) * z + (p[3] as number) >=
          -r,
      );
    } catch {
      return null;
    }
  };

  function snapshot() {
    const textures: Any[] = [];
    const textureIndex = new Map<Any, number>();
    const texRef = (t: Any) => {
      if (!t || !t.isTexture) return null;
      let i = textureIndex.get(t);
      if (i === undefined) {
        i = textures.length;
        textureIndex.set(t, i);
        const img = t.image;
        const src = img && typeof img.currentSrc === "string" ? img.currentSrc || img.src : null;
        const url = state.urls.get(t) ?? (src && !/^(blob|data):/.test(src) ? src : null);
        textures.push({
          name: t.name || null,
          type: t.isCompressedTexture
            ? "compressed"
            : t.isCubeTexture
              ? "cube"
              : t.isDataTexture
                ? "data"
                : t.isVideoTexture
                  ? "video"
                  : t.isCanvasTexture
                    ? "canvas"
                    : "image",
          url,
          width: img?.width ?? img?.[0]?.width ?? null,
          height: img?.height ?? img?.[0]?.height ?? null,
        });
      }
      return i;
    };
    const material = (m: Any) => {
      if (!m) return null;
      const maps: Record<string, number | null> = {};
      for (const key of MAPS) if (m[key]) maps[key] = texRef(m[key]);
      return {
        type: m.type ?? null,
        name: m.name || null,
        color: hex(m.color),
        emissive: hex(m.emissive),
        roughness: round(m.roughness),
        metalness: round(m.metalness),
        opacity: round(m.opacity),
        transparent: Boolean(m.transparent),
        visible: m.visible !== false,
        maps,
        shader: m.isShaderMaterial ? true : undefined,
      };
    };
    const camerasOf = new Map<Any, Any>();
    let latest = 0;
    for (const [, r] of state.rendered) latest = Math.max(latest, r.at);
    const active = [...state.scenes].filter((s) => {
      const r = state.rendered.get(s);
      return r && r.at >= latest - 250;
    });
    for (const s of active) camerasOf.set(s, state.rendered.get(s).camera);
    let mainCamera: Any = null;
    let mainSize = -1;
    const scenes = active.map((scene) => {
      const camera = camerasOf.get(scene);
      const planes = planesOf(camera);
      const nodes: Any[] = [];
      let r3f = false;
      const segment = (obj: Any, siblings: Any[]) => {
        const base = obj.name ? obj.name : `${obj.type}#`;
        const same = siblings.filter((s) => (s.name ? s.name : `${s.type}#`) === base);
        const i = same.indexOf(obj);
        return obj.name ? (i > 0 ? `${base}[${i}]` : base) : `${base}${i}`;
      };
      const walk = (obj: Any, path: string, parent: string | null) => {
        if (obj.__r3f) r3f = true;
        const node: Any = {
          path,
          name: obj.name || null,
          type: obj.type ?? null,
          parent,
          visible: obj.visible !== false,
          position: vec(obj.position, ["x", "y", "z"]),
          quaternion: vec(obj.quaternion, ["x", "y", "z", "w"]),
          scale: vec(obj.scale, ["x", "y", "z"]),
        };
        if (obj.isMesh || obj.isPoints || obj.isLine || obj.isSprite) {
          const g = obj.geometry;
          const pos = g?.attributes?.position;
          if (g && !g.boundingBox && pos) g.computeBoundingBox?.();
          const bb = g?.boundingBox;
          node.geometry = g
            ? {
                type: g.type ?? null,
                vertices: pos?.count ?? 0,
                triangles: g.index
                  ? Math.floor(g.index.count / 3)
                  : Math.floor((pos?.count ?? 0) / 3),
                bounds: bb ? [vec(bb.min, ["x", "y", "z"]), vec(bb.max, ["x", "y", "z"])] : null,
                hash: fnv(pos?.data?.array ?? pos?.array),
                morphTargets: g.morphAttributes?.position?.length ?? 0,
              }
            : null;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          node.material = mats.map(material);
          node.frustum = inView(planes, obj);
          if (obj.isSkinnedMesh) node.skinned = { bones: obj.skeleton?.bones?.length ?? 0 };
          if (obj.isInstancedMesh) node.instances = obj.count;
          if (state.urls.get(obj.parent)) node.source = state.urls.get(obj.parent);
        }
        if (state.urls.get(obj)) node.source = state.urls.get(obj);
        if (obj.isLight)
          node.light = {
            color: hex(obj.color),
            intensity: round(obj.intensity),
            castShadow: Boolean(obj.castShadow),
            distance: round(obj.distance),
            angle: round(obj.angle),
          };
        if (obj.isCamera)
          node.camera = obj.isPerspectiveCamera
            ? {
                fov: round(obj.fov),
                near: round(obj.near),
                far: round(obj.far),
                zoom: round(obj.zoom),
                aspect: round(obj.aspect),
              }
            : {
                left: round(obj.left),
                right: round(obj.right),
                top: round(obj.top),
                bottom: round(obj.bottom),
                near: round(obj.near),
                far: round(obj.far),
                zoom: round(obj.zoom),
              };
        nodes.push(node);
        const children = obj.children ?? [];
        for (const child of children) walk(child, `${path}/${segment(child, children)}`, path);
      };
      const root = scene.name || "Scene";
      walk(scene, root, null);
      if (nodes.length > mainSize) {
        mainSize = nodes.length;
        mainCamera = camera;
      }
      const fog = scene.fog
        ? {
            type: scene.fog.isFogExp2 ? "exp2" : "linear",
            color: hex(scene.fog.color),
            near: round(scene.fog.near),
            far: round(scene.fog.far),
            density: round(scene.fog.density),
          }
        : null;
      const bg = scene.background;
      return {
        name: root,
        background: bg?.isColor
          ? { color: hex(bg) }
          : bg?.isTexture
            ? { texture: texRef(bg) }
            : null,
        environment: scene.environment ? texRef(scene.environment) : null,
        fog,
        r3f,
        camera: camera
          ? {
              name: camera.name || null,
              type: camera.type,
              path: nodes.find((n) => n.name && n.name === camera.name)?.path ?? null,
            }
          : null,
        nodes,
      };
    });
    const renderer = state.rendered.get(active[0])?.renderer ?? state.renderers[0];
    const el = renderer?.domElement;
    const rect = el?.getBoundingClientRect?.();
    return {
      revision: state.revision,
      renderer: renderer
        ? {
            toneMapping: renderer.toneMapping ?? null,
            toneMappingExposure: round(renderer.toneMappingExposure),
            outputColorSpace: renderer.outputColorSpace ?? null,
            shadowMap: renderer.shadowMap
              ? {
                  enabled: Boolean(renderer.shadowMap.enabled),
                  type: renderer.shadowMap.type ?? null,
                }
              : null,
            pixelRatio: round(renderer.getPixelRatio?.()),
            size: el ? [el.width, el.height] : null,
          }
        : null,
      canvas: rect
        ? [round(rect.left), round(rect.top), round(rect.width), round(rect.height)]
        : null,
      camera: mainCamera?.name ?? null,
      scenes,
      textures,
    };
  }

  w.__s2sWebgl = {
    summary() {
      return {
        contexts: { ...state.contexts },
        webgpuAdapters: state.gpuAdapters,
        revision: state.revision ?? (w.__THREE__ ? String(w.__THREE__) : null),
        scenes: state.scenes.length,
        renderers: state.renderers.length,
        programs: state.programs.length,
        r3f:
          state.scenes.some((s: Any) => s.__r3f) ||
          [...document.querySelectorAll("canvas")].some(
            (c: Any) => c.__r3f || Object.keys(c).some((k) => k.startsWith("__r3f")),
          ),
      };
    },
    snapshot,
    programs() {
      return state.programs.slice();
    },
    canvases() {
      return [...document.querySelectorAll("canvas")]
        .map((c) => c.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => [
          Math.round(r.left),
          Math.round(r.top),
          Math.round(r.width),
          Math.round(r.height),
        ]);
    },
  };
}
