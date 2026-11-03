const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { spawnSync } = require('node:child_process');
const { packageRelease } = require('./package-release.cjs');

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkmemo-release-test-'));
  try {
    const write = (file, data) => fs.writeFileSync(path.join(root, file), JSON.stringify(data));
    fs.mkdirSync(path.join(root, 'dist'));
    write('manifest.json', { id: 'spark-memo', version: '0.2.10', minAppVersion: '1.8.7' });
    write('package.json', { version: '0.2.10' });
    write('package-lock.json', { version: '0.2.10', packages: { '': { version: '0.2.10' } } });
    write('versions.json', { '0.2.10': '1.8.7' });
    fs.writeFileSync(path.join(root, 'dist/main.js'), 'module.exports = "built";');
    fs.writeFileSync(path.join(root, 'styles.css'), '.jp-test { color: red; }');
    run(root, write);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('release packaging preserves exactly three asset byte streams', () => fixture(root => {
  const out = path.join(root, 'package');
  packageRelease(root, '0.2.10', out);
  assert.deepEqual(fs.readdirSync(out).sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const [source, dest] of [['dist/main.js', 'main.js'], ['manifest.json', 'manifest.json'], ['styles.css', 'styles.css']]) {
    assert.deepEqual(fs.readFileSync(path.join(out, dest)), fs.readFileSync(path.join(root, source)));
  }
}));

test('release packaging rejects mismatched versions, invalid tags, incomplete builds and existing outputs', () => {
  for (const tag of ['v0.2.10', '../0.2.10', '0.2.10; echo unsafe', '0.2.9']) fixture(root => {
    const out = path.join(root, 'package');
    assert.throws(() => packageRelease(root, tag, out)); assert.equal(fs.existsSync(out), false);
  });
  for (const file of ['package.json', 'package-lock.json', 'versions.json']) fixture((root, write) => {
    write(file, file === 'package-lock.json' ? { version: '0.2.9', packages: { '': { version: '0.2.9' } } }
      : file === 'versions.json' ? { '0.2.10': '1.13.0' } : { version: '0.2.9' });
    assert.throws(() => packageRelease(root, '0.2.10', path.join(root, 'package')));
  });
  fixture(root => {
    fs.writeFileSync(path.join(root, 'dist/main.js'), '');
    assert.throws(() => packageRelease(root, '0.2.10', path.join(root, 'package')));
  });
  fixture(root => {
    const out = path.join(root, 'package'); fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'keep.txt'), 'keep');
    assert.throws(() => packageRelease(root, '0.2.10', out));
    assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'keep');
  });
});

test('attestation workflow is manual, tag-bound, pinned, and cannot publish a release', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-attest.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const job = workflow.jobs.build;
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.permissions['id-token'], 'write');
  assert.equal(job.permissions.attestations, 'write');
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /^actions\/[\w-]+@[a-f0-9]{40}$/);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, 'refs/tags/${{ inputs.tag }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const guard = job.steps[0].run;
  for (const [tag, ref, succeeds] of [
    ['0.2.10', 'refs/tags/0.2.10', true], ['0.2.10', 'refs/heads/main', false],
    ['0.2.10', 'refs/tags/0.2.9', false], ['v0.2.10', 'refs/tags/v0.2.10', false],
    ['0.2.10; echo unsafe', 'refs/tags/0.2.10; echo unsafe', false],
  ]) {
    const result = spawnSync('bash', ['-e', '-c', guard], {
      env: { ...process.env, RELEASE_TAG: tag, GITHUB_REF: ref }, encoding: 'utf8',
    });
    assert.equal(result.status === 0, succeeds, `${tag} ${ref}`);
  }
  assert.ok(job.steps.some(step => step.run?.includes('"$(git rev-parse HEAD)" = "$GITHUB_SHA"')));
  const packageAt = job.steps.findIndex(step => step.run?.includes('scripts/package-release.cjs'));
  const attestAt = job.steps.findIndex(step => step.uses?.startsWith('actions/attest@'));
  const uploadAt = job.steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(packageAt < attestAt && attestAt < uploadAt);
  assert.equal(job.steps[attestAt].with['subject-path'], job.steps[uploadAt].with.path);
  assert.ok(!job.steps.some(step => /gh release|git push|npm publish/.test(step.run ?? '')));
});
