/* Computed-to-Clean CSS Snatcher — content script.
 *
 * Pipeline for a picked element:
 *   getComputedStyle  →  diff against a pristine element of the same tag (in a hidden iframe)
 *   →  drop inherited-from-parent values, layout-resolved noise, logical-property duplicates
 *   →  collapse longhands into shorthands  →  tidy values (hex colours, 0px → 0, rounding)
 *   →  order sensibly and format as CSS / inline style / React style object.
 */
(() => {
  'use strict';
  if (window.__cssSnatcher) { window.__cssSnatcher.toggle(); return; }

  // ───────────────────────── options ─────────────────────────
  const STORE_KEY = 'snatcherOpts';
  const DEFAULT_OPTS = { format: 'css', colors: 'hex', keepInherited: false, keepSize: false, pseudo: true, subtree: false };
  const opts = { ...DEFAULT_OPTS };
  const MAX_NODES = 150;
  const MAX_DEPTH = 8;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE']);

  const store = (() => { try { return globalThis.chrome && chrome.storage && chrome.storage.local; } catch (e) { return null; } })();
  const loadOpts = () => new Promise((res) => {
    if (!store) return res();
    try { store.get(STORE_KEY, (r) => { Object.assign(opts, (r && r[STORE_KEY]) || {}); res(); }); } catch (e) { res(); }
  });
  const saveOpts = () => { try { store && store.set({ [STORE_KEY]: opts }); } catch (e) { /* ignore */ } };

  // ───────────────────────── property knowledge ─────────────────────────
  const INHERITED = new Set([
    'color', 'cursor', 'direction', 'font-family', 'font-size', 'font-style', 'font-variant-caps', 'font-variant-ligatures',
    'font-variant-numeric', 'font-variant-east-asian', 'font-weight', 'font-stretch', 'font-kerning', 'font-feature-settings',
    'font-variation-settings', 'font-optical-sizing', 'font-size-adjust', 'letter-spacing', 'line-height', 'list-style-type',
    'list-style-position', 'list-style-image', 'quotes', 'tab-size', 'text-align', 'text-align-last', 'text-indent',
    'text-transform', 'text-shadow', 'text-rendering', 'text-wrap', 'visibility', 'white-space', 'word-break', 'word-spacing',
    'overflow-wrap', 'hyphens', 'pointer-events', 'border-collapse', 'border-spacing', 'empty-cells', 'caption-side',
    'fill', 'stroke', 'stroke-width', 'caret-color', 'accent-color', 'color-scheme', 'writing-mode', 'text-orientation',
  ]);

  // Props whose computed value is the *resolved* layout value, not what the author wrote.
  // Dropped unless an author rule/inline style set them (or "Keep sizes" is on).
  const RESOLVED = ['width', 'height', 'top', 'right', 'bottom', 'left', 'transform-origin', 'perspective-origin'];
  const AUTHOR_PROPS = new Set([...RESOLVED, 'margin-left', 'margin-right']);

  const NOISE_RE = /(^|-)(block|inline)(-|$)|(^|-)(start|end)-(start|end)/; // logical-property duplicates
  const NOISE_SET = new Set(['grid-row-gap', 'grid-column-gap', 'grid-gap', 'word-wrap', 'interpolate-size', 'app-region']);
  const WEBKIT_KEEP = new Set(['-webkit-line-clamp', '-webkit-box-orient', '-webkit-background-clip', '-webkit-text-stroke-width', '-webkit-text-stroke-color']);
  const isNoise = (n) => {
    if (n.startsWith('--') || n.startsWith('row-rule') || n.startsWith('rule-')) return true;
    if (n.startsWith('-webkit-')) return !WEBKIT_KEEP.has(n);
    return NOISE_RE.test(n) || NOISE_SET.has(n);
  };

  const ORDER = ['content', 'display', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index', 'float', 'clear',
    'flex', 'align', 'justify', 'place', 'order', 'gap', 'grid', 'width', 'height', 'min-', 'max-', 'aspect', 'margin', 'padding',
    'box-sizing', 'overflow', 'border', 'outline', 'background', 'color', 'opacity', 'box-shadow', 'font', 'line-height',
    'letter-spacing', 'text', 'white-space', 'word', 'vertical-align', 'list', 'cursor', 'transform', 'transition', 'animation'];
  const orderIdx = (n) => { const i = ORDER.findIndex((p) => n.startsWith(p)); return i < 0 ? ORDER.length : i; };

  // ───────────────────────── baseline (pristine element per tag) ─────────────────────────
  let probe = null;
  let baseCache = new Map();
  let ruleIndex = [];

  const makeProbe = () => {
    probe = document.createElement('iframe');
    probe.setAttribute('aria-hidden', 'true');
    probe.tabIndex = -1;
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:600px;border:0;visibility:hidden;pointer-events:none';
    document.documentElement.appendChild(probe);
    const d = probe.contentDocument;
    d.open(); d.write('<!doctype html><html><body></body></html>'); d.close();
    baseCache = new Map();
  };
  const destroyProbe = () => { if (probe) probe.remove(); probe = null; baseCache = new Map(); ruleIndex = []; };

  const snapshot = (cs) => {
    const o = {};
    for (let i = 0; i < cs.length; i++) { const n = cs[i]; o[n] = cs.getPropertyValue(n); }
    return o;
  };

  const baseline = (el, forPseudo) => {
    const key = forPseudo ? '::pseudo' : el.namespaceURI + '|' + el.localName;
    if (baseCache.has(key)) return baseCache.get(key);
    const d = probe.contentDocument;
    const e = forPseudo ? d.createElement('span') : d.createElementNS(el.namespaceURI, el.localName);
    d.body.appendChild(e);
    const snap = snapshot(probe.contentWindow.getComputedStyle(e));
    e.remove();
    baseCache.set(key, snap);
    return snap;
  };

  // ───────────────────────── authored-rule index (only the props we care about) ─────────────────────────
  const collectRules = () => {
    const out = [];
    const walk = (rules) => {
      for (const r of rules) {
        try {
          if (r.styleSheet) { walk(r.styleSheet.cssRules); continue; }
          if (r.selectorText !== undefined) {
            const props = new Map();
            for (let i = 0; i < r.style.length; i++) {
              const p = r.style[i];
              if (AUTHOR_PROPS.has(p)) props.set(p, r.style.getPropertyValue(p));
            }
            if (props.size) out.push({ sel: r.selectorText, props });
          } else if (r.cssRules) {
            if (r.media && !matchMedia(r.media.mediaText).matches) continue;
            walk(r.cssRules);
          }
        } catch (e) { /* cross-origin sheet or odd rule */ }
      }
    };
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    for (const s of sheets) { try { walk(s.cssRules); } catch (e) { /* cross-origin */ } }
    return out;
  };

  const authoredFor = (el, pseudo) => {
    const m = new Map();
    for (const r of ruleIndex) {
      try {
        let sel = r.sel;
        if (pseudo) {
          // only selectors ending in this pseudo-element; test the host part against el
          const alt = pseudo.slice(1); // ':before' legacy single-colon form
          sel = splitTop(r.sel).filter((s) => s.endsWith(pseudo) || s.endsWith(alt))
            .map((s) => s.slice(0, s.length - (s.endsWith(pseudo) ? pseudo.length : alt.length)) || '*').join(',');
          if (!sel) continue;
        }
        if (el.matches(sel)) for (const [p, v] of r.props) m.set(p, v);
      } catch (e) { /* bad selector */ }
    }
    if (!pseudo && el.style) {
      for (let i = 0; i < el.style.length; i++) {
        const p = el.style[i];
        if (AUTHOR_PROPS.has(p)) m.set(p, el.style.getPropertyValue(p));
      }
    }
    return m;
  };

  // ───────────────────────── value tidying ─────────────────────────
  const RGB_RE = /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*\.?\d+)\s*)?\)/g;
  const toHex = (m, r, g, b, a) => {
    if (a !== undefined && +a < 1) {
      if (+a === 0 && +r === 0 && +g === 0 && +b === 0) return 'transparent';
      return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+(+a).toFixed(2)})`;
    }
    const h = [r, g, b].map((n) => Math.round(+n).toString(16).padStart(2, '0'));
    return h.every((x) => x[0] === x[1]) ? '#' + h.map((x) => x[0]).join('') : '#' + h.join('');
  };

  const tidy = (name, val) => {
    if (name === 'content' || name === 'font-family' || name === 'quotes' || val.includes('url(')) return val;
    let v = val;
    if (opts.colors === 'hex') v = v.replace(RGB_RE, toHex);
    v = v.replace(/(-?\d*\.\d+)px/g, (m, n) => `${+(+n).toFixed(2)}px`);
    v = v.replace(/(^|[\s,(])-?0(?:\.0+)?px(?![\w.%])/g, (m, p) => p + '0');
    if (name === 'font-weight') v = v === '400' ? 'normal' : v === '700' ? 'bold' : v;
    return v;
  };

  const splitTop = (s) => { // split on commas that are not inside parentheses
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const box4 = ([t, r, b, l]) => (l === r ? (b === t ? (r === t ? t : `${t} ${r}`) : `${t} ${r} ${b}`) : `${t} ${r} ${b} ${l}`);

  // ───────────────────────── the cleaner ─────────────────────────
  // Returns { decls: [[name, value], …], total } for an element (or one of its pseudo-elements).
  const cleanStyles = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo || null);
    const cur = snapshot(cs);
    const base = baseline(el, !!pseudo);
    const parentCs = pseudo ? getComputedStyle(el) : (el.parentElement ? getComputedStyle(el.parentElement) : null);
    const authored = authoredFor(el, pseudo);
    const total = Object.keys(cur).length;

    // authored margin:auto is restored instead of the resolved px value
    for (const p of ['margin-left', 'margin-right']) if (authored.get(p) === 'auto') cur[p] = 'auto';

    // 1. diff against defaults and parent
    const keep = new Map();
    for (const [n, v] of Object.entries(cur)) {
      if (isNoise(n)) continue;
      if (base[n] === v) continue;
      if (!opts.keepInherited && parentCs && INHERITED.has(n) && parentCs.getPropertyValue(n) === v) continue;
      keep.set(n, v);
    }
    for (const p of ['margin-left', 'margin-right']) if (authored.get(p) === 'auto') keep.set(p, 'auto');

    // 2. resolved-layout values: keep only if the author set them
    for (const p of RESOLVED) {
      if (!keep.has(p)) continue;
      if (!(opts.keepSize || authored.has(p))) keep.delete(p);
    }
    // 'auto' minimums differ only because of the parent's layout mode (flex/grid item)
    for (const p of ['min-width', 'min-height']) if (cur[p] === 'auto') keep.delete(p);
    if (parseFloat(cur['-webkit-text-stroke-width']) === 0) ['-webkit-text-stroke-width', '-webkit-text-stroke-color'].forEach((p) => keep.delete(p));
    if (cur.position === 'static') for (const p of ['top', 'right', 'bottom', 'left']) keep.delete(p);

    // 3. dependent props that are meaningless when their "switch" is off
    if (cur['caret-color'] === cur.color) keep.delete('caret-color');
    if (cur['column-rule-style'] === 'none') ['column-rule-width', 'column-rule-color', 'column-rule-style'].forEach((p) => keep.delete(p));
    if (cur['text-emphasis-style'] === 'none') keep.delete('text-emphasis-color');
    if (cur['outline-style'] === 'none') ['outline-width', 'outline-color', 'outline-style', 'outline-offset'].forEach((p) => keep.delete(p));
    if (cur['background-image'] === 'none') {
      ['background-size', 'background-position-x', 'background-position-y', 'background-repeat', 'background-origin', 'background-attachment', 'background-blend-mode']
        .forEach((p) => keep.delete(p));
    }

    const out = new Map();
    const touched = (names) => names.some((n) => keep.has(n));
    const drop = (names) => names.forEach((n) => keep.delete(n));
    const sides = ['top', 'right', 'bottom', 'left'];

    // 4. shorthands
    for (const g of ['margin', 'padding']) {
      const names = sides.map((s) => `${g}-${s}`);
      if (touched(names)) { out.set(g, box4(names.map((n) => cur[n]))); drop(names); }
    }

    const bnames = sides.flatMap((s) => ['width', 'style', 'color'].map((k) => `border-${s}-${k}`));
    if (touched(bnames)) {
      const b = sides.map((s) => ({ s, w: cur[`border-${s}-width`], st: cur[`border-${s}-style`], c: cur[`border-${s}-color`] }));
      const vis = b.filter((x) => x.st !== 'none' && x.st !== 'hidden' && parseFloat(x.w) > 0);
      const same = vis.length === 4 && vis.every((x) => x.w === vis[0].w && x.st === vis[0].st && x.c === vis[0].c);
      if (same) out.set('border', `${vis[0].w} ${vis[0].st} ${vis[0].c}`);
      else vis.forEach((x) => out.set(`border-${x.s}`, `${x.w} ${x.st} ${x.c}`));
      drop(bnames);
    }

    const corners = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => `border-${c}-radius`);
    if (touched(corners)) {
      const vals = corners.map((n) => cur[n]);
      if (vals.some((v) => v.includes(' '))) corners.forEach((n) => { if (cur[n] !== '0px') out.set(n, cur[n]); });
      else out.set('border-radius', box4(vals));
      drop(corners);
    }

    if (touched(['outline-width', 'outline-style', 'outline-color'])) {
      out.set('outline', `${cur['outline-width']} ${cur['outline-style']} ${cur['outline-color']}`);
      drop(['outline-width', 'outline-style', 'outline-color']);
    }

    if (touched(['overflow-x', 'overflow-y'])) {
      const [x, y] = [cur['overflow-x'], cur['overflow-y']];
      out.set('overflow', x === y ? x : `${x} ${y}`);
      drop(['overflow-x', 'overflow-y']);
    }

    if (touched(['row-gap', 'column-gap'])) {
      const [r, c] = [cur['row-gap'], cur['column-gap']];
      out.set('gap', r === c ? r : `${r} ${c}`);
      drop(['row-gap', 'column-gap']);
    }

    if (touched(['flex-grow', 'flex-shrink', 'flex-basis'])) {
      out.set('flex', `${cur['flex-grow']} ${cur['flex-shrink']} ${cur['flex-basis']}`);
      drop(['flex-grow', 'flex-shrink', 'flex-basis']);
    }

    if (sides.every((s) => keep.has(s)) && sides.every((s) => cur[s] === cur.top)) {
      out.set('inset', cur.top); drop(sides);
    }

    const td = ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'];
    if (touched(td)) {
      if (cur['text-decoration-line'] !== 'none') {
        const parts = [cur['text-decoration-line']];
        if (cur['text-decoration-style'] !== 'solid') parts.push(cur['text-decoration-style']);
        if (cur['text-decoration-color'] !== cur.color) parts.push(cur['text-decoration-color']);
        out.set('text-decoration', parts.join(' '));
      }
      drop(td);
    }

    if (touched(['background-position-x', 'background-position-y'])) {
      out.set('background-position', `${cur['background-position-x']} ${cur['background-position-y']}`);
      drop(['background-position-x', 'background-position-y']);
    }

    const tr = ['transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function', 'transition-behavior'];
    if (touched(tr)) {
      const P = splitTop(cur['transition-property']), D = splitTop(cur['transition-duration']);
      const T = splitTop(cur['transition-timing-function']), L = splitTop(cur['transition-delay']);
      const entries = P.map((p, i) => {
        const parts = [p, D[i % D.length]];
        const t = T[i % T.length], l = L[i % L.length];
        if (t !== 'ease') parts.push(t);
        if (l !== '0s') parts.push(l);
        return parts.join(' ');
      });
      if (!D.every((d) => d === '0s') || !L.every((l) => l === '0s')) out.set('transition', entries.join(', '));
      drop(tr);
    }

    // 5. everything else as-is
    for (const [n, v] of keep) out.set(n, v);

    const decls = [...out].map(([n, v]) => [n, tidy(n, v)]);
    decls.sort((a, b) => orderIdx(a[0]) - orderIdx(b[0]));
    return { decls, total };
  };

  // ───────────────────────── selectors ─────────────────────────
  const simple = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const cls = [...el.classList].filter((c) => c.length <= 40).slice(0, 2);
    return el.localName + cls.map((c) => '.' + CSS.escape(c)).join('');
  };
  const segment = (el) => {
    const s = simple(el);
    const p = el.parentElement;
    if (!p || s[0] === '#') return s;
    const sibs = [...p.children].filter((c) => { try { return c.matches(s); } catch (e) { return false; } });
    return sibs.length > 1 ? `${s}:nth-child(${[...p.children].indexOf(el) + 1})` : s;
  };

  // ───────────────────────── snatch ─────────────────────────
  const snatch = (target) => {
    makeProbe();
    ruleIndex = collectRules();
    try {
      const rules = [];
      let count = 0, rootStats = { total: 0, kept: 0 };
      const visit = (el, sel, depth) => {
        if (count >= MAX_NODES || SKIP_TAGS.has(el.tagName)) return;
        if (el !== target && getComputedStyle(el).display === 'none') return;
        count++;
        const { decls, total } = cleanStyles(el);
        if (el === target) rootStats = { total, kept: decls.length };
        rules.push({ sel, decls });
        if (opts.pseudo) {
          for (const ps of ['::before', '::after']) {
            const c = getComputedStyle(el, ps).content;
            if (c === 'none' || c === 'normal') continue;
            rules.push({ sel: sel + ps, decls: cleanStyles(el, ps).decls });
          }
        }
        if (opts.subtree && depth < MAX_DEPTH) {
          for (const child of el.children) visit(child, `${sel} > ${segment(child)}`, depth + 1);
        }
      };
      const rootSel = simple(target);
      visit(target, rootSel, 0);
      return { selector: rootSel, rules, stats: rootStats, text: format(rules) };
    } finally {
      destroyProbe();
    }
  };

  // ───────────────────────── output formats ─────────────────────────
  // Best-effort Tailwind: common props map to utilities, everything else becomes [prop:value].
  const toTailwind = (decls) => {
    const px = (v) => { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v); return m ? +m[1] : null; };
    const arb = (v) => `[${v.replace(/\s+/g, '_')}]`;
    const sp = (v) => {
      if (v === '0') return '0';
      if (v === 'auto') return 'auto';
      const n = px(v);
      return n !== null && (n / 4) * 2 === Math.round((n / 4) * 2) ? String(n / 4) : arb(v);
    };
    const neg = (c, v) => (v.startsWith('-') ? '-' + c : c);
    const quad = (pfx, v) => {
      const p = v.split(/\s+/); const [t, r, b, l] = [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
      const cls = (k, x) => `${x.startsWith('-') ? '-' : ''}${pfx}${k}-${sp(x.replace(/^-/, '')) }`;
      if (t === r && r === b && b === l) return [cls('', t)];
      if (t === b && r === l) return [cls('y', t), cls('x', r)];
      return [cls('t', t), cls('r', r), cls('b', b), cls('l', l)];
    };
    const W = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
    const J = { 'flex-start': 'start', 'flex-end': 'end', 'space-between': 'between', 'space-around': 'around', 'space-evenly': 'evenly', center: 'center' };
    const out = [];
    for (const [n, v] of decls) {
      if (n === 'display') out.push({ none: 'hidden', 'inline-block': 'inline-block', 'inline-flex': 'inline-flex', 'inline-grid': 'inline-grid' }[v] || v);
      else if (n === 'position') out.push(v);
      else if (n === 'flex-direction') out.push({ row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' }[v] || `[flex-direction:${v}]`);
      else if (n === 'flex-wrap') out.push({ wrap: 'flex-wrap', 'wrap-reverse': 'flex-wrap-reverse', nowrap: 'flex-nowrap' }[v] || `[flex-wrap:${v}]`);
      else if (n === 'align-items') out.push(J[v] && v !== 'center' ? `items-${J[v]}` : /^(center|stretch|baseline)$/.test(v) ? `items-${v}` : `[align-items:${v}]`);
      else if (n === 'justify-content') out.push(J[v] ? `justify-${J[v]}` : `[justify-content:${v}]`);
      else if (n === 'gap') { const p = v.split(/\s+/); out.push(p.length === 1 ? `gap-${sp(v)}` : `gap-y-${sp(p[0])}`, ...(p.length > 1 ? [`gap-x-${sp(p[1])}`] : [])); }
      else if (n === 'margin' || n === 'padding') out.push(...quad(n === 'margin' ? 'm' : 'p', v));
      else if (/^(margin|padding)-(top|right|bottom|left)$/.test(n)) out.push(`${v.startsWith('-') ? '-' : ''}${n[0] === 'm' ? 'm' : 'p'}${n.split('-')[1][0]}-${sp(v.replace(/^-/, ''))}`);
      else if (n === 'width' || n === 'height') out.push(`${n[0]}-${v === '100%' ? 'full' : arb(v)}`);
      else if (n === 'border-radius') out.push(v === '0' ? 'rounded-none' : v === '9999px' || v === '50%' ? 'rounded-full' : `rounded-${arb(v)}`);
      else if (n === 'background-color') out.push(`bg-${arb(v)}`);
      else if (n === 'color') out.push(`text-${arb(v)}`);
      else if (n === 'font-size') out.push(`text-${arb(v)}`);
      else if (n === 'font-weight') out.push(W[v] ? `font-${W[v]}` : v === 'bold' ? 'font-bold' : v === 'normal' ? 'font-normal' : `font-${arb(v)}`);
      else if (n === 'text-align' && /^(left|center|right|justify)$/.test(v)) out.push(`text-${v}`);
      else if (n === 'cursor') out.push(`cursor-${v}`);
      else if (n === 'opacity') out.push(`opacity-${arb(v)}`);
      else if (n === 'border') {
        const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(v);
        if (m) out.push(m[1] === '1px' ? 'border' : `border-${arb(m[1])}`, `border-${m[2]}`, `border-${arb(m[3])}`);
        else out.push(`[border:${v.replace(/\s+/g, '_')}]`);
      } else out.push(`[${n}:${v.replace(/\s+/g, '_')}]`);
    }
    return out;
  };

  const format = (rules) => {
    const root = rules[0];
    if (opts.format === 'tailwind') return `class="${toTailwind(root.decls).join(' ')}"`;
    if (opts.format === 'inline') {
      return `style="${root.decls.map(([n, v]) => `${n}: ${v.replace(/"/g, "'")}`).join('; ')}"`;
    }
    if (opts.format === 'react') {
      const camel = (n) => n.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      const body = root.decls.map(([n, v]) => `  ${camel(n)}: '${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n');
      return `{\n${body}\n}`;
    }
    const blocks = new Map();
    for (const r of rules) {
      if (!r.decls.length) continue;
      const body = r.decls.map(([n, v]) => `  ${n}: ${v};`).join('\n');
      if (!blocks.has(body)) blocks.set(body, []);
      blocks.get(body).push(r.sel);
    }
    return [...blocks].map(([body, sels]) => `${sels.join(',\n')} {\n${body}\n}`).join('\n\n')
      || `${root.sel} {\n  /* no differences from browser defaults */\n}`;
  };

  // ───────────────────────── UI ─────────────────────────
  let host = null, shadow = null, $ = null;
  let picking = false, current = null, hover = null;

  const UI_CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .panel,.banner,.hl{--body:#727272;--body-edge:#5c5c5c;--on-body:#fff;--on-body-soft:#efefef;--panel:#e6e4de;--field:#f2f0eb;
      --ink:#161616;--ink-soft:#55544f;--line:#9d9c96;--key-fg:#f2f0ea;--orange:#ff4a0f;--lcd:#0d0d0d;--lcd-fg:#f4f4ef;--lcd-dim:#77766f;
      --label:"Helvetica Neue",Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
    .panel{position:fixed;right:12px;top:0;width:min(360px,calc(100vw - 24px));max-height:100vh;overflow:auto;padding:10px;background:var(--body);color:var(--on-body);
      box-shadow:0 14px 40px rgba(0,0,0,.4);border-radius:0 0 8px 8px;font:11px/1.3 var(--label);letter-spacing:.06em;pointer-events:auto}
    .panel[hidden],.banner[hidden],.hl[hidden]{display:none}
    header{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--panel);border-top:6px solid var(--body-edge);color:var(--ink)}
    h1{margin:0;font-size:18px;font-weight:300;letter-spacing:.02em;line-height:1;white-space:nowrap}
    .sel{flex:1;min-width:0;color:var(--ink-soft);font:10px var(--mono);letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
    .lcd{padding:10px 12px 8px;background:var(--lcd);color:var(--lcd-fg)}
    .lcd .cap{display:flex;justify-content:space-between;gap:8px;font-size:9px;color:var(--lcd-dim);text-transform:uppercase}
    textarea{display:block;width:100%;height:190px;margin:6px 0 0;padding:0;border:0;border-radius:0;background:transparent;color:var(--lcd-fg);
      font:12px/1.5 var(--mono);letter-spacing:0;resize:vertical;white-space:pre;tab-size:2;outline:0}
    textarea::selection{background:var(--orange);color:#fff}
    .stat{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .opts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;padding:12px 6px 4px}
    .opts label{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--on-body-soft)}
    .opts label.chk{flex-direction:row;align-items:center;gap:7px;font-weight:500;white-space:nowrap}
    .opts select{width:100%;padding:6px 7px;background:var(--field);color:var(--ink);border:1px solid var(--line);border-radius:3px;
      font:inherit;font-size:11px;letter-spacing:.04em;text-transform:none;box-shadow:inset 0 1px 2px rgba(0,0,0,.15)}
    .opts select:focus-visible{outline:0;border-color:var(--orange);box-shadow:inset 0 1px 2px rgba(0,0,0,.15),0 0 0 2px rgba(255,74,15,.25)}
    input[type=checkbox]{margin:0;width:13px;height:13px;accent-color:var(--orange)}
    footer{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:8px;padding:10px 6px 6px}
    .key{position:relative;padding:10px 4px 8px;border:0;border-radius:4px;cursor:pointer;white-space:nowrap;
      background:linear-gradient(#2c2c2c,#181818);color:var(--key-fg);font:600 11px var(--label);letter-spacing:.06em;text-transform:uppercase;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 3px 0 #050505,0 6px 8px rgba(0,0,0,.3);transition:transform .06s,box-shadow .06s}
    .key:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 0 #050505,0 2px 4px rgba(0,0,0,.3)}
    .key:focus-visible{outline:2px solid var(--orange);outline-offset:3px}
    .key.hot{background:linear-gradient(#ff6a35,var(--orange));color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 3px 0 #a82a00,0 6px 8px rgba(0,0,0,.3)}
    .key.hot:active{box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 1px 0 #a82a00}
    .icon-btn{width:26px;height:26px;padding:0;border:0;border-radius:4px;cursor:pointer;flex:none;
      background:linear-gradient(#2c2c2c,#181818);color:var(--key-fg);font-size:12px;line-height:1;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 2px 0 #050505,0 4px 6px rgba(0,0,0,.3)}
    .icon-btn:hover{color:var(--orange)}
    .icon-btn:active{transform:translateY(1px)}
    .icon-btn:focus-visible{outline:2px solid var(--orange);outline-offset:2px}
    .banner{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:9px 16px;background:var(--panel);color:var(--ink);
      border-top:4px solid var(--orange);font:600 10px var(--label);letter-spacing:.08em;text-transform:uppercase;pointer-events:none;
      box-shadow:0 8px 24px rgba(0,0,0,.35)}
    .banner b{color:var(--orange)}
    .hl{position:fixed;pointer-events:none;border:2px solid var(--orange);background:rgba(255,74,15,.12);transition:all 60ms}
    .hl span{position:absolute;left:-2px;top:-22px;background:var(--orange);color:#fff;font:10px var(--mono);letter-spacing:0;padding:2px 6px;white-space:nowrap}
    @media (prefers-reduced-motion:reduce){.key,.hl{transition:none}}
  `;

  const buildUI = () => {
    host = document.createElement('div');
    host.id = '__css-snatcher-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="hl" hidden><span></span></div>
      <div class="banner" hidden>Click an element to snatch its CSS · <b>Esc</b> to cancel</div>
      <div class="panel" hidden>
        <header><h1>CSS Snatcher</h1><span class="sel"></span><button class="icon-btn" data-act="close" title="Close" aria-label="Close">✕</button></header>
        <div class="lcd">
          <div class="cap"><span>Output</span><span class="stat"></span></div>
          <textarea readonly spellcheck="false" aria-label="Snatched CSS"></textarea>
        </div>
        <div class="opts">
          <label>Format <select data-opt="format"><option value="css">CSS</option><option value="inline">Inline style</option><option value="react">React style</option><option value="tailwind">Tailwind</option></select></label>
          <label>Colours <select data-opt="colors"><option value="hex">Hex</option><option value="rgb">As computed</option></select></label>
          <label class="chk"><input type="checkbox" data-opt="keepInherited"> Keep inherited</label>
          <label class="chk"><input type="checkbox" data-opt="keepSize"> Keep sizes</label>
          <label class="chk"><input type="checkbox" data-opt="pseudo"> ::before / ::after</label>
          <label class="chk"><input type="checkbox" data-opt="subtree"> Include children</label>
        </div>
        <footer>
          <button class="key" data-act="pick">Re-pick</button><button class="key" data-act="parent">↑ Parent</button><button class="key hot" data-act="copy">Copy</button>
        </footer>
      </div>`;
    document.documentElement.appendChild(host);
    $ = {
      hl: shadow.querySelector('.hl'), banner: shadow.querySelector('.banner'), panel: shadow.querySelector('.panel'),
      sel: shadow.querySelector('.sel'), out: shadow.querySelector('textarea'), stat: shadow.querySelector('.stat'),
      copy: shadow.querySelector('[data-act=copy]'),
    };
    syncOptsToUI();
    shadow.addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.opt;
      if (!k) return;
      opts[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      saveOpts(); render();
    });
    shadow.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'close') close();
      else if (act === 'pick') startPick();
      else if (act === 'copy') copy();
      else if (act === 'parent' && current && current.parentElement && current !== document.documentElement) { current = current.parentElement; render(); }
    });
  };

  const syncOptsToUI = () => {
    if (!shadow) return;
    shadow.querySelectorAll('[data-opt]').forEach((n) => {
      if (n.type === 'checkbox') n.checked = !!opts[n.dataset.opt]; else n.value = opts[n.dataset.opt];
    });
  };

  const label = (el) => simple(el);
  const place = (el) => {
    if (!el || !$) return;
    const r = el.getBoundingClientRect();
    Object.assign($.hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    $.hl.firstChild.textContent = `${label(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    $.hl.firstChild.style.top = r.top < 26 ? 'auto' : '-22px';
    $.hl.firstChild.style.bottom = r.top < 26 ? '-22px' : 'auto';
    $.hl.hidden = false;
  };

  const render = () => {
    if (!current || !$) return;
    let result;
    try { result = snatch(current); } catch (err) { $.out.value = 'Could not read styles: ' + err.message; return; }
    $.sel.textContent = result.selector;
    $.sel.title = result.selector;
    $.out.value = result.text;
    const n = result.rules.length;
    $.stat.textContent = `${result.stats.total} computed → ${result.stats.kept} declarations` + (n > 1 ? ` · ${n} rules` : '');
    $.panel.hidden = false;
    place(current);
  };

  const copy = async () => {
    const text = $.out.value;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { /* fall through */ }
    if (!ok) { $.out.select(); try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ } }
    $.copy.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { if ($) $.copy.textContent = 'Copy'; }, 1200);
  };

  // ───────────────────────── picking ─────────────────────────
  const BLOCKED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'];
  const onMove = (e) => {
    if (!picking || e.target === host) return;
    hover = e.target; place(hover);
  };
  const onBlock = (e) => {
    if (!picking || e.target === host) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'click') { picking = false; current = e.target; $.banner.hidden = true; render(); }
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || !host) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (picking && current) { picking = false; $.banner.hidden = true; render(); } else close();
  };

  const startPick = () => {
    picking = true;
    $.banner.hidden = false; $.panel.hidden = true; $.hl.hidden = true;
  };

  const open = () => {
    if (host) return;
    buildUI();
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow, true);
    BLOCKED.forEach((t) => window.addEventListener(t, onBlock, true));
    startPick();
    loadOpts().then(() => { syncOptsToUI(); if (current) render(); });
  };

  const onReflow = () => { const el = picking ? hover : current; if (el) place(el); };

  const close = () => {
    picking = false; current = null; hover = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onReflow, true);
    window.removeEventListener('resize', onReflow, true);
    BLOCKED.forEach((t) => window.removeEventListener(t, onBlock, true));
    if (host) host.remove();
    host = shadow = $ = null;
  };

  const toggle = () => (host ? close() : open());

  // test/debug hook (isolated world in the real extension, so not visible to the page)
  window.__cssSnatcher = { toggle, snatch, opts, cleanStyles: (el) => { makeProbe(); ruleIndex = collectRules(); try { return cleanStyles(el); } finally { destroyProbe(); } } };
  open();
})();
