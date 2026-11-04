/* ---------------------------------------------------------------------------
   Print preview for the project charts:
     - Schedule tab      -> Gantt chart            (mode "gantt")
     - WBS tab           -> work breakdown tree    (mode "wbs")
     - Systems tabs      -> use cases, architecture, context, sequence,
                            states, activity       (mode = the diagram type)

   Everything is drawn from the data as one SVG per page, sized to the chosen
   paper (portrait/landscape, A5 … Tabloid). Text is wrapped by measuring it
   with the real font, so names are never cut off. Every page carries a small
   Together logo watermark at the bottom.

   Gantt  : activity names get their own column (width adjustable); long
            charts paginate by whole rows.
   WBS and diagrams: fit to one page, or print at a fixed scale — a drawing
            bigger than a page is then split over several pages.

   Uses globals from project.html / i18n.js / config.js:
     project, t(), currentLang, escapeHTML(), ganttParseDate(), ganttFmt(),
     ganttTickPlan(), ganttConnectorPath(), GANTT_DAY_MS, layoutWbsTree(),
     wbsLabelMap(), ensureDiagramState(), diagramState, diagramSelected,
     diagramGroup, buildDiagramSvgHTML(), DIAGRAM_EXPORT_CSS
   --------------------------------------------------------------------------- */

const PT_PAPERS = {
  // name: [width mm, height mm in portrait, CSS @page keyword (null = use mm)]
  A5:      [148,   210,   'A5'],
  A4:      [210,   297,   'A4'],
  A3:      [297,   420,   'A3'],
  A2:      [420,   594,   null],
  Letter:  [215.9, 279.4, 'letter'],
  Legal:   [215.9, 355.6, 'legal'],
  Tabloid: [279.4, 431.8, 'ledger']
};
const PT_PX_PER_MM = 96 / 25.4;
const PT_MARGIN_PX = Math.round(10 * PT_PX_PER_MM);       // 10 mm
const PT_FONT = 'Arial, Helvetica, sans-serif';
const PT_LOGO_SRC = 'assets/logo.png';
const PT_LOGO_RATIO = 222 / 892;                          // height / width of the logo file
const PT_SCALES = ['fit', '200', '150', '100', '75', '50', '25'];

const ptState = { paper: 'A4', orient: 'landscape', labelPct: 30, scale: 'fit' };
let ptMode = 'gantt';

/* ---------- text wrapping, measured with the real font ---------- */

let ptCtx = null;
function ptTextWidth(text, size, bold){
  if (!ptCtx) ptCtx = document.createElement('canvas').getContext('2d');
  ptCtx.font = `${bold ? '700 ' : ''}${size}px ${PT_FONT}`;
  return ptCtx.measureText(text).width;
}

// Greedy word wrap to a pixel width. Words longer than a whole line are split
// by character, so nothing is ever clipped or dropped.
function ptWrap(text, maxW, size, bold){
  const lines = [];
  let cur = '';
  const push = () => { if (cur){ lines.push(cur); cur = ''; } };
  String(text).split(/\s+/).filter(Boolean).forEach(word => {
    while (ptTextWidth(word, size, bold) > maxW){
      let cut = word.length - 1;
      while (cut > 1 && ptTextWidth(word.slice(0, cut), size, bold) > maxW) cut--;
      push();
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = cur ? cur + ' ' + word : word;
    if (cur && ptTextWidth(next, size, bold) > maxW){ push(); cur = word; }
    else cur = next;
  });
  push();
  return lines.length ? lines : [''];
}

/* ---------- logo watermark ---------- */

// The logo is turned into a small data: URL once, so it is certainly there when
// the browser prints. If that fails (e.g. the page is opened from a file), the
// plain relative path is used instead.
let ptLogoHref = PT_LOGO_SRC, ptLogoPromise = null;
function ptLoadLogo(){
  if (ptLogoPromise) return ptLogoPromise;
  ptLogoPromise = new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 360; c.height = Math.round(360 * PT_LOGO_RATIO);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        ptLogoHref = c.toDataURL('image/png');
      } catch (e) { /* keep the relative path */ }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = PT_LOGO_SRC;
  });
  return ptLogoPromise;
}

