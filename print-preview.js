/* ---------------------------------------------------------------------------
   Schedule tab — print preview for the Gantt chart.

   Draws the chart from the data (project.project_activities and
   project.project_activity_links) as one SVG per page, sized to the chosen
   paper. Activity names get their own column and are wrapped onto as many
   lines as they need — never cut off — and the column width is adjustable.

   Uses globals from project.html / i18n.js / config.js:
     project, t(), currentLang, escapeHTML(), ganttParseDate(), ganttFmt(),
     ganttTickPlan(), ganttConnectorPath(), GANTT_DAY_MS
   --------------------------------------------------------------------------- */

const GP_PAPERS = {
  // name: [width mm, height mm in portrait, CSS @page keyword (null = use mm)]
  A5:      [148,   210,   'A5'],
  A4:      [210,   297,   'A4'],
  A3:      [297,   420,   'A3'],
  A2:      [420,   594,   null],
  Letter:  [215.9, 279.4, 'letter'],
  Legal:   [215.9, 355.6, 'legal'],
  Tabloid: [279.4, 431.8, 'ledger']
};
const GP_PX_PER_MM = 96 / 25.4;
const GP_MARGIN_PX = Math.round(10 * GP_PX_PER_MM);       // 10 mm
const GP_FONT = 'Arial, Helvetica, sans-serif';

const gpState = { paper: 'A4', orient: 'landscape', labelPct: 30 };

/* ---------- text wrapping, measured with the real font ---------- */

let gpCtx = null;
function gpTextWidth(text, size, bold){
  if (!gpCtx) gpCtx = document.createElement('canvas').getContext('2d');
  gpCtx.font = `${bold ? '700 ' : ''}${size}px ${GP_FONT}`;
  return gpCtx.measureText(text).width;
}

