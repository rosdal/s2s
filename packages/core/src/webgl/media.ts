import type { Browser, Page } from "playwright-core";
import { launchBrowser } from "../capture/browser.js";

/**
 * Image and audio work done in Chromium, which already ships every codec s2s needs: decode PNG,
 * JPEG and WebP, resize, encode WebP, decode and resample audio. No native Node addons.
 */
export interface MediaTools {
  /** Resize so neither side exceeds `maxSize` (never upscales) and encode as WebP. */
  toWebp(
    bytes: Uint8Array,
    mime: string,
    maxSize: number,
  ): Promise<{ bytes: Buffer; width: number; height: number } | null>;
  /** Duration and channel count, or `null` when Chromium can't decode it. */
  audioInfo(
    bytes: Uint8Array,
  ): Promise<{ durationMs: number; channels: number; sampleRate: number } | null>;
  /** Mixed to mono and resampled to `rate`. */
  audioMono(bytes: Uint8Array, rate: number): Promise<Float32Array | null>;
}

export interface MediaOptions {
  headless?: boolean;
  executablePath?: string;
}

/** Run `fn` with a browser-backed `MediaTools`; the browser starts on first use. */
export async function withMedia<T>(
  options: MediaOptions,
  fn: (tools: MediaTools) => Promise<T>,
): Promise<T> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  const ready = async (): Promise<Page> => {
    if (page) return page;
    browser = await launchBrowser({
      ...(options.headless !== undefined ? { headless: options.headless } : {}),
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
    page = await browser.newPage();
    await page.setContent("<!doctype html><title>s2s media</title>");
    return page;
  };
  const b64 = (bytes: Uint8Array) =>
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  const tools: MediaTools = {
    async toWebp(bytes, mime, maxSize) {
      const p = await ready();
      const result = await p.evaluate(
        async ({ data, type, max }) => {
          try {
            const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([raw], { type }));
            const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bitmap, 0, 0, width, height);
            const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
            const buf = new Uint8Array(await blob.arrayBuffer());
            let s = "";
            for (let i = 0; i < buf.length; i += 0x8000)
              s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return { data: btoa(s), width, height };
          } catch {
            return null;
          }
        },
        { data: b64(bytes), type: mime, max: maxSize },
      );
      return result
        ? { bytes: Buffer.from(result.data, "base64"), width: result.width, height: result.height }
        : null;
    },
    async audioInfo(bytes) {
      const p = await ready();
      return p.evaluate(async (data) => {
        try {
          const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const ctx = new OfflineAudioContext(1, 1, 44100);
          const buffer = await ctx.decodeAudioData(raw.buffer);
          return {
            durationMs: Math.round(buffer.duration * 1000),
            channels: buffer.numberOfChannels,
            sampleRate: buffer.sampleRate,
          };
        } catch {
          return null;
        }
      }, b64(bytes));
    },
    async audioMono(bytes, rate) {
      const p = await ready();
      const out = await p.evaluate(
        async ({ data, rate: r }) => {
          try {
            const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
            const probe = new OfflineAudioContext(1, 1, 44100);
            const decoded = await probe.decodeAudioData(raw.buffer);
            const length = Math.max(1, Math.ceil(decoded.duration * r));
            const ctx = new OfflineAudioContext(1, length, r);
            const source = ctx.createBufferSource();
            source.buffer = decoded;
            source.connect(ctx.destination);
            source.start();
            const rendered = await ctx.startRendering();
            const f = rendered.getChannelData(0);
            const bytes8 = new Uint8Array(f.buffer.slice(0));
            let s = "";
            for (let i = 0; i < bytes8.length; i += 0x8000)
              s += String.fromCharCode(...bytes8.subarray(i, i + 0x8000));
            return btoa(s);
          } catch {
            return null;
          }
        },
        { data: b64(bytes), rate },
      );
      if (!out) return null;
      const buf = Buffer.from(out, "base64");
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
    },
  };
  try {
    return await fn(tools);
  } finally {
    await browser?.close().catch(() => {});
  }
}