// Small, faint, centred in the bottom margin of every page.
function ptLogoMarkup(pg){
  const w = 96, h = Math.round(w * PT_LOGO_RATIO);
  return `<image href="${ptLogoHref}" x="${Math.round((pg.wpx - w) / 2)}" y="${pg.hpx - 9 - h}" width="${w}" height="${h}" opacity="0.5" preserveAspectRatio="xMidYMid meet"/>`;
}

/* ---------- page geometry and the part every page shares ---------- */

function ptPageSize(){
  const [w, h] = PT_PAPERS[ptState.paper];
  const mm = ptState.orient === 'landscape' ? { w: h, h: w } : { w, h };
  return { wmm: mm.w, hmm: mm.h, wpx: Math.round(mm.w * PT_PX_PER_MM), hpx: Math.round(mm.h * PT_PX_PER_MM) };
}

const PT_TITLE_H = 56;
function ptChrome(pg, titleText, subText, pageNo, pageCount){
  const pad = PT_MARGIN_PX, right = pg.wpx - pad;
  const printed = `${t('gantt.printed')} ${new Date().toLocaleDateString(currentLang, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  let s = `<rect width="${pg.wpx}" height="${pg.hpx}" fill="#ffffff"/>`;
  s += `<text x="${pad}" y="${pad + 18}" font-family="${PT_FONT}" font-size="18" font-weight="700" fill="#2C3742">${escapeHTML(titleText)}</text>`;
  s += `<text x="${pad}" y="${pad + 38}" font-family="${PT_FONT}" font-size="12" fill="#5A6672">${escapeHTML(subText)}</text>`;
  s += `<text x="${right}" y="${pad + 18}" text-anchor="end" font-family="${PT_FONT}" font-size="12" fill="#5A6672">${escapeHTML(t('gantt.page_of').replace('{n}', pageNo).replace('{total}', pageCount))}</text>`;
  s += `<text x="${right}" y="${pad + 38}" text-anchor="end" font-family="${PT_FONT}" font-size="12" fill="#5A6672">${escapeHTML(printed)}</text>`;
  s += ptLogoMarkup(pg);
  return s;
}

/* ---------- Gantt ---------- */

// idPrefix keeps marker ids unique between the preview and the print copy
// (a marker defined inside a display:none SVG is not drawn).
function ptBuildGanttPages(idPrefix){
  const activities = (project.project_activities || []).slice()
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  if (!activities.length) return null;
  const links = project.project_activity_links || [];

  const pg = ptPageSize();
  const pad = PT_MARGIN_PX;
  const contentW = pg.wpx - 2 * pad;
  const contentH = pg.hpx - 2 * pad - 2;               // slack so a page never spills onto a blank one
  const labelColW = Math.round(contentW * ptState.labelPct / 100);
  const plotW = contentW - labelColW;

  let first = ganttParseDate(activities[0].start_date), last = ganttParseDate(activities[0].end_date);
  activities.forEach(a => {
    first = Math.min(first, ganttParseDate(a.start_date));
    last = Math.max(last, ganttParseDate(a.end_date));
  });
  const minDate = first - GANTT_DAY_MS;
  const totalDays = Math.round((last + GANTT_DAY_MS - minDate) / GANTT_DAY_MS) + 1;
  const dayWidth = plotW / totalDays;                   // the whole time span always fits the page width
  const plan = ganttTickPlan(minDate, totalDays, dayWidth, 30);

  const NAME_SIZE = 13, LINE_H = 15, DATE_H = 14;
  const headerH = 46;
  const rows = activities.map(a => {
    const lines = ptWrap(a.title, labelColW - 18, NAME_SIZE, true);
    return { a, lines, h: Math.max(40, lines.length * LINE_H + DATE_H + 14) };
  });

  // paginate: rows are never split across pages
  const avail = contentH - PT_TITLE_H - headerH;
  const chunks = [];
  let cur = [], used = 0;
  rows.forEach(r => {
    if (cur.length && used + r.h > avail){ chunks.push(cur); cur = []; used = 0; }
    cur.push(r); used += r.h;
  });
  if (cur.length) chunks.push(cur);

  const fullFmt = { month: 'short', day: 'numeric', year: 'numeric' };
  const rangeText = `${ganttFmt(first, fullFmt)} – ${ganttFmt(last, fullFmt)}`;
  const titleText = `${project.title} — ${t('project.tab_schedule')}`;
  const plotX = pad + labelColW;
  const headerY = pad + PT_TITLE_H;
  const bodyY = headerY + headerH;

  const pages = chunks.map((chunk, pi) => {
    const bodyH = chunk.reduce((n, r) => n + r.h, 0);
    const arrowId = `${idPrefix}-arrow-${pi}`;
    let s = ptChrome(pg, titleText, rangeText, pi + 1, chunks.length);

    // time header
    s += `<rect x="${plotX}" y="${headerY}" width="${plotW}" height="${headerH}" fill="#EEF4F8"/>`;
    s += `<rect x="${pad}" y="${headerY}" width="${labelColW}" height="${headerH}" fill="#EEF4F8"/>`;
    s += `<text x="${pad + 8}" y="${headerY + 28}" font-family="${PT_FONT}" font-size="11" font-weight="700" fill="#5A6672">${escapeHTML(t('gantt.activity_col').toUpperCase())}</text>`;
    plan.months.forEach(m => {
      s += `<line x1="${plotX + m.x}" y1="${headerY}" x2="${plotX + m.x}" y2="${headerY + 22}" stroke="#C9D3DA" stroke-width="1"/>`;
      if (m.label) s += `<text x="${plotX + m.x + 5}" y="${headerY + 15}" font-family="${PT_FONT}" font-size="12" font-weight="700" fill="#2C3742">${escapeHTML(m.label)}</text>`;
    });
    s += `<line x1="${plotX}" y1="${headerY + 22}" x2="${plotX + plotW}" y2="${headerY + 22}" stroke="#C9D3DA" stroke-width="1"/>`;

    // row stripes
    let y = bodyY;
    chunk.forEach((r, idx) => {
      s += `<rect x="${pad}" y="${y}" width="${contentW}" height="${r.h}" fill="${idx % 2 ? '#F7FAFC' : '#ffffff'}"/>`;
      y += r.h;
    });
    // grid lines + day numbers
    plan.ticks.forEach(tk => {
      const x = plotX + tk.x;
      s += `<line x1="${x}" y1="${headerY + 22}" x2="${x}" y2="${bodyY + bodyH}" stroke="#E3E8EC" stroke-width="1"/>`;
      if (tk.x + 4 + ptTextWidth(tk.label, 12, false) <= plotW){      // skip a label that would run past the page edge
        s += `<text x="${x + 4}" y="${headerY + 38}" font-family="${PT_FONT}" font-size="12" fill="#2C3742">${escapeHTML(tk.label)}</text>`;
      }
    });

    // names + bars
    const rowCenterY = {};
    const onPage = new Set();
    y = bodyY;
    chunk.forEach(r => {
      const a = r.a;
      rowCenterY[a.id] = y - bodyY + r.h / 2;
      onPage.add(a.id);
      const blockH = r.lines.length * LINE_H + DATE_H;
      const top = y + (r.h - blockH) / 2;
      r.lines.forEach((ln, k) => {
        s += `<text x="${pad + 8}" y="${top + 11 + k * LINE_H}" font-family="${PT_FONT}" font-size="${NAME_SIZE}" font-weight="700" fill="#2C3742">${escapeHTML(ln)}</text>`;
      });
      const sameYear = new Date(ganttParseDate(a.start_date)).getUTCFullYear() === new Date(ganttParseDate(a.end_date)).getUTCFullYear();
      const dFmt = sameYear ? { month: 'short', day: 'numeric' } : fullFmt;
      s += `<text x="${pad + 8}" y="${top + r.lines.length * LINE_H + 10}" font-family="${PT_FONT}" font-size="11" fill="#5A6672">${escapeHTML(ganttFmt(ganttParseDate(a.start_date), dFmt))} – ${escapeHTML(ganttFmt(ganttParseDate(a.end_date), dFmt))}</text>`;

      const start = ganttParseDate(a.start_date), end = ganttParseDate(a.end_date);
      const bx = plotX + Math.round((start - minDate) / GANTT_DAY_MS) * dayWidth;
      const bw = Math.max((Math.round((end - start) / GANTT_DAY_MS) + 1) * dayWidth - 2, 4);
      s += `<rect x="${bx}" y="${y + 10}" width="${bw}" height="${r.h - 20}" rx="4" fill="#3E8FD0" stroke="#1F5C93" stroke-width="1"/>`;
      y += r.h;
    });

    // frame
    s += `<line x1="${plotX}" y1="${headerY}" x2="${plotX}" y2="${bodyY + bodyH}" stroke="#C9D3DA" stroke-width="1"/>`;
    s += `<rect x="${pad}" y="${headerY}" width="${contentW}" height="${headerH + bodyH}" fill="none" stroke="#C9D3DA" stroke-width="1"/>`;

    // dependency arrows (only when both activities are on this page)
    const byId = new Map(activities.map(a => [a.id, a]));
    let connectors = '';
    links.forEach(l => {
      if (!onPage.has(l.predecessor_id) || !onPage.has(l.successor_id)) return;
      const d = ganttConnectorPath(l, byId, minDate, dayWidth, rowCenterY, 8);
      if (d) connectors += `<path d="${d}" fill="none" stroke="#8a97a3" stroke-width="1.5" marker-end="url(#${arrowId})"/>`;
    });
    if (connectors) s += `<g transform="translate(${plotX},${bodyY})">${connectors}</g>`;

    const defs = `<defs><marker id="${arrowId}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#8a97a3"/></marker></defs>`;
    return { defs, body: s };
  });

  return { pages, pg, count: chunks.length, info: '' };
}

/* ---------- WBS and diagrams: a drawing placed on pages ---------- */

// A "drawing" is { x, y, w, h, render(idPrefix) -> { defs, body } } in its own
// coordinate space; the page builder below scales it and, when needed, tiles it.

function ptWbsDrawing(){
  const items = project.project_wbs_items || [];
  if (!items.length) return null;

  const nodeW = 190, gapX = 24, gapY = 52, padX = 10, padY = 10, titleLH = 16, descLH = 14, margin = 12;
  const { nodes } = layoutWbsTree(items, 1, { nodeW, nodeH: 1, gapX, gapY: 0 });
  const labels = wbsLabelMap(items);
  nodes.forEach(n => {
    n.titleLines = ptWrap(labels.get(n.id) || n.title, nodeW - 2 * padX, 13, true);
    n.descLines = n.description ? ptWrap(n.description, nodeW - 2 * padX, 11, false) : [];
    n.boxH = padY * 2 + n.titleLines.length * titleLH + (n.descLines.length ? 4 + n.descLines.length * descLH : 0);
  });

  // each tree level is only as tall as its tallest box
  const maxDepth = Math.max(...nodes.map(n => n.depth));
  const depthH = [], depthTop = [];
  let acc = 0;
  for (let d = 0; d <= maxDepth; d++){
    depthH[d] = Math.max(...nodes.filter(n => n.depth === d).map(n => n.boxH));
    depthTop[d] = acc;
    acc += depthH[d] + gapY;
  }
  const treeW = Math.max(...nodes.map(n => n.x)) + nodeW;
  const treeH = acc - gapY;
  const byId = new Map(nodes.map(n => [n.id, n]));

  let body = '';
  nodes.forEach(n => {
    if (!n.parent_id || !byId.has(n.parent_id)) return;
    const p = byId.get(n.parent_id);
    const x1 = margin + p.x + nodeW / 2, y1 = margin + depthTop[p.depth] + depthH[p.depth];
    const x2 = margin + n.x + nodeW / 2, y2 = margin + depthTop[n.depth];
    const midY = (y1 + y2) / 2;
    body += `<path d="M${x1},${y1} L${x1},${midY} L${x2},${midY} L${x2},${y2}" fill="none" stroke="#8a97a3" stroke-width="1.5"/>`;
  });
  nodes.forEach(n => {
    const x = margin + n.x, y = margin + depthTop[n.depth], h = depthH[n.depth];
    body += `<rect x="${x}" y="${y}" width="${nodeW}" height="${h}" rx="8" fill="#ffffff" stroke="${n.parent_id ? '#3E8FD0' : '#E8834F'}" stroke-width="1.5"/>`;
    const blockH = n.titleLines.length * titleLH + (n.descLines.length ? 4 + n.descLines.length * descLH : 0);
    let ty = y + (h - blockH) / 2;
    n.titleLines.forEach(ln => {
      body += `<text x="${x + nodeW / 2}" y="${ty + 12}" text-anchor="middle" font-family="${PT_FONT}" font-size="13" font-weight="700" fill="#2C3742">${escapeHTML(ln)}</text>`;
      ty += titleLH;
    });
    if (n.descLines.length){
      ty += 4;
      n.descLines.forEach(ln => {
        body += `<text x="${x + nodeW / 2}" y="${ty + 10}" text-anchor="middle" font-family="${PT_FONT}" font-size="11" fill="#5A6672">${escapeHTML(ln)}</text>`;
        ty += descLH;
      });
    }
  });

  return { x: 0, y: 0, w: treeW + 2 * margin, h: treeH + 2 * margin, render: () => ({ defs: '', body }) };
}

// The export CSS, limited to the printed pages so it can't restyle the live editor.
function ptScopedDiagramCss(){
  return DIAGRAM_EXPORT_CSS.replace(/(^|\})\s*([^{}]+)\{/g, (m, close, sel) =>
    `${close}${sel.split(',').map(x => '.gp-page ' + x.trim()).join(',')}{`);
}

function ptDiagramDrawing(type){
  const st = ensureDiagramState(type);
  if (!st || (!st.nodes.length && !st.edges.length)) return null;

  // draw it at 100% with no selection highlight, as the SVG export does
  const prevSel = diagramSelected[type], prevGroup = diagramGroup[type];
  diagramSelected[type] = null; diagramGroup[type] = new Set();
  let markup;
  try { markup = buildDiagramSvgHTML(type, 1); }
  finally { diagramSelected[type] = prevSel; diagramGroup[type] = prevGroup; }

  const vb = markup.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  const canvasW = vb ? Number(vb[1]) : 1200, canvasH = vb ? Number(vb[2]) : 700;
  markup = markup.replace(/<line class="diagram-edge-hit"[^>]*><\/line>/g, '');   // invisible click targets
  const defsMatch = markup.match(/<defs>[\s\S]*?<\/defs>/);
  const defs = defsMatch ? defsMatch[0] : '';
  const body = markup.replace(/^[\s\S]*?<\/defs>/, '').replace(/<\/svg>\s*$/, '');
  const style = `<style>${ptScopedDiagramCss()}</style>`;
  const markerRe = new RegExp(`diagramMarker-${type}-`, 'g');

  // crop to the shapes and lines instead of printing the whole empty canvas
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
  probe.innerHTML = `<div class="gp-page"><svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">${style}${defs}${body}</svg></div>`;
  document.body.appendChild(probe);
  let box = null;
  try {
    const svg = probe.querySelector('svg'), o = svg.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    svg.querySelectorAll('.diagram-node, .diagram-edge-group').forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      x0 = Math.min(x0, r.left - o.left); y0 = Math.min(y0, r.top - o.top);
      x1 = Math.max(x1, r.right - o.left); y1 = Math.max(y1, r.bottom - o.top);
    });
    if (x0 !== Infinity) box = { x0, y0, x1, y1 };
  } finally { probe.remove(); }
  if (!box) box = { x0: 0, y0: 0, x1: canvasW, y1: canvasH };

  const m = 24;
  const x = Math.max(0, Math.floor(box.x0 - m)), y = Math.max(0, Math.floor(box.y0 - m));
  const w = Math.min(canvasW, Math.ceil(box.x1 + m)) - x, h = Math.min(canvasH, Math.ceil(box.y1 + m)) - y;
  return {
    x, y, w, h,
    // marker ids get a per-page prefix: ids must be unique in the document, and a
    // marker inside a hidden SVG (the live editor while printing) isn't drawn
    render: (idp) => ({ defs: style + defs.replace(markerRe, idp + '-m-'), body: body.replace(markerRe, idp + '-m-') })
  };
}

