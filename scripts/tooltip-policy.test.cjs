// Run with node --test scripts/tooltip-policy.test.cjs. Static policy guards, not visual acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = file => readFileSync(path.join(root, file), 'utf8');

test('suppression CSS is limited to marked Spark Memo surfaces and never hides global tooltip elements', () => {
  const css = source('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const suppression = rules.filter(rule => /--no-tooltip\s*:/.test(rule[2]));
  assert.equal(suppression.length, 1);
  assert.deepEqual(suppression[0][1].trim().split(',').map(selector => selector.trim()), [
    '.jp-no-tooltip', '.jp-no-tooltip [aria-label]',
  ]);
  assert.match(suppression[0][2], /--no-tooltip\s*:\s*true\s*;/);
  assert.ok(!/display\s*:|visibility\s*:|opacity\s*:/.test(suppression[0][2]));
  for (const rule of rules) assert.ok(!/(^|[\s,])\.tooltip\b/.test(rule[1]), rule[1]);
});

test('only heatmap detail titles are generated; menu labels and errors are not stripped', () => {
  const titles = [];
  for (const file of readdirSync(path.join(root, 'src')).filter(file => file.endsWith('.ts'))) {
    const contents = source(`src/${file}`);
    const ast = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        assert.notEqual(method, 'setTooltip', file);
        if (['setAttr', 'setAttribute'].includes(method) && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'title') {
          assert.equal(file, 'capture-view.ts');
          assert.equal(node.expression.expression.getText(ast), 'cell');
          assert.ok(node.arguments[1].getText(ast).includes("t('stats.cell"));
          titles.push(node.getText(ast));
        }
      }
      // `title` in an attr object is an HTML hover hint; menu/modal title options are not.
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'title' &&
          ts.isObjectLiteralExpression(node.parent) && ts.isPropertyAssignment(node.parent.parent) &&
          node.parent.parent.name.getText(ast) === 'attr') {
        assert.fail(`Unexpected native hover title in ${file}: ${node.getText(ast)}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.equal(titles.length, 2);
  assert.match(source('src/capture-view.ts'), /label\.textContent = String\(c\.count\)/); // Map count remains.
  assert.match(source('src/capture-view.ts'), /setTitle\(t\('capture\.menuDeleteMemo'\)\)/);
  assert.match(source('src/capture-view.ts'), /titleEl\.setText\(this\.opts\.title\)/);
  assert.match(source('src/capture-view.ts'), /notice\(t\('notice\.updateFailed'/);
});
