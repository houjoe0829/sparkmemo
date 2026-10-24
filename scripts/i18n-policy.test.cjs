// Run with node --test scripts/i18n-policy.test.cjs. No browser, network or vault writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// Exceptions are exact file + UI entry + value, never a language-wide exemption.
const ALLOWED_UI_LITERALS = new Set([
  'settings-tab.ts:setPlaceholder:Memo', // Actual heading name, not instructional text.
  'settings-tab.ts:text:houqiao829@gmail.com', // Contact address is data, identical in every locale.
  'settings-tab.ts:setPlaceholder:\\d{2}:\\d{2}', // Stored regex example.
  'capture-view.ts:text:Ctrl ↵', // Physical keycap label, independent of UI language.
  'capture-view.ts:text: B', // Standard byte units, not prose.
  'capture-view.ts:text: KB',
  'capture-view.ts:text: MB',
]);
const UI_METHODS = new Set(['setText', 'setTitle', 'setName', 'setDesc', 'setPlaceholder',
  'setButtonText', 'createTextNode', 'renderTopLevelMessage', 'renderStatsError']);
const UI_PROPS = new Set(['text', 'placeholder', 'aria-label', 'aria-description', 'aria-valuetext', 'alt']);

/** Follow same-file constants, conditionals, templates and helper return values into UI sinks.
 * This is a regression guard, not a claim to perform whole-program data-flow analysis.
 * User data, external calls and intentional non-UI prompt bodies remain untouched.
 */
function auditSource(file, content) {
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => name === file ? ast : undefined;
  host.fileExists = name => name === file;
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const problems = [], exceptions = new Set(), seenProblems = new Set();
  const word = /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/;
  function literal(value, node, entry) {
    if (!word.test(value)) return; // Numbers, punctuation and icon-only glyphs are not prose.
    const key = `${file}:${entry}:${value}`;
    if (ALLOWED_UI_LITERALS.has(key)) { exceptions.add(key); return; }
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    const problem = `${file}:${line} ${entry}: ${JSON.stringify(value)}`;
    if (!seenProblems.has(problem)) { seenProblems.add(problem); problems.push(problem); }
  }
  function returned(body, entry, seen) {
    if (!body) return;
    if (!ts.isBlock(body)) { inspect(body, entry, seen); return; }
    function walk(node) {
      if (ts.isReturnStatement(node) && node.expression) inspect(node.expression, entry, seen);
      else if (!ts.isFunctionLike(node)) ts.forEachChild(node, walk);
    }
    ts.forEachChild(body, walk);
  }
  function declaration(symbol) {
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }
  function inspect(node, entry, seen = new Set()) {
    if (!node || seen.has(node)) return;
    seen = new Set(seen); seen.add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal(node.text, node, entry);
    else if (ts.isTemplateExpression(node)) {
      literal(node.head.text, node.head, entry);
      for (const span of node.templateSpans) { inspect(span.expression, entry, seen); literal(span.literal.text, span.literal, entry); }
    } else if (ts.isConditionalExpression(node)) {
      inspect(node.whenTrue, entry, seen); inspect(node.whenFalse, entry, seen);
    } else if (ts.isBinaryExpression(node)) {
      inspect(node.left, entry, seen); inspect(node.right, entry, seen);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) inspect(node.expression, entry, seen);
    else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(item => inspect(item, entry, seen));
    else if (ts.isElementAccessExpression(node)) inspect(node.expression, entry, seen);
    else if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const d = declaration(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node));
      if (d && d.getSourceFile() === ast && (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d))) inspect(d.initializer, entry, seen);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.getText(ast) === 't') return;
      if (node.expression.getText(ast) === 'String') { inspect(node.arguments[0], entry, seen); return; }
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      let d = declaration(checker.getSymbolAtLocation(callee));
      if (d && d.getSourceFile() === ast && ts.isVariableDeclaration(d)) d = d.initializer;
      if (d && d.getSourceFile() === ast && ts.isFunctionLike(d)) returned(d.body, entry, seen);
    }
  }
  function objectOptions(node) {
    if (!node || !ts.isObjectLiteralExpression(node)) return;
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = p.name.text;
      if (UI_PROPS.has(name)) inspect(p.initializer, name);
      else if (name === 'attr') objectOptions(p.initializer);
    }
  }
  function walk(node) {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'notice') inspect(node.arguments[0], 'notice');
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (UI_METHODS.has(method)) inspect(node.arguments[0], method);
        if (['createEl', 'createDiv', 'createSpan'].includes(method)) node.arguments.forEach(objectOptions);
        if (['setAttr', 'setAttribute'].includes(method) && UI_PROPS.has(node.arguments[0]?.text)) inspect(node.arguments[1], node.arguments[0].text);
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Notice') inspect(node.arguments?.[0], 'Notice');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)
      && ['textContent', 'placeholder', 'ariaLabel'].includes(node.left.name.text)) inspect(node.right, node.left.name.text);
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return { problems, exceptions };
}

