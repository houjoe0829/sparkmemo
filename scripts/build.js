/**
 * Wraps esbuild's JS API (instead of the CLI) so we can inject a
 * monotonically increasing build number alongside the plugin version.
 * The counter lives in build-number.txt and is committed to git so it
 * keeps counting up across machines/releases instead of resetting.
 *
 * Only real (non-watch) builds bump the counter — `npm run dev` starts
 * one long-lived esbuild watch process, so bumping on every rebuild
 * would just mean "how many times I saved a file", not a release count.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const buildNumberFile = path.join(root, 'build-number.txt');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const watch = process.argv.includes('--watch');

let buildNumber = parseInt(fs.readFileSync(buildNumberFile, 'utf8').trim(), 10) || 0;
if (!watch) {
  buildNumber += 1;
  fs.writeFileSync(buildNumberFile, String(buildNumber) + '\n');
}

const options = {
  entryPoints: [path.join(root, 'src/main.ts')],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', 'builtin-modules'],
  loader: { '.wasm': 'binary' },
  format: 'cjs',
  target: 'es2018',
  outfile: path.join(root, 'dist/main.js'),
  define: {
    __PLUGIN_VERSION__: JSON.stringify(manifest.version),
    __BUILD_NUMBER__: JSON.stringify(String(buildNumber)),
  },
};

async function run() {
  if (watch) {
    options.sourcemap = 'inline';
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log(`Watching (v${manifest.version}, build #${buildNumber})...`);
  } else {
    options.sourcemap = true;
    options.treeShaking = true;
    await esbuild.build(options);
    console.log(`Built v${manifest.version}, build #${buildNumber}`);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
