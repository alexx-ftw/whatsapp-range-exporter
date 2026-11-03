"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../WhatsApp-Range-Exporter.user.js');
const html = Core.uiTemplate({format:'txt',dateOrder:'auto',mediaMode:'none',theme:'auto'});
const base = html.match(/\.toggle\{([^}]+)\}/)[1];
test('launcher is almost invisible at rest, without a distracting shadow', () => {
  assert.match(base, /(?:^|;)opacity:\.14(?:;|$)/);
  assert.match(base, /(?:^|;)box-shadow:none(?:;|$)/);
});
test('hover, keyboard focus and press reveal the launcher completely', () => {
  assert.match(html, /\.toggle:hover,\.toggle:focus-visible,\.toggle:active\{opacity:1;[^}]*box-shadow:var\(--shadow\)/);
});
test('only opacity is animated; the button does not move or grow on hover', () => {
  assert.match(base, /transition:opacity \.14s ease/);
  assert.doesNotMatch(base, /transform:|transition:[^;}]*background/);
});
test('touch-only devices keep a discoverable half-opacity launcher', () => {
  assert.match(html, /@media\(hover:none\)\{\.toggle\{opacity:\.5\}\}/);
});
test('reduced-motion users still have transitions disabled', () => {
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)[^\n]*transition:none!important/);
});
