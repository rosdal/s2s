import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodePng(buffer: Uint8Array): Image {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function encodePng(image: Image): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

/** The image on a `width` × `height` canvas, padded with transparent pixels. */
function padTo(image: Image, width: number, height: number): Uint8Array {
  if (image.width === width && image.height === height) return image.data;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    out.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
  }
  return out;
}

const BLOCK = 8;

/**
 * Rectangles around the differing pixels, found on an 8 px block grid: connected blocks become one
 * rectangle, padded by a block. Sorted largest first.
 */
export function diffRegions(
  differs: (x: number, y: number) => boolean,
  width: number,
  height: number,
): Rect[] {
  const cols = Math.ceil(width / BLOCK);
  const rows = Math.ceil(height / BLOCK);
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (differs(x, y)) grid[Math.floor(y / BLOCK) * cols + Math.floor(x / BLOCK)] = 1;
  const seen = new Uint8Array(cols * rows);
  const rects: Rect[] = [];
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue;
    let minX = cols;
    let minY = rows;
    let maxX = 0;
    let maxY = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop() as number;
      const cx = cell % cols;
      const cy = Math.floor(cell / cols);
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const next = ny * cols + nx;
        if (grid[next] && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    const x = Math.max(0, (minX - 1) * BLOCK);
    const y = Math.max(0, (minY - 1) * BLOCK);
    rects.push({
      x,
      y,
      width: Math.min(width, (maxX + 2) * BLOCK) - x,
      height: Math.min(height, (maxY + 2) * BLOCK) - y,
    });
  }
  return rects.sort((a, b) => b.width * b.height - a.width * a.height || a.y - b.y || a.x - b.x);
}

/** Masks larger than this share of the page are dropped: the page moved, it didn't just animate. */
export const MAX_MASK_SHARE = 0.75;

/**
 * Regions that changed between two screenshots of the same page: clocks, carousels, video. Only
 * the area both shots cover is compared, so a page that grew doesn't mask its new tail. A mask
 * over more than three quarters of the page means the layout shifted; it is dropped rather than hiding
 * everything.
 */
export function dynamicMask(first: Image, second: Image): Rect[] {
  const width = Math.min(first.width, second.width);
  const height = Math.min(first.height, second.height);
  const a = cropTo(first, width, height);
  const b = cropTo(second, width, height);
  const out = new Uint8Array(width * height * 4);
  pixelmatch(a, b, out, width, height, { threshold: 0.1, diffMask: true, includeAA: false });
  // With diffMask, differing pixels are painted opaque and the rest left transparent.
  const rects = diffRegions((x, y) => (out[(y * width + x) * 4 + 3] as number) > 0, width, height);
  const area = rects.reduce((n, r) => n + r.width * r.height, 0);
  return area > width * height * MAX_MASK_SHARE ? [] : rects;
}

function cropTo(image: Image, width: number, height: number): Uint8Array {
  if (image.width === width && image.height === height) return image.data;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    out.set(
      image.data.subarray(y * image.width * 4, y * image.width * 4 + width * 4),
      y * width * 4,
    );
  return out;
}

export interface PixelDiff {
  /** Differing pixels over unmasked pixels, 0 to 1. */
  ratio: number;
  differing: number;
  compared: number;
  width: number;
  height: number;
  regions: Rect[];
  /** The diff image: differences in red over a faded copy of the baseline. */
  diff: Image;
}

/** Compare a screenshot with its baseline, ignoring the masked regions. */
export function comparePixels(baseline: Image, current: Image, mask: Rect[]): PixelDiff {
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  const a = padTo(baseline, width, height);
  const b = new Uint8Array(padTo(current, width, height));
  // Masked pixels take the baseline's value so they never count. Walk each rectangle's own
  // pixels (overlaps counted once), not every pixel against every rectangle.
  let maskedPixels = 0;
  const seen = mask.length > 1 ? new Uint8Array(width * height) : undefined;
  for (const r of mask) {
    const x1 = Math.min(width, r.x + r.width);
    const y1 = Math.min(height, r.y + r.height);
    for (let y = Math.max(0, r.y); y < y1; y++)
      for (let x = Math.max(0, r.x); x < x1; x++) {
        const p = y * width + x;
        if (seen) {
          if (seen[p]) continue;
          seen[p] = 1;
        }
        maskedPixels++;
        b.set(a.subarray(p * 4, p * 4 + 4), p * 4);
      }
  }
  const out = new Uint8Array(width * height * 4);
  const differing = pixelmatch(a, b, out, width, height, { threshold: 0.1, alpha: 0.2 });
  const compared = Math.max(1, width * height - maskedPixels);
  const regions = diffRegions(
    (x, y) => {
      const i = (y * width + x) * 4;
      return out[i] === 255 && out[i + 1] === 0 && out[i + 2] === 0;
    },
    width,
    height,
  );
  return {
    ratio: differing / compared,
    differing,
    compared,
    width,
    height,
    regions,
    diff: { width, height, data: out },
  };
}