// Greedy word wrap to a pixel width. Words longer than a whole line are split
// by character, so nothing is ever clipped or dropped.
function gpWrap(text, maxW, size, bold){
  const lines = [];
  let cur = '';
  const push = () => { if (cur){ lines.push(cur); cur = ''; } };
  String(text).split(/\s+/).filter(Boolean).forEach(word => {
    while (gpTextWidth(word, size, bold) > maxW){
      let cut = word.length - 1;
      while (cut > 1 && gpTextWidth(word.slice(0, cut), size, bold) > maxW) cut--;
      push();
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = cur ? cur + ' ' + word : word;
    if (cur && gpTextWidth(next, size, bold) > maxW){ push(); cur = word; }
    else cur = next;
  });
  push();
  return lines.length ? lines : [''];
}

/* ---------- page geometry ---------- */

function gpPageSize(){
  const [w, h] = GP_PAPERS[gpState.paper];
  const mm = gpState.orient === 'landscape' ? { w: h, h: w } : { w, h };
  return { wmm: mm.w, hmm: mm.h, wpx: Math.round(mm.w * GP_PX_PER_MM), hpx: Math.round(mm.h * GP_PX_PER_MM) };
}

/* ---------- build the pages ---------- */

// idPrefix keeps marker ids unique between the preview and the print copy
// (a marker defined inside a display:none SVG is not drawn).
function gpBuildPages(idPrefix){
  const activities = (project.project_activities || []).slice()
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  if (!activities.length) return null;
  const links = project.project_activity_links || [];

  const pg = gpPageSize();
  const pad = GP_MARGIN_PX;
  const contentW = pg.wpx - 2 * pad;
  const contentH = pg.hpx - 2 * pad - 2;               // slack so a page never spills onto a blank one
  const labelColW = Math.round(contentW * gpState.labelPct / 100);
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
  const titleH = 56, headerH = 46;
  const rows = activities.map(a => {
    const lines = gpWrap(a.title, labelColW - 18, NAME_SIZE, true);
    return { a, lines, h: Math.max(40, lines.length * LINE_H + DATE_H + 14) };
  });

  // paginate: rows are never split across pages
  const avail = contentH - titleH - headerH;
  const chunks = [];
  let cur = [], used = 0;
  rows.forEach(r => {
    if (cur.length && used + r.h > avail){ chunks.push(cur); cur = []; used = 0; }
    cur.push(r); used += r.h;
  });
  if (cur.length) chunks.push(cur);

  const fullFmt = { month: 'short', day: 'numeric', year: 'numeric' };
  const rangeText = `${ganttFmt(first, fullFmt)} – ${ganttFmt(last, fullFmt)}`;
  const printedText = `${t('gantt.printed')} ${new Date().toLocaleDateString(currentLang, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const plotX = pad + labelColW;
  const headerY = pad + titleH;
  const bodyY = headerY + headerH;

  const svgs = chunks.map((chunk, pi) => {
    const bodyH = chunk.reduce((n, r) => n + r.h, 0);
    const arrowId = `${idPrefix}-arrow-${pi}`;
    let s = `<rect width="${pg.wpx}" height="${pg.hpx}" fill="#ffffff"/>`;

    // title block
    s += `<text x="${pad}" y="${pad + 18}" font-family="${GP_FONT}" font-size="18" font-weight="700" fill="#2C3742">${escapeHTML(project.title)} — ${escapeHTML(t('project.tab_schedule'))}</text>`;
    s += `<text x="${pad}" y="${pad + 38}" font-family="${GP_FONT}" font-size="12" fill="#5A6672">${escapeHTML(rangeText)}</text>`;
    s += `<text x="${pad + contentW}" y="${pad + 18}" text-anchor="end" font-family="${GP_FONT}" font-size="12" fill="#5A6672">${escapeHTML(t('gantt.page_of').replace('{n}', pi + 1).replace('{total}', chunks.length))}</text>`;
    s += `<text x="${pad + contentW}" y="${pad + 38}" text-anchor="end" font-family="${GP_FONT}" font-size="12" fill="#5A6672">${escapeHTML(printedText)}</text>`;

    // time header
    s += `<rect x="${plotX}" y="${headerY}" width="${plotW}" height="${headerH}" fill="#EEF4F8"/>`;
    s += `<rect x="${pad}" y="${headerY}" width="${labelColW}" height="${headerH}" fill="#EEF4F8"/>`;
    s += `<text x="${pad + 8}" y="${headerY + 28}" font-family="${GP_FONT}" font-size="11" font-weight="700" fill="#5A6672">${escapeHTML(t('gantt.activity_col').toUpperCase())}</text>`;
    plan.months.forEach(m => {
      s += `<line x1="${plotX + m.x}" y1="${headerY}" x2="${plotX + m.x}" y2="${headerY + 22}" stroke="#C9D3DA" stroke-width="1"/>`;
      if (m.label) s += `<text x="${plotX + m.x + 5}" y="${headerY + 15}" font-family="${GP_FONT}" font-size="12" font-weight="700" fill="#2C3742">${escapeHTML(m.label)}</text>`;
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
      if (tk.x + 4 + gpTextWidth(tk.label, 12, false) <= plotW){      // skip a label that would run past the page edge
        s += `<text x="${x + 4}" y="${headerY + 38}" font-family="${GP_FONT}" font-size="12" fill="#2C3742">${escapeHTML(tk.label)}</text>`;
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
        s += `<text x="${pad + 8}" y="${top + 11 + k * LINE_H}" font-family="${GP_FONT}" font-size="${NAME_SIZE}" font-weight="700" fill="#2C3742">${escapeHTML(ln)}</text>`;
      });
      const sameYear = new Date(ganttParseDate(a.start_date)).getUTCFullYear() === new Date(ganttParseDate(a.end_date)).getUTCFullYear();
      const dFmt = sameYear ? { month: 'short', day: 'numeric' } : fullFmt;
      s += `<text x="${pad + 8}" y="${top + r.lines.length * LINE_H + 10}" font-family="${GP_FONT}" font-size="11" fill="#5A6672">${escapeHTML(ganttFmt(ganttParseDate(a.start_date), dFmt))} – ${escapeHTML(ganttFmt(ganttParseDate(a.end_date), dFmt))}</text>`;

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

  return { pages: svgs, pg, count: chunks.length };
}

// width/height strings are CSS lengths ("320px" for the preview, "297mm" for paper)
function gpPageHTML(page, pg, width, height){
  return `<div class="gp-page"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pg.wpx} ${pg.hpx}" width="${width}" height="${height}">${page.defs}${page.body}</svg></div>`;
}

/* ---------- preview dialog ---------- */

let gpOverlay = null, gpKeyHandler = null, gpResizeHandler = null;

