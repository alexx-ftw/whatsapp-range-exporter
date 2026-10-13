'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Core = require('../WhatsApp-Range-Exporter.user.js');
const source = fs.readFileSync(require.resolve('../WhatsApp-Range-Exporter.user.js'), 'utf8');
const settings = { format:'txt',dateOrder:'auto',mediaMode:'none',loadOlderFromPhone:false,theme:'auto' };
const message = (id, media=[]) => ({ id, author:'Persona de prueba', text:'Mensaje de prueba', timestamp:Date.UTC(2026,9,13,12), media });
const result = { records:[message('ONE'),message('TWO',[{type:'image'}])], excludedMessages:[], metadataWarnings:[], partial:false };

test('installed version is shown in the header and matches metadata', () => {
 const html=Core.uiTemplate(settings);
 assert.match(html, new RegExp(`data-role="version"[^>]*>v${Core.VERSION.replaceAll('.','\\.')}`));
 assert.match(source,new RegExp(`@version\\s+${Core.VERSION.replaceAll('.','\\.')}`));
});
test('new panel has a separate scrollable body and always accessible footer',()=>{
 const html=Core.uiTemplate(settings);
 assert.match(html,/data-role="panel-body"/);
 assert.match(html,/<footer[^>]*data-role="action-bar"/);
 assert.match(html,/data-role="action-help"/);
 assert.match(html,/data-role="range-summary"/);
});
test('UI contains no selects or native disclosures',()=>assert.doesNotMatch(Core.uiTemplate(settings),/<(?:select|option|details|summary)(?:\s|>)/));
test('default last endpoint stays last available',()=>assert.match(Core.uiTemplate(settings),/data-role="end-kind" data-value="none"/));
test('theme choices are visible buttons, and user settings are preserved',()=>{
 assert.match(Core.uiTemplate({...settings,theme:'dark'}),/data-role="theme" data-value="dark"/);
 assert.match(Core.uiTemplate({...settings,format:'json'}),/data-role="format" data-value="json"/);
});
test('initial counters do not invent totals',()=>{
 assert.equal(typeof Core.buildPanelSummary,'function');
 const s=Core.buildPanelSummary(null,null,null,0);
 assert.equal(s.messages,null); assert.equal(s.recovered,null); assert.equal(s.failed,null);
 assert.equal(s.partial,false);
});
test('range counts respect exclusions and unprepared media are not called recovered',()=>{
 const s=Core.buildPanelSummary({...result,excludedMessages:[message('ONE')]},null,null,0);
 assert.equal(s.messages,1); assert.equal(s.excluded,1); assert.equal(s.expected,1);
 assert.equal(s.recovered,null); assert.equal(s.failed,null);
});
test('media results include missing items and warnings',()=>{
 const c={files:[],failures:[{recordId:'TWO',error:'No disponible'}],warnings:[],foundCount:1,totalBytes:0};
 const s=Core.buildPanelSummary(result,c,null,0);
 assert.equal(s.recovered,0); assert.equal(s.failed,1); assert.equal(s.partial,true);
});
test('image subset report never pretends to count all media',()=>{
 const s=Core.buildPanelSummary(result,null,{failures:[],missingCount:1,expectedCount:3,totalBytes:40},2);
 assert.equal(s.scope,'images'); assert.equal(s.expected,3);assert.equal(s.recovered,2);assert.equal(s.failed,1);assert.equal(s.partial,true);
});
test('scan partial remains partial even when all files are recovered',()=>{
 assert.equal(Core.buildPanelSummary({...result,partial:true},{files:[{recordId:'TWO'}],failures:[],foundCount:1},null,0).partial,true);
});
test('progress has no fake percentage for scans without totals',()=>{
 assert.equal(typeof Core.panelProgress,'function');
 assert.equal(Core.panelProgress({phase:'Recopilando',count:30}).percent,null);
 assert.equal(Core.panelProgress({completed:2,total:8}).percent,25);
 assert.equal(Core.panelProgress({percent:110}).percent,100);
});
test('metadata URLs and settings key are kept',()=>{
 for(const field of ['updateURL','downloadURL']) assert.match(source,new RegExp(`@${field}\\s+https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js`));
 assert.match(source, /const SETTINGS_KEY = 'wa-range-exporter-settings-v1'/);
});
test('TXT has no removed export header',()=>{
 const text=Core.formatText(result);assert.doesNotMatch(text,/^(Chat:|Mensajes:|Exportado:)/m);assert.match(text,/Mensaje de prueba/);
});
test('image queue advances only after successful clipboard write and supports repeat', async()=>{
 const file={blob:new Blob(['PNG'],{type:'image/png'}),filename:'synthetic.png'};
 const q=new Core.ImageClipboardQueue([file,file]);
 class Item {constructor(data){this.data=data;}static supports(){return true;}}
 let calls=0;const opts={ClipboardItemImpl:Item,clipboard:{write:async()=>{calls++;}}};
 await q.copyNext(opts);assert.equal(q.cursor,1);await q.copyLast(opts);assert.equal(q.cursor,1);await q.copyNext(opts);assert.equal(q.cursor,2);assert.equal(calls,3);
});
test('an open image queue takes precedence over a previous media result',()=>{
 const media={files:[{recordId:'TWO'}],failures:[],foundCount:1};
 const report={failures:[{error:'Conversión fallida'}],missingCount:0,expectedCount:1};
 const s=Core.buildPanelSummary(result,media,report,0);
 assert.equal(s.scope,'images');assert.equal(s.failed,1);assert.equal(s.partial,true);
});
test('reported progress safely clamps invalid endpoints',()=>{
 assert.equal(Core.panelProgress({percent:-1}).percent,0);
 assert.equal(Core.panelProgress({total:0,completed:4}).percent,null);
 assert.equal(Core.panelProgress({total:4,completed:10}).percent,100);
});
test('warning messages are retained and deduplicated',()=>{
 const s=Core.buildPanelSummary({...result,scanWarnings:['Aviso A'],metadataWarnings:['Aviso A','Aviso B']},null,null,0);
 assert.deepEqual(s.warnings,['Aviso A','Aviso B']);
});
test('zero messages is shown as zero, not unknown',()=>{
 const s=Core.buildPanelSummary({...result,records:[]},null,null,0);assert.equal(s.messages,0);assert.equal(s.expected,0);
});
test('v1.5 changes no collection, date, file, compression or clipboard engine code',()=>{
 const crypto = require('node:crypto');
 const engine = source.split('  /** Presentation only: never change records')[0]
  .replace(`// @version      ${Core.VERSION}`,'// @version      1.4.3')
  .replace(`const VERSION = '${Core.VERSION}';`,"const VERSION = '1.4.3';");
 assert.equal(crypto.createHash('sha256').update(engine).digest('hex'),'ca891c4e3749d7b2cb8e3b92f174fe51a40b6358ffc9c8fbddb15f7a0d83b26a');
});
test('theme changes do not animate a light background under dark-theme text',()=>assert.doesNotMatch(Core.uiTemplate(settings),/transition:background/));
