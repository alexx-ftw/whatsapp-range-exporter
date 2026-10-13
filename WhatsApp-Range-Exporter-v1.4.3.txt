// ==UserScript==
// @name         WhatsApp Web - Copiar y exportar rango de mensajes
// @namespace    eros.local.whatsapp
// @version      1.4.3
// @description  Exporta rangos y adjuntos con exclusiones y controles por botones. Copia imágenes separadas en una cola manual, solo mediante el portapapeles.
// @author       Eros
// @match        https://web.whatsapp.com/*
// @require      https://github.com/wppconnect-team/wa-js/releases/download/v4.6.0/wppconnect-wa.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @updateURL    https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js
// @downloadURL  https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* globals WPP, JSZip, ClipboardItem */

(function initUniversal(factory) {
  'use strict';

  const Core = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = Core;
  }

  if (typeof window !== 'undefined') {
    window.__WA_RANGE_EXPORTER__ = Core;

    if (
      typeof document !== 'undefined'
      && window.location
      && window.location.hostname === 'web.whatsapp.com'
    ) {
      Core.bootstrap();
    }
  }
}(function createWhatsAppRangeExporter() {
  'use strict';

  const VERSION = '1.4.3';
  const HOST_ID = 'wa-range-exporter-host';
  const GLOBAL_STYLE_ID = 'wa-range-exporter-page-style';
  const MESSAGE_SELECTOR = '[data-testid^="conv-msg-"], [data-testid="image-album"]';
  const SCROLLER_SELECTOR = '[data-testid="conversation-panel-messages"]';
  const TITLE_SELECTOR = '[data-testid="conversation-info-header-chat-title"]';
  const SETTINGS_KEY = 'wa-range-exporter-settings-v1';
  const PICK_CLASS = 'wa-range-exporter-pick-target';
  const EXCLUDED_CLASS = 'wa-range-exporter-excluded';
  const TEXT_SELECTOR = '[data-testid="selectable-text"], .selectable-text, [data-testid="image-caption"], [data-testid="video-caption"], [data-testid="media-caption"]';
  const DAY_MS = 24 * 60 * 60 * 1000;

  function pad(value, length = 2) {
    return String(value).padStart(length, '0');
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(createAbortError());
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, milliseconds);

      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(createAbortError());
      };

      function cleanup() {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function createAbortError() {
    const error = new Error('Operación cancelada');
    error.name = 'AbortError';
    return error;
  }

  function normalizeLineBreaks(value) {
    return String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n')
      .replace(/[\t\f\v]+/g, ' ')
      .replace(/[ \u00a0]+\n/g, '\n')
      .replace(/\n[ \u00a0]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeInline(value) {
    return normalizeLineBreaks(value).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  function localDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return '';
    }
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function localTimeText(date, includeSeconds = false) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return '';
    }
    const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return includeSeconds ? `${base}:${pad(date.getSeconds())}` : base;
  }

  function formatLocalDateTime(timestamp, includeSeconds = false) {
    if (timestamp == null || Number.isNaN(Number(timestamp))) {
      return 'Fecha desconocida';
    }
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) {
      return 'Fecha desconocida';
    }
    return `${localDateKey(date)} ${localTimeText(date, includeSeconds)}`;
  }

  function localeDateOrder(locale) {
    try {
      const parts = new Intl.DateTimeFormat(locale || undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }).formatToParts(new Date(2006, 10, 22));
      const order = parts
        .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
        .map((part) => ({ year: 'Y', month: 'M', day: 'D' }[part.type]))
        .join('');
      if (order === 'DMY' || order === 'MDY' || order === 'YMD') {
        return order;
      }
    } catch (_error) {
      // Intl can fail for an invalid locale. The fallback below remains deterministic.
    }
    return /^en-(?:US|CA|PH)(?:-|$)/i.test(locale || '') ? 'MDY' : 'DMY';
  }

  function extractMetadataDateText(value) {
    const match = /^\[[^,\]]+,\s*([^\]]+)\]/u.exec(String(value || '').trim());
    return match ? match[1].trim() : '';
  }

  function splitNumericDate(value) {
    const parts = String(value || '').trim().match(/\d{1,4}/g);
    if (!parts || parts.length < 3) {
      return null;
    }
    return parts.slice(0, 3).map(Number);
  }

  // A browser's language is NOT necessarily WhatsApp's language.
  // Native timestamp pairs and unambiguous numeric dates are stronger than UI hints.
  function resolveDateOrder(metadataValues, locale, options = {}) {
    let dmy = 0, mdy = 0, ymd = 0;
    for (const value of metadataValues || []) {
      const dateText = extractMetadataDateText(value);
      const parts = splitNumericDate(dateText);
      if (!parts) continue;
      const [first, second] = parts;
      if (/^\s*\d{4}/.test(dateText)) ymd++;
      else if (first > 12 && first <= 31 && second <= 12) dmy++;
      else if (second > 12 && second <= 31 && first <= 12) mdy++;
    }
    const pairVotes = { DMY: 0, MDY: 0 };
    for (const pair of options.timestampPairs || []) {
      if (!Number.isFinite(pair.timestamp)) continue;
      const a = parsePrePlainText(pair.rawMetadata, { dateOrder: 'DMY' });
      const b = parsePrePlainText(pair.rawMetadata, { dateOrder: 'MDY' });
      if (a && b && a.dateKey === b.dateKey) continue;
      const key = localDateKey(new Date(pair.timestamp));
      if (a && a.dateKey === key) pairVotes.DMY++;
      if (b && b.dateKey === key) pairVotes.MDY++;
    }
    const conflict = Boolean((dmy && mdy) || (pairVotes.DMY && pairVotes.MDY) || (dmy && pairVotes.MDY) || (mdy && pairVotes.DMY));
    if (!conflict && (pairVotes.DMY || pairVotes.MDY)) {
      return { order: pairVotes.DMY ? 'DMY' : 'MDY', source: 'timestamp-pair', ambiguous: false, conflict: false };
    }
    if (!conflict && (dmy || mdy)) return { order: dmy ? 'DMY' : 'MDY', source: 'numeric-evidence', ambiguous: false, conflict: false };
    if (ymd && !dmy && !mdy && (metadataValues || []).every(v => /^\s*\d{4}/.test(extractMetadataDateText(v)))) {
      return { order: 'YMD', source: 'numeric-evidence', ambiguous: false, conflict: false };
    }
    const uiLocale = options.uiLocale || '';
    return { order: localeDateOrder(uiLocale || locale || 'es-ES'), source: uiLocale ? 'whatsapp-ui' : 'browser-fallback',
      ambiguous: conflict || !uiLocale, conflict };
  }

  function detectDateOrder(metadataValues, locale, options = {}) {
    return resolveDateOrder(metadataValues, locale, options).order;
  }

  function ownMessageElements(root, selector) {
    const found = Array.from(root.querySelectorAll(selector));
    if (root.matches && root.matches(selector)) found.unshift(root);
    return found.filter(el => !el.closest('[data-testid="quoted-message"], [data-testid="reaction-bubble"]'));
  }

  function metadataAuthor(value) {
    const match = /^\[[^\]]+\]\s*(.*):\s*$/u.exec(String(value || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim());
    return match ? normalizeInline(match[1]) : '';
  }

  function isSelfAlias(value) {
    return /^(?:yo|you|tú|tu|me)$/iu.test(normalizeInline(value));
  }

  function uiDateLocale(scope) {
    // Only inspect UI outside messages, never the language of somebody's message.
    const labels = Array.from(scope.querySelectorAll('span, button')).filter(el => !el.closest(MESSAGE_SELECTOR))
      .map(el => normalizeInline(el.textContent)).filter(t => t.length < 130);
    if (labels.some(t => /^(?:hoy|ayer|lunes|martes|miércoles|jueves|viernes|sábado|domingo)$/iu.test(t)
      || /Haz clic aquí para obtener mensajes anteriores/i.test(t))) return {locale:'es-ES',strength:2};
    if (labels.some(t => /^(?:today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(t)
      || /Click here to get older messages/i.test(t))) {
      const doc = scope.ownerDocument || scope;
      const hint = doc.documentElement && doc.documentElement.lang || '';
      const browser = typeof navigator !== 'undefined' ? navigator.language : '';
      return {locale:/^en-/i.test(hint) ? hint : /^en-/i.test(browser) ? browser : 'en-US',strength:2};
    }
    const doc = scope.ownerDocument || scope;
    return {locale:doc.documentElement && doc.documentElement.lang || '',strength:1};
  }

  function rawIdentity(raw) {
    const id = firstDefined(raw && raw.id, raw && raw.__x_id, raw && raw.key);
    const fullId = serializeMessageId(id);
    const fromMe = firstDefined(raw && raw.fromMe, raw && raw.__x_fromMe,
      id && typeof id === 'object' ? firstDefined(id.fromMe, id.__x_fromMe) : undefined);
    const direction = typeof fromMe === 'boolean' ? (fromMe ? 'out' : 'in')
      : /^true_/.test(fullId) ? 'out' : /^false_/.test(fullId) ? 'in' : null;
    const remote = serializeWid(id && typeof id === 'object' ? (id.remote || id.__x_remote) : null)
      || (/^(?:true|false)_([^_]+)_/.exec(fullId) || [])[1] || '';
    return { fullId, shortId: normalizeMessageId(fullId), direction, remote };
  }

  function rawAuthorName(raw) {
    const sender = raw && (raw.senderObj || raw.__x_senderObj);
    const value = sender && firstDefined(sender.name, sender.pushname, sender.formattedName);
    return typeof value === 'string' && !/@(?:c\.us|g\.us|lid)$/.test(value) ? normalizeInline(value) : '';
  }

  function snapshotRawMetadata(raw) {
    const identity = rawIdentity(raw);
    return { id: identity.fullId, fromMe: identity.direction === 'out' ? true : identity.direction === 'in' ? false : undefined,
      t: firstDefined(raw && raw.t, raw && raw.__x_t, raw && raw.timestamp),
      type: firstDefined(rawValue(raw, 'type'), ''), caption: rawMediaCaption(raw),
      mimetype: rawValue(raw, 'mimetype'), filename: rawValue(raw, 'filename'),
      senderObj: { name: rawAuthorName(raw) } };
  }

  function loadedMetadataContext(wpp) {
    const result = { chatId: '', isGroup: undefined, peerAuthor: '', rawMessages: [] };
    try {
      const chat = wpp && wpp.chat && typeof wpp.chat.getActiveChat === 'function' ? wpp.chat.getActiveChat() : null;
      if (!chat) return result;
      result.chatId = serializeWid(chat.id || chat.__x_id);
      if (/@g\.us$/.test(result.chatId)) result.isGroup = true;
      else if (/@(?:c\.us|s\.whatsapp\.net|lid)$/.test(result.chatId)) result.isGroup = false;
      else if (typeof chat.isGroup === 'boolean') result.isGroup = chat.isGroup;
      if (result.isGroup === false) {
        const contact = chat.contact || chat.__x_contact || {};
        result.peerAuthor = normalizeInline(chat.formattedTitle || chat.name || contact.name || contact.pushname || '');
        if (!result.peerAuthor && typeof document !== 'undefined') result.peerAuthor = getChatTitle();
        if (result.peerAuthor === 'Chat de WhatsApp') result.peerAuthor = '';
      }
      result.rawMessages = rawMessagesFromActiveChatModel(chat).filter(raw => {
        const remote = rawIdentity(raw).remote;
        return !remote || !result.chatId || remote === result.chatId;
      }).map(snapshotRawMetadata);
    } catch (_error) { /* WA-JS might not yet be ready. Never invent native metadata. */ }
    return result;
  }

  function normalizeRecordAuthors(records, context = {}) {
    const outgoingNames = new Map();
    for (const r of records || []) {
      if (r.direction === 'out' && r.author && !isSelfAlias(r.author)) {
        const weight = r.authorSource === 'dom-metadata' ? 10 : 1;
        outgoingNames.set(r.author, (outgoingNames.get(r.author) || 0) + weight);
      }
    }
    const ownAuthor = context.ownAuthor || [...outgoingNames].sort((a,b) => b[1]-a[1])[0]?.[0] || 'Yo';
    return (records || []).map(r => {
      const direction = isSelfAlias(r.author) ? 'out' : r.direction;
      if (direction === 'out') return { ...r, direction, author: ownAuthor,
        authorSource: r.author === ownAuthor ? r.authorSource : 'self-normalized' };
      if (direction === 'in' && !r.author && context.isGroup === false && context.peerAuthor) {
        return { ...r, author: context.peerAuthor, authorSource: 'private-chat' };
      }
      return { ...r };
    });
  }

  function normalizeYear(year) {
    if (year >= 100) {
      return year;
    }
    return year >= 70 ? 1900 + year : 2000 + year;
  }

  function parseNumericDate(value, dateOrder) {
    const dateText = String(value || '').trim();
    const parts = splitNumericDate(dateText);
    if (!parts) {
      return null;
    }

    let order = dateOrder || 'DMY';
    if (/^\s*\d{4}/.test(dateText)) {
      order = 'YMD';
    }

    let year;
    let month;
    let day;
    if (order === 'YMD') {
      [year, month, day] = parts;
    } else if (order === 'MDY') {
      [month, day, year] = parts;
    } else {
      [day, month, year] = parts;
    }

    year = normalizeYear(year);
    if (
      !Number.isInteger(year)
      || !Number.isInteger(month)
      || !Number.isInteger(day)
      || month < 1
      || month > 12
      || day < 1
      || day > 31
    ) {
      return null;
    }

    const candidate = new Date(year, month - 1, day);
    if (
      candidate.getFullYear() !== year
      || candidate.getMonth() !== month - 1
      || candidate.getDate() !== day
    ) {
      return null;
    }

    return { year, month, day };
  }

  function parseTimeParts(value) {
    const text = String(value || '')
      .trim()
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .replace(/[.]/g, '')
      .replace(/[\u202f\u00a0]/g, ' ')
      .replace(/\b([ap])\s+m\b/gi, '$1m');
    const match = /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?(?:\s|$)/i.exec(text);
    if (!match) {
      return null;
    }

    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    const meridiem = (match[4] || '').toLowerCase();

    if (minute > 59 || second > 59) {
      return null;
    }

    if (meridiem) {
      if (hour < 1 || hour > 12) {
        return null;
      }
      if (meridiem === 'am') {
        hour = hour === 12 ? 0 : hour;
      } else {
        hour = hour === 12 ? 12 : hour + 12;
      }
    } else if (hour > 23) {
      return null;
    }

    return { hour, minute, second };
  }

  function parsePrePlainText(value, options = {}) {
    const text = String(value || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    const match = /^\[([^,\]]+),\s*([^\]]+)\]\s*(.*):\s*$/u.exec(text);
    if (!match) {
      return null;
    }

    const timeParts = parseTimeParts(match[1]);
    const dateParts = parseNumericDate(match[2], options.dateOrder || 'DMY');
    if (!timeParts || !dateParts) {
      return null;
    }

    const date = new Date(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day,
      timeParts.hour,
      timeParts.minute,
      timeParts.second,
      0,
    );
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return {
      author: normalizeInline(match[3]),
      date,
      timestamp: date.getTime(),
      dateKey: localDateKey(date),
      timeText: localTimeText(date, timeParts.second !== 0),
      dateParts,
      timeParts,
      raw: text,
    };
  }

  function parseDateBoundary(dateValue, timeValue, side) {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || '').trim());
    if (!dateMatch) {
      throw new Error('Selecciona una fecha válida');
    }

    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    let hour = 0;
    let minute = 0;
    let second = 0;
    let millisecond = 0;

    if (String(timeValue || '').trim()) {
      const parsedTime = parseTimeParts(String(timeValue).trim());
      if (!parsedTime) {
        throw new Error('Selecciona una hora válida');
      }
      ({ hour, minute, second } = parsedTime);
      if (side === 'end' && !/:\d{2}:\d{2}/.test(String(timeValue))) {
        second = 59;
        millisecond = 999;
      }
    } else if (side === 'end') {
      hour = 23;
      minute = 59;
      second = 59;
      millisecond = 999;
    }

    const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
    ) {
      throw new Error('Selecciona una fecha válida');
    }
    return date;
  }

  function compareRecords(left, right) {
    const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : Number.POSITIVE_INFINITY;
    const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return (left.firstSeen || 0) - (right.firstSeen || 0);
  }

  function insertSorted(array, value, comparator) {
    let low = 0;
    let high = array.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (comparator(array[middle], value) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    array.splice(low, 0, value);
  }

  function orderRecords(records, edges) {
    const list = Array.from(records || []);
    const byId = new Map(list.map((record) => [record.id, record]));
    const indegree = new Map(list.map((record) => [record.id, 0]));
    const usableEdges = new Map();

    for (const [from, destinations] of edges || []) {
      if (!byId.has(from)) {
        continue;
      }
      for (const to of destinations || []) {
        if (!byId.has(to) || from === to) {
          continue;
        }
        if (!usableEdges.has(from)) {
          usableEdges.set(from, new Set());
        }
        if (!usableEdges.get(from).has(to)) {
          usableEdges.get(from).add(to);
          indegree.set(to, (indegree.get(to) || 0) + 1);
        }
      }
    }

    const ready = list.filter((record) => indegree.get(record.id) === 0).sort(compareRecords);
    const ordered = [];
    const emitted = new Set();

    while (ready.length) {
      const record = ready.shift();
      if (emitted.has(record.id)) {
        continue;
      }
      emitted.add(record.id);
      ordered.push(record);
      for (const destination of usableEdges.get(record.id) || []) {
        indegree.set(destination, indegree.get(destination) - 1);
        if (indegree.get(destination) === 0) {
          insertSorted(ready, byId.get(destination), compareRecords);
        }
      }
    }

    if (ordered.length !== list.length) {
      const remaining = list.filter((record) => !emitted.has(record.id)).sort(compareRecords);
      ordered.push(...remaining);
    }

    return ordered;
  }

  function dateAtLocalMidnight(timestamp) {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function timeOnLocalDay(dayTimestamp, timeParts) {
    const day = new Date(dayTimestamp);
    return new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      timeParts.hour,
      timeParts.minute,
      timeParts.second || 0,
      0,
    ).getTime();
  }

  function inferMissingTimestamps(records) {
    // Infer only a UNIQUE day bracketed by real dates. No chained guesses or +/-day heuristics.
    const output = (records || []).map(r => ({ ...r }));
    const anchors = output.map(r => Number.isFinite(r.timestamp) && !r.timestampInferred);
    for (let index = 0; index < output.length; index++) {
      const r = output[index];
      if (Number.isFinite(r.timestamp) || !r.timeParts || r.dateError) continue;
      let before = index-1, after = index+1;
      while (before >= 0 && !anchors[before]) before--;
      while (after < output.length && !anchors[after]) after++;
      if (before < 0 || after >= output.length) continue;
      const a = output[before], b = output[after];
      if (a.dateAmbiguous || b.dateAmbiguous || a.timestamp > b.timestamp || b.timestamp-a.timestamp > 2*DAY_MS) continue;
      const firstDay = new Date(dateAtLocalMidnight(a.timestamp));
      const candidates = [];
      for (let offset = 0; offset <= 2; offset++) {
        const day = new Date(firstDay.getFullYear(),firstDay.getMonth(),firstDay.getDate()+offset).getTime();
        const t = timeOnLocalDay(day,r.timeParts);
        if (Math.floor(t/60000) >= Math.floor(a.timestamp/60000) && Math.floor(t/60000) <= Math.floor(b.timestamp/60000)) candidates.push(t);
      }
      if (candidates.length !== 1) continue;
      const date = new Date(candidates[0]);
      Object.assign(r,{timestamp:date.getTime(),dateKey:localDateKey(date),timeText:localTimeText(date,Boolean(r.timeParts.second)),
        timestampInferred:true,timestampSource:'bounded-clock'});
    }
    return output;
  }

  function endpointIndex(records, endpoint, side) {
    if (!endpoint || endpoint.kind === 'none') {
      return side === 'start' ? 0 : records.length - 1;
    }

    if (endpoint.kind === 'message') {
      const index = records.findIndex((record) => record.id === endpoint.messageId);
      if (index === -1) {
        const error = new Error(`No se encontró el mensaje de ${side === 'start' ? 'inicio' : 'fin'}`);
        error.code = 'MESSAGE_NOT_FOUND';
        throw error;
      }
      return index;
    }

    if (endpoint.kind === 'date') {
      if (!Number.isFinite(endpoint.timestamp)) {
        throw new Error(`La fecha de ${side === 'start' ? 'inicio' : 'fin'} no es válida`);
      }
      if (side === 'start') {
        const index = records.findIndex(
          (record) => Number.isFinite(record.timestamp) && record.timestamp >= endpoint.timestamp,
        );
        return index === -1 ? records.length : index;
      }
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (Number.isFinite(records[index].timestamp) && records[index].timestamp <= endpoint.timestamp) {
          return index;
        }
      }
      return -1;
    }

    throw new Error('Tipo de límite desconocido');
  }

  function selectRange(records, bounds) {
    if (!Array.isArray(records) || records.length === 0) {
      return { records: [], startIndex: -1, endIndex: -1, swapped: false };
    }

    let startIndex = endpointIndex(records, bounds && bounds.start, 'start');
    let endIndex = endpointIndex(records, bounds && bounds.end, 'end');
    let swapped = false;

    if (startIndex > endIndex && startIndex < records.length && endIndex >= 0) {
      [startIndex, endIndex] = [endIndex, startIndex];
      swapped = true;
    }

    if (startIndex < 0 || endIndex < 0 || startIndex >= records.length || endIndex >= records.length) {
      return { records: [], startIndex, endIndex, swapped };
    }

    return {
      records: records.slice(startIndex, endIndex + 1),
      startIndex,
      endIndex,
      swapped,
    };
  }


  /** Exclusions are exact message identities, not text searches or date cutoffs. */
  function exclusionIds(data) {
    return new Set([
      ...Array.from(data && data.excludedIds || []),
      ...Array.from(data && data.excludedMessages || [], (record) => record.messageId || record.id),
    ].map(normalizeMessageId).filter(Boolean));
  }

  function recordText(record) {
    return normalizeLineBreaks(record && (record.text || record.caption) || '');
  }

  function quotedWasExcluded(quoted, data, ids) {
    if (!quoted) return false;
    if (ids.has(normalizeMessageId(quoted.messageId || quoted.id))) return true;
    // DOM quotes often lack an id. Only strip a matching author AND exact text/name.
    const text = recordText(quoted);
    const author = normalizeInline(quoted.author || '');
    if (!author) return false;
    return Array.from(data && data.excludedMessages || []).some((record) => {
      if (normalizeInline(record.author || '') !== author) return false;
      if (text && text === recordText(record)) return true;
      return (quoted.media || []).some((media) => media.filename && (record.media || [])
        .some((item) => item.filename === media.filename));
    });
  }

  function exportRecords(data) {
    const records = Array.from(data && data.records || []);
    const ids = exclusionIds(data);
    if (!ids.size) return records;
    return records.filter((record) => !ids.has(normalizeMessageId(record.id)))
      .map((record) => quotedWasExcluded(record.quoted, data, ids) ? { ...record, quoted: null } : record);
  }

  function candidateIsExcluded(candidate, ids) {
    return [candidate.recordId, candidate.fullId, candidate.shortId]
      .some((id) => id && ids.has(normalizeMessageId(id)));
  }

  /** Filter again at the file-writing boundary, even if a caller retained an old cache. */
  function exportMediaCollection(data, collection) {
    if (!collection) return { files: [], failures: [], warnings: [], foundCount: 0, downloadedCount: 0, totalBytes: 0 };
    const ids = exclusionIds(data);
    if (!ids.size) return collection;
    const included = new Set(exportRecords(data).map((record) => normalizeMessageId(record.id)));
    const keep = (item) => included.has(normalizeMessageId(item.recordId)) && !candidateIsExcluded(item, ids);
    const files = (collection.files || []).filter(keep);
    const failures = (collection.failures || []).filter(keep);
    const pruned = files.length !== (collection.files || []).length || failures.length !== (collection.failures || []).length;
    // Unstructured cached warnings can contain a removed filename. Do not carry them over.
    const warnings = pruned ? [] : Array.from(collection.warnings || []);
    if (pruned && files.some((file) => file.quality && file.quality !== 'original')) {
      warnings.push('Algunos adjuntos incluidos proceden de la versión visible y pueden tener menor calidad');
    }
    return { ...collection, files, failures, warnings, foundCount: files.length + failures.length,
      downloadedCount: files.length, totalBytes: files.reduce((sum, file) => sum + Number(file.size || 0), 0) };
  }

  function rawMediaCaption(raw) {
    return normalizeLineBreaks(rawValue(raw, 'caption') || '');
  }

  function loadedCaptionIndex() {
    const captions = new Map();
    try {
      const wpp = typeof WPP !== 'undefined' ? WPP : null;
      const chat = wpp && wpp.chat && typeof wpp.chat.getActiveChat === 'function' ? wpp.chat.getActiveChat() : null;
      for (const raw of rawMessagesFromActiveChatModel(chat)) {
        const id = normalizeMessageId(raw.id || raw.__x_id || raw.key);
        const caption = rawMediaCaption(raw);
        if (id && caption) captions.set(id, caption);
      }
    } catch (_error) { /* DOM-only mode remains usable if WA-JS is not ready. */ }
    return captions;
  }

  function csvEscape(value) {
    const text = String(value == null ? '' : value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
  }

  function serializeWid(value) {
    if (value == null) {
      return '';
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    if (typeof value !== 'object') {
      return String(value);
    }
    if (typeof value._serialized === 'string') {
      return value._serialized;
    }
    if (typeof value.user === 'string' && typeof value.server === 'string') {
      return `${value.user}@${value.server}`;
    }
    if (typeof value.toString === 'function') {
      const text = String(value.toString());
      if (text && text !== '[object Object]') {
        return text;
      }
    }
    return '';
  }

  function serializeMessageId(value) {
    if (value == null) {
      return '';
    }
    if (typeof value === 'string') {
      return value.trim().replace(/^conv-msg-/, '');
    }
    if (typeof value !== 'object') {
      return String(value);
    }
    if (typeof value._serialized === 'string') {
      return value._serialized;
    }
    if (value.id && typeof value.id === 'object' && typeof value.id._serialized === 'string') {
      return value.id._serialized;
    }
    if (typeof value.id === 'string' && value.remote) {
      const remote = serializeWid(value.remote);
      const fromMe = firstDefined(value.fromMe, value.__x_fromMe);
      if (remote && typeof fromMe === 'boolean') {
        const participant = serializeWid(value.participant || value.__x_participant);
        return `${fromMe ? 'true' : 'false'}_${remote}_${value.id}${participant ? `_${participant}` : ''}`;
      }
    }
    if (typeof value.id === 'string') {
      return value.id;
    }
    if (typeof value.toString === 'function') {
      const text = String(value.toString());
      if (text && text !== '[object Object]') {
        return text;
      }
    }
    return '';
  }

  function normalizeMessageId(value) {
    const serialized = serializeMessageId(value && value.id && !value._serialized ? value.id : value);
    if (!serialized) {
      return '';
    }
    const withoutDomPrefix = serialized.replace(/^conv-msg-/, '');
    if (/^album-/i.test(withoutDomPrefix)) {
      return withoutDomPrefix;
    }
    const fullKey = /^(?:true|false)_([^_]+)_([^_]+)(?:_(.+))?$/.exec(withoutDomPrefix);
    return fullKey ? fullKey[2] : withoutDomPrefix;
  }

  function normalizeTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return numeric < 100000000000 ? Math.round(numeric * 1000) : Math.round(numeric);
  }

  function normalizeMime(value) {
    return String(value || '').split(';')[0].trim().toLowerCase();
  }

  function normalizeMediaType(value, mime = '') {
    const type = String(value || '').toLowerCase();
    const normalizedMime = normalizeMime(mime);
    if (/^(?:image|photo|picture)$/.test(type) || normalizedMime.startsWith('image/')) {
      return type === 'sticker' ? 'sticker' : 'image';
    }
    if (/^(?:sticker)$/.test(type)) {
      return 'sticker';
    }
    if (/^(?:video|gif|gif-video)$/.test(type) || normalizedMime.startsWith('video/')) {
      return 'video';
    }
    if (/^(?:audio|ptt|voice|voice-note)$/.test(type) || normalizedMime.startsWith('audio/')) {
      return 'audio';
    }
    if (/^(?:document|doc|file)$/.test(type)) {
      return 'document';
    }
    if (normalizedMime && normalizedMime !== 'application/octet-stream') {
      return 'document';
    }
    return type || 'file';
  }

  function isDownloadableMediaType(type) {
    return ['image', 'video', 'audio', 'document', 'sticker', 'file'].includes(normalizeMediaType(type));
  }

  function rawValue(raw, key) {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const mediaData = raw.mediaData || raw.__x_mediaData || {};
    const direct = firstDefined(raw[key], raw[`__x_${key}`]);
    if (direct !== undefined) {
      return direct;
    }
    const aliases = {
      filename: ['fileName', 'filename'],
      mimetype: ['mimetype', 'mimeType'],
      size: ['fileSize', 'filesize', 'size'],
      type: ['mediaType', 'type'],
      albumId: ['albumId', 'multicastId'],
    }[key] || [key];
    for (const alias of aliases) {
      const value = firstDefined(mediaData[alias], mediaData[`__x_${alias}`]);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }

  function describeRawMediaMessage(raw) {
    const idValue = firstDefined(raw && raw.id, raw && raw.__x_id, raw && raw.key);
    const fullId = serializeMessageId(idValue);
    const mime = normalizeMime(firstDefined(rawValue(raw, 'mimetype'), raw && raw.mime));
    const type = normalizeMediaType(firstDefined(rawValue(raw, 'type'), raw && raw.mediaType), mime);
    const filename = normalizeInline(firstDefined(rawValue(raw, 'filename'), ''));
    const caption = rawMediaCaption(raw);
    const timestamp = normalizeTimestamp(firstDefined(
      raw && raw.t,
      raw && raw.__x_t,
      raw && raw.timestamp,
      raw && raw.messageTimestamp,
    ));
    const size = Number(firstDefined(rawValue(raw, 'size'), 0)) || 0;
    const albumKey = normalizeInline(firstDefined(rawValue(raw, 'albumId'), ''));
    return {
      raw,
      fullId,
      shortId: normalizeMessageId(fullId || idValue),
      timestamp,
      type,
      mime,
      filename,
      caption,
      size,
      direction: rawIdentity(raw).direction,
      albumKey,
    };
  }

  function mediaTypesCompatible(left, right) {
    const a = normalizeMediaType(left);
    const b = normalizeMediaType(right);
    if (a === b) {
      return true;
    }
    return (a === 'sticker' && b === 'image') || (a === 'image' && b === 'sticker');
  }

  function recordSupportsMediaType(record, type) {
    if (mediaTypesCompatible(record && record.type, type)) {
      return true;
    }
    return (record && record.media || []).some((item) => mediaTypesCompatible(item.type, type));
  }

  function recordHasMultipleMedia(record) {
    return Number(record && record.albumCount) > 1
      || (record && record.media || []).filter(item => isDownloadableMediaType(item.type)).length > 1;
  }

  function ownMediaId(media, record) {
    const explicit = normalizeMessageId(media.domMessageId || media.shortId || '');
    if (explicit && !/^album-/i.test(explicit)) return explicit;
    const full = serializeMessageId(media.fullId || '');
    // Older metadata enrichment stamped the owner's id on every photo. Do not trust it.
    if (full && (!recordHasMultipleMedia(record) || full !== record.fullId)) {
      const id = normalizeMessageId(full);
      if (!/^album-/i.test(id)) return id;
    }
    if (!recordHasMultipleMedia(record)) {
      const id = normalizeMessageId(record && record.id);
      return /^album-/i.test(id) ? '' : id;
    }
    return '';
  }

  function ownMediaFullId(media, record) {
    const id = ownMediaId(media, record);
    if (!id) return '';
    for (const value of [media.fullId, record && record.fullId]) {
      const full = serializeMessageId(value || '');
      if (/^(?:true|false)_/.test(full) && normalizeMessageId(full) === id) return full;
    }
    return '';
  }

  function mediaSlotKey(media, record, index = 0) {
    if (media.mediaKey) return media.mediaKey;
    if (media.albumKey && media.albumIndex) return `${media.albumKey}:${media.albumIndex}`;
    const id = ownMediaId(media, record);
    return id ? `message:${id}:${media.type}` : `${record.id}:${media.type}:slot:${index + 1}`;
  }

  function matchRawMediaMessages(records, rawMessages) {
    const sourceRecords = Array.from(records || []);
    const recordByShortId = new Map();
    const mediaByShortId = new Map();

    for (const record of sourceRecords) {
      const recordShortId = normalizeMessageId(record.id);
      if (recordShortId && !/^album-/i.test(recordShortId)) {
        recordByShortId.set(recordShortId, record);
      }
      for (const media of record.media || []) {
        const shortId = ownMediaId(media, record);
        if (shortId) {
          mediaByShortId.set(shortId, { record, media });
        }
      }
    }

    const matches = [];
    const usedDomMedia = new Set();
    const rawAssociationCounts = new Map();
    const allRawDescriptors = mergeRawMessageLists(rawMessages || [])
      .map(describeRawMediaMessage)
      .filter((item) => isDownloadableMediaType(item.type))
      .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
    const albumRawIds = new Set();
    const albumOwner = new Map();

    for (const record of sourceRecords) {
      const identity = parseAlbumIdentity((record.media || []).find(item => item.albumKey)?.albumKey || record.id || '', '');
      const expectedCount = Math.max(Number(record.albumCount || identity.count || 0), (record.media || []).length);
      if (expectedCount <= 1) {
        continue;
      }
      const explicitIds = (record.media || [])
        .map((media) => ownMediaId(media, record))
        .filter(Boolean);
      const firstId = identity.firstId || explicitIds[0] || '';
      const lastId = identity.lastId || explicitIds[explicitIds.length - 1] || '';
      const firstIndex = firstId ? allRawDescriptors.findIndex((item) => item.shortId === firstId) : -1;
      const lastIndex = lastId ? allRawDescriptors.findIndex((item) => item.shortId === lastId) : -1;
      const compatible = (item) => (
        (!record.direction || !item.direction || record.direction === item.direction)
        && recordSupportsMediaType(record, item.type)
        && (!Number.isFinite(record.timestamp) || !Number.isFinite(item.timestamp) || Math.abs(item.timestamp - record.timestamp) <= 10 * 60 * 1000)
      );
      let albumDescriptors = [];
      if (firstIndex >= 0 && lastIndex >= 0 && firstId !== lastId) {
        const from = Math.min(firstIndex, lastIndex);
        const to = Math.max(firstIndex, lastIndex);
        albumDescriptors = allRawDescriptors.slice(from, to + 1).filter(compatible);
      } else {
        // One known endpoint plus a nearby timestamp is not proof of album membership.
        // Only an explicit shared native album id can establish additional members.
        const anchors = allRawDescriptors.filter(item => explicitIds.includes(item.shortId)
          || item.shortId === identity.firstId || item.shortId === identity.lastId);
        const keys = new Set(anchors.map(item => item.albumKey).filter(Boolean));
        if (keys.size === 1) {
          albumDescriptors = allRawDescriptors.filter(item => keys.has(item.albumKey) && compatible(item));
        }
      }
      albumDescriptors = albumDescriptors.filter(item => {
        const owner = recordByShortId.get(item.shortId);
        const mediaOwner = mediaByShortId.get(item.shortId)?.record;
        return (!owner || owner === record) && (!mediaOwner || mediaOwner === record);
      });
      if (albumDescriptors.length !== expectedCount) {
        // With a partial/interleaved native list, ordinal matching could attach a
        // different photo's thumbnail. Keep only members with a proven DOM id.
        albumDescriptors = albumDescriptors.filter(item => explicitIds.includes(item.shortId));
      }
      for (const descriptor of albumDescriptors) {
        if (descriptor.fullId) {
          albumRawIds.add(descriptor.fullId);
          albumOwner.set(descriptor.fullId, record);
        }
        if (descriptor.shortId) {
          albumRawIds.add(descriptor.shortId);
          albumOwner.set(descriptor.shortId, record);
        }
      }
    }

    const rawDescriptors = allRawDescriptors.filter((item) => {
      if (
        recordByShortId.has(item.shortId)
        || mediaByShortId.has(item.shortId)
        || albumRawIds.has(item.fullId)
        || albumRawIds.has(item.shortId)
      ) {
        return true;
      }
      return false; // A timestamp alone never proves membership in the selected range.
    });

    for (const rawDescriptor of rawDescriptors) {
      const exactMedia = mediaByShortId.get(rawDescriptor.shortId);
      const record = exactMedia?.record
        || albumOwner.get(rawDescriptor.fullId)
        || albumOwner.get(rawDescriptor.shortId)
        || recordByShortId.get(rawDescriptor.shortId);
      if (!record) {
        continue;
      }
      let domMedia = exactMedia?.media || null;
      if (!domMedia) {
        domMedia = (record.media || []).find((item) => (
          !usedDomMedia.has(item)
          && !ownMediaId(item, record)
          && mediaTypesCompatible(item.type, rawDescriptor.type)
        )) || null;
      }
      if (domMedia) {
        usedDomMedia.add(domMedia);
      }
      const candidate = {
        ...rawDescriptor,
        record,
        albumMember: albumOwner.has(rawDescriptor.fullId) || albumOwner.has(rawDescriptor.shortId),
        recordId: record.id,
        author: record.author || '',
        candidateUrls: Array.from(domMedia?.candidateUrls || []),
        filename: rawDescriptor.filename || domMedia?.filename || '',
        mime: rawDescriptor.mime || domMedia?.mime || '',
        type: normalizeMediaType(rawDescriptor.type || domMedia?.type),
        domMedia,
        mediaKey: domMedia ? mediaSlotKey(domMedia, record, record.media.indexOf(domMedia)) : `message:${rawDescriptor.shortId}`,
        albumIndex: domMedia && domMedia.albumIndex || null,
      };
      matches.push(candidate);
      rawAssociationCounts.set(record.id, (rawAssociationCounts.get(record.id) || 0) + 1);
    }

    for (const record of sourceRecords) {
      const rawCount = rawAssociationCounts.get(record.id) || 0;
      const expectedAlbumCount = Number(record.albumCount || (record.media || []).find((item) => item.albumCount)?.albumCount || 0);
      if (expectedAlbumCount && rawCount >= expectedAlbumCount) {
        continue;
      }
      for (const media of record.media || []) {
        if (usedDomMedia.has(media) || !isDownloadableMediaType(media.type)) {
          continue;
        }
        const shortId = ownMediaId(media, record);
        matches.push({
          record,
          recordId: record.id,
          author: record.author || '',
          fullId: ownMediaFullId(media, record),
          shortId,
          timestamp: record.timestamp,
          direction: record.direction,
          type: normalizeMediaType(media.type),
          mime: normalizeMime(media.mime),
          filename: media.filename || '',
          size: Number(media.size || 0),
          albumKey: media.albumKey || '',
          albumIndex: media.albumIndex || null,
          mediaKey: mediaSlotKey(media, record, record.media.indexOf(media)),
          candidateUrls: Array.from(media.candidateUrls || []),
          domMedia: media,
        });
      }
    }

    const seen = new Set();
    return matches.filter((item, index) => {
      const url = item.candidateUrls && item.candidateUrls[0] && item.candidateUrls[0].url;
      const fingerprint = item.fullId || (item.shortId ? `message:${item.shortId}` : '')
        || item.mediaKey || (url ? `${item.recordId}:url:${url}` : '') || `${item.recordId}:${item.type}:${item.filename}:${index}`;
      if (seen.has(fingerprint)) {
        return false;
      }
      seen.add(fingerprint);
      return true;
    });
  }

  const MIME_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/webm': 'webm',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
  };

  function extensionFromFilename(filename) {
    const match = /\.([a-z0-9]{1,12})$/i.exec(String(filename || '').trim());
    return match ? match[1].toLowerCase() : '';
  }

  function inferMediaExtension(item) {
    const fromName = extensionFromFilename(item && item.filename);
    if (fromName) {
      return fromName;
    }
    const mime = normalizeMime(item && item.mime);
    if (MIME_EXTENSIONS[mime]) {
      return MIME_EXTENSIONS[mime];
    }
    return {
      image: 'jpg',
      sticker: 'webp',
      video: 'mp4',
      audio: 'ogg',
      document: 'bin',
      file: 'bin',
    }[normalizeMediaType(item && item.type)] || 'bin';
  }

  function mediaCategory(type) {
    return {
      image: 'fotos',
      sticker: 'stickers',
      video: 'videos',
      audio: 'audios',
      document: 'documentos',
      file: 'archivos',
    }[normalizeMediaType(type)] || 'archivos';
  }

  function sanitizeMediaPart(value, fallback = 'archivo') {
    const basename = String(value || '').split(/[\\/]/).pop() || '';
    const sanitized = basename
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/^\.+/, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '')
      .slice(0, 110);
    return sanitized || fallback;
  }

  function buildMediaPath(record, descriptor, index, usedPaths = new Set()) {
    const type = normalizeMediaType(descriptor && descriptor.type);
    const category = mediaCategory(type);
    const date = Number.isFinite(record && record.timestamp) ? new Date(record.timestamp) : null;
    const stamp = date
      ? `${localDateKey(date)}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
      : 'fecha-desconocida';
    const author = sanitizeMediaPart(String(record && record.author || '').replace(/[\\/]/g, '_'), record && record.direction === 'out' ? 'Yo' : 'Desconocido')
      .replace(/\.[^.]+$/, '')
      .slice(0, 45);
    const extension = inferMediaExtension(descriptor);
    const original = sanitizeMediaPart(descriptor && descriptor.filename, `${type}_${pad(index, 3)}.${extension}`);
    const originalExtension = extensionFromFilename(original);
    const base = sanitizeMediaPart(originalExtension ? original.slice(0, -(originalExtension.length + 1)) : original, `${type}_${pad(index, 3)}`)
      .replace(/\.+/g, '_');
    let suffix = 1;
    let filename = `${stamp}_${author}_${base}.${originalExtension || extension}`;
    let path = `${category}/${filename}`;
    while (usedPaths.has(path.toLowerCase())) {
      suffix += 1;
      filename = `${stamp}_${author}_${base}_${suffix}.${originalExtension || extension}`;
      path = `${category}/${filename}`;
    }
    usedPaths.add(path.toLowerCase());
    return path;
  }

  function ensureNotAborted(signal) {
    if (signal && signal.aborted) {
      throw createAbortError();
    }
  }

  function waitForOperation(operation, options = {}) {
    const signal = options.signal;
    const timeoutMilliseconds = Math.max(0, Number(options.timeoutMilliseconds) || 0);
    ensureNotAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        callback(value);
      };
      const onAbort = () => finish(reject, createAbortError());
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (timeoutMilliseconds > 0) {
        timer = setTimeout(() => {
          finish(reject, new Error(options.timeoutMessage || 'La operación agotó el tiempo de espera'));
        }, timeoutMilliseconds);
      }
      Promise.resolve(operation).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  function isBlobLike(value) {
    return Boolean(value && typeof value === 'object' && Number.isFinite(Number(value.size)) && typeof value.arrayBuffer === 'function');
  }

  function errorMessage(error) {
    if (!error) {
      return 'Error desconocido';
    }
    return normalizeInline(error.message || String(error)) || 'Error desconocido';
  }

  function expectedMimeForExtension(extension) {
    const normalized = String(extension || '').toLowerCase();
    return Object.entries(MIME_EXTENSIONS).find(([, value]) => value === normalized)?.[0] || '';
  }

  function mediaBlobCompatibility(blob, candidate, source = {}) {
    if (!isBlobLike(blob) || Number(blob.size) <= 0) {
      return { ok: false, reason: 'El archivo recibido está vacío' };
    }
    const actualMime = normalizeMime(blob.type);
    const expectedType = normalizeMediaType(candidate && candidate.type, candidate && candidate.mime);
    const expectedExtension = extensionFromFilename(candidate && candidate.filename);
    const expectedMime = normalizeMime(candidate && candidate.mime) || expectedMimeForExtension(expectedExtension);
    const quality = source.quality || 'original';

    if (expectedType === 'document' && quality === 'preview') {
      if (!actualMime || (expectedMime && actualMime !== expectedMime)) {
        return { ok: false, reason: 'La URL disponible es una previsualización, no el documento original' };
      }
    }
    if (expectedExtension === 'pdf' && actualMime && actualMime !== 'application/pdf') {
      return { ok: false, reason: `Se esperaba un PDF y se recibió ${actualMime}` };
    }
    if (expectedType === 'image' && actualMime && !actualMime.startsWith('image/')) {
      return { ok: false, reason: `El archivo recibido no es una imagen (${actualMime})` };
    }
    if (expectedType === 'sticker' && actualMime && !actualMime.startsWith('image/')) {
      return { ok: false, reason: `El archivo recibido no es un sticker compatible (${actualMime})` };
    }
    if (expectedType === 'video' && actualMime && !actualMime.startsWith('video/')) {
      return { ok: false, reason: `El archivo recibido no es un vídeo (${actualMime})` };
    }
    if (expectedType === 'audio' && actualMime && !actualMime.startsWith('audio/') && actualMime !== 'application/ogg') {
      return { ok: false, reason: `El archivo recibido no es audio (${actualMime})` };
    }
    return { ok: true, mime: actualMime || expectedMime || normalizeMime(candidate && candidate.mime) };
  }

  function normalizeCandidateUrl(value) {
    if (!value) {
      return null;
    }
    if (typeof value === 'string') {
      return { url: value, source: 'dom', quality: 'display' };
    }
    if (typeof value === 'object' && value.url) {
      return {
        url: String(value.url),
        source: value.source || 'dom',
        quality: value.quality || 'display',
      };
    }
    return null;
  }

  async function fetchMediaBlob(candidate, options = {}) {
    ensureNotAborted(options.signal);
    const wpp = options.wpp !== undefined
      ? options.wpp
      : (typeof WPP !== 'undefined' ? WPP : null);
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const failures = [];

    if (candidate && candidate.fullId && wpp && wpp.chat && typeof wpp.chat.downloadMedia === 'function') {
      try {
        const blob = await waitForOperation(wpp.chat.downloadMedia(candidate.fullId), {
          signal: options.signal,
          timeoutMilliseconds: Number(options.mediaTimeout) || 120000,
          timeoutMessage: 'WA-JS agotó el tiempo de espera al descargar el archivo',
        });
        ensureNotAborted(options.signal);
        const compatible = mediaBlobCompatibility(blob, candidate, { quality: 'original' });
        if (!compatible.ok) {
          throw new Error(compatible.reason);
        }
        return {
          blob,
          mime: compatible.mime,
          filename: candidate.filename || '',
          source: 'wa-js',
          quality: 'original',
        };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw error;
        }
        failures.push(`WA-JS: ${errorMessage(error)}`);
      }
    }

    for (const rawUrl of candidate && candidate.candidateUrls || []) {
      const source = normalizeCandidateUrl(rawUrl);
      if (!source || !source.url) {
        continue;
      }
      if (!fetchImpl) {
        failures.push(`${source.source}: fetch no está disponible`);
        continue;
      }
      try {
        ensureNotAborted(options.signal);
        const response = await fetchImpl(source.url, { signal: options.signal });
        if (!response || response.ok === false) {
          throw new Error(`HTTP ${response && response.status ? response.status : 'desconocido'}`);
        }
        const blob = await response.blob();
        ensureNotAborted(options.signal);
        const compatible = mediaBlobCompatibility(blob, candidate, source);
        if (!compatible.ok) {
          throw new Error(compatible.reason);
        }
        return {
          blob,
          mime: compatible.mime,
          filename: candidate.filename || '',
          source: source.source,
          quality: source.quality,
        };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw error;
        }
        failures.push(`${source.source}: ${errorMessage(error)}`);
      }
    }

    const detail = failures.length ? failures.join(' | ') : 'No hay una fuente original o visible disponible';
    throw new Error(`No se pudo obtener un archivo compatible: ${detail}`);
  }

  async function waitForWppReady(wpp, signal, timeoutMilliseconds = 15000) {
    if (!wpp) {
      return null;
    }
    ensureNotAborted(signal);
    if (wpp.isReady || (wpp.chat && typeof wpp.chat.getMessages === 'function' && !wpp.loader)) {
      return wpp;
    }
    if (wpp.loader && typeof wpp.loader.onReady === 'function') {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error('WA-JS no terminó de cargar a tiempo'));
          }
        }, timeoutMilliseconds);
        const onAbort = () => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(createAbortError());
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          wpp.loader.onReady(() => {
            if (!settled) {
              settled = true;
              cleanup();
              resolve();
            }
          });
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
    }
    return wpp;
  }

  function rawMessagesFromActiveChatModel(chat) {
    const candidates = [
      chat && chat.msgs && chat.msgs.models,
      chat && chat.msgs && chat.msgs._models,
      chat && chat.__x_msgs && chat.__x_msgs.models,
      chat && chat.__x_msgs && chat.__x_msgs._models,
    ];
    const models = candidates.find(Array.isArray);
    return models ? Array.from(models) : [];
  }

  function mergeRawMessageLists(...lists) {
    const byId = new Map();
    const withoutId = [];
    for (const list of lists) {
      for (const raw of Array.from(list || [])) {
        const idValue = firstDefined(raw && raw.id, raw && raw.__x_id, raw && raw.key);
        const fullId = serializeMessageId(idValue);
        if (fullId) {
          byId.set(fullId, raw);
        } else if (!withoutId.includes(raw)) {
          withoutId.push(raw);
        }
      }
    }
    return [...byId.values(), ...withoutId];
  }

  function expectedMediaCount(records) {
    return Array.from(records || []).reduce((total, record) => {
      const descriptorCount = (record && record.media || []).filter((item) => isDownloadableMediaType(item.type)).length;
      const albumCount = Number(record && record.albumCount || 0);
      return total + Math.max(descriptorCount, albumCount);
    }, 0);
  }

  function loadedMediaCoversRange(records, rawMessages) {
    const expected = expectedMediaCount(records);
    if (!expected) {
      return true;
    }
    const originalIds = new Set(
      matchRawMediaMessages(records, rawMessages)
        .map((item) => item.fullId)
        .filter(Boolean),
    );
    return originalIds.size >= expected;
  }

  async function loadRawMediaMessages(wpp, options = {}) {
    const readyWpp = await waitForWppReady(wpp, options.signal, options.wppTimeout || 15000);
    if (!readyWpp || !readyWpp.chat) {
      return [];
    }
    ensureNotAborted(options.signal);
    const activeChat = typeof readyWpp.chat.getActiveChat === 'function'
      ? readyWpp.chat.getActiveChat()
      : null;
    if (!activeChat) {
      throw new Error('WA-JS no detectó el chat activo');
    }
    const chatId = serializeWid(activeChat.id || activeChat.__x_id);
    const loaded = rawMessagesFromActiveChatModel(activeChat);
    if (Array.isArray(options.records) && loadedMediaCoversRange(options.records, loaded)) {
      return loaded;
    }
    if (chatId && typeof readyWpp.chat.getMessages === 'function') {
      try {
        const messages = await readyWpp.chat.getMessages(chatId, { count: -1, media: 'all' });
        ensureNotAborted(options.signal);
        if (Array.isArray(messages)) {
          return mergeRawMessageLists(loaded, messages);
        }
      } catch (error) {
        if (loaded.length) {
          return loaded;
        }
        throw error;
      }
    }
    return loaded;
  }

  async function collectMediaFiles(data, options = {}) {
    ensureNotAborted(options.signal);
    if (!expectedMediaCount(exportRecords(data))) {
      return { files: [], failures: [], warnings: [], foundCount: 0, downloadedCount: 0, totalBytes: 0, rawMessageCount: 0 };
    }
    const wpp = options.wpp !== undefined
      ? options.wpp
      : (typeof WPP !== 'undefined' ? WPP : null);
    let rawMessages = Array.isArray(options.rawMessages) ? options.rawMessages : null;
    const warnings = [];
    if (!wpp || !wpp.chat || typeof wpp.chat.downloadMedia !== 'function') {
      warnings.push('WA-JS no está disponible para solicitar los originales; se usarán únicamente las fuentes visibles que sigan activas');
    }
    if (typeof options.onProgress === 'function') {
      options.onProgress({ phase: 'Buscando adjuntos', completed: 0, total: 0, downloaded: 0, failed: 0 });
    }
    if (!rawMessages) {
      try {
        rawMessages = await waitForOperation(loadRawMediaMessages(wpp, {
          ...options,
          records: options.loadingRecords || data && data.records || [],
        }), { signal: options.signal, timeoutMilliseconds: 120000,
          timeoutMessage: 'La consulta de medios agotó el tiempo de espera' });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw error;
        }
        rawMessages = [];
        warnings.push(`No se pudo consultar la lista interna de medios: ${errorMessage(error)}`);
      }
    }

    // Associate using the UNFILTERED range so removed media cannot migrate to a neighbor.
    const excluded = exclusionIds(data);
    const candidates = matchRawMediaMessages(data && data.records || [], rawMessages)
      .filter((candidate) => !candidateIsExcluded(candidate, excluded)
        && (!options.candidateFilter || options.candidateFilter(candidate)));
    for (const candidate of candidates) {
      if (candidate.caption && !recordText(candidate.record)
        && normalizeMessageId(candidate.recordId) === candidate.shortId) {
        candidate.record.caption = candidate.caption;
      }
    }
    let activeChatId = '';
    if (wpp && wpp.chat && typeof wpp.chat.getActiveChat === 'function') {
      try {
        const activeChat = wpp.chat.getActiveChat();
        activeChatId = serializeWid(activeChat && (activeChat.id || activeChat.__x_id));
      } catch (_error) {
        activeChatId = '';
      }
    }
    if (activeChatId) {
      for (const candidate of candidates) {
        if (!candidate.fullId && candidate.shortId && !/^album-/i.test(candidate.shortId)
          && ['in','out'].includes(candidate.direction) && !/@g\.us$/.test(activeChatId)) {
          const fromMe = candidate.direction === 'out' ? 'true' : 'false';
          candidate.fullId = `${fromMe}_${activeChatId}_${candidate.shortId}`;
        }
      }
    }
    const files = new Array(candidates.length);
    const failures = new Array(candidates.length);
    const usedPaths = new Set();
    const concurrency = clamp(Number(options.concurrency) || 3, 1, 6);
    let cursor = 0;
    let completed = 0;

    async function worker() {
      while (true) {
        ensureNotAborted(options.signal);
        const index = cursor;
        cursor += 1;
        if (index >= candidates.length) {
          return;
        }
        const candidate = candidates[index];
        try {
          const result = await fetchMediaBlob(candidate, {
            ...options,
            wpp,
          });
          const descriptor = {
            ...candidate,
            filename: result.filename || candidate.filename,
            mime: result.mime || candidate.mime,
          };
          const path = buildMediaPath(candidate.record, descriptor, index + 1, usedPaths);
          const file = {
            recordId: candidate.recordId,
            messageTimestamp: candidate.record && candidate.record.timestamp,
            author: candidate.record && candidate.record.author || '',
            path,
            filename: descriptor.filename || path.split('/').pop(),
            type: normalizeMediaType(descriptor.type),
            mime: normalizeMime(descriptor.mime || result.blob.type),
            size: Number(result.blob.size) || 0,
            source: result.source,
            quality: result.quality,
            fullId: candidate.fullId || '',
            shortId: candidate.shortId || '',
            mediaKey: candidate.mediaKey || '', albumIndex: candidate.albumIndex || null,
            blob: result.blob,
          };
          files[index] = options.transformFile ? await options.transformFile(file) : file;
        } catch (error) {
          if (error && error.name === 'AbortError') {
            throw error;
          }
          failures[index] = {
            recordId: candidate.recordId,
            messageTimestamp: candidate.record && candidate.record.timestamp,
            author: candidate.record && candidate.record.author || '',
            filename: candidate.filename || '',
            type: normalizeMediaType(candidate.type),
            fullId: candidate.fullId || '',
            shortId: candidate.shortId || '',
            mediaKey: candidate.mediaKey || '', albumIndex: candidate.albumIndex || null,
            error: errorMessage(error),
          };
        } finally {
          completed += 1;
          if (typeof options.onProgress === 'function') {
            options.onProgress({
              phase: 'Descargando adjuntos',
              completed,
              total: candidates.length,
              downloaded: files.filter(Boolean).length,
              failed: failures.filter(Boolean).length,
              current: candidate.filename || candidate.shortId || candidate.type,
            });
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(candidates.length, 1)) }, () => worker()));
    ensureNotAborted(options.signal);
    const successfulFiles = files.filter(Boolean);
    const failedFiles = failures.filter(Boolean);
    const visibleFallbackCount = successfulFiles.filter((item) => item.quality && item.quality !== 'original').length;
    if (visibleFallbackCount) {
      warnings.push(`${visibleFallbackCount} adjunto${visibleFallbackCount === 1 ? '' : 's'} se guardó desde la versión visible de WhatsApp y puede tener menor calidad que el original`);
    }
    return {
      files: successfulFiles,
      failures: failedFiles,
      warnings,
      foundCount: candidates.length,
      downloadedCount: successfulFiles.length,
      totalBytes: successfulFiles.reduce((sum, item) => sum + item.size, 0),
      rawMessageCount: rawMessages.length,
    };
  }

  function mediaPlaceholder(media) {
    const item = media || {};
    if (item.filename) {
      return `[${item.label || 'Archivo'}: ${item.filename}]`;
    }
    return `[${item.label || item.type || 'Contenido multimedia'}]`;
  }

  function recordContent(record) {
    const parts = [];
    if (recordText(record)) {
      parts.push(recordText(record));
    }
    for (const media of record.media || []) {
      const placeholder = mediaPlaceholder(media);
      if (!parts.some((part) => part.includes(placeholder))) {
        parts.push(placeholder);
      }
    }
    if (!parts.length) {
      parts.push(`[${record.type || 'Mensaje'}]`);
    }
    return parts.join('\n');
  }

  function formatText(data) {
    const lines = [];

    for (const record of exportRecords(data)) {
      const author = record.author || (record.direction === 'out' ? 'Yo' : 'Desconocido');
      const content = recordContent(record).replace(/\n/g, '\n    ');
      lines.push(`[${formatLocalDateTime(record.timestamp)}] ${author}: ${content}`);
      if (record.quoted) {
        const quotedAuthor = record.quoted.author ? `${record.quoted.author}: ` : '';
        lines.push(`    ↪ ${quotedAuthor}${record.quoted.text || recordContent(record.quoted)}`);
      }
      if (record.reactions && record.reactions.length) {
        lines.push(`    Reacciones: ${record.reactions.join(' ')}`);
      }
    }

    return lines.join('\n');
  }

  function formatCsv(data) {
    const headers = ['id', 'fecha', 'hora', 'autor', 'dirección', 'tipo', 'mensaje', 'cita', 'reacciones'];
    const rows = [headers.join(',')];

    for (const record of exportRecords(data)) {
      const date = Number.isFinite(record.timestamp) ? new Date(record.timestamp) : null;
      const quoted = record.quoted
        ? `${record.quoted.author ? `${record.quoted.author}: ` : ''}${record.quoted.text || recordContent(record.quoted)}`
        : '';
      rows.push([
        record.id,
        date ? localDateKey(date) : '',
        date ? localTimeText(date, true) : (record.timeText || ''),
        record.author || '',
        record.direction || '',
        record.type || '',
        recordContent(record),
        quoted,
        (record.reactions || []).join(' '),
      ].map(csvEscape).join(','));
    }

    return `\uFEFF${rows.join('\r\n')}`;
  }

  function publicRecord(record) {
    const date = Number.isFinite(record.timestamp) ? new Date(record.timestamp) : null;
    return {
      id: record.id,
      timestamp: date ? date.toISOString() : null,
      localDate: date ? localDateKey(date) : (record.dateKey || null),
      localTime: date ? localTimeText(date, true) : (record.timeText || null),
      timestampInferred: Boolean(record.timestampInferred),
      timestampSource: record.timestampSource || null,
      dateOrder: record.dateOrder || null,
      dateAmbiguous: Boolean(record.dateAmbiguous),
      rawMetadata: record.rawMetadata || null,
      directionSource: record.directionSource || null,
      authorSource: record.authorSource || null,
      author: record.author || null,
      direction: record.direction || null,
      type: record.type || null,
      text: recordText(record),
      media: (record.media || []).map((item) => ({
        type: item.type || null,
        label: item.label || null,
        filename: item.filename || null,
        mime: item.mime || null,
        size: Number(item.size || 0) || null,
        albumIndex: Number(item.albumIndex || 0) || null,
        albumCount: Number(item.albumCount || 0) || null,
      })),
      quoted: record.quoted ? {
        author: record.quoted.author || null,
        text: record.quoted.text || '',
        type: record.quoted.type || null,
        media: (record.quoted.media || []).map((item) => ({
          type: item.type || null,
          label: item.label || null,
          filename: item.filename || null,
        })),
      } : null,
      reactions: Array.from(record.reactions || []),
    };
  }

  function formatJson(data) {
    const exportedAt = data.exportedAt instanceof Date ? data.exportedAt : new Date(data.exportedAt || Date.now());
    return JSON.stringify({
      exporter: 'WhatsApp Web Range Exporter',
      version: VERSION,
      chat: data.chatTitle || 'Chat de WhatsApp',
      exportedAt: exportedAt.toISOString(),
      messageCount: exportRecords(data).length,
      bounds: data.bounds || null,
      dateResolution: data.dateResolution || null,
      metadataWarnings: data.metadataWarnings || [],
      partial: data.partial ?? null,
      scanWarnings: data.scanWarnings || [],
      stopReason: data.stopReason || null,
      messages: exportRecords(data).map(publicRecord),
    }, null, 2);
  }

  function formatHtml(data) {
    const exportedAt = data.exportedAt instanceof Date ? data.exportedAt : new Date(data.exportedAt || Date.now());
    const messageHtml = exportRecords(data).map((record) => {
      const directionClass = record.direction === 'out' ? 'out' : 'in';
      const quote = record.quoted
        ? `<blockquote><strong>${escapeHtml(record.quoted.author || '')}</strong>${record.quoted.author ? ': ' : ''}${escapeHtml(record.quoted.text || recordContent(record.quoted)).replace(/\n/g, '<br>')}</blockquote>`
        : '';
      const reactions = record.reactions && record.reactions.length
        ? `<div class="reactions">${escapeHtml(record.reactions.join(' '))}</div>`
        : '';
      return `<article class="message ${directionClass}">
        <header><strong>${escapeHtml(record.author || (record.direction === 'out' ? 'Yo' : 'Desconocido'))}</strong><time>${escapeHtml(formatLocalDateTime(record.timestamp))}</time></header>
        ${quote}
        <div class="content">${escapeHtml(recordContent(record)).replace(/\n/g, '<br>')}</div>
        ${reactions}
      </article>`;
    }).join('\n');

    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.chatTitle || 'Chat de WhatsApp')}</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111b21;background:#efeae2}*{box-sizing:border-box}body{margin:0;padding:24px}.wrap{max-width:920px;margin:auto}.summary{background:#fff;border-radius:14px;padding:18px 22px;margin-bottom:20px;box-shadow:0 2px 10px #0002}.message{width:min(78%,700px);background:#fff;border-radius:12px;padding:10px 12px;margin:8px 0;box-shadow:0 1px 2px #0002}.message.out{margin-left:auto;background:#d9fdd3}.message header{display:flex;gap:18px;justify-content:space-between;align-items:baseline;margin-bottom:6px}.message time{font-size:12px;color:#667781;white-space:nowrap}.content{white-space:normal;overflow-wrap:anywhere}blockquote{margin:4px 0 8px;padding:7px 9px;border-left:4px solid #00a884;background:#ffffffaa;border-radius:4px;color:#3b4a54}.reactions{display:inline-block;background:#fff;border-radius:999px;padding:2px 7px;margin-top:7px;box-shadow:0 1px 3px #0003}@media(max-width:650px){body{padding:10px}.message{width:92%}}
</style>
</head>
<body><main class="wrap"><section class="summary"><h1>${escapeHtml(data.chatTitle || 'Chat de WhatsApp')}</h1><p>${exportRecords(data).length} mensajes. Exportado el ${escapeHtml(formatLocalDateTime(exportedAt.getTime(), true))}.</p></section>${messageHtml}</main></body>
</html>`;
  }

  function formatExport(data, format) {
    switch (String(format || 'txt').toLowerCase()) {
      case 'csv':
        return formatCsv(data);
      case 'json':
        return formatJson(data);
      case 'html':
        return formatHtml(data);
      case 'txt':
      default:
        return formatText(data);
    }
  }

  function textFromNode(node) {
    if (!node) {
      return '';
    }
    if (node.nodeType === 3) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== 1) {
      return '';
    }

    const element = node;
    const tagName = element.tagName ? element.tagName.toLowerCase() : '';
    if (tagName === 'br') {
      return '\n';
    }
    if (tagName === 'img') {
      return element.getAttribute('data-plain-text') || element.getAttribute('alt') || '';
    }
    if (tagName === 'svg' || tagName === 'style' || tagName === 'script') {
      return '';
    }

    let output = '';
    for (const child of element.childNodes || []) {
      output += textFromNode(child);
    }
    return output;
  }

  function topLevelSelectableElements(scope, excludedScope) {
    if (!scope || !scope.querySelectorAll) {
      return [];
    }
    const elements = Array.from(scope.querySelectorAll(TEXT_SELECTOR));
    if (scope.matches && scope.matches(TEXT_SELECTOR)) elements.unshift(scope);
    return elements.filter((element) => {
      if (excludedScope && excludedScope.contains(element)) {
        return false;
      }
      if (element.closest('[data-testid="msg-meta"], [data-testid="reaction-bubble"], [data-testid="forwarded-header"], [aria-hidden="true"], [hidden]')) {
        return false;
      }
      const parentSelectable = element.parentElement && element.parentElement.closest(TEXT_SELECTOR);
      return !parentSelectable || !scope.contains(parentSelectable);
    });
  }

  function extractSelectableText(scope, excludedScope) {
    const pieces = [];
    const seen = new Set();
    for (const element of topLevelSelectableElements(scope, excludedScope)) {
      const value = normalizeLineBreaks(textFromNode(element));
      if (value && !seen.has(value)) {
        seen.add(value);
        pieces.push(value);
      }
    }
    return pieces.join('\n');
  }

  function isInsideExcluded(element, excludedScope) {
    return Boolean(excludedScope && excludedScope.contains(element));
  }

  function parseAlbumIdentity(dataId, ariaLabel = '') {
    const key = String(dataId || '').trim();
    const match = /^album-([^-]+)-([^-]+)-(\d+)$/i.exec(key);
    const labelCountMatch = /\b(\d+)\s+(?:fotos?|photos?|vídeos?|videos?|archivos?)/iu.exec(String(ariaLabel || ''));
    return {
      key,
      firstId: match ? match[1] : '',
      lastId: match ? match[2] : '',
      count: match ? Number(match[3]) : (labelCountMatch ? Number(labelCountMatch[1]) : 0),
    };
  }

  function extractStyleUrls(styleText) {
    const output = [];
    const seen = new Set();
    const expression = /url\(\s*(["']?)(.*?)\1\s*\)/giu;
    let match;
    while ((match = expression.exec(String(styleText || '')))) {
      const url = String(match[2] || '').trim();
      if (url && !seen.has(url)) {
        seen.add(url);
        output.push(url);
      }
    }
    return output;
  }

  function closestDomMessageId(element) {
    if (!element || typeof element.closest !== 'function') {
      return '';
    }
    const root = element.closest('[data-testid^="conv-msg-"], [data-testid="image-album"]');
    if (!root) {
      return '';
    }
    return normalizeMessageId(root.getAttribute('data-id') || root.getAttribute('data-testid'));
  }

  function mediaUrlCandidates(element, type) {
    if (!element || !element.querySelectorAll) {
      return [];
    }
    const normalizedType = normalizeMediaType(type);
    const output = [];
    const seen = new Set();
    const add = (url, source, quality) => {
      const normalizedUrl = String(url || '').trim();
      if (!normalizedUrl || seen.has(normalizedUrl) || /^javascript:/i.test(normalizedUrl)) {
        return;
      }
      if (!/^(?:blob:|data:|https?:)/i.test(normalizedUrl)) {
        return;
      }
      seen.add(normalizedUrl);
      output.push({ url: normalizedUrl, source, quality });
    };

    const selector = normalizedType === 'audio'
      ? 'audio[src], audio source[src], source[type^="audio/"][src]'
      : normalizedType === 'video'
        ? 'video[src], video source[src], source[type^="video/"][src]'
        : normalizedType === 'document'
          ? 'a[href], object[data], embed[src], [data-download-url]'
          : 'img[src], picture source[src]';
    const nodes = [];
    if (element.matches && element.matches(selector)) {
      nodes.push(element);
    }
    nodes.push(...element.querySelectorAll(selector));
    for (const node of nodes) {
      const url = node.getAttribute('src')
        || node.getAttribute('href')
        || node.getAttribute('data')
        || node.getAttribute('data-download-url');
      const quality = /^data:/i.test(url || '') ? 'preview' : (/^blob:/i.test(url || '') ? 'display' : 'remote');
      add(url, `dom-${normalizedType}`, quality);
    }

    const styled = [];
    if (element.matches && element.matches('[style]')) {
      styled.push(element);
    }
    styled.push(...element.querySelectorAll('[style]'));
    for (const node of styled) {
      for (const url of extractStyleUrls(node.getAttribute('style') || '')) {
        const quality = normalizedType === 'document' || /^data:/i.test(url) ? 'preview' : 'display';
        add(url, normalizedType === 'document' ? 'document-preview' : `dom-${normalizedType}`, quality);
      }
    }

    return output.sort((left, right) => {
      const rank = { original: 0, remote: 1, display: 2, preview: 3 };
      return (rank[left.quality] ?? 9) - (rank[right.quality] ?? 9);
    });
  }

  function thumbnailMessageId(element, boundary) {
    for (let node = element; node && node !== boundary; node = node.parentElement) {
      const value = node.getAttribute('data-message-id') || node.getAttribute('data-id')
        || (/^conv-msg-/.test(node.getAttribute('data-testid') || '') ? node.getAttribute('data-testid') : '');
      const id = normalizeMessageId(value);
      if (id && !/^album-/i.test(id)) return id;
    }
    return '';
  }

  function extractAlbumMedia(albumRoot) {
    const identity = parseAlbumIdentity(
      albumRoot.getAttribute('data-id') || '',
      albumRoot.getAttribute('aria-label') || '',
    );
    const thumbs = Array.from(albumRoot.querySelectorAll('[data-testid="image-thumb"], [data-testid*="video-thumb"]'));
    const label = normalizeInline(albumRoot.getAttribute('aria-label') || '');
    const defaultType = /vídeos?|videos?/iu.test(label) ? 'video' : 'image';
    const count = Math.max(identity.count, thumbs.length, 1);
    const descriptors = Array.from({ length: count }, (_, index) => {
      const thumb = thumbs[index] || null;
      const type = thumb && /video/i.test(thumb.getAttribute('data-testid') || '') ? 'video' : defaultType;
      return {
        type,
        label: type === 'video' ? 'Vídeo' : 'Imagen',
        albumKey: identity.key,
        albumIndex: index + 1,
        albumCount: count,
        mediaKey: `${identity.key}:${index + 1}`,
        domMessageId: thumb ? thumbnailMessageId(thumb, albumRoot) : '',
        candidateUrls: thumb ? mediaUrlCandidates(thumb, type) : [],
      };
    });
    if (identity.firstId && descriptors[0] && !descriptors[0].domMessageId) {
      descriptors[0].domMessageId = identity.firstId;
    }
    if (identity.lastId && descriptors[descriptors.length - 1] && !descriptors[descriptors.length - 1].domMessageId) {
      descriptors[descriptors.length - 1].domMessageId = identity.lastId;
    }
    return descriptors;
  }

  function documentFilename(element) {
    const title = element.getAttribute('title') || '';
    const quoted = /["“”]([^"“”]+)["“”]/u.exec(title);
    if (quoted) {
      return normalizeInline(quoted[1]);
    }

    const candidates = Array.from(element.querySelectorAll('span[dir="auto"], [title]'))
      .map((candidate) => normalizeInline(candidate.getAttribute('title') || textFromNode(candidate)))
      .filter(Boolean);
    return candidates.find((candidate) => /\.[a-z0-9]{1,8}$/i.test(candidate)) || candidates[0] || '';
  }

  function extractMedia(scope, excludedScope) {
    if (!scope || !scope.querySelectorAll) {
      return [];
    }

    const output = [];
    const seen = new Set();
    const add = (item, key) => {
      const fingerprint = key || `${item.type}:${item.filename || item.label || ''}`;
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        output.push(item);
      }
    };

    const albumRoots = [];
    if (scope.matches && scope.matches('[data-testid="image-album"]')) {
      albumRoots.push(scope);
    }
    albumRoots.push(...scope.querySelectorAll('[data-testid="image-album"]'));
    for (const albumRoot of albumRoots) {
      if (isInsideExcluded(albumRoot, excludedScope)) {
        continue;
      }
      for (const item of extractAlbumMedia(albumRoot)) {
        add(item, `album:${item.albumKey}:${item.albumIndex}`);
      }
    }

    for (const element of scope.querySelectorAll('[data-testid="document-thumb"]')) {
      if (!isInsideExcluded(element, excludedScope)) {
        const filename = documentFilename(element);
        add({
          type: 'document',
          label: 'Documento',
          filename,
          domMessageId: closestDomMessageId(element),
          candidateUrls: mediaUrlCandidates(element, 'document'),
        }, `document:${closestDomMessageId(element) || filename || output.length}`);
      }
    }

    const imageThumbs = Array.from(scope.querySelectorAll('[data-testid="image-thumb"]'))
      .filter(element => !isInsideExcluded(element, excludedScope) && !element.closest('[data-testid="image-album"]'));
    for (const [index, element] of imageThumbs.entries()) {
      const parentId = closestDomMessageId(element);
      const domMessageId = thumbnailMessageId(element, scope) || (index === 0 ? parentId : '');
      const candidateUrls = mediaUrlCandidates(element, 'image');
      const mediaKey = `${scope.getAttribute('data-id') || parentId}:image:${index + 1}`;
      add({ type: 'image', label: 'Imagen', domMessageId, candidateUrls, mediaKey,
        ...(imageThumbs.length > 1 ? { albumKey: scope.getAttribute('data-id') || parentId,
          albumIndex: index + 1, albumCount: imageThumbs.length } : {}),
      }, mediaKey);
    }

    for (const element of scope.querySelectorAll('video, [data-testid*="video-thumb"], [data-testid="video-player"]')) {
      if (!isInsideExcluded(element, excludedScope) && !element.closest('[data-testid="image-album"]')) {
        const domMessageId = closestDomMessageId(element);
        const candidateUrls = mediaUrlCandidates(element, 'video');
        add({ type: 'video', label: 'Vídeo', domMessageId, candidateUrls }, `video:${domMessageId || candidateUrls[0]?.url || output.length}`);
      }
    }

    const audioMarkers = Array.from(scope.querySelectorAll(
      'audio, [data-testid*="audio-player"], [data-testid*="voice-message"], [data-testid="ptt-status"], [aria-label*="mensaje de voz" i], [aria-label*="voice message" i]',
    )).filter((element) => !isInsideExcluded(element, excludedScope));
    if (audioMarkers.length) {
      const domMessageId = closestDomMessageId(audioMarkers[0]) || normalizeMessageId(scope.getAttribute && (scope.getAttribute('data-id') || scope.getAttribute('data-testid')));
      const candidateUrls = mediaUrlCandidates(scope, 'audio');
      add({ type: 'audio', label: 'Audio', domMessageId, candidateUrls }, `audio:${domMessageId || candidateUrls[0]?.url || output.length}`);
    }

    for (const element of scope.querySelectorAll('[data-testid*="sticker"]')) {
      if (!isInsideExcluded(element, excludedScope)) {
        const domMessageId = closestDomMessageId(element);
        const candidateUrls = mediaUrlCandidates(element, 'sticker');
        add({ type: 'sticker', label: 'Sticker', domMessageId, candidateUrls }, `sticker:${domMessageId || candidateUrls[0]?.url || output.length}`);
      }
    }

    for (const element of scope.querySelectorAll('[data-testid*="location"], [aria-label*="location" i], [aria-label*="ubicación" i]')) {
      if (!isInsideExcluded(element, excludedScope)) {
        add({ type: 'location', label: 'Ubicación' }, `location:${output.length}`);
      }
    }

    for (const element of scope.querySelectorAll('[data-testid*="contact-card"], [data-testid*="vcard"]')) {
      if (!isInsideExcluded(element, excludedScope)) {
        add({ type: 'contact', label: 'Contacto' }, `contact:${output.length}`);
      }
    }

    return output;
  }

  function extractQuotedMessage(root) {
    const quotedRoot = root && root.querySelector && root.querySelector('[data-testid="quoted-message"]');
    if (!quotedRoot) {
      return null;
    }

    const authorElement = quotedRoot.querySelector('[data-testid="author"]');
    const author = normalizeInline(authorElement ? textFromNode(authorElement) : '');
    const media = extractMedia(quotedRoot, null);
    let text = extractSelectableText(quotedRoot, null);

    if (!text) {
      const symbol = quotedRoot.querySelector('[data-testid="chat-msg-symbol"] title');
      const symbolText = symbol ? normalizeInline(symbol.textContent) : '';
      if (/image/i.test(symbolText)) {
        text = 'Foto';
      } else if (/video/i.test(symbolText)) {
        text = 'Vídeo';
      } else if (/audio|voice/i.test(symbolText)) {
        text = 'Audio';
      } else if (media.length) {
        text = media.map(mediaPlaceholder).join(' ');
      }
    }

    let type = media[0] ? media[0].type : 'text';
    if (/^(?:photo|foto|image|imagen)$/i.test(text)) {
      type = 'image';
      if (!media.length) {
        media.push({ type: 'image', label: 'Imagen' });
      }
    }

    return { author, text, type, media };
  }

  function extractDirection(root) {
    const id = root.getAttribute('data-id') || '';
    if (/^true_/.test(id)) return 'out';
    if (/^false_/.test(id)) return 'in';
    if (root.matches('.message-out') || ownMessageElements(root, '.message-out, [data-testid="tail-out"], [data-icon="tail-out"]').length) return 'out';
    if (root.matches('.message-in') || ownMessageElements(root, '.message-in, [data-testid="tail-in"], [data-icon="tail-in"]').length) return 'in';
    const labels = ownMessageElements(root, '[aria-label]').map(el => normalizeInline(el.getAttribute('aria-label')));
    if (labels.some(label => /^(?:you|tú|tu|yo):\s*$/iu.test(label))) return 'out';
    const statusElements = ownMessageElements(root, '[data-testid="msg-meta"] [aria-label], [data-icon="msg-check"], [data-icon="msg-dblcheck"]');
    if (statusElements.some(el => /^(?:delivered|read|sent|sending|played|entregado|leído|leido|enviado|enviando|reproducido)$/iu.test(normalizeInline(el.getAttribute('aria-label')))
      || /^msg-(?:check|dblcheck)$/.test(el.getAttribute('data-icon') || ''))) return 'out';
    const titles = ownMessageElements(root, '[data-testid="msg-meta"] svg title').map(el => normalizeInline(el.textContent));
    if (titles.some(t => /^(?:wds-ic-(?:read|sent|delivered)|msg-(?:check|dblcheck))$/.test(t))) return 'out';
    const author = extractAuthorFallback(root, null);
    if (isSelfAlias(author)) return 'out';
    if (author) return 'in';
    // Dehydrated / unsupported bubbles are UNKNOWN, not incoming by default.
    return null;
  }

  function extractAuthorFallback(root, direction) {
    const labeled = [];
    if (root.matches && root.matches('[aria-label]')) {
      labeled.push(root);
    }
    labeled.push(...root.querySelectorAll('span[aria-label], div[aria-label]'));
    for (const element of labeled) {
      if (element.closest('[data-testid="quoted-message"]')) {
        continue;
      }
      const label = normalizeInline(element.getAttribute('aria-label') || '');
      if (!label) {
        continue;
      }
      const albumAuthor = /^(.*?)\s+Álbum de archivos multimedia\b/iu.exec(label)
        || /^(.*?)\s+Media album\b/iu.exec(label);
      const author = albumAuthor ? albumAuthor[1].trim() : label.replace(/:\s*$/, '').trim();
      if (!albumAuthor && !/:$/.test(label)) {
        continue;
      }
      if (/^(?:you|tú|tu|yo)$/i.test(author)) {
        return 'Yo';
      }
      if (!/^(?:delivered|read|sent|forwarded|message|mensaje)$/i.test(author)) {
        return author;
      }
    }
    return direction === 'out' ? 'Yo' : '';
  }

  function extractClockFromRoot(root, side = 'last') {
    const metadata = ownMessageElements(root, '[data-testid="msg-meta"]');
    const ordered = side === 'first' ? metadata : metadata.reverse();
    for (const item of ordered) {
      const parsed = parseTimeParts(normalizeInline(textFromNode(item)));
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  function extractReactions(root) {
    const reactions = [];
    const seen = new Set();
    for (const element of root.querySelectorAll('[data-testid="reaction-bubble"], [aria-label^="reaction " i], [aria-label^="reacción " i]')) {
      const label = normalizeInline(element.getAttribute('aria-label') || textFromNode(element));
      let value = '';
      const match = /^(?:reaction|reacción)\s+(.+?)(?:\.\s|\.|$)/iu.exec(label);
      if (match) {
        value = match[1].trim();
      } else {
        value = label;
      }
      if (value && !seen.has(value)) {
        seen.add(value);
        reactions.push(value);
      }
    }
    return reactions;
  }

  function inferMessageType(text, media, root) {
    if (media && media.length) {
      return media[0].type;
    }
    if (text) {
      return 'text';
    }
    const allText = normalizeInline(textFromNode(root));
    if (/message was deleted|mensaje eliminado|eliminaste este mensaje/i.test(allText)) {
      return 'deleted';
    }
    if (/missed (?:voice|video) call|llamada perdida/i.test(allText)) {
      return 'call';
    }
    return 'unknown';
  }

  function extractMessageElement(root, options = {}) {
    if (!root || !root.querySelector) {
      throw new TypeError('Se esperaba un elemento de mensaje');
    }

    const testId = root.getAttribute('data-testid') || '';
    const id = root.getAttribute('data-id') || testId.replace(/^conv-msg-/, '') || `message-${options.firstSeen || 0}`;
    const prePlainElement = ownMessageElements(root, '[data-pre-plain-text]')[0];
    const prePlainValue = prePlainElement ? prePlainElement.getAttribute('data-pre-plain-text') : '';
    const parsed = prePlainValue
      ? parsePrePlainText(prePlainValue, { dateOrder: options.dateOrder || 'DMY' })
      : null;
    const quotedRoot = root.querySelector('[data-testid="quoted-message"]');
    const direction = extractDirection(root);
    const author = metadataAuthor(prePlainValue) || extractAuthorFallback(root, direction);
    // Captions may be siblings of the metadata wrapper, and may only have a class.
    const text = extractSelectableText(root, quotedRoot)
      || rawMediaCaption(options.rawMessage)
      || (options.captionById && options.captionById.get(normalizeMessageId(id))) || '';
    const media = extractMedia(root, quotedRoot);
    const quoted = extractQuotedMessage(root);
    const isAlbum = testId === 'image-album';
    const timeParts = (parsed && parsed.timeParts) || extractClockFromRoot(root, isAlbum ? 'first' : 'last');
    const type = inferMessageType(text, media, root);
    const albumCount = isAlbum
      ? parseAlbumIdentity(root.getAttribute('data-id') || '', root.getAttribute('aria-label') || '').count
      : 0;

    const record = {
      id,
      firstSeen: Number.isFinite(options.firstSeen) ? options.firstSeen : 0,
      timestampSource: parsed ? 'dom-metadata' : '',
      authorSource: metadataAuthor(prePlainValue) ? 'dom-metadata' : author ? 'dom-label' : '',
      directionSource: direction ? 'dom' : '',
      timestamp: parsed ? parsed.timestamp : null,
      timestampInferred: false,
      dateKey: parsed ? parsed.dateKey : '',
      timeText: parsed ? parsed.timeText : (timeParts ? `${pad(timeParts.hour)}:${pad(timeParts.minute)}` : ''),
      timeParts,
      author,
      direction,
      type,
      text,
      media,
      albumCount,
      quoted,
      reactions: extractReactions(root),
      rawMetadata: prePlainValue || '',
    };
    return enrichRecordMetadata(record, options.rawMessage);
  }

  function enrichRecordMetadata(record, raw) {
    if (!raw || rawIdentity(raw).shortId !== normalizeMessageId(record.id)) return record;
    const identity = rawIdentity(raw);
    const timestamp = normalizeTimestamp(firstDefined(raw.t, raw.__x_t, raw.timestamp));
    const next = { ...record, fullId: /^(?:true|false)_/.test(identity.fullId) ? identity.fullId : record.fullId || '' };
    if (Number.isFinite(timestamp)) {
      const date = new Date(timestamp);
      Object.assign(next, { timestamp, dateKey: localDateKey(date), timeText: localTimeText(date, true),
        timeParts: {hour:date.getHours(),minute:date.getMinutes(),second:date.getSeconds()},
        timestampSource:'wa-js',timestampInferred:false,dateAmbiguous:false });
    }
    if (identity.direction) Object.assign(next,{direction:identity.direction,directionSource:'wa-js'});
    const name = rawAuthorName(raw);
    if (name && (!next.author || isSelfAlias(next.author))) Object.assign(next,{author:name,authorSource:'wa-js-sender'});
    const rawType = rawValue(raw, 'type'), rawMime = rawValue(raw, 'mimetype');
    const type = rawType || rawMime ? normalizeMediaType(rawType,rawMime) : '';
    const hasNativeMedia = Boolean(type && ['image','video','audio','document','sticker','file'].includes(type));
    if (next.type === 'unknown' && hasNativeMedia) next.type = type;
    if (hasNativeMedia && !(next.media || []).length) {
      next.media = [{type,domMessageId:identity.shortId,fullId:identity.fullId,mime:rawValue(raw,'mimetype') || '',
        filename:rawValue(raw,'filename') || '',candidateUrls:[]}];
    }
    next.media = (next.media || []).map(item => ({...item, fullId: ownMediaFullId(item, next)}));
    return next;
  }

  function mergeUniqueItems(left, right, fingerprint) {
    const output = [];
    const seen = new Set();
    for (const item of [...(left || []), ...(right || [])]) {
      const key = fingerprint(item);
      if (!seen.has(key)) {
        seen.add(key);
        output.push(item);
      }
    }
    return output;
  }

  function mediaFingerprint(item) {
    if (item.mediaKey) return item.mediaKey;
    if (item.albumKey && item.albumIndex) return `${item.albumKey}:${item.albumIndex}`;
    const id = normalizeMessageId(item.domMessageId || item.shortId || item.fullId);
    if (id) return `${item.type}:message:${id}`;
    const url = item.candidateUrls && item.candidateUrls[0] && item.candidateUrls[0].url;
    return [item.type,item.filename,item.label,url].join(':');
  }

  function mergeMediaItems(left, right) {
    const items = new Map();
    for (const incoming of [...(left || []), ...(right || [])]) {
      let key = mediaFingerprint(incoming), old = items.get(key);
      if (!old) {
        const id = normalizeMessageId(incoming.domMessageId || incoming.shortId || incoming.fullId);
        const match = id && [...items].find(([, value]) => {
          if (value.mediaKey && incoming.mediaKey && value.mediaKey !== incoming.mediaKey) return false;
          return mediaTypesCompatible(value.type, incoming.type)
            && normalizeMessageId(value.domMessageId || value.shortId || value.fullId) === id;
        });
        if (match) {
          old = match[1];
          const mergedKey = old.mediaKey && !incoming.mediaKey ? match[0] : key;
          items.delete(match[0]); key = mergedKey;
        }
      }
      if (!old) { items.set(key, incoming); continue; }
      const merged = {...old, ...incoming};
      for (const field of ['domMessageId','fullId','shortId','filename','mime']) {
        if (!merged[field] && old[field]) merged[field] = old[field];
      }
      // Prefer new sources; keep older ones only as a bounded fallback for this SAME slot.
      merged.candidateUrls = mergeUniqueItems(incoming.candidateUrls, old.candidateUrls,
        source => typeof source === 'string' ? source : source.url).slice(0, 8);
      items.set(key, merged);
    }
    return [...items.values()];
  }

  function mergeRecords(existing, incoming) {
    if (!existing) return incoming;
    const chooseText = incoming.text && incoming.text.length > (existing.text || '').length ? incoming.text : existing.text;
    const rank = r => !Number.isFinite(r.timestamp) ? 0 : r.timestampSource === 'wa-js' ? 4 : r.timestampInferred ? 1 : 3;
    const timed = rank(incoming) >= rank(existing) && rank(incoming) > 0 ? incoming : existing;
    const directed = incoming.direction && (incoming.directionSource === 'wa-js' || existing.directionSource !== 'wa-js') ? incoming : existing;
    const authored = incoming.author && !isSelfAlias(incoming.author) ? incoming : existing.author ? existing : incoming;
    return {
      ...existing, ...incoming,
      firstSeen: Math.min(existing.firstSeen || 0,incoming.firstSeen || 0),
      timestamp: timed.timestamp, timestampSource: timed.timestampSource || '', timestampInferred: Boolean(timed.timestampInferred),
      dateKey: timed.dateKey || '', timeText: timed.timeText || existing.timeText || incoming.timeText || '',
      timeParts: timed.timeParts || existing.timeParts || incoming.timeParts,
      direction: directed.direction || null, directionSource: directed.directionSource || '',
      author: authored.author || '', authorSource: authored.authorSource || '',
      type: incoming.type && incoming.type !== 'unknown' ? incoming.type : existing.type,
      text: chooseText || '', rawMetadata: incoming.rawMetadata || existing.rawMetadata || '',
      fullId: incoming.fullId || existing.fullId || '',
      dayGroup: incoming.dayGroup || existing.dayGroup || '', dayLabel: incoming.dayLabel || existing.dayLabel || '',
      media: mergeMediaItems(existing.media,incoming.media),
      albumCount: Math.max(Number(existing.albumCount || 0),Number(incoming.albumCount || 0)),
      quoted: existing.quoted || incoming.quoted,
      reactions: mergeUniqueItems(existing.reactions,incoming.reactions,item => item),
    };
  }

  function readDayLabel(label, order, referenceDate) {
    const text = normalizeInline(label).toLowerCase();
    let offset;
    if (/^(?:hoy|today)$/.test(text)) offset = 0;
    if (/^(?:ayer|yesterday)$/.test(text)) offset = -1;
    if (offset !== undefined) return new Date(referenceDate.getFullYear(),referenceDate.getMonth(),referenceDate.getDate()+offset).getTime();
    const parts = /^\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(text) ? parseNumericDate(text,order) : null;
    return parts ? new Date(parts.year,parts.month-1,parts.day).getTime() : null;
  }

  function dayGroupsInDom(scope) {
    const groups = new Map(); let label = '', group = '';
    for (const el of scope.querySelectorAll(`${MESSAGE_SELECTOR}, span`)) {
      if (el.matches(MESSAGE_SELECTOR)) {
        if (label) {
          if (!group) group = el.getAttribute('data-id') || el.getAttribute('data-testid');
          groups.set(el,{dayGroup:group,dayLabel:label});
        }
      } else if (!el.closest(MESSAGE_SELECTOR)) {
        const t = normalizeInline(el.textContent);
        if (/^(?:today|yesterday|hoy|ayer|lunes|martes|miércoles|jueves|viernes|sábado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4})$/iu.test(t)) {
          label=t; group='';
        }
      }
    }
    return groups;
  }

  function createCollector(dateOrder, options = {}) {
    const records = new Map(), edges = new Map(), rawById = new Map();
    let firstSeenCounter = 0, uiLocale = options.uiLocale || '', uiStrength = options.uiLocale ? 3 : 0;
    const automatic = dateOrder === 'auto' || !dateOrder || options.autoDetect;
    const locale = options.locale || (typeof navigator !== 'undefined' ? navigator.language : 'es-ES');
    const referenceDate = options.referenceDate || new Date();
    let context = options.context || {}, resolution = {order:automatic?'DMY':dateOrder,source:automatic?'browser-fallback':'manual',ambiguous:Boolean(automatic),conflict:false};
    const wpp = options.wpp !== undefined ? options.wpp : typeof WPP !== 'undefined' ? WPP : null;

    function refresh() {
      if (automatic) {
        const pairs = [...records.values()].filter(r=>r.rawMetadata && r.timestampSource === 'wa-js')
          .map(r=>({rawMetadata:r.rawMetadata,timestamp:r.timestamp}));
        resolution = resolveDateOrder([...records.values()].map(r=>r.rawMetadata).filter(Boolean),locale,{uiLocale,timestampPairs:pairs});
      }
      for (const [id,old] of records) {
        let r = enrichRecordMetadata(old,rawById.get(normalizeMessageId(id)));
        if (r.timestampSource !== 'wa-js') {
          const parsed = r.rawMetadata ? parsePrePlainText(r.rawMetadata,{dateOrder:resolution.order}) : null;
          // A later observation can change the inferred locale: reparse ALL retained metadata.
          const uncertain = Boolean(automatic && resolution.ambiguous && r.rawMetadata && parsed
            && !/^\s*\d{4}/.test(extractMetadataDateText(r.rawMetadata))
            && (()=>{const a=parseNumericDate(extractMetadataDateText(r.rawMetadata),'DMY'),b=parseNumericDate(extractMetadataDateText(r.rawMetadata),'MDY');
              return a && b && (a.day!==b.day || a.month!==b.month);})());
          Object.assign(r,{timestamp:parsed ? parsed.timestamp : null,dateKey:parsed ? parsed.dateKey : '',
            timestampSource:parsed?'dom-metadata':'',timestampInferred:false,dateAmbiguous:uncertain,dateOrder:resolution.order});
          if (parsed) Object.assign(r,{timeText:parsed.timeText,timeParts:parsed.timeParts});
          if (r.rawMetadata && !parsed) r.dateError = 'invalid-metadata'; else delete r.dateError;
        }
        records.set(id,r);
      }
    }

    function collect(scope) {
      scope = scope || document;
      const roots = Array.from(scope.querySelectorAll(MESSAGE_SELECTOR));
      const loaded = loadedMetadataContext(wpp);
      if (context.chatId && loaded.chatId && context.chatId !== loaded.chatId) throw new Error('El chat cambió durante la recopilación');
      context = {...context,...Object.fromEntries(Object.entries(loaded).filter(([key,v])=>key!=='rawMessages' && v!=='' && v!==undefined))};
      for (const raw of [...loaded.rawMessages,...(options.rawMessages || [])]) {
        const id = rawIdentity(raw).shortId; if (id) rawById.set(id,snapshotRawMetadata(raw));
      }
      const observedLocale = uiDateLocale(scope);
      if (observedLocale.locale && observedLocale.strength >= uiStrength && !options.uiLocale) {
        uiLocale = observedLocale.locale; uiStrength = observedLocale.strength;
      }
      const groups = dayGroupsInDom(scope), orderedIds = [], captionById = loadedCaptionIndex();
      for (const root of roots) {
        const id = root.getAttribute('data-id') || (root.getAttribute('data-testid') || '').replace(/^conv-msg-/,'');
        const r = extractMessageElement(root,{dateOrder:resolution.order,captionById,firstSeen:firstSeenCounter,rawMessage:rawById.get(normalizeMessageId(id))});
        Object.assign(r,groups.get(root) || {});
        if (!records.has(r.id)) firstSeenCounter++;
        records.set(r.id,mergeRecords(records.get(r.id),r)); orderedIds.push(r.id);
      }
      for (let i=0; i<orderedIds.length-1; i++) {
        const from=orderedIds[i],to=orderedIds[i+1]; if (from===to) continue;
        if (!edges.has(from)) edges.set(from,new Set()); edges.get(from).add(to);
      }
      refresh();
      return orderedIds.map(id=>records.get(id));
    }

    function finalize() {
      refresh();
      let ordered=orderRecords([...records.values()],edges);
      const groups = new Map();
      for (const r of ordered) {
        if (!r.dayGroup) continue;
        if (!groups.has(r.dayGroup)) groups.set(r.dayGroup,new Set());
        if (r.dateKey && !r.timestampInferred && !r.dateAmbiguous) groups.get(r.dayGroup).add(r.dateKey);
      }
      ordered = ordered.map(r=> {
        if (Number.isFinite(r.timestamp) || !r.dayGroup || !r.timeParts || r.dateError) return r;
        const dates=groups.get(r.dayGroup);
        let day=null;
        if (dates && dates.size===1) day=readDayLabel([...dates][0],'YMD',referenceDate);
        else if ((!dates || !dates.size) && (!resolution.ambiguous || /^(?:hoy|today|ayer|yesterday)$/i.test(r.dayLabel || '')
          || /^\d{4}[/.\-]/.test(r.dayLabel || ''))) day=readDayLabel(r.dayLabel,resolution.order,referenceDate);
        if (day==null) return r;
        const timestamp=timeOnLocalDay(day,r.timeParts), date=new Date(timestamp);
        return {...r,timestamp,dateKey:localDateKey(date),timeText:localTimeText(date,Boolean(r.timeParts.second)),
          timestampSource:'day-heading',timestampInferred:false,dateAmbiguous:false};
      });
      ordered=inferMissingTimestamps(ordered);
      return normalizeRecordAuthors(ordered,context);
    }

    return {records,edges,collect,finalize,has:id=>records.has(id),
      get size(){return records.size;}, get dateOrder(){return resolution.order;},get dateResolution(){return {...resolution};}};
  }

  function getChatTitle() {
    const element = document.querySelector(TITLE_SELECTOR);
    return normalizeInline(element ? textFromNode(element) : '') || 'Chat de WhatsApp';
  }

  function elementStyle(element) {
    const view = element && element.ownerDocument && element.ownerDocument.defaultView;
    return view && view.getComputedStyle ? view.getComputedStyle(element) : null;
  }

  function findScrollCandidates(primary) {
    const candidates = [primary];
    const roots = Array.from(primary.querySelectorAll(MESSAGE_SELECTOR));
    // Only wrappers of the WHOLE message list qualify. A scrollable caption,
    // a message bubble, or an unrelated page ancestor is never the chat scroller.
    const inner = [];
    let node = roots[0] && roots[0].parentElement;
    while (node && node !== primary && primary.contains(node)) {
      if (!node.closest(MESSAGE_SELECTOR) && roots.every(root => node.contains(root))) inner.push(node);
      node = node.parentElement;
    }
    candidates.push(...inner.reverse());
    const boundary = primary.closest('[data-testid="conversation-panel-body"]') || primary.closest('#main');
    node = primary.parentElement;
    while (boundary && primary !== boundary && node && boundary.contains(node)) {
      candidates.push(node);
      if (node === boundary) break;
      node = node.parentElement;
    }
    return candidates;
  }

  function findScroller() {
    const primaries = Array.from(document.querySelectorAll(SCROLLER_SELECTOR));
    const primary = primaries.find(element => element.clientHeight > 0 && element.getClientRects().length);
    if (!primary) return null;
    const candidates = findScrollCandidates(primary);
    const available = candidate => {
      const style = elementStyle(candidate);
      return candidate.clientHeight > 0 && style && style.visibility !== 'hidden' && style.display !== 'none';
    };
    // A chat which fits on screen is STILL the correct scroll container.
    // Do not require scrollHeight > clientHeight: that chose unrelated ancestors
    // for short conversations, and could leave the scan running for 10,000 steps.
    const scrollable = candidates.find(candidate => available(candidate)
      && /^(auto|scroll|overlay)$/.test(elementStyle(candidate).overflowY));
    if (scrollable) return scrollable;
    const hidden = candidates.find(candidate => available(candidate)
      && elementStyle(candidate).overflowY === 'hidden' && candidate.scrollHeight > candidate.clientHeight + 2);
    return hidden || primary;
  }

  /** Physical coordinates, including flex column-reverse and fractional pixels. */
  function getScrollState(scroller) {
    const style = elementStyle(scroller);
    const reversed = Boolean(style && /flex/.test(style.display) && style.flexDirection === 'column-reverse');
    const height = Number(scroller.scrollHeight) || 0;
    const clientHeight = Number(scroller.clientHeight) || 0;
    const maximum = Math.max(0, height - clientHeight);
    const rawTop = Number(scroller.scrollTop) || 0;
    const minimumTop = reversed ? -maximum : 0;
    const maximumTop = reversed ? 0 : maximum;
    const top = clamp(rawTop, minimumTop, maximumTop);
    const offset = reversed ? maximum + top : top;
    return { top, rawTop, height, clientHeight, maximum, minimumTop, maximumTop, reversed, offset,
      atTop: clientHeight > 0 && offset <= 2,
      atBottom: clientHeight > 0 && maximum - offset <= 2 };
  }

  function historyIsLoading(scope) {
    if (!scope || !scope.querySelectorAll) return false;
    const selectors = '[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i], [data-testid*="spinner" i]';
    const nodes = Array.from(scope.querySelectorAll(selectors));
    if (scope.matches && scope.matches('[aria-busy="true"]')) nodes.push(scope);
    return nodes.some(node => {
      if (node.closest(MESSAGE_SELECTOR) || !node.getClientRects().length) return false;
      const style = elementStyle(node);
      return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    });
  }

  /** Height changes alone are NOT progress. Do not confuse a loop with new messages. */
  function createScrollProgressTracker(options = {}) {
    const clock = options.clock || (() => Date.now());
    const boundaryQuietMs = options.boundaryQuietMs ?? 700;
    const stallTimeoutMs = Math.max(options.stallTimeoutMs ?? 2500, boundaryQuietMs + 1);
    const loadingTimeoutMs = options.loadingTimeoutMs ?? 12000;
    const maximumStagnantSteps = options.maximumStagnantSteps ?? 12;
    let direction = null, largestCount = -1, furthestTop = null, lastProgress = clock();
    let stagnant = 0, edgeSince = null, edgeSamples = 0, previousSignature = '';
    const signatures = new Set();
    return {
      observe(nextDirection, records, movement, count, loading = false) {
        const now = clock();
        const signature = records.map(record => record.id).join('\n');
        if (direction !== nextDirection) {
          direction = nextDirection; largestCount = count; furthestTop = movement.beforeTop;
          signatures.clear(); signatures.add(signature); previousSignature = signature;
          stagnant = 0; edgeSince = null; edgeSamples = 0; lastProgress = now;
        }
        const newMessages = count > largestCount;
        const newViewport = !signatures.has(signature);
        const forward = direction === 'down' ? movement.afterTop > furthestTop + 2 : movement.afterTop < furthestTop - 2;
        if (newMessages || newViewport || forward) {
          stagnant = 0; lastProgress = now;
          if (newMessages || newViewport) furthestTop = movement.afterTop;
          else furthestTop = direction === 'down' ? Math.max(furthestTop, movement.afterTop) : Math.min(furthestTop, movement.afterTop);
        } else stagnant++;
        largestCount = Math.max(largestCount, count);
        signatures.add(signature);
        const edge = direction === 'up' ? movement.atTop : movement.atBottom;
        const quietEdge = edge && !loading && !newMessages && signature === previousSignature
          && Math.abs(movement.afterTop - movement.beforeTop) <= 2
          && Math.abs(movement.afterHeight - movement.beforeHeight) <= 2;
        if (quietEdge) {
          if (edgeSince === null) edgeSince = now;
          edgeSamples++;
        } else { edgeSince = null; edgeSamples = 0; }
        previousSignature = signature;
        const stableEdge = edgeSamples >= 2 && edgeSince !== null && now - edgeSince >= boundaryQuietMs;
        // A genuinely quiet edge has its own finite settling window.
        const stalled = !stableEdge && !quietEdge && stagnant >= maximumStagnantSteps
          && now - lastProgress >= (loading ? loadingTimeoutMs : stallTimeoutMs);
        return { stableTop: stableEdge && direction === 'up', stableBottom: stableEdge && direction === 'down',
          stalled, stagnantSteps: stagnant, idleMs: now - lastProgress };
      },
    };
  }

  function viewportTimestampRange(records) {
    const timestamps = (records || [])
      .filter((record) => !record.dateAmbiguous)
      .map((record) => record.timestamp)
      .filter(Number.isFinite);
    if (!timestamps.length) {
      return null;
    }
    return { min: Math.min(...timestamps), max: Math.max(...timestamps) };
  }

  function scrollRatio(scroller) {
    const state = getScrollState(scroller);
    return state.maximum > 0 ? clamp(state.offset / state.maximum, 0, 1) : 0;
  }

  async function waitForDomToSettle(target, signal, options = {}) {
    const quietMs = options.quietMs ?? 180;
    const maximumMs = options.maximumMs ?? 1400;
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(createAbortError());
        return;
      }

      let quietTimer;
      let maximumTimer;
      let observer;
      let completed = false;

      const finish = (error) => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(quietTimer);
        clearTimeout(maximumTimer);
        if (observer) {
          observer.disconnect();
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const scheduleQuiet = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), quietMs);
      };
      const onAbort = () => finish(createAbortError());

      if (typeof MutationObserver === 'function' && target) {
        observer = new MutationObserver(scheduleQuiet);
        observer.observe(target, { childList: true, subtree: true, attributes: true });
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      maximumTimer = setTimeout(() => finish(), maximumMs);
      scheduleQuiet();
    });
  }

  async function performScrollStep(scroller, direction, signal, options = {}) {
    ensureNotAborted(signal);
    const before = getScrollState(scroller);
    const amount = Math.max(320, Math.floor(before.clientHeight * 0.68));
    const target = clamp(before.top + (direction === 'up' ? -amount : amount), before.minimumTop, before.maximumTop);
    // Avoid page scroll-behavior:smooth making a completed step look unfinished.
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: target, behavior: 'instant' });
    else scroller.scrollTop = target;
    const EventClass = scroller.ownerDocument?.defaultView?.Event || Event;
    scroller.dispatchEvent(new EventClass('scroll', { bubbles: true }));
    await waitForDomToSettle(scroller, signal, options);
    await sleep(options.pauseMs ?? 40, signal);
    const after = getScrollState(scroller);
    return {
      moved: Math.abs(after.top - before.top) > 2,
      atTop: after.atTop, atBottom: after.atBottom,
      beforeTop: before.top, afterTop: after.top,
      beforeHeight: before.height, afterHeight: after.height,
      maximum: after.maximum, reversed: after.reversed,
    };
  }

  function findOlderMessagesButton(scroller) {
    const words = [
      'older messages',
      'get older messages',
      'mensajes antiguos',
      'mensajes anteriores',
      'mensajes más antiguos',
      'mensagens antigas',
    ];
    return Array.from(scroller.querySelectorAll('button')).find((button) => {
      const text = normalizeInline(textFromNode(button)).toLowerCase();
      return words.some((word) => text.includes(word));
    }) || null;
  }

  async function tryLoadOlderMessages(scroller, signal) {
    const button = findOlderMessagesButton(scroller);
    if (!button || button.disabled) {
      return false;
    }
    button.click();
    await waitForDomToSettle(scroller, signal, { quietMs: 350, maximumMs: 5000 });
    await sleep(300, signal);
    return true;
  }

  function endpointHint(endpoint) {
    if (!endpoint || endpoint.kind === 'none') {
      return null;
    }
    if (Number.isFinite(endpoint.timestamp)) {
      return { type: 'timestamp', value: endpoint.timestamp };
    }
    if (Number.isFinite(endpoint.positionHint)) {
      return { type: 'position', value: endpoint.positionHint };
    }
    return null;
  }

  function normalizeBoundsForScan(bounds) {
    const output = {
      start: { ...(bounds.start || { kind: 'none' }) },
      end: { ...(bounds.end || { kind: 'none' }) },
      swapped: false,
    };
    const left = endpointHint(output.start);
    const right = endpointHint(output.end);
    if (output.start.kind === 'date' && output.end.kind === 'date' && left && right && left.type === right.type && left.value > right.value) {
      [output.start, output.end] = [output.end, output.start];
      output.swapped = true;
    }
    return output;
  }

  function lowerReached(endpoint, collector, viewportRecords, direction) {
    if (!endpoint || endpoint.kind === 'none') {
      return false;
    }
    if (endpoint.kind === 'message') {
      return collector.has(endpoint.messageId);
    }
    const range = viewportTimestampRange(viewportRecords);
    if (!range || !Number.isFinite(endpoint.timestamp)) {
      return false;
    }
    return direction === 'up' ? range.min <= endpoint.timestamp : range.max >= endpoint.timestamp;
  }

  function upperReached(endpoint, collector, viewportRecords) {
    if (!endpoint || endpoint.kind === 'none') {
      return false;
    }
    if (endpoint.kind === 'message') {
      return (viewportRecords || []).some((record) => record.id === endpoint.messageId);
    }
    const range = viewportTimestampRange(viewportRecords);
    return Boolean(range && Number.isFinite(endpoint.timestamp) && range.max > endpoint.timestamp);
  }

  function chooseLowerDirection(endpoint, viewportRecords, scroller) {
    if (!endpoint || endpoint.kind === 'none') {
      return 'up';
    }
    const range = viewportTimestampRange(viewportRecords);
    if (range && Number.isFinite(endpoint.timestamp)) {
      if (range.min > endpoint.timestamp) {
        return 'up';
      }
      if (range.max < endpoint.timestamp) {
        return 'down';
      }
      return 'up';
    }
    if (Number.isFinite(endpoint.positionHint)) {
      return endpoint.positionHint <= scrollRatio(scroller) ? 'up' : 'down';
    }
    return 'up';
  }

  async function scanRange(bounds, options = {}) {
    const signal = options.signal;
    const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const scroller = options.scroller || findScroller();
    if (!scroller) throw new Error('Abre primero el chat que quieres exportar');
    // Reading is restricted to the conversation, even when its scroll wrapper is outside it.
    const scope = options.scope || (scroller.matches?.(SCROLLER_SELECTOR) ? scroller : scroller.querySelector(SCROLLER_SELECTOR)) || scroller;
    const normalizedBounds = normalizeBoundsForScan(bounds);
    const collector = createCollector(options.dateOrder || 'auto', options);
    let viewportRecords = collector.collect(scope);
    let phase = 'Buscando el inicio', stepCount = 0;
    const maximumSteps = Math.max(0, Number.isFinite(options.maximumSteps) ? options.maximumSteps : 10000);
    let tracker = createScrollProgressTracker(options);
    let stopReason = '', upperConfirmed = false, lowerConfirmed = false;
    const scanWarnings = [];
    const startedAt = Date.now();
    const update = (extra = {}) => {
      const range = viewportTimestampRange(viewportRecords);
      report({ phase, count: collector.size, stepCount, elapsedMs: Date.now() - startedAt,
        oldest: range ? range.min : null, newest: range ? range.max : null, ...extra });
    };
    function interrupt(reason, message) {
      const error = new Error(message);
      error.code = 'SCAN_INTERRUPTED'; error.reason = reason;
      throw error;
    }
    async function step(direction) {
      ensureNotAborted(signal);
      if (stepCount >= maximumSteps) interrupt('step-limit', 'Se alcanzó el límite de recorrido sin confirmar todo el rango.');
      if (!scroller.isConnected || !scope.isConnected || scroller.clientHeight <= 0) {
        interrupt('container-unavailable', 'El panel del chat dejó de estar disponible durante el recorrido.');
      }
      const movement = await performScrollStep(scroller, direction, signal, options.scrollOptions || {});
      stepCount++;
      ensureNotAborted(signal);
      if (!scroller.isConnected || !scope.isConnected) interrupt('container-unavailable', 'WhatsApp sustituyó el panel durante el recorrido.');
      viewportRecords = collector.collect(scope);
      const progress = tracker.observe(direction, viewportRecords, movement, collector.size, historyIsLoading(scope));
      update({ direction, ...progress });
      if (progress.stalled) interrupt('stalled', 'No hubo avance verificable tras varios intentos. No se pudo confirmar todo el rango; se conservan los mensajes recopilados.');
      return { ...movement, ...progress };
    }
    const requiredMessageIds = [normalizedBounds.start, normalizedBounds.end]
      .filter(endpoint => endpoint && endpoint.kind === 'message').map(endpoint => endpoint.messageId);
    const hasAllRequiredMessages = () => requiredMessageIds.every(id => collector.has(id));
    const lower = normalizedBounds.start, upper = normalizedBounds.end;
    let direction = chooseLowerDirection(lower, viewportRecords, scroller);
    let reachedLower = lowerReached(lower, collector, viewportRecords, direction);
    let atTop = false, loadedOlderAttempts = 0;
    async function loadOlder() {
      if (!options.loadOlderFromPhone || loadedOlderAttempts >= 8) return false;
      const loaded = await tryLoadOlderMessages(scope, signal);
      if (loaded) {
        loadedOlderAttempts++;
        viewportRecords = collector.collect(scope);
        tracker = createScrollProgressTracker(options);
        update();
      }
      return loaded;
    }
    update();
    try {
      while (!reachedLower) {
        const movement = await step(direction);
        atTop = movement.stableTop;
        if (direction === 'up' && atTop && await loadOlder()) continue;
        reachedLower = lowerReached(lower, collector, viewportRecords, direction);
        if (lower.kind === 'none' && atTop) reachedLower = true;
        if (movement.stableTop || movement.stableBottom) {
          // Reaching the oldest locally available message also satisfies a date
          // earlier than the available history, not an absent selected message.
          if (atTop && lower.kind === 'date') reachedLower = true;
          break;
        }
      }
      if (!reachedLower && lower.kind === 'message' && direction === 'up' && atTop) {
        phase = 'Buscando el mensaje inicial hacia abajo';
        while (!collector.has(lower.messageId)) {
          const movement = await step('down');
          if (movement.stableBottom) break;
        }
        reachedLower = collector.has(lower.messageId);
      }
      lowerConfirmed = reachedLower;
      if (reachedLower && !(lower.kind === 'none' && atTop)) await step('up');

      phase = 'Recopilando hasta el final';
      tracker = createScrollProgressTracker(options);
      let foundUpperAtStep = null;
      while (true) {
        const reached = upperReached(upper, collector, viewportRecords);
        if (reached && foundUpperAtStep === null) foundUpperAtStep = stepCount;
        if (reached && stepCount > foundUpperAtStep) { upperConfirmed = true; break; }
        const movement = await step('down');
        if (movement.stableBottom) {
          upperConfirmed = upper.kind !== 'message' || collector.has(upper.messageId);
          break;
        }
      }

      // Retain the recovery path for selected messages with stale date/position hints.
      if (!hasAllRequiredMessages()) {
        phase = 'Buscando los límites seleccionados en todo el chat';
        while (true) {
          const movement = await step('up');
          if (movement.stableTop) {
            if (await loadOlder()) continue;
            break;
          }
        }
        let foundAtStep = null;
        while (true) {
          if (hasAllRequiredMessages() && foundAtStep === null) foundAtStep = stepCount;
          if (foundAtStep !== null && stepCount > foundAtStep) break;
          const movement = await step('down');
          if (movement.stableBottom) break;
        }
        if (hasAllRequiredMessages()) {
          if (lower.kind === 'message') lowerConfirmed = true;
          if (upper.kind === 'message') upperConfirmed = true;
        }
      }
      if (!lowerConfirmed || !upperConfirmed) interrupt('boundary-unconfirmed', 'No se pudo confirmar uno de los límites del rango.');
      stopReason = upper.kind === 'none' ? 'available-end-confirmed' : 'range-confirmed';
    } catch (error) {
      if (!error || error.code !== 'SCAN_INTERRUPTED') throw error;
      stopReason = error.reason;
      scanWarnings.push(error.message);
    }
    ensureNotAborted(signal);
    phase = 'Ordenando y filtrando'; update();
    const allRecords = collector.finalize();
    if ([normalizedBounds.start, normalizedBounds.end].some(bound => bound.kind === 'date') && allRecords.some(record => record.dateAmbiguous)) {
      throw new Error('Hay fechas ambiguas. Selecciona Día / mes / año o Mes / día / año y vuelve a recopilar.');
    }
    // Missing selected endpoints still raise MESSAGE_NOT_FOUND; never silently
    // substitute some other first/last message just to produce an export.
    const selected = selectRange(allRecords, normalizedBounds);
    return {
      records: selected.records, allRecords, selected,
      dateOrder: collector.dateOrder, dateResolution: collector.dateResolution,
      metadataWarnings: [...metadataWarnings(selected.records, collector.dateResolution), ...scanWarnings],
      scanWarnings, partial: scanWarnings.length > 0, stopReason,
      bounds: normalizedBounds, steps: stepCount, collectedCount: collector.size,
    };
  }

  function metadataWarnings(records, resolution) {
    const messages=[];
    const ambiguous=records.filter(r=>r.dateAmbiguous).length;
    const undated=records.filter(r=>!Number.isFinite(r.timestamp)).length;
    const anonymous=records.filter(r=>!r.author).length;
    const unknownDirection=records.filter(r=>!r.direction).length;
    if (ambiguous) messages.push(`${ambiguous} fechas ambiguas: verifica el orden de fecha antes de usarlas.`);
    if (undated) messages.push(`${undated} mensajes sin fecha verificable.`);
    if (anonymous) messages.push(`${anonymous} mensajes sin autor identificable.`);
    if (unknownDirection) messages.push(`${unknownDirection} mensajes sin dirección identificable.`);
    if (resolution && resolution.conflict) messages.push('Se encontraron formatos de fecha contradictorios.');
    return messages;
  }

  function sanitizedFilename(value) {
    const sanitized = String(value || 'chat-whatsapp')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90);
    return sanitized || 'chat-whatsapp';
  }

  function exportFilename(data, format) {
    const first = data.records && data.records[0];
    const last = data.records && data.records[data.records.length - 1];
    const range = first && last
      ? `${(first.dateKey || 'inicio').replace(/-/g, '')}-${(last.dateKey || 'fin').replace(/-/g, '')}`
      : localDateKey(new Date()).replace(/-/g, '');
    return `${sanitizedFilename(data.chatTitle)}_${range}.${format}`;
  }

  function formatDefinition(format) {
    const normalized = String(format || 'txt').toLowerCase();
    return {
      txt: { extension: 'txt', mime: 'text/plain;charset=utf-8' },
      csv: { extension: 'csv', mime: 'text/csv;charset=utf-8' },
      json: { extension: 'json', mime: 'application/json;charset=utf-8' },
      html: { extension: 'html', mime: 'text/html;charset=utf-8' },
    }[normalized] || { extension: 'txt', mime: 'text/plain;charset=utf-8' };
  }

  function buildMediaManifest(data, collection) {
    collection = exportMediaCollection(data, collection);
    const exportedAt = data && data.exportedAt instanceof Date
      ? data.exportedAt
      : new Date(data && data.exportedAt || Date.now());
    const files = (collection && collection.files || []).map((item) => ({
      messageId: item.recordId || null,
      messageTimestamp: Number.isFinite(item.messageTimestamp) ? new Date(item.messageTimestamp).toISOString() : null,
      author: item.author || null,
      path: item.path,
      originalFilename: item.filename || null,
      type: item.type || null,
      mime: item.mime || null,
      bytes: Number(item.size || 0),
      source: item.source || null,
      quality: item.quality || null,
    }));
    const failures = (collection && collection.failures || []).map((item) => ({
      messageId: item.recordId || null,
      messageTimestamp: Number.isFinite(item.messageTimestamp) ? new Date(item.messageTimestamp).toISOString() : null,
      author: item.author || null,
      filename: item.filename || null,
      type: item.type || null,
      error: item.error || 'No disponible',
    }));
    return {
      exporter: 'WhatsApp Web Range Exporter',
      version: VERSION,
      chat: data && data.chatTitle || 'Chat de WhatsApp',
      exportedAt: exportedAt.toISOString(),
      messageCount: exportRecords(data).length,
      bounds: data && data.bounds || null,
      dateResolution: data && data.dateResolution || null,
      metadataWarnings: data && data.metadataWarnings || [],
      partial: data && data.partial != null ? data.partial : null,
      scanWarnings: data && data.scanWarnings || [],
      stopReason: data && data.stopReason || null,
      media: {
        found: Number(collection && collection.foundCount || 0),
        downloaded: Number(collection && collection.downloadedCount || 0),
        unavailable: failures.length,
        totalBytes: Number(collection && collection.totalBytes || 0),
        warnings: Array.from(collection && collection.warnings || []),
      },
      files,
      failures,
      messages: exportRecords(data).map(publicRecord),
    };
  }

  function formatMediaErrors(collection) {
    const lines = [];
    for (const warning of collection && collection.warnings || []) {
      lines.push(`[AVISO] ${warning}`);
    }
    for (const failure of collection && collection.failures || []) {
      const when = Number.isFinite(failure.messageTimestamp)
        ? formatLocalDateTime(failure.messageTimestamp, true)
        : 'fecha desconocida';
      const name = failure.filename || failure.shortId || failure.type || 'adjunto';
      lines.push(`[${when}] ${failure.author || 'Autor desconocido'} - ${name}: ${failure.error || 'No disponible'}`);
    }
    return lines.join('\n');
  }

  async function buildMediaArchive(data, collection, options = {}) {
    collection = exportMediaCollection(data, collection);
    ensureNotAborted(options.signal);
    const JSZipImpl = options.JSZipImpl || (typeof JSZip !== 'undefined' ? JSZip : null);
    if (typeof JSZipImpl !== 'function') {
      throw new Error('JSZip no está disponible. Reinstala o actualiza el userscript');
    }
    const zip = new JSZipImpl();
    const format = String(options.format || 'txt').toLowerCase();
    const definition = formatDefinition(format);
    zip.file(`conversacion.${definition.extension}`, formatExport(data, format));
    const manifest = buildMediaManifest(data, collection);
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const errors = formatMediaErrors(collection);
    if (errors) {
      zip.file('errores.txt', errors);
    }
    for (const file of collection && collection.files || []) {
      ensureNotAborted(options.signal);
      zip.file(file.path, file.blob, { binary: true });
    }
    const level = options.mode === 'zip-ultra' ? 9 : 6;
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level },
      streamFiles: true,
    }, (metadata) => {
      ensureNotAborted(options.signal);
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          phase: options.mode === 'zip-ultra' ? 'Ultracomprimiendo' : 'Comprimiendo',
          percent: Number(metadata && metadata.percent || 0),
          currentFile: metadata && metadata.currentFile || '',
        });
      }
    });
    ensureNotAborted(options.signal);
    return {
      blob,
      filename: exportFilename(data, 'zip'),
      manifest,
      compressionLevel: level,
    };
  }

  function separateExportBaseName(data) {
    return exportFilename(data, 'zip').replace(/\.zip$/i, '');
  }

  function buildSeparateExportEntries(data, collection, format = 'txt') {
    collection = exportMediaCollection(data, collection);
    const normalizedFormat = String(format || 'txt').toLowerCase();
    const definition = formatDefinition(normalizedFormat);
    const baseName = separateExportBaseName(data);
    const entries = [{
      kind: 'conversation',
      filename: `${baseName}.${definition.extension}`,
      mime: definition.mime,
      content: formatExport(data, normalizedFormat),
    }, {
      kind: 'manifest',
      filename: `${baseName}_manifest.json`,
      mime: 'application/json;charset=utf-8',
      content: JSON.stringify(buildMediaManifest(data, collection), null, 2),
    }];
    const errors = formatMediaErrors(collection);
    if (errors) {
      entries.push({
        kind: 'errors',
        filename: `${baseName}_errores.txt`,
        mime: 'text/plain;charset=utf-8',
        content: errors,
      });
    }
    for (const file of collection && collection.files || []) {
      entries.push({
        kind: 'media',
        filename: String(file.path || file.filename || 'archivo.bin').replace(/[\\/]+/g, '__'),
        mime: file.mime || file.blob && file.blob.type || 'application/octet-stream',
        blob: file.blob,
        path: file.path || '',
      });
    }
    return entries;
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (!bytes) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / (1024 ** unitIndex);
    const digits = unitIndex === 0 || amount >= 100 ? 0 : 1;
    return `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: digits }).format(amount)} ${units[unitIndex]}`;
  }

  function mediaCollectionSummary(collection) {
    const found = Number(collection && collection.foundCount || 0);
    const downloaded = Number(collection && collection.downloadedCount || 0);
    const unavailable = Number(collection && collection.failures && collection.failures.length || 0);
    const unavailableText = unavailable === 1 ? '1 no disponible' : `${unavailable} no disponibles`;
    return `${downloaded}/${found} adjuntos, ${unavailableText}, ${formatBytes(collection && collection.totalBytes)}`;
  }

  async function copyTextAndSingleMedia(content, htmlContent, file, options = {}) {
    if (!file || !isBlobLike(file.blob)) {
      return false;
    }
    const clipboard = options.clipboard || (typeof navigator !== 'undefined' ? navigator.clipboard : null);
    const ClipboardItemImpl = options.ClipboardItemImpl || (typeof ClipboardItem === 'function' ? ClipboardItem : null);
    const mime = normalizeMime(file.mime || file.blob.type);
    if (!clipboard || typeof clipboard.write !== 'function' || !ClipboardItemImpl || !mime) {
      return false;
    }
    if (typeof ClipboardItemImpl.supports === 'function' && !ClipboardItemImpl.supports(mime)) {
      return false;
    }
    const payload = {
      'text/plain': new Blob([content], { type: 'text/plain' }),
    };
    if (htmlContent) {
      payload['text/html'] = new Blob([htmlContent], { type: 'text/html' });
    }
    if (!Object.prototype.hasOwnProperty.call(payload, mime)) {
      payload[mime] = file.blob;
    }
    try {
      await clipboard.write([new ClipboardItemImpl(payload)]);
      return true;
    } catch (_error) {
      return false;
    }
  }

  /** Only actual image attachments: never a video poster, audio avatar or PDF preview. */
  function isClipboardImage(item) {
    if (!item) return false;
    const type = String(item.type || '').toLowerCase();
    const mime = normalizeMime(item.mime || item.mimetype);
    const extension = extensionFromFilename(item.filename);
    if (/^(?:video|gif-video|audio|ptt|voice|voice-note|text|chat)$/.test(type)) return false;
    if (/^(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|mp4|webm|mp3|ogg|m4a)$/.test(extension)) return false;
    if (mime && mime !== 'application/octet-stream' && !mime.startsWith('image/')) return false;
    return /^(?:image|photo|picture|sticker)$/.test(type) || mime.startsWith('image/')
      || /^(?:png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/.test(extension);
  }

  /** Decode locally and preserve pixel dimensions. Unsupported/huge images fail, not resize. */
  async function imageToClipboardPng(blob, options = {}) {
    ensureNotAborted(options.signal);
    const maxSourceBytes = Number(options.maxImageBytes) || 64 * 1024 * 1024;
    if (!isBlobLike(blob) || !blob.size) throw new Error('La imagen está vacía');
    if (blob.size > maxSourceBytes) throw new Error('La imagen supera el límite de memoria por imagen (64 MiB)');
    let bitmap = null;
    let url = null;
    let canvas = null;
    let cancelled = false;
    try {
      if (typeof createImageBitmap === 'function') {
        const operation = createImageBitmap(blob);
        // A decoder cannot always be interrupted; close its late result after cancellation.
        operation.then((value) => { if (cancelled) value.close(); }, () => {});
        try {
          bitmap = await waitForOperation(operation, { signal: options.signal, timeoutMilliseconds: 30000,
            timeoutMessage: 'Tiempo agotado al decodificar la imagen' });
        } catch (error) { cancelled = true; throw error; }
      } else if (typeof Image === 'function' && typeof document !== 'undefined') {
        url = URL.createObjectURL(blob);
        bitmap = new Image();
        const image = bitmap;
        await waitForOperation(new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('El navegador no puede decodificar esta imagen'));
          image.src = url;
        }), { signal: options.signal, timeoutMilliseconds: 30000 });
      } else {
        throw new Error('Este navegador no dispone de un decodificador de imágenes');
      }
      ensureNotAborted(options.signal);
      const width = Number(bitmap.naturalWidth || bitmap.width);
      const height = Number(bitmap.naturalHeight || bitmap.height);
      const maxPixels = Number(options.maxPixels) || 40 * 1000 * 1000;
      if (!width || !height || width * height > maxPixels || width > 32767 || height > 32767) {
        throw new Error('La imagen es demasiado grande para copiarla sin reducirla (máximo 40 megapíxeles)');
      }
      const sourceMime = normalizeMime(blob.type);
      let output = blob;
      if (sourceMime !== 'image/png') {
        canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No se pudo preparar el lienzo PNG');
        context.drawImage(bitmap, 0, 0);
        output = await waitForOperation(new Promise((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error('No se pudo convertir la imagen a PNG')), 'image/png');
        }), { signal: options.signal, timeoutMilliseconds: 30000 });
      }
      ensureNotAborted(options.signal);
      if (output.size > maxSourceBytes) throw new Error('El PNG supera el límite de memoria por imagen (64 MiB)');
      return { blob: output, width, height, sourceMime, converted: sourceMime !== 'image/png' };
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      else if (bitmap) { bitmap.onload = null; bitmap.onerror = null; bitmap.src = ''; }
      if (url) URL.revokeObjectURL(url);
      if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }

  /** Prepare a queue in RAM. This path has no clipboard writes, saves, ZIPs or downloads. */
  async function prepareImageClipboard(data, options = {}) {
    ensureNotAborted(options.signal);
    const convertImage = options.convertImageImpl || imageToClipboardPng;
    const maxTotalBytes = Number(options.maxTotalBytes) || 256 * 1024 * 1024;
    const imageRecords = exportRecords(data).filter((record) => (record.media || []).some(isClipboardImage));
    if (!imageRecords.length) return { files: [], failures: [], warnings: [], foundCount: 0,
      downloadedCount: 0, totalBytes: 0, rawMessageCount: 0, missingCount: 0, expectedCount: 0 };
    let totalBytes = 0;
    const collection = await collectMediaFiles(data, {
      ...options,
      concurrency: 1,
      candidateFilter(candidate) {
        if (!isClipboardImage(candidate)) return false;
        // Raw records share coarse timestamps. An adjacent, unselected photo must not
        // be matched merely because it is close in time to a selected photo.
        if (!candidate.raw || candidate.albumMember) return true;
        if (normalizeMessageId(candidate.recordId) === candidate.shortId) return true;
        return (candidate.record.media || []).some((media) =>
          normalizeMessageId(media.domMessageId || media.shortId || media.fullId) === candidate.shortId);
      },
      // Load only image-related history if the active model already covers the images.
      loadingRecords: imageRecords,
      async transformFile(file) {
        ensureNotAborted(options.signal);
        if (options.isCurrent && !options.isCurrent()) throw createAbortError();
        const converted = await convertImage(file.blob, options);
        ensureNotAborted(options.signal);
        if (!converted || !isBlobLike(converted.blob) || normalizeMime(converted.blob.type) !== 'image/png') {
          throw new Error('No se pudo obtener una imagen PNG válida');
        }
        if (totalBytes + converted.blob.size > maxTotalBytes) {
          throw new Error('Límite de memoria de la cola alcanzado. Reduce el rango o excluye imágenes y vuelve a prepararlo');
        }
        totalBytes += converted.blob.size;
        return { ...file, ...converted, mime: 'image/png', size: converted.blob.size };
      },
    });
    ensureNotAborted(options.signal);
    if (options.isCurrent && !options.isCurrent()) throw createAbortError();
    const order = new Map(imageRecords.map((record, index) => [record.id, index]));
    collection.files.sort((a, b) => (order.get(a.recordId) ?? Infinity) - (order.get(b.recordId) ?? Infinity));
    let missingCount = 0;
    const excluded = exclusionIds(data);
    for (const record of imageRecords) {
      const known = [...collection.files, ...collection.failures].filter((item) => item.recordId === record.id).length;
      const allMedia = record.media || [];
      const imageCount = allMedia.filter(item => isClipboardImage(item)
        && !excluded.has(ownMediaId(item, record))).length;
      const extraSlots = Math.max(0, Number(record.albumCount || 0) - allMedia.length);
      const expected = imageCount + extraSlots;
      missingCount += Math.max(0, expected - known);
    }
    const expectedCount = collection.files.length + collection.failures.length + missingCount;
    if (missingCount) collection.warnings.push(`${missingCount} imagen(es) del rango no se pudieron localizar, incluidas posibles fotos ocultas de álbumes. La cola no está completa`);
    if (collection.files.some((file) => file.converted && !/^image\/(?:jpeg|jpg)$/.test(file.sourceMime))) {
      collection.warnings.push('Las imágenes animadas (GIF/WebP/stickers) se copian como un fotograma estático');
    }
    return { ...collection, missingCount, expectedCount };
  }

  /** Exactly one binary item per explicit click; no text or download fallback. */
  async function copyPngImage(file, options = {}) {
    ensureNotAborted(options.signal);
    if (!file || !isBlobLike(file.blob) || !file.blob.size || normalizeMime(file.blob.type) !== 'image/png') {
      throw new Error('Primero prepara una imagen PNG válida');
    }
    const clipboard = options.clipboard || (typeof navigator !== 'undefined' ? navigator.clipboard : null);
    const Item = options.ClipboardItemImpl || (typeof ClipboardItem === 'function' ? ClipboardItem : null);
    if (!clipboard || typeof clipboard.write !== 'function' || !Item) {
      throw new Error('El portapapeles de imágenes no está disponible en este navegador');
    }
    if (typeof Item.supports === 'function' && !Item.supports('image/png')) {
      throw new Error('El navegador no permite copiar imágenes PNG');
    }
    // Called synchronously before any await, retaining the click's user activation.
    const operation = clipboard.write([new Item({ 'image/png': file.blob })]);
    await waitForOperation(operation, { signal: options.signal, timeoutMilliseconds: 30000,
      timeoutMessage: 'El portapapeles no respondió. Vuelve a pulsar Copiar' });
  }

  class ImageClipboardQueue {
    constructor(files) {
      this.files = Array.from(files || []);
      this.cursor = 0;
      this.lastCopiedIndex = -1;
      this.busy = false;
      this.closed = false;
    }
    get length() { return this.files.length; }
    get current() { return this.closed ? null : this.files[this.cursor] || null; }
    get lastCopied() { return this.closed ? null : this.files[this.lastCopiedIndex] || null; }
    copyNext(options = {}) { return this.copyAt(this.cursor, true, options); }
    copyLast(options = {}) { return this.copyAt(this.lastCopiedIndex, false, options); }
    async copyAt(index, advance, options) {
      if (this.closed) throw new Error('La cola de imágenes está cerrada');
      if (this.busy) throw new Error('Ya hay una copia en curso');
      ensureNotAborted(options.signal);
      if (options.isCurrent && !options.isCurrent()) throw createAbortError();
      const file = this.files[index];
      if (!file) throw new Error(advance ? 'No quedan imágenes pendientes' : 'Todavía no se ha copiado ninguna imagen');
      const total = this.length;
      this.busy = true;
      try {
        await copyPngImage(file, options);
        ensureNotAborted(options.signal);
        if (this.closed || (options.isCurrent && !options.isCurrent())) throw createAbortError();
        if (advance) this.cursor = index + 1;
        this.lastCopiedIndex = index;
        return { file, index: index + 1, total };
      } finally { this.busy = false; }
    }
    close() {
      this.closed = true;
      this.files.length = 0;
      this.cursor = 0;
      this.lastCopiedIndex = -1;
      // Do not clear the system clipboard; its last explicitly copied image remains there.
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function downloadText(content, filename, mime) {
    downloadBlob(new Blob([content], { type: mime }), filename);
  }

  async function copyText(content, htmlContent) {
    if (htmlContent && navigator.clipboard && typeof ClipboardItem === 'function') {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([content], { type: 'text/plain' }),
          'text/html': new Blob([htmlContent], { type: 'text/html' }),
        })]);
        return;
      } catch (_error) {
        // Fall through to plain text copying.
      }
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(content);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) {
      throw new Error('El navegador no permitió copiar al portapapeles');
    }
  }

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        format: ['txt', 'csv', 'json', 'html'].includes(parsed.format) ? parsed.format : 'txt',
        dateOrder: ['auto', 'DMY', 'MDY', 'YMD'].includes(parsed.dateOrder) ? parsed.dateOrder : 'auto',
        loadOlderFromPhone: Boolean(parsed.loadOlderFromPhone),
        mediaMode: ['none', 'separate', 'zip', 'zip-ultra'].includes(parsed.mediaMode) ? parsed.mediaMode : 'none',
      };
    } catch (_error) {
      return { format: 'txt', dateOrder: 'auto', loadOlderFromPhone: false, mediaMode: 'none' };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_error) {
      // Storage may be unavailable in private mode. The script still works.
    }
  }

  function ensurePageStyle() {
    if (document.getElementById(GLOBAL_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = GLOBAL_STYLE_ID;
    style.textContent = `
      .${PICK_CLASS}{outline:3px solid #00a884!important;outline-offset:3px!important;border-radius:9px!important;cursor:crosshair!important}
      .${EXCLUDED_CLASS}{outline:3px dashed #d13f45!important;outline-offset:2px!important;border-radius:9px!important}
      body.wa-range-exporter-picking,body.wa-range-exporter-picking *{cursor:crosshair!important}
    `;
    document.head.appendChild(style);
  }

  /** Render a single-choice control as visible, accessible buttons, never a select. */
  function choiceGroupTemplate(role, label, choices, selectedValue, variant = '') {
    const current = choices.some(([value]) => value === selectedValue) ? selectedValue : choices[0][0];
    return `<div class="choice-group ${escapeHtml(variant)}" data-role="${escapeHtml(role)}" data-value="${escapeHtml(current)}" role="radiogroup" aria-label="${escapeHtml(label)}" aria-disabled="false">
      ${choices.map(([value, text]) => `<button type="button" class="choice" role="radio" data-value="${escapeHtml(value)}" aria-checked="${value === current}" tabindex="${value === current ? '0' : '-1'}">${escapeHtml(text)}</button>`).join('')}
    </div>`;
  }

  /**
   * Preserve the value/disabled/change contract used by the existing panel.
   * Programmatic value changes update the highlight without emitting change,
   * just like the old control. No hidden select or duplicated input state exists.
   */
  function bindChoiceGroup(group) {
    const buttons = Array.from(group.querySelectorAll('button[data-value]'));
    if (!buttons.length) return;
    let disabled = false;
    const render = () => {
      for (const button of buttons) {
        const selected = button.dataset.value === group.dataset.value;
        button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected && !disabled ? 0 : -1;
        button.disabled = disabled;
      }
      group.setAttribute('aria-disabled', String(disabled));
    };
    Object.defineProperties(group, {
      value: {
        configurable: true,
        get: () => group.dataset.value,
        set: (value) => {
          if (!buttons.some((button) => button.dataset.value === String(value))) return;
          group.dataset.value = String(value);
          render();
        },
      },
      disabled: {
        configurable: true,
        get: () => disabled,
        set: (value) => { disabled = Boolean(value); render(); },
      },
    });
    const choose = (button, focus = false) => {
      if (disabled || !button || button.disabled) return;
      const changed = group.value !== button.dataset.value;
      group.value = button.dataset.value;
      if (focus) button.focus();
      if (changed) {
        const EventClass = group.ownerDocument.defaultView.Event;
        group.dispatchEvent(new EventClass('input', { bubbles: true }));
        group.dispatchEvent(new EventClass('change', { bubbles: true }));
      }
    };
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (buttons.includes(button)) choose(button);
    });
    group.addEventListener('keydown', (event) => {
      if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
      const button = event.target.closest('button[data-value]');
      const index = buttons.indexOf(button);
      if (index < 0) return;
      let next;
      switch (event.key) {
        case 'ArrowRight': case 'ArrowDown': next = (index + 1) % buttons.length; break;
        case 'ArrowLeft': case 'ArrowUp': next = (index + buttons.length - 1) % buttons.length; break;
        case 'Home': next = 0; break;
        case 'End': next = buttons.length - 1; break;
        default: return; // Enter and Space retain the native button click behavior.
      }
      event.preventDefault();
      event.stopPropagation();
      choose(buttons[next], true);
    });
    render();
  }

  function uiTemplate(settings) {
    return `
<style>
:host{all:initial;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111b21;line-height:1.35}*{box-sizing:border-box}button,input{font:inherit}.toggle{position:fixed;right:18px;bottom:88px;width:52px;height:52px;border:0;border-radius:50%;background:#00a884;color:#fff;font-size:25px;box-shadow:0 6px 24px #0005;cursor:pointer;z-index:2147483647}.toggle:hover{background:#008f72}.panel{position:fixed;right:18px;bottom:150px;width:min(430px,calc(100vw - 24px));max-height:min(790px,calc(100vh - 170px));overflow:auto;background:#f7f9fa;border:1px solid #d8e0e3;border-radius:16px;box-shadow:0 14px 48px #0005;z-index:2147483647}.panel[hidden]{display:none}.head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff;padding:14px 16px;border-bottom:1px solid #e5e9eb;z-index:2}.head h2{font-size:16px;margin:0}.close{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#54656f}.body{padding:14px}.hint{font-size:12px;color:#54656f;margin:0 0 12px}.endpoint{background:#fff;border:1px solid #e2e7e9;border-radius:12px;padding:11px;margin-bottom:10px}.endpoint-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.endpoint-title strong{font-size:13px}.mode-area{margin-top:8px}.pick{width:100%;border:0;border-radius:8px;padding:9px 10px;background:#e7fce9;color:#006c52;font-weight:650;cursor:pointer}.pick:hover{background:#d5f8dc}.selection{display:block;margin-top:7px;font-size:11px;color:#54656f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.date-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:7px}.date-grid input{width:100%;min-width:0;border:1px solid #cbd5d9;border-radius:8px;padding:8px;background:#fff}.options{display:grid;gap:9px;background:#fff;border:1px solid #e2e7e9;border-radius:12px;padding:11px;margin-bottom:10px}.option-row{display:grid;min-width:0;gap:7px;font-size:12px}.option-label{font-weight:650}.checkbox{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#3b4a54}.checkbox input{margin-top:2px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.primary{grid-column:1/-1;border:0;border-radius:9px;padding:10px;background:#00a884;color:#fff;font-weight:700;cursor:pointer}.primary:hover{background:#008f72}.secondary,.danger{border:1px solid #cbd5d9;border-radius:9px;padding:9px;background:#fff;cursor:pointer}.secondary:disabled,.primary:disabled{opacity:.45;cursor:not-allowed}.danger{color:#c62828;border-color:#efb9b9}.status{margin-top:10px;padding:9px 10px;border-radius:9px;background:#e9edef;color:#3b4a54;font-size:12px;min-height:34px}.status.error{background:#ffe7e7;color:#8b1a1a}.status.success{background:#e4f8eb;color:#006c52}.status.warning{background:#fff2dd;color:#7d3616}.status.warning{background:#fff3d6;color:#704a00}.progress{height:4px;background:#dfe5e7;border-radius:999px;overflow:hidden;margin-top:7px}.progress>span{display:block;width:35%;height:100%;background:#00a884;border-radius:999px;animation:move 1.1s linear infinite}.progress[hidden]{display:none}@keyframes move{from{transform:translateX(-110%)}to{transform:translateX(330%)}}.privacy{font-size:10px;color:#667781;margin:10px 2px 0}.hidden{display:none!important}@media(max-width:500px){.panel{right:12px;bottom:140px;max-height:calc(100vh - 154px)}.toggle{right:12px;bottom:78px}}
.exclusions{background:#fff;border:1px solid #e2e7e9;border-radius:12px;padding:11px;margin-bottom:10px}.exclusion-head{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13px;margin-bottom:8px}.exclusion-actions{display:flex;gap:7px}.exclusion-actions button{flex:1}.excluded-list{max-height:130px;overflow:auto;margin-top:7px}.excluded-row{display:flex;align-items:center;gap:6px;border-top:1px solid #e9edef;padding:6px 0;font-size:11px}.excluded-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.excluded-row button{border:0;background:#fce9e9;color:#922b2b;border-radius:5px;padding:5px 7px;cursor:pointer}.exclusion-help{margin:7px 0 0;font-size:11px;color:#54656f}.pick-tray{position:fixed;right:18px;bottom:150px;width:min(430px,calc(100vw - 24px));padding:12px;background:#fff;border:2px solid #d13f45;border-radius:12px;box-shadow:0 6px 24px #0004;z-index:2147483647;font-size:12px}.pick-tray p{margin:0 0 8px}.pick-tray button{width:100%}button:disabled{opacity:.45;cursor:not-allowed}
.clipboard-action{grid-column:1/-1;color:#006c52;font-weight:650}.image-clipboard{margin-top:12px;border:1px solid #94cdbb;border-radius:12px;background:#fff;padding:11px}.image-head{display:flex;justify-content:space-between;gap:8px;font-size:13px;margin-bottom:8px}.image-preview{display:block;max-width:100%;max-height:160px;width:100%;height:160px;margin:8px auto;object-fit:contain;border-radius:6px}.image-name{font-size:11px;color:#54656f;overflow-wrap:anywhere;margin:8px 0}.image-note{font-size:11px;color:#54656f;margin:9px 0 0}.image-issues{font-size:11px;margin-top:8px;color:#8b391a}.image-issues pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:130px;overflow:auto;font:inherit}.image-count{white-space:normal;text-align:right;max-width:58%;overflow-wrap:anywhere}.image-clipboard button{min-width:0;font-size:12px}.image-clipboard img[hidden]{display:none}
.choice-group{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;min-width:0}
.choice-group.kind{grid-template-columns:repeat(3,minmax(0,1fr))}
.choice-group.format-choices{grid-template-columns:repeat(4,minmax(0,1fr))}
.choice{appearance:none;min-width:0;min-height:40px;padding:8px 7px;border:1px solid #cbd5d9;border-radius:8px;background:#fff;color:#3b4a54;font-size:12px;font-weight:600;line-height:1.3;text-align:center;white-space:normal;overflow-wrap:break-word;cursor:pointer;touch-action:manipulation}
.choice:hover:not(:disabled){background:#f0f7f4;border-color:#8cb9aa}
.choice[aria-checked="true"]{background:#dff5eb;border-color:#008867;color:#00583f;box-shadow:inset 0 0 0 1px #008867}
.choice:focus-visible,.image-issues-toggle:focus-visible{outline:3px solid #1674aa;outline-offset:2px}
.choice:disabled{opacity:.5;cursor:not-allowed}
.image-issues-toggle{width:100%;min-height:36px;border:1px solid #dfb690;border-radius:7px;background:#fff7ee;color:#7d3616;padding:7px;text-align:left;cursor:pointer}
.image-issues-toggle::before{content:'+';display:inline-block;width:16px;font-weight:700}
.image-issues-toggle[aria-expanded="true"]::before{content:'−'}
@media(max-width:380px){.choice-group.kind{grid-template-columns:repeat(2,minmax(0,1fr))}.choice-group.kind .choice:last-child{grid-column:1/-1}.choice-group.format-choices{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(prefers-reduced-motion:reduce){.progress>span{animation:none}}
</style>
<button class="toggle" data-role="toggle" title="Exportar rango de mensajes" aria-label="Exportar rango de mensajes">⇩</button>
<section class="panel" data-role="panel" hidden>
  <header class="head"><h2>Exportar rango de mensajes</h2><button class="close" data-role="close" aria-label="Cerrar">×</button></header>
  <div class="body">
    <p class="hint">Cada límite puede ser un mensaje elegido, una fecha y hora, o el principio/final disponible.</p>
    ${endpointTemplate('start', 'Desde', 'message')}
    ${endpointTemplate('end', 'Hasta', 'none')}
    <section class="exclusions">
      <div class="exclusion-head"><strong>Excluir mensajes</strong><span data-role="excluded-count" aria-live="polite">0 seleccionados</span></div>
      <div class="exclusion-actions"><button class="secondary" data-role="pick-exclude">Seleccionar mensajes</button><button class="secondary" data-role="clear-exclusions" disabled>Restablecer</button></div>
      <div class="excluded-list" data-role="excluded-list"></div>
      <p class="exclusion-help">Clic para excluir o reincluir. No borra nada del chat. Un álbum seleccionado excluye todas sus fotos.</p>
    </section>
    <section class="options">
      <div class="option-row"><span class="option-label">Formato</span>
        ${choiceGroupTemplate('format', 'Formato', [['txt', 'TXT legible'], ['csv', 'CSV'], ['json', 'JSON'], ['html', 'HTML visual']], settings.format, 'format-choices')}
      </div>
      <div class="option-row"><span class="option-label">Orden de fecha</span>
        ${choiceGroupTemplate('date-order', 'Orden de fecha', [['auto', 'Automático'], ['DMY', 'Día / mes / año'], ['MDY', 'Mes / día / año'], ['YMD', 'Año / mes / día']], settings.dateOrder)}
      </div>
      <div class="option-row"><span class="option-label">Incluir adjuntos</span>
        ${choiceGroupTemplate('media-mode', 'Incluir adjuntos', [['none', 'No, solo mensajes'], ['separate', 'Sí, separados'], ['zip', 'Sí, un ZIP'], ['zip-ultra', 'Sí, ZIP ultracomprimido']], settings.mediaMode)}
      </div>
      <label class="checkbox"><input type="checkbox" data-role="load-older"${settings.loadOlderFromPhone ? ' checked' : ''}><span>Intentar pulsar “cargar mensajes antiguos desde el teléfono” al llegar arriba</span></label>
    </section>
    <div class="actions">
      <button class="primary" data-role="scan">Recopilar rango</button>
      <button class="secondary" data-role="copy" disabled>Copiar</button>
      <button class="secondary" data-role="download" disabled>Descargar</button>
      <button class="secondary clipboard-action" data-role="copy-images" disabled title="Preparar las imágenes del rango para copiarlas una a una; no descarga archivos">Copiar imágenes</button>
      <button class="danger hidden" data-role="cancel">Cancelar</button>
    </div>
    <section class="image-clipboard hidden" data-role="image-queue" aria-label="Cola de imágenes al portapapeles">
      <div class="image-head"><strong>Imágenes al portapapeles</strong><span class="image-count" data-role="image-count" aria-live="polite"></span></div>
      <img class="image-preview" data-role="image-preview" alt="Vista previa de la próxima imagen de la cola" hidden>
      <p class="image-name" data-role="image-name"></p>
      <div class="actions">
        <button class="primary" data-role="image-next" disabled>Copiar 1 de N</button>
        <button class="secondary" data-role="image-again" disabled>Volver a copiar</button>
        <button class="secondary" data-role="image-close">Cerrar cola</button>
      </div>
      <p class="image-note" data-role="image-note"></p>
      <section class="image-issues" data-role="image-issues" hidden>
        <button type="button" class="image-issues-toggle" data-role="image-issues-toggle" aria-expanded="false" aria-controls="wa-range-exporter-image-issues-text">Mostrar avisos de imágenes</button>
        <pre id="wa-range-exporter-image-issues-text" data-role="image-issues-text" hidden></pre>
      </section>
    </section>
    <div class="status" data-role="status">Abre un chat y selecciona los dos límites</div>
    <div class="progress" data-role="progress" hidden><span></span></div>
    <p class="privacy">Todo se procesa dentro de tu navegador. Los adjuntos originales se solicitan a la sesión abierta de WhatsApp; cuando no están disponibles, se registra el fallo sin sustituirlos silenciosamente por una miniatura.</p>
  </div>
</section>
<div class="pick-tray hidden" data-role="exclusion-tray"><p data-role="exclusion-tray-label" aria-live="polite">Haz clic en los mensajes que quieras excluir</p><button class="secondary" data-role="finish-exclusions">Terminar selección</button></div>`;
  }

  function endpointTemplate(key, title, selectedKind) {
    return `<section class="endpoint" data-endpoint="${key}">
      <div class="endpoint-title"><strong>${title}</strong></div>
      ${choiceGroupTemplate(`${key}-kind`, title, [
        ['message', 'Mensaje seleccionado'],
        ['date', 'Fecha y hora'],
        ['none', key === 'start' ? 'Primer mensaje disponible' : 'Último mensaje disponible'],
      ], selectedKind, 'kind')}
      <div class="mode-area" data-mode="message">
        <button class="pick" data-role="pick-${key}">Elegir ${key === 'start' ? 'mensaje inicial' : 'mensaje final'}</button>
        <span class="selection" data-role="${key}-selection">Ningún mensaje elegido</span>
      </div>
      <div class="mode-area hidden" data-mode="date">
        <div class="date-grid"><input type="date" data-role="${key}-date"><input type="time" data-role="${key}-time" step="60"></div>
      </div>
    </section>`;
  }

  function mountUI() {
    if (!document.body) {
      return null;
    }
    const existing = document.getElementById(HOST_ID);
    if (existing) {
      return existing;
    }

    ensurePageStyle();
    const settings = loadSettings();
    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = uiTemplate(settings);
    for (const group of shadow.querySelectorAll('.choice-group')) bindChoiceGroup(group);
    document.body.appendChild(host);

    const refs = {};
    for (const role of [
      'toggle', 'panel', 'close', 'format', 'date-order', 'media-mode', 'load-older', 'scan', 'copy', 'download', 'cancel',
      'status', 'progress', 'start-kind', 'end-kind', 'pick-start', 'pick-end', 'start-selection', 'end-selection',
      'start-date', 'end-date', 'start-time', 'end-time',
      'pick-exclude', 'clear-exclusions', 'excluded-count', 'excluded-list',
      'exclusion-tray', 'exclusion-tray-label', 'finish-exclusions',
      'copy-images', 'image-queue', 'image-count', 'image-preview', 'image-name',
      'image-next', 'image-again', 'image-close', 'image-note', 'image-issues', 'image-issues-text', 'image-issues-toggle',
    ]) {
      refs[role] = shadow.querySelector(`[data-role="${role}"]`);
    }

    const state = {
      open: false,
      picking: null,
      hoverRoot: null,
      selections: { start: null, end: null },
      exclusions: new Map(),
      imageQueue: null,
      imageQueueResult: null,
      imagePreviewUrl: null,
      imageReport: null,
      chatKey: currentChatKey(),
      result: null,
      mediaCollection: null,
      abortController: null,
      scanning: false,
    };

    function setOpen(open) {
      state.open = Boolean(open);
      refs.panel.hidden = !state.open;
    }

    function setStatus(message, kind = '') {
      if (kind === 'success' && state.result && state.result.partial) {
        kind = 'warning';
        message += ' AVISO: exportación parcial; no se confirmó todo el rango.';
      }
      refs.status.textContent = message;
      refs.status.className = `status${kind ? ` ${kind}` : ''}`;
    }

    function setBusy(busy) {
      state.scanning = busy;
      refs.scan.disabled = busy;
      const empty = !state.result || exportRecords(state.result).length === 0;
      refs.copy.disabled = busy || empty;
      refs.download.disabled = busy || empty;
      refs['copy-images'].disabled = busy || empty;
      refs['image-next'].disabled = busy || !state.imageQueue || !state.imageQueue.current;
      refs['image-again'].disabled = busy || !state.imageQueue || !state.imageQueue.lastCopied;
      refs['image-close'].disabled = busy;
      refs['pick-exclude'].disabled = busy;
      refs['clear-exclusions'].disabled = busy || !state.exclusions.size;
      for (const control of shadow.querySelectorAll('.endpoint input,.endpoint button,.excluded-row button')) control.disabled = busy;
      for (const role of ['start-kind', 'end-kind', 'format', 'date-order', 'media-mode']) refs[role].disabled = busy;
      refs['load-older'].disabled = busy;
      refs.cancel.classList.toggle('hidden', !busy);
      refs.progress.hidden = !busy;
    }

    function endpointContainer(key) {
      return shadow.querySelector(`[data-endpoint="${key}"]`);
    }

    function refreshEndpointMode(key) {
      const kind = refs[`${key}-kind`].value;
      const container = endpointContainer(key);
      for (const area of container.querySelectorAll('[data-mode]')) {
        area.classList.toggle('hidden', area.getAttribute('data-mode') !== kind);
      }
    }

    function selectionLabel(selection) {
      if (!selection) {
        return 'Ningún mensaje elegido';
      }
      const when = selection.timestamp ? formatLocalDateTime(selection.timestamp) : (selection.timeText || 'fecha sin determinar');
      return `${when} · ${selection.author || 'Autor desconocido'} · ${selection.preview || '[Mensaje]'}`;
    }

    function updateSelection(key) {
      refs[`${key}-selection`].textContent = selectionLabel(state.selections[key]);
      refs[`${key}-selection`].title = selectionLabel(state.selections[key]);
    }


    function currentChatKey() {
      try {
        const wpp = typeof WPP !== 'undefined' ? WPP : null;
        const active = wpp && wpp.chat && typeof wpp.chat.getActiveChat === 'function' ? wpp.chat.getActiveChat() : null;
        const id = serializeWid(active && (active.id || active.__x_id));
        if (id) return `id:${id}`;
      } catch (_error) { /* Fall back to the header until WA-JS is ready. */ }
      return `title:${getChatTitle()}`;
    }

    function syncChatContext() {
      const key = currentChatKey();
      if (key === state.chatKey) return false;
      state.chatKey = key;
      if (state.abortController) state.abortController.abort();
      finishPicking();
      state.exclusions.clear();
      state.result = null;
      state.mediaCollection = null;
      state.selections = { start: null, end: null };
      updateSelection('start'); updateSelection('end');
      refreshExclusions();
      setStatus('Chat cambiado. Se han limpiado los límites elegidos y las exclusiones');
      return true;
    }

    function paintExclusions() {
      const scroller = findScroller();
      const ids = exclusionIds({ excludedMessages: Array.from(state.exclusions.values()) });
      for (const root of document.querySelectorAll(`${MESSAGE_SELECTOR}, .${EXCLUDED_CLASS}`)) {
        const id = root.getAttribute('data-id') || (root.getAttribute('data-testid') || '').replace(/^conv-msg-/, '');
        root.classList.toggle(EXCLUDED_CLASS, Boolean(scroller && scroller.contains(root) && ids.has(normalizeMessageId(id))));
      }
    }

    function refreshExclusions() {
      clearImageQueue();
      const size = state.exclusions.size;
      refs['excluded-count'].textContent = `${size} seleccionado${size === 1 ? '' : 's'}`;
      refs['exclusion-tray-label'].textContent = `${size} excluido${size === 1 ? '' : 's'}. Clic para alternar; Esc o Terminar para volver.`;
      refs['excluded-list'].replaceChildren();
      for (const [id, record] of state.exclusions) {
        const row = document.createElement('div'); row.className = 'excluded-row';
        const label = document.createElement('span');
        label.textContent = `${record.author || 'Mensaje'} · ${normalizeInline(recordContent(record)).slice(0, 110)}`;
        label.title = label.textContent;
        const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = 'Reincluir';
        undo.setAttribute('aria-label', `Reincluir ${label.textContent}`);
        undo.addEventListener('click', () => {
          if (state.scanning || syncChatContext()) return;
          state.exclusions.delete(id); refreshExclusions(); exclusionStatus();
        });
        row.append(label, undo); refs['excluded-list'].appendChild(row);
      }
      if (state.result) state.result.excludedMessages = Array.from(state.exclusions.values());
      state.mediaCollection = null; // Never export a cache made before an exclusion change.
      paintExclusions();
      setBusy(state.scanning);
    }

    function clearImageQueue() {
      if (state.imageQueue) state.imageQueue.close();
      state.imageQueue = null;
      state.imageQueueResult = null;
      state.imageReport = null;
      if (state.imagePreviewUrl) URL.revokeObjectURL(state.imagePreviewUrl);
      state.imagePreviewUrl = null;
      refs['image-preview'].removeAttribute('src');
      refs['image-queue'].classList.add('hidden');
      refs['image-issues-text'].textContent = '';
      refs['image-issues-text'].hidden = true;
      refs['image-issues-toggle'].setAttribute('aria-expanded', 'false');
      refs['image-issues-toggle'].textContent = 'Mostrar avisos de imágenes';
    }

    function invalidateRange() {
      clearImageQueue();
      state.result = null;
      state.mediaCollection = null;
      setBusy(state.scanning);
      setStatus('Rango modificado. Pulsa Recopilar rango antes de copiar o exportar');
    }

    function refreshImageQueue() {
      const queue = state.imageQueue;
      if (!queue || queue.closed) { refs['image-queue'].classList.add('hidden'); return; }
      const report = state.imageReport;
      refs['image-queue'].classList.remove('hidden');
      const unavailable = Number(report && report.missingCount || 0) + (report && report.failures || []).length;
      const expected = Math.max(Number(report && report.expectedCount || 0), queue.length + unavailable);
      refs['image-count'].textContent = `${queue.cursor}/${expected} copiadas${unavailable ? ` · ${unavailable} no disponible${unavailable === 1 ? '' : 's'}` : ''}`;
      refs['image-next'].textContent = queue.current
        ? (queue.cursor ? `Copiar siguiente (${queue.cursor + 1} de ${queue.length})` : `Copiar 1 de ${queue.length}`)
        : (unavailable ? (queue.length ? 'Copiadas las disponibles' : 'Sin imágenes disponibles') : (queue.length ? 'Todas copiadas' : 'No hay imágenes'));
      refs['image-again'].textContent = queue.lastCopied ? `Volver a copiar ${queue.lastCopiedIndex + 1}` : 'Volver a copiar';
      const file = queue.current || queue.lastCopied;
      if (state.imagePreviewUrl) URL.revokeObjectURL(state.imagePreviewUrl);
      state.imagePreviewUrl = file ? URL.createObjectURL(file.blob) : null;
      if (state.imagePreviewUrl) refs['image-preview'].src = state.imagePreviewUrl;
      else refs['image-preview'].removeAttribute('src');
      refs['image-preview'].hidden = !file;
      refs['image-name'].textContent = file
        ? `${queue.current ? 'Próxima' : 'Última copiada'}: ${file.filename || 'Imagen'} · ${file.width} × ${file.height}` : 'No hay imágenes disponibles';
      const issues = [
        ...(report && report.warnings || []),
        ...(report && report.failures || []).map((item) => `${item.filename || item.shortId || 'Imagen'}: ${item.error}`),
      ];
      refs['image-issues'].hidden = !issues.length;
      refs['image-issues-text'].textContent = issues.join('\n');
      refs['image-note'].textContent = (unavailable ? `Cola incompleta: ${unavailable} de ${expected} imágenes no están disponibles. ` : '') + 'Pega con Ctrl+V (o ⌘V) antes de copiar la siguiente. No se detecta el pegado en otra aplicación. Solo imágenes, sin texto, archivos en disco ni ZIP.';
      setBusy(state.scanning);
    }

    async function runPrepareImages() {
      if (state.scanning || syncChatContext()) return;
      finishPicking();
      if (!state.result || !exportRecords(state.result).length) return;
      clearImageQueue();
      const result = state.result;
      const chatKey = currentChatKey();
      const controller = new AbortController();
      const isCurrent = () => state.result === result && currentChatKey() === chatKey;
      state.abortController = controller;
      setBusy(true);
      setStatus('Preparando imágenes en memoria. El portapapeles todavía no cambia');
      try {
        const collection = await prepareImageClipboard(result, {
          signal: controller.signal, isCurrent,
          onProgress(progress) {
            if (controller.signal.aborted || !isCurrent()) return;
            const total = Number(progress.total) || 0;
            setStatus(total
              ? `Preparando imágenes en memoria: ${progress.completed}/${total} · ${progress.failed || 0} no disponibles`
              : 'Localizando imágenes del rango');
          },
        });
        ensureNotAborted(controller.signal);
        if (!isCurrent()) throw createAbortError();
        state.imageQueue = new ImageClipboardQueue(collection.files);
        state.imageQueueResult = result;
        state.imageReport = { warnings: collection.warnings, failures: collection.failures,
          missingCount: collection.missingCount, expectedCount: collection.expectedCount, totalBytes: collection.totalBytes };
        if (collection.failures.length || collection.missingCount) {
          refs['image-issues-text'].hidden = false;
          refs['image-issues-toggle'].setAttribute('aria-expanded', 'true');
          refs['image-issues-toggle'].textContent = 'Ocultar avisos de imágenes';
        }
        refreshImageQueue();
        const missing = collection.failures.length + collection.missingCount;
        setStatus(collection.files.length
          ? `${collection.files.length} imágenes preparadas (${formatBytes(collection.totalBytes)}).${missing ? ` ${missing} no disponibles.` : ''} Pulsa Copiar 1 de ${collection.files.length}`
          : `No hay imágenes listas.${missing ? ` ${missing} no disponibles; revisa los avisos de la cola.` : ' No se encontraron imágenes en el rango incluido.'}`,
        missing ? '' : (collection.files.length ? 'success' : ''));
        refs.status.scrollIntoView({ block: 'end' });
      } catch (error) {
        clearImageQueue();
        setStatus(error && error.name === 'AbortError' ? 'Preparación de imágenes cancelada'
          : `No se pudieron preparar las imágenes: ${errorMessage(error)}`, error && error.name === 'AbortError' ? '' : 'error');
      } finally {
        if (state.abortController === controller) state.abortController = null;
        setBusy(false);
      }
    }

    async function runImageCopy(repeat = false) {
      if (state.scanning || syncChatContext()) return;
      const queue = state.imageQueue;
      const result = state.imageQueueResult;
      const chatKey = currentChatKey();
      if (!queue || queue.closed || !result || result !== state.result) return;
      const controller = new AbortController();
      const isCurrent = () => state.imageQueue === queue && state.result === result && currentChatKey() === chatKey;
      state.abortController = controller;
      setBusy(true);
      try {
        // No fetch/decode before write: each ready PNG is written inside the button click.
        const copied = await (repeat ? queue.copyLast({ signal: controller.signal, isCurrent })
          : queue.copyNext({ signal: controller.signal, isCurrent }));
        refreshImageQueue();
        const unavailable = Number(state.imageReport && state.imageReport.missingCount || 0)
          + (state.imageReport && state.imageReport.failures || []).length;
        setStatus(`Imagen ${copied.index} de ${copied.total} disponibles copiada. Pégala ahora en ChatGPT/Codex.${unavailable
          ? ` Cola incompleta: ${unavailable} imagen(es) no disponibles.`
          : !queue.current ? ' Es la última de la cola.' : ''}`, unavailable ? 'warning' : 'success');
      } catch (error) {
        if (isCurrent()) refreshImageQueue();
        const denied = error && error.name === 'NotAllowedError';
        setStatus(error && error.name === 'AbortError' ? 'Copia cancelada. Una escritura ya enviada al sistema podría haber terminado'
          : denied ? 'El navegador no permitió escribir en el portapapeles. Mantén esta pestaña activa, permite el acceso si lo solicita y vuelve a pulsar Copiar. La cola no ha avanzado'
          : `No se pudo copiar: ${errorMessage(error)}. No se ha descargado ningún archivo`, 'error');
      } finally {
        if (state.abortController === controller) state.abortController = null;
        setBusy(false);
      }
    }

    function exclusionStatus() {
      const included = state.result ? exportRecords(state.result).length : null;
      const removed = state.result ? state.result.records.length - included : 0;
      setStatus(included == null
        ? `${state.exclusions.size} mensajes marcados para excluir. No se borra nada de WhatsApp`
        : `${included} mensajes listos para exportar; ${removed} excluidos dentro del rango`, 'success');
    }

    function finishPicking() {
      if (state.hoverRoot) {
        state.hoverRoot.classList.remove(PICK_CLASS);
      }
      state.hoverRoot = null;
      state.picking = null;
      refs['exclusion-tray'].classList.add('hidden');
      document.body.classList.remove('wa-range-exporter-picking');
      document.removeEventListener('mousemove', onPickMove, true);
      document.removeEventListener('pointerdown', onPickPointerDown, true);
      document.removeEventListener('click', onPickClick, true);
      document.removeEventListener('keydown', onPickKeyDown, true);
    }

    function onPickMove(event) {
      if (!state.picking) {
        return;
      }
      const path = event.composedPath ? event.composedPath() : [];
      let candidate = path.find((node) => node && node.matches && node.matches(MESSAGE_SELECTOR))
        || (event.target && event.target.closest ? event.target.closest(MESSAGE_SELECTOR) : null);
      if (candidate && !(findScroller()?.contains(candidate))) candidate = null;
      if (state.hoverRoot && state.hoverRoot !== candidate) {
        state.hoverRoot.classList.remove(PICK_CLASS);
      }
      state.hoverRoot = candidate || null;
      if (state.hoverRoot) {
        state.hoverRoot.classList.add(PICK_CLASS);
      }
    }

    function inferPickedRecord(root, dateOrder) {
      const scroller=findScroller() || document;
      const collector=createCollector(dateOrder);
      collector.collect(scroller);
      const id=root.getAttribute('data-id') || (root.getAttribute('data-testid') || '').replace(/^conv-msg-/,'');
      return collector.finalize().find(r=>r.id===id) || extractMessageElement(root,{dateOrder});
    }

    function onPickPointerDown(event) {
      if (!state.picking || event.button !== 0) return;
      const root = event.target && event.target.closest ? event.target.closest(MESSAGE_SELECTOR) : null;
      if (!root || !findScroller()?.contains(root)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    }

    function onPickClick(event) {
      if (!state.picking) {
        return;
      }
      const path = event.composedPath ? event.composedPath() : [];
      const root = path.find((node) => node && node.matches && node.matches(MESSAGE_SELECTOR))
        || (event.target && event.target.closest ? event.target.closest(MESSAGE_SELECTOR) : null);
      if (!root || !findScroller()?.contains(root)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (syncChatContext() || state.scanning) return;
      const scroller = findScroller();
      const dateOrder = refs['date-order'].value;
      const record = inferPickedRecord(root, dateOrder);
      const key = state.picking;
      if (key === 'exclude') {
        const id = normalizeMessageId(record.id);
        if (!id || /^message-\d+$/.test(id)) {
          setStatus('Este mensaje no tiene un identificador estable para excluirlo', 'error'); return;
        }
        if (state.exclusions.has(id)) state.exclusions.delete(id);
        else state.exclusions.set(id, record);
        refreshExclusions(); exclusionStatus();
        return;
      }
      state.selections[key] = {
        messageId: record.id,
        timestamp: record.timestamp,
        dateKey: record.dateKey,
        timeText: record.timeText,
        author: record.author,
        preview: normalizeInline(recordContent(record)).slice(0, 100),
        positionHint: scroller ? scrollRatio(scroller) : null,
        chatTitle: getChatTitle(),
      };
      invalidateRange();
      refs[`${key}-kind`].value = 'message';
      updateSelection(key);
      refreshEndpointMode(key);
      finishPicking();
      setOpen(true);
      setStatus(`Mensaje de ${key === 'start' ? 'inicio' : 'fin'} seleccionado`, 'success');
    }

    function onPickKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        const excluding = state.picking === 'exclude';
        finishPicking(); setOpen(true);
        if (excluding) exclusionStatus(); else setStatus('Selección cancelada');
      }
    }

    function beginPicking(key) {
      if (state.scanning) return;
      syncChatContext();
      if (!findScroller()) {
        setStatus('Abre primero el chat que quieres exportar', 'error');
        return;
      }
      finishPicking();
      state.picking = key;
      document.body.classList.add('wa-range-exporter-picking');
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('pointerdown', onPickPointerDown, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKeyDown, true);
      setStatus(`Haz clic en el mensaje de ${key === 'start' ? 'inicio' : 'fin'}. Pulsa Esc para cancelar`);
      setOpen(false);
      if (key === 'exclude') {
        refs['exclusion-tray'].classList.remove('hidden');
        refreshExclusions(); exclusionStatus();
      }
    }

    function readEndpoint(key) {
      const kind = refs[`${key}-kind`].value;
      if (kind === 'none') {
        return { kind: 'none' };
      }
      if (kind === 'message') {
        const selection = state.selections[key];
        if (!selection) {
          throw new Error(`Elige el mensaje de ${key === 'start' ? 'inicio' : 'fin'}`);
        }
        if (selection.chatTitle && selection.chatTitle !== getChatTitle()) {
          throw new Error(`El mensaje de ${key === 'start' ? 'inicio' : 'fin'} pertenece a otro chat`);
        }
        return {
          kind: 'message',
          messageId: selection.messageId,
          timestamp: selection.timestamp,
          positionHint: selection.positionHint,
        };
      }
      const date = parseDateBoundary(refs[`${key}-date`].value, refs[`${key}-time`].value, key);
      return { kind: 'date', timestamp: date.getTime() };
    }

    function persistOptions() {
      saveSettings({
        format: refs.format.value,
        dateOrder: refs['date-order'].value,
        mediaMode: refs['media-mode'].value,
        loadOlderFromPhone: refs['load-older'].checked,
      });
    }

    function operationProgressLabel(progress) {
      const current = normalizeInline(progress && progress.current || progress && progress.currentFile || '').slice(0, 70);
      if (Number.isFinite(progress && progress.percent)) {
        const percent = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(progress.percent);
        return `${progress.phase || 'Procesando'}: ${percent}%${current ? ` · ${current}` : ''}`;
      }
      const total = Number(progress && progress.total || 0);
      const completed = Number(progress && progress.completed || 0);
      const result = total ? `${completed}/${total}` : `${completed}`;
      const counts = total
        ? ` · ${Number(progress.downloaded || 0)} descargados, ${Number(progress.failed || 0)} no disponibles`
        : '';
      return `${progress.phase || 'Procesando'}: ${result}${counts}${current ? ` · ${current}` : ''}`;
    }

    async function ensureMediaCollection(signal) {
      ensureNotAborted(signal);
      if (state.mediaCollection) {
        return state.mediaCollection;
      }
      if (!state.result) {
        throw new Error('Recopila primero el rango de mensajes');
      }
      const resultReference = state.result;
      if (getChatTitle() !== resultReference.chatTitle || (resultReference.chatKey && currentChatKey() !== resultReference.chatKey)) {
        throw new Error('Has cambiado de chat desde la recopilación. Vuelve al chat original o recopila el rango de nuevo');
      }
      const collection = await collectMediaFiles(resultReference, {
        signal,
        onProgress(progress) {
          setStatus(operationProgressLabel(progress));
        },
      });
      ensureNotAborted(signal);
      if (state.result === resultReference) {
        state.mediaCollection = collection;
      }
      return collection;
    }

    async function downloadSeparateEntries(entries, signal) {
      for (let index = 0; index < entries.length; index += 1) {
        ensureNotAborted(signal);
        const entry = entries[index];
        setStatus(`Descargando por separado: ${index + 1}/${entries.length} · ${entry.filename}`);
        if (entry.blob) {
          downloadBlob(entry.blob, entry.filename);
        } else {
          downloadText(entry.content || '', entry.filename, entry.mime || 'application/octet-stream');
        }
        if (index + 1 < entries.length) {
          await sleep(120, signal);
        }
      }
    }

    function collectionCompletionKind(collection) {
      const hasFailures = Boolean(collection && collection.failures && collection.failures.length);
      const hasWarnings = Boolean(collection && collection.warnings && collection.warnings.length);
      return hasFailures || hasWarnings ? '' : 'success';
    }

    async function runScan() {
      if (state.scanning) return;
      syncChatContext();
      const operationChatKey = state.chatKey;
      try {
        finishPicking();
        const bounds = { start: readEndpoint('start'), end: readEndpoint('end') };
        clearImageQueue();
        state.result = null;
        state.mediaCollection = null;
        setBusy(true);
        setStatus('Iniciando la recopilación');
        persistOptions();
        state.abortController = new AbortController();
        const chatTitle = getChatTitle();
        const scan = await scanRange(bounds, {
          dateOrder: refs['date-order'].value,
          loadOlderFromPhone: refs['load-older'].checked,
          signal: state.abortController.signal,
          onProgress(progress) {
            const oldest = progress.oldest ? formatLocalDateTime(progress.oldest) : 'sin fecha';
            const newest = progress.newest ? formatLocalDateTime(progress.newest) : 'sin fecha';
            setStatus(`${progress.phase}: ${progress.count} mensajes recopilados (${oldest} a ${newest})`);
          },
        });
        if (syncChatContext() || currentChatKey() !== operationChatKey) throw new Error('El chat cambió durante la recopilación');
        state.result = {
          chatTitle,
          chatKey: operationChatKey,
          excludedMessages: Array.from(state.exclusions.values()),
          exportedAt: new Date(),
          bounds: scan.bounds,
          records: scan.records,
          dateOrder: scan.dateOrder,
          dateResolution: scan.dateResolution,
          metadataWarnings: scan.metadataWarnings,
          collectedCount: scan.collectedCount,
          partial: scan.partial,
          scanWarnings: scan.scanWarnings,
          stopReason: scan.stopReason,
        };
        const swapped = scan.bounds.swapped || scan.selected.swapped;
        const suffix = swapped ? ' Los límites estaban invertidos y se ordenaron cronológicamente.' : '';
        setStatus(`${scan.partial ? 'Recopilación parcial' : 'Listo'}: ${exportRecords(state.result).length} mensajes para exportar; ${scan.records.length - exportRecords(state.result).length} excluidos dentro del rango. Se revisaron ${scan.collectedCount}.${suffix}${scan.metadataWarnings.length ? ' AVISO: '+scan.metadataWarnings.join(' ') : ''}`, scan.metadataWarnings.length ? 'warning' : 'success');
      } catch (error) {
        if (error && error.name === 'AbortError') {
          setStatus('Recopilación cancelada');
        } else {
          console.error('[WA Range Exporter]', error);
          setStatus(error && error.message ? error.message : 'No se pudo recopilar el rango', 'error');
        }
      } finally {
        state.abortController = null;
        setBusy(false);
      }
    }

    async function runCopy() {
      if (state.scanning || syncChatContext()) return;
      finishPicking();
      if (!state.result || !exportRecords(state.result).length) {
        return;
      }
      try {
        setBusy(true);
        persistOptions();
        state.abortController = new AbortController();
        const signal = state.abortController.signal;
        const format = refs.format.value;
        const mediaMode = refs['media-mode'].value;
        const collection = mediaMode === 'none' ? null : await ensureMediaCollection(signal);
        const selectedOutput = formatExport(state.result, format);
        const plainOutput = format === 'html' ? formatText(state.result) : selectedOutput;
        const htmlOutput = format === 'html' ? selectedOutput : null;

        if (mediaMode === 'none') {
          await copyText(plainOutput, htmlOutput);
          setStatus(`${exportRecords(state.result).length} mensajes copiados`, 'success');
          return;
        }

        if (collection.files.length === 1) {
          const binaryCopied = await copyTextAndSingleMedia(plainOutput, htmlOutput, collection.files[0]);
          if (binaryCopied) {
            setStatus(`Texto y adjunto copiados · ${mediaCollectionSummary(collection)}`, collectionCompletionKind(collection));
            return;
          }
        }

        await copyText(plainOutput, htmlOutput);
        if (!collection.foundCount && !collection.warnings.length) {
          setStatus(`${exportRecords(state.result).length} mensajes copiados; no había adjuntos`, 'success');
          return;
        }

        const archive = await buildMediaArchive(state.result, collection, {
          format,
          mode: mediaMode === 'zip-ultra' ? 'zip-ultra' : 'zip',
          signal,
          onProgress(progress) {
            setStatus(operationProgressLabel(progress));
          },
        });
        downloadBlob(archive.blob, archive.filename);
        setStatus(`Texto copiado. Los adjuntos se descargaron en ${archive.filename} · ${mediaCollectionSummary(collection)}`, collectionCompletionKind(collection));
      } catch (error) {
        if (error && error.name === 'AbortError') {
          setStatus('Copia y exportación canceladas');
        } else {
          console.error('[WA Range Exporter]', error);
          setStatus(error && error.message ? error.message : 'No se pudo copiar', 'error');
        }
      } finally {
        state.abortController = null;
        setBusy(false);
      }
    }

    async function runDownload() {
      if (state.scanning || syncChatContext()) return;
      finishPicking();
      if (!state.result || !exportRecords(state.result).length) {
        return;
      }
      try {
        setBusy(true);
        persistOptions();
        state.abortController = new AbortController();
        const signal = state.abortController.signal;
        const format = refs.format.value;
        const mediaMode = refs['media-mode'].value;

        if (mediaMode === 'none') {
          const definition = formatDefinition(format);
          const output = formatExport(state.result, format);
          const filename = exportFilename(state.result, definition.extension);
          downloadText(output, filename, definition.mime);
          setStatus(`Archivo generado: ${filename}`, 'success');
          return;
        }

        const collection = await ensureMediaCollection(signal);
        if (mediaMode === 'separate') {
          const entries = buildSeparateExportEntries(state.result, collection, format);
          await downloadSeparateEntries(entries, signal);
          setStatus(`Descarga separada completada · ${mediaCollectionSummary(collection)}. El navegador puede pedir permiso para varias descargas`, collectionCompletionKind(collection));
          return;
        }

        const archive = await buildMediaArchive(state.result, collection, {
          format,
          mode: mediaMode,
          signal,
          onProgress(progress) {
            setStatus(operationProgressLabel(progress));
          },
        });
        downloadBlob(archive.blob, archive.filename);
        const compression = archive.compressionLevel === 9 ? 'ZIP ultracomprimido' : 'ZIP';
        setStatus(`${compression} generado: ${archive.filename} · ${mediaCollectionSummary(collection)}`, collectionCompletionKind(collection));
      } catch (error) {
        if (error && error.name === 'AbortError') {
          setStatus('Descarga cancelada');
        } else {
          console.error('[WA Range Exporter]', error);
          setStatus(error && error.message ? error.message : 'No se pudo generar la descarga', 'error');
        }
      } finally {
        state.abortController = null;
        setBusy(false);
      }
    }

    refs.toggle.addEventListener('click', () => { syncChatContext(); if (state.picking) { finishPicking(); setOpen(true); } else setOpen(!state.open); });
    refs.close.addEventListener('click', () => setOpen(false));
    refs['start-kind'].addEventListener('change', () => { refreshEndpointMode('start'); invalidateRange(); });
    refs['end-kind'].addEventListener('change', () => { refreshEndpointMode('end'); invalidateRange(); });
    for (const role of ['start-date', 'end-date', 'start-time', 'end-time']) refs[role].addEventListener('input', invalidateRange);
    refs['pick-start'].addEventListener('click', () => beginPicking('start'));
    refs['pick-end'].addEventListener('click', () => beginPicking('end'));
    refs['pick-exclude'].addEventListener('click', () => beginPicking('exclude'));
    refs['finish-exclusions'].addEventListener('click', () => { finishPicking(); setOpen(true); exclusionStatus(); });
    refs['clear-exclusions'].addEventListener('click', () => {
      if (state.scanning || syncChatContext()) return;
      state.exclusions.clear(); refreshExclusions(); exclusionStatus();
    });
    refs.scan.addEventListener('click', runScan);
    refs.copy.addEventListener('click', runCopy);
    refs['copy-images'].addEventListener('click', runPrepareImages);
    refs['image-issues-toggle'].addEventListener('click', () => {
      const expanded = refs['image-issues-toggle'].getAttribute('aria-expanded') !== 'true';
      refs['image-issues-toggle'].setAttribute('aria-expanded', String(expanded));
      refs['image-issues-toggle'].textContent = expanded ? 'Ocultar avisos de imágenes' : 'Mostrar avisos de imágenes';
      refs['image-issues-text'].hidden = !expanded;
    });
    refs['image-next'].addEventListener('click', () => runImageCopy(false));
    refs['image-again'].addEventListener('click', () => runImageCopy(true));
    refs['image-close'].addEventListener('click', () => {
      if (state.scanning) return;
      clearImageQueue(); setBusy(false);
      setStatus('Cola cerrada. El portapapeles no se ha modificado');
    });
    refs.download.addEventListener('click', runDownload);
    refs.cancel.addEventListener('click', () => state.abortController && state.abortController.abort());
    refs.format.addEventListener('change', persistOptions);
    refs['date-order'].addEventListener('change', () => { persistOptions(); invalidateRange(); });
    refs['media-mode'].addEventListener('change', persistOptions);
    refs['load-older'].addEventListener('change', persistOptions);

    document.addEventListener('keydown', (event) => {
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setOpen(!state.open);
      }
    });

    // Repaint by id when WhatsApp recycles message elements, not by their DOM position.
    let repaintQueued = false;
    const exclusionObserver = new MutationObserver(() => {
      if (repaintQueued) return;
      repaintQueued = true;
      requestAnimationFrame(() => {
        repaintQueued = false;
        if (!host.isConnected) { exclusionObserver.disconnect(); finishPicking(); clearImageQueue(); if (state.abortController) state.abortController.abort(); return; }
        if (!syncChatContext()) paintExclusions();
      });
    });
    exclusionObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-id', 'data-testid'],
    });
    window.addEventListener('pagehide', () => { if (state.abortController) state.abortController.abort(); clearImageQueue(); });
    refreshEndpointMode('start');
    refreshEndpointMode('end');
    refreshExclusions();
    host.__waRangeExporterState = state;
    return host;
  }

  function bootstrap() {
    const mount = () => {
      if (document.body) {
        mountUI();
        return true;
      }
      return false;
    };
    if (mount()) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (mount()) {
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  return {
    VERSION,
    MESSAGE_SELECTOR,
    detectDateOrder,
    resolveDateOrder,
    normalizeRecordAuthors,
    loadedMetadataContext,
    enrichRecordMetadata,
    metadataWarnings,
    parseTimeParts,
    parseNumericDate,
    parsePrePlainText,
    parseDateBoundary,
    orderRecords,
    inferMissingTimestamps,
    selectRange,
    exportRecords,
    exportMediaCollection,
    rawMediaCaption,
    csvEscape,
    normalizeMessageId,
    parseAlbumIdentity,
    extractStyleUrls,
    describeRawMediaMessage,
    matchRawMediaMessages,
    buildMediaPath,
    fetchMediaBlob,
    collectMediaFiles,
    buildMediaManifest,
    buildMediaArchive,
    buildSeparateExportEntries,
    formatBytes,
    mediaCollectionSummary,
    copyTextAndSingleMedia,
    isClipboardImage,
    imageToClipboardPng,
    prepareImageClipboard,
    copyPngImage,
    ImageClipboardQueue,
    formatText,
    formatCsv,
    formatJson,
    formatHtml,
    formatExport,
    textFromNode,
    extractSelectableText,
    extractMedia,
    extractQuotedMessage,
    extractMessageElement,
    mergeRecords,
    createCollector,
    scanRange,
    findScroller,
    getScrollState,
    createScrollProgressTracker,
    uiTemplate,
    mountUI,
    bootstrap,
    sanitizedFilename,
    exportFilename,
  };
}));
