'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Core = require('../WhatsApp-Range-Exporter.user.js');
const source = fs.readFileSync(require.resolve('../WhatsApp-Range-Exporter.user.js'), 'utf8');
const settings = { format:'txt', dateOrder:'auto', mediaMode:'none', loadOlderFromPhone:false, theme:'auto' };

test('launcher leaves a separate right-hand lane for native WhatsApp controls', () => {
  const html = Core.uiTemplate(settings);
  assert.match(html, /\.toggle\{position:fixed;right:calc\(96px \+ env\(safe-area-inset-right, 0px\)\)/);
});

test('narrow layouts do not move the launcher back over native controls', () => {
  const html = Core.uiTemplate(settings);
  const positions = [...html.matchAll(/\.toggle\{[^}]*\bright:[^;}]+/g)];
  assert.equal(positions.length, 1, 'Use one shared launcher position at every breakpoint');
});

test('launcher keeps its accessible target size and keyboard shortcut', () => {
  const html = Core.uiTemplate(settings);
  assert.match(html, /\.toggle\{[^}]*width:52px;height:52px/);
  assert.match(html, /aria-label="Abrir exportador de WhatsApp, versión [^"]+"/);
  assert.match(source, /event\.altKey && event\.shiftKey && event\.key\.toLowerCase\(\) === 'e'/);
});

test('release changes only the launcher CSS and version in the shipped source', () => {
  const previous = source
    .replace(`// @version      ${Core.VERSION}`, '// @version      1.5.0')
    .replace(`const VERSION = '${Core.VERSION}';`, "const VERSION = '1.5.0';")
    .replace('.toggle{position:fixed;right:calc(96px + env(safe-area-inset-right, 0px));', '.toggle{position:fixed;right:20px;')
    .replace('.image-preview{height:200px}.pick-tray{', '.image-preview{height:200px}.toggle{right:16px}.pick-tray{');
  assert.equal(crypto.createHash('sha256').update(previous).digest('hex'),
    '3d7dd3d3bef8dd4908f970f66c0713c00fd5568efc916d702f15009fec97ef97');
});