function ptBuildDrawingPages(idPrefix, d, titleText){
  const pg = ptPageSize();
  const pad = PT_MARGIN_PX;
  const areaW = pg.wpx - 2 * pad;
  const areaH = pg.hpx - 2 * pad - PT_TITLE_H - 2;

  const s = ptState.scale === 'fit' ? Math.min(areaW / d.w, areaH / d.h, 2) : Number(ptState.scale) / 100;
  const cols = Math.max(1, Math.ceil(d.w * s / areaW - 1e-6));
  const rows = Math.max(1, Math.ceil(d.h * s / areaH - 1e-6));
  const count = cols * rows;
  const pct = Math.round(s * 100);

  const pages = [];
  for (let r = 0; r < rows; r++){
    for (let c = 0; c < cols; c++){
      const idx = r * cols + c;
      const art = d.render(`${idPrefix}-${idx}`);
      const drawW = Math.min(areaW, d.w * s - c * areaW);        // size of this page's piece, in page px
      const drawH = Math.min(areaH, d.h * s - r * areaH);
      // a drawing that fits on one page is centred; pieces of a larger one start at the margin
      const offX = pad + (count === 1 ? (areaW - drawW) / 2 : 0);
      const offY = pad + PT_TITLE_H + (count === 1 ? (areaH - drawH) / 2 : 0);
      const vbX = d.x + c * areaW / s, vbY = d.y + r * areaH / s;
      let sub = `${t('print.scale')} ${pct}%`;
      if (count > 1) sub += ` · ${t('print.tile').replace('{r}', r + 1).replace('{c}', c + 1)}`;

      let body = ptChrome(pg, titleText, sub, idx + 1, count);
      body += `<svg x="${offX}" y="${offY}" width="${drawW}" height="${drawH}" viewBox="${vbX} ${vbY} ${drawW / s} ${drawH / s}">${art.defs}${art.body}</svg>`;
      if (count > 1) body += `<rect x="${offX}" y="${offY}" width="${drawW}" height="${drawH}" fill="none" stroke="#DFE5E9" stroke-width="1"/>`;
      pages.push({ defs: '', body });
    }
  }
  return { pages, pg, count, pct, info: `${t('print.scale')} ${pct}%` };
}

