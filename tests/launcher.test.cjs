'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Core = require('../WhatsApp-Range-Exporter.user.js');
const source = fs.readFileSync(require.resolve('../WhatsApp-Range-Exporter.user.js'), 'utf8');
const settings = { format:'txt', dateOrder:'auto', mediaMode:'none', loadOlderFromPhone:false, theme:'auto' };
const launcherStyle = () => Core.uiTemplate(settings).match(/\.toggle\{([^}]+)\}/)[1];

test('launcher stays near the right edge instead of covering message bubbles', () => {
  assert.match(launcherStyle(), /right:calc\(20px \+ env\(safe-area-inset-right, 0px\)\)/);
});
test('launcher is vertically separated above the native bottom control', () => {
  assert.match(launcherStyle(), /bottom:calc\(164px \+ env\(safe-area-inset-bottom, 0px\)\)/);
});
test('launcher is compact but keeps a 44px clickable target', () => {
  assert.match(launcherStyle(), /width:44px;height:44px/);
  assert.match(launcherStyle(), /border-radius:12px/);
});
test('one shared launcher position applies to wide and narrow viewports', () => {
  const html = Core.uiTemplate(settings);
  assert.equal([...html.matchAll(/\.toggle\{[^}]*\bright:[^;}]+/g)].length, 1);
});
test('accessible name and keyboard alternative remain available', () => {
  assert.match(Core.uiTemplate(settings), /aria-label="Abrir exportador de WhatsApp, versión [^"]+"/);
  assert.match(source, /event\.altKey && event\.shiftKey && event\.key\.toLowerCase\(\) === 'e'/);
});
test('release changes only launcher layout and version compared with v1.5.1', () => {
  const previous = source
    .replace(`// @version      ${Core.VERSION}`, '// @version      1.5.1')
    .replace(`const VERSION = '${Core.VERSION}';`, "const VERSION = '1.5.1';")
    .replace(/\.toggle\{[^}]+\}/, '.toggle{position:fixed;right:calc(96px + env(safe-area-inset-right, 0px));bottom:88px;display:grid;place-items:center;width:52px;height:52px;padding:0;background:var(--accent);color:var(--surface);border:1px solid var(--accent-hover);border-radius:16px;box-shadow:var(--shadow);cursor:pointer;z-index:2147483647}');
  assert.equal(crypto.createHash('sha256').update(previous).digest('hex'),
    'c5e0258b59c1e136dbdca588faec84b38f4a3c666bf52935960b06512b101968');
});
