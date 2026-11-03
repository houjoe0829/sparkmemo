// Package only validated build assets. This script never creates tags or publishes releases.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function packageRelease(root, tag, outputDir) {
  assert.match(tag, /^\d+\.\d+\.\d+$/, 'Use a plain x.y.z release tag');
  assert.ok(outputDir, 'An explicit output directory is required');
  const readJson = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const versions = readJson('versions.json');
  assert.equal(manifest.id, 'spark-memo');
  for (const version of [manifest.version, pkg.version, lock.version, lock.packages[''].version]) {
    assert.equal(version, tag, 'Version metadata must match the requested tag');
  }
  assert.equal(versions[tag], manifest.minAppVersion, 'Minimum app versions must match');
  const assets = [['dist/main.js', 'main.js'], ['manifest.json', 'manifest.json'], ['styles.css', 'styles.css']]
    .map(([source, name]) => [name, fs.readFileSync(path.join(root, source))]);
  for (const [name, bytes] of assets) assert.ok(bytes.length > 0, `${name} must not be empty`);
  // Refuse existing output rather than replacing an earlier package or unrelated files.
  fs.mkdirSync(outputDir);
  for (const [name, bytes] of assets) fs.writeFileSync(path.join(outputDir, name), bytes, { flag: 'wx' });
  return assets.map(([name]) => name);
}

if (require.main === module) {
  const [, , tag, outputDir] = process.argv;
  try {
    console.log('Packaged:', packageRelease(process.cwd(), tag, outputDir).join(', '));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { packageRelease };