/* ---------- what is being printed ---------- */

function ptSource(){
  if (ptMode === 'gantt'){
    if (!(project.project_activities || []).length){ alert(t('project.no_activities')); return null; }
    return { build: (id) => ptBuildGanttPages(id) };
  }
  if (ptMode === 'wbs'){
    const d = ptWbsDrawing();
    if (!d){ alert(t('project.wbs_no_items')); return null; }
    const title = `${project.title} — ${t('project.tab_wbs')}`;
    return { drawing: true, build: (id) => ptBuildDrawingPages(id, d, title) };
  }
  const d = ptDiagramDrawing(ptMode);
  if (!d){ alert(t('project.diagram_export_empty')); return null; }
  const title = `${project.title} — ${t('project.tab_' + ptMode)}`;
  return { drawing: true, build: (id) => ptBuildDrawingPages(id, d, title) };
}

// width/height strings are CSS lengths ("320px" for the preview, "297mm" for paper)
function ptPageHTML(page, pg, width, height){
  return `<div class="gp-page"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pg.wpx} ${pg.hpx}" width="${width}" height="${height}">${page.defs}${page.body}</svg></div>`;
}

/* ---------- preview dialog ---------- */

let ptOverlay = null, ptKeyHandler = null, ptResizeHandler = null, ptSrc = null;

