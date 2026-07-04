/**
 * WASM-based WebP encoder (libwebp via @jsquash/webp), used instead of
 * `canvas.toBlob('image/webp', ...)` because Safari/iOS can *decode* WebP
 * but has never implemented canvas *encoding* to WebP — toBlob silently
 * resolves `null` there. This wrapper works identically on every platform
 * (desktop Obsidian and iOS/Android), so compression quality is no longer
 * platform-dependent.
 *
 * The wasm binary is inlined into the bundle at build time (esbuild's
 * `binary` loader for `.wasm`), so there is no runtime fetch/network
 * dependency — important since Obsidian mobile has no reliable way to
 * fetch a sibling asset file from the plugin's own folder.
 */
import createWebpModule from '@jsquash/webp/codec/enc/webp_enc.js';
// esbuild's `binary` loader turns this into an inlined Uint8Array at build time.
import wasmBinary from '@jsquash/webp/codec/enc/webp_enc.wasm';
import { defaultOptions, type EncodeOptions } from '@jsquash/webp/meta.js';
import type { WebPModule } from '@jsquash/webp/codec/enc/webp_enc';

let modulePromise: Promise<WebPModule> | null = null;

function getModule(): Promise<WebPModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasmModule = await WebAssembly.compile(wasmBinary as BufferSource);
      return createWebpModule({
        noInitialRun: true,
        instantiateWasm: (imports, callback) => {
          const instance = new WebAssembly.Instance(wasmModule, imports);
          callback(instance);
          return instance.exports;
        },
      }) as unknown as Promise<WebPModule>;
    })();
  }
  return modulePromise;
}

/** Encodes raw canvas pixel data to a WebP-encoded ArrayBuffer. */
export async function encodeWebp(imageData: ImageData, options: Partial<EncodeOptions> = {}): Promise<ArrayBuffer> {
  const module = await getModule();
  const result = module.encode(imageData.data, imageData.width, imageData.height, { ...defaultOptions, ...options });
  if (!result) throw new Error('WebP encode failed');
  return result.buffer as ArrayBuffer;
}
