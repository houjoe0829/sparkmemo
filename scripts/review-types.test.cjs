// Reproduce the interop/null-check combination behind the community review warnings.
// The TypeScript program is in memory; no tsconfig, source or build output is rewritten.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');
const { ESLint } = require('eslint');

test('community-style interop and null checking retain the recommended type-safety rules', async () => {
  const root = path.resolve(__dirname, '..');
  const configPath = path.join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options, noEmit: true, skipLibCheck: true,
    esModuleInterop: true, strictNullChecks: true,
  });
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: [{
      files: ['src/**/*.ts'],
      languageOptions: { parserOptions: { projectService: false, project: false, programs: [program] } },
    }],
  });
  const rules = (await eslint.calculateConfigForFile(path.join(root, 'src/capture-view.ts'))).rules;
  for (const rule of ['no-unsafe-assignment', 'no-unsafe-call', 'no-unsafe-member-access',
    'no-unsafe-argument', 'no-unnecessary-type-assertion']) {
    assert.ok(rules[`@typescript-eslint/${rule}`][0] > 0, `${rule} must stay enabled`);
  }
  const results = await eslint.lintFiles(['src']);
  const errors = results.reduce((sum, file) => sum + file.errorCount, 0);
  const warnings = results.reduce((sum, file) => sum + file.warningCount, 0);
  const formatter = await eslint.loadFormatter('stylish');
  assert.equal(errors, 0, formatter.format(results));
  assert.equal(warnings, 0, formatter.format(results));
});