function openPrintPreview(mode){
  ptMode = mode;
  const src = ptSource();
  if (!src) return;
  closePrintPreview();
  ptSrc = src;

  const paperOptions = Object.keys(PT_PAPERS).map(p => {
    const [w, h] = PT_PAPERS[p];
    return `<option value="${p}" ${p === ptState.paper ? 'selected' : ''}>${p} (${w} × ${h} mm)</option>`;
  }).join('');
  const scaleOptions = PT_SCALES.map(v =>
    `<option value="${v}" ${v === ptState.scale ? 'selected' : ''}>${v === 'fit' ? escapeHTML(t('print.scale_fit')) : v + '%'}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'gp-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('gantt.preview_title'));
  overlay.innerHTML = `
    <div class="gp-panel">
      <aside class="gp-controls">
        <h3>${escapeHTML(t('gantt.preview_title'))}</h3>
        <label>${escapeHTML(t('gantt.paper'))}
          <select id="gpPaper">${paperOptions}</select>
        </label>
        <fieldset>
          <legend>${escapeHTML(t('gantt.orientation'))}</legend>
          <label class="gp-radio"><input type="radio" name="gpOrient" value="portrait" ${ptState.orient === 'portrait' ? 'checked' : ''}> ${escapeHTML(t('gantt.portrait'))}</label>
          <label class="gp-radio"><input type="radio" name="gpOrient" value="landscape" ${ptState.orient === 'landscape' ? 'checked' : ''}> ${escapeHTML(t('gantt.landscape'))}</label>
        </fieldset>
        ${src.drawing ? `
        <label>${escapeHTML(t('print.scale'))}
          <select id="gpScale">${scaleOptions}</select>
        </label>
        <p class="credits-note">${escapeHTML(t('print.scale_hint'))}</p>` : `
        <label>${escapeHTML(t('gantt.names_width'))}: <span id="gpLabelVal">${ptState.labelPct}%</span>
          <input type="range" id="gpLabelPct" min="15" max="60" step="1" value="${ptState.labelPct}">
        </label>
        <p class="credits-note">${escapeHTML(t('gantt.names_hint'))}</p>`}
        <p class="credits-note" id="gpPageCount"></p>
        <div class="gp-actions">
          <button class="btn btn-primary" id="gpPrint" type="button">${escapeHTML(t('gantt.do_print'))}</button>
          <button class="btn btn-ghost" id="gpClose" type="button">${escapeHTML(t('gantt.close'))}</button>
        </div>
      </aside>
      <div class="gp-stage" id="gpStage"><div class="gp-pages" id="gpPages"></div></div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('gp-open');
  ptOverlay = overlay;

  let timer = null;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(renderPrintPreview, 60); };
  overlay.querySelector('#gpPaper').addEventListener('change', e => { ptState.paper = e.target.value; refresh(); });
  overlay.querySelectorAll('input[name="gpOrient"]').forEach(r => r.addEventListener('change', e => { ptState.orient = e.target.value; refresh(); }));
  const scaleSel = overlay.querySelector('#gpScale');
  if (scaleSel) scaleSel.addEventListener('change', e => { ptState.scale = e.target.value; refresh(); });
  const labelRange = overlay.querySelector('#gpLabelPct');
  if (labelRange) labelRange.addEventListener('input', e => {
    ptState.labelPct = Number(e.target.value);
    overlay.querySelector('#gpLabelVal').textContent = ptState.labelPct + '%';
    refresh();
  });
  overlay.querySelector('#gpPrint').addEventListener('click', printChart);
  overlay.querySelector('#gpClose').addEventListener('click', closePrintPreview);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closePrintPreview(); });

  ptKeyHandler = e => { if (e.key === 'Escape') closePrintPreview(); };
  ptResizeHandler = () => renderPrintPreview();
  document.addEventListener('keydown', ptKeyHandler);
  window.addEventListener('resize', ptResizeHandler);

  renderPrintPreview();
  ptLoadLogo().then(renderPrintPreview);                 // redraw once the logo is ready
  overlay.querySelector('#gpPrint').focus();
}