test('all source UI sinks and same-file random pools avoid untranslated prose', () => {
  const problems = [], exceptions = new Set();
  for (const file of fs.readdirSync(path.join(root, 'src')).filter(file => file.endsWith('.ts'))) {
    const result = auditSource(file, fs.readFileSync(path.join(root, 'src', file), 'utf8'));
    problems.push(...result.problems); result.exceptions.forEach(value => exceptions.add(value));
  }
  assert.deepEqual(problems, []);
  assert.deepEqual([...exceptions].sort(), [...ALLOWED_UI_LITERALS].sort(), 'Remove stale exceptions instead of leaving broad loopholes');
});
test('policy catches direct, conditional, nested attribute, template and helper/array literals', () => {
  for (const source of [
    `root.createDiv({text:'Forgotten copy'});`,
    `el.setText(ok ? t('known') : 'Forgotten fallback');`,
    `root.createEl('input', {attr:{placeholder:'Type here'}});`,
    'el.textContent = `Found ${count} notes`;',
    `const messages = ['One', 'Two']; const pick = () => messages[0]; notice(pick());`,
    `class View { static pool=['One', 'Two']; pick(){const pool=View.pool; return pool[0];} render(){root.createEl('input',{attr:{placeholder:this.pick()}});} }`,
    `el.setAttribute('aria-label', 'Untranslated label');`,
    `el.setText('漏掉的文案');`,
    `el.setText('翻訳されていない文言');`,
    `new Notice('Forgotten notification');`,
  ]) assert.ok(auditSource('fixture.ts', source).problems.length > 0, source);
});
test('policy permits translated pools, external/user data, symbols and non-UI Chinese prompt bodies', () => {
  const source = `const prompts = [{prompt:'保留中文指令正文'}];
    class View { static pool=['capture.placeholder.happening']; pick(){return t(View.pool[0]);}
      render(){root.createEl('input',{attr:{placeholder:this.pick()}});el.setText(this.userText);notice(t('failure',{error:external.message}));} }
    root.createSpan({text:'#'}); el.setText(String(count));`;
  assert.deepEqual(auditSource('fixture.ts', source).problems, []);
});

test('plugin-generated errors reaching the UI use translation keys, not raw internal messages', () => {
  for (const [file, keys] of [
    ['main.ts', ['notice.dailyNoteCreationFailed']],
    ['capture-view.ts', ['preview.errorNoVaultPath', 'preview.errorDecodeFailed', 'preview.errorCanvasUnavailable', 'preview.errorEncodeFailed']],
  ]) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    for (const key of keys) assert.ok(source.includes(`new Error(t('${key}'))`), `${file}: ${key}`);
  }
  const source = fs.readFileSync(path.join(root, 'src/send-to-myclaudian-modal.ts'), 'utf8');
  assert.ok(source.includes("notice(t('myclaudian.sendError', { error:"));
});

// UI text can already be in a dictionary yet still contain an untranslated English copy.
const SHARED_LANGUAGE_VALUES = new Set([
  'settings.language.en:English',
  'settings.about.github:GitHub',
  'settings.about.x:X · @houjoe1',
  'app.name:Spark Memo',
  'ribbon.captureView:Spark Memo',
  'settings.title:Spark Memo',
]);
function untranslatedCopies(english, translated) {
  return Object.entries(english).filter(([key, value]) => /[A-Za-z]/.test(value)
    && translated[key] === value && !SHARED_LANGUAGE_VALUES.has(`${key}:${value}`)).map(([key]) => key);
}
function readDictionary(locale) {
  const text = fs.readFileSync(path.join(root, 'src/locales', `${locale}.ts`), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports });
  return module.exports.default;
}
test('non-English dictionaries do not silently reuse English UI prose except exact brand/native-language labels', () => {
  const english = readDictionary('en');
  for (const locale of ['zh', 'zh-TW', 'ja']) assert.deepEqual(untranslatedCopies(english, readDictionary(locale)), [], locale);
  assert.deepEqual(untranslatedCopies({ 'search.randomMemoLabel': 'Random Memo' }, { 'search.randomMemoLabel': 'Random Memo' }), ['search.randomMemoLabel']);
  assert.deepEqual(untranslatedCopies({ 'app.name': 'Spark Memo' }, { 'app.name': 'Spark Memo' }), []);
  assert.deepEqual(untranslatedCopies({ 'app.name': 'Forgotten title' }, { 'app.name': 'Forgotten title' }), ['app.name']);
});
