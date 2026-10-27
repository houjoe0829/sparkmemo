// Local counterpart to the community's CSS warnings. No files are rewritten.
const { readFileSync } = require('node:fs');
const { transformSync } = require('esbuild');

function checkCss(source) {
  const errors = [];
  const parsed = transformSync(source, { loader: 'css', logLevel: 'silent' });
  errors.push(...parsed.warnings.map(warning => warning.text));
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let inlineOverrides = 0;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/:has\s*\(/.test(selectors)) errors.push(`Avoid :has(): ${selectors.trim()}`);
    for (const declaration of body.split(';').filter(value => /!\s*important\b/.test(value))) {
      if (selectors.trim() === '.is-mobile .jp-capture-root' && /^\s*padding-bottom:\s*0\s*!important\s*$/.test(declaration)) inlineOverrides++;
      else errors.push(`Avoid !important: ${selectors.trim()} { ${declaration.trim()} }`);
    }
  }
  if (inlineOverrides !== 1) errors.push('Keep exactly one documented mobile keyboard inline-style override.');
  return { errors, inlineOverrides };
}
module.exports = { checkCss };
if (require.main === module) {
  const result = checkCss(readFileSync(require('node:path').join(__dirname, '../styles.css'), 'utf8'));
  result.errors.forEach(error => console.error(error));
  if (result.errors.length) process.exitCode = 1;
  else console.log(`CSS passed. Retained ${result.inlineOverrides} documented mobile keyboard override for device verification.`);
}