function closePrintPreview(){
  if (ptOverlay){ ptOverlay.remove(); ptOverlay = null; }
  ptSrc = null;
  document.body.classList.remove('gp-open');
  if (ptKeyHandler){ document.removeEventListener('keydown', ptKeyHandler); ptKeyHandler = null; }
  if (ptResizeHandler){ window.removeEventListener('resize', ptResizeHandler); ptResizeHandler = null; }
}

function renderPrintPreview(){
  if (!ptOverlay || !ptSrc) return;
  const built = ptSrc.build('pv');
  if (!built) return;
  const stage = ptOverlay.querySelector('#gpStage');
  const scale = Math.min(1, Math.max(0.1, (stage.clientWidth - 32) / built.pg.wpx));
  const w = Math.round(built.pg.wpx * scale), h = Math.round(built.pg.hpx * scale);
  ptOverlay.querySelector('#gpPages').innerHTML = built.pages.map(p => ptPageHTML(p, built.pg, w + 'px', h + 'px')).join('');
  ptOverlay.querySelector('#gpPageCount').textContent =
    `${ptState.paper} · ${t('gantt.' + ptState.orient)} · ` + t('gantt.pages_count').replace('{n}', built.count)
    + (built.pct && built.pct < 40 ? ` — ${t('print.small_hint')}` : '');   // a big drawing squeezed onto one page
}