function openGanttPrintPreview(){
  if (!(project.project_activities || []).length){ alert(t('project.no_activities')); return; }
  closeGanttPrintPreview();

  const paperOptions = Object.keys(GP_PAPERS).map(p => {
    const [w, h] = GP_PAPERS[p];
    return `<option value="${p}" ${p === gpState.paper ? 'selected' : ''}>${p} (${w} × ${h} mm)</option>`;
  }).join('');

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
          <label class="gp-radio"><input type="radio" name="gpOrient" value="portrait" ${gpState.orient === 'portrait' ? 'checked' : ''}> ${escapeHTML(t('gantt.portrait'))}</label>
          <label class="gp-radio"><input type="radio" name="gpOrient" value="landscape" ${gpState.orient === 'landscape' ? 'checked' : ''}> ${escapeHTML(t('gantt.landscape'))}</label>
        </fieldset>
        <label>${escapeHTML(t('gantt.names_width'))}: <span id="gpLabelVal">${gpState.labelPct}%</span>
          <input type="range" id="gpLabelPct" min="15" max="60" step="1" value="${gpState.labelPct}">
        </label>
        <p class="credits-note">${escapeHTML(t('gantt.names_hint'))}</p>
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
  gpOverlay = overlay;

  let timer = null;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(renderGanttPreview, 60); };
  overlay.querySelector('#gpPaper').addEventListener('change', e => { gpState.paper = e.target.value; refresh(); });
  overlay.querySelectorAll('input[name="gpOrient"]').forEach(r => r.addEventListener('change', e => { gpState.orient = e.target.value; refresh(); }));
  overlay.querySelector('#gpLabelPct').addEventListener('input', e => {
    gpState.labelPct = Number(e.target.value);
    overlay.querySelector('#gpLabelVal').textContent = gpState.labelPct + '%';
    refresh();
  });
  overlay.querySelector('#gpPrint').addEventListener('click', printGantt);
  overlay.querySelector('#gpClose').addEventListener('click', closeGanttPrintPreview);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeGanttPrintPreview(); });

  gpKeyHandler = e => { if (e.key === 'Escape') closeGanttPrintPreview(); };
  gpResizeHandler = () => renderGanttPreview();
  document.addEventListener('keydown', gpKeyHandler);
  window.addEventListener('resize', gpResizeHandler);

  renderGanttPreview();
  overlay.querySelector('#gpPrint').focus();
}

function closeGanttPrintPreview(){
  if (gpOverlay){ gpOverlay.remove(); gpOverlay = null; }
  document.body.classList.remove('gp-open');
  if (gpKeyHandler){ document.removeEventListener('keydown', gpKeyHandler); gpKeyHandler = null; }
  if (gpResizeHandler){ window.removeEventListener('resize', gpResizeHandler); gpResizeHandler = null; }
}

function renderGanttPreview(){
  if (!gpOverlay) return;
  const built = gpBuildPages('pv');
  if (!built) return;
  const stage = gpOverlay.querySelector('#gpStage');
  const scale = Math.min(1, Math.max(0.1, (stage.clientWidth - 32) / built.pg.wpx));
  const w = Math.round(built.pg.wpx * scale), h = Math.round(built.pg.hpx * scale);
  gpOverlay.querySelector('#gpPages').innerHTML = built.pages.map(p => gpPageHTML(p, built.pg, w + 'px', h + 'px')).join('');
  gpOverlay.querySelector('#gpPageCount').textContent =
    `${gpState.paper} · ${t('gantt.' + gpState.orient)} · ` + t('gantt.pages_count').replace('{n}', built.count);
}

/* ---------- print ---------- */

function printGantt(){
  const built = gpBuildPages('pr');
  if (!built) return;

  let root = document.getElementById('printRoot');
  if (!root){ root = document.createElement('div'); root.id = 'printRoot'; document.body.appendChild(root); }
  // physical size in mm, minus a hair so rounding never creates a blank trailing page
  root.innerHTML = built.pages.map(p => gpPageHTML(p, built.pg, built.pg.wmm + 'mm', (built.pg.hmm - 0.5) + 'mm')).join('');

  const kw = GP_PAPERS[gpState.paper][2];
  const size = kw ? `${kw} ${gpState.orient}` : `${built.pg.wmm}mm ${built.pg.hmm}mm`;
  let style = document.getElementById('printPageStyle');
  if (!style){ style = document.createElement('style'); style.id = 'printPageStyle'; document.head.appendChild(style); }
  style.textContent = `@page { size: ${size}; margin: 0; }`;

  document.body.classList.add('printing-gantt');
  const cleanup = () => {
    document.body.classList.remove('printing-gantt');
    root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}
