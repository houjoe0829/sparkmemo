declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}

/** Injected by scripts/build.js via esbuild `define`. */
declare const __PLUGIN_VERSION__: string;
declare const __BUILD_NUMBER__: string;