/* ---------- print ---------- */

async function printChart(){
  // rebuild from the current data, and make sure the logo is loaded before the browser prints
  const src = ptSource();
  if (!src) return;
  await ptLoadLogo();
  const built = src.build('pr');
  if (!built) return;

  let root = document.getElementById('printRoot');
  if (!root){ root = document.createElement('div'); root.id = 'printRoot'; document.body.appendChild(root); }
  // physical size in mm, minus a hair so rounding never creates a blank trailing page
  root.innerHTML = built.pages.map(p => ptPageHTML(p, built.pg, built.pg.wmm + 'mm', (built.pg.hmm - 0.5) + 'mm')).join('');

  const kw = PT_PAPERS[ptState.paper][2];
  const size = kw ? `${kw} ${ptState.orient}` : `${built.pg.wmm}mm ${built.pg.hmm}mm`;
  let style = document.getElementById('printPageStyle');
  if (!style){ style = document.createElement('style'); style.id = 'printPageStyle'; document.head.appendChild(style); }
  style.textContent = `@page { size: ${size}; margin: 0; }`;

  document.body.classList.add('printing-chart');
  const cleanup = () => {
    document.body.classList.remove('printing-chart');
    root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  await new Promise(res => requestAnimationFrame(() => setTimeout(res, 120)));   // let the pages and the logo paint
  window.print();
}
