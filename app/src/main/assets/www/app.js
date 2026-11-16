/* Recall Notes v3. A rebuild of the 2.0 study app without a framework.
 * Data: the same localStorage key ("recall-v2") and shape as 2.0, so existing units, notes, progress and backups
 * carry over. Card ids are made exactly as 2.0 made them, so review progress stays attached to the right cards.
 * Native bridge (Android): window.RecallNative.{postJson, setReminder, requestNotifications, saveFile}. */
'use strict';
(function () {
  const KEY = 'recall-v2', DAY = 864e5;
  const DEFAULTS = { resultCount: 5, passageWords: 120, theme: 'light', textSize: 'medium', startView: 'Home', quizLength: 10, showHints: true, dailyGoal: 0,
    aiEngine: 'off', aiEndpoint: 'https://api.openai.com/v1/chat/completions', aiKey: '', aiModel: 'gpt-4o-mini', aiPassages: 5,
    reminderOn: false, reminderHour: 19, reminderMinute: 0, examDate: '', focusMin: 25, breakMin: 5 };
  const blank = () => ({ version: 2, units: [], files: [], progress: {}, quizBest: {}, saved: [], studyDays: [], reviewLog: {}, missed: {}, settings: { ...DEFAULTS }, results: {} });
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  function normalise(p) { const i = p || {}; return { version: 2, units: Array.isArray(i.units) ? i.units : [], files: Array.isArray(i.files) ? i.files : [], progress: obj(i.progress), quizBest: obj(i.quizBest), saved: Array.isArray(i.saved) ? i.saved : [], studyDays: Array.isArray(i.studyDays) ? i.studyDays : [], reviewLog: obj(i.reviewLog), missed: obj(i.missed), results: obj(i.results), settings: { ...DEFAULTS, ...obj(i.settings) } }; }
  function load() { try { const r = localStorage.getItem(KEY); return r ? normalise(JSON.parse(r)) : blank(); } catch (e) { return blank(); } }
  let S = load();
  if (S.settings.aiEngine === 'device') { S.settings.aiEngine = 'off'; S.notice = 'On-device AI is not part of version 3. Your notes search still works offline; add an AI service in Settings if you want written answers.'; try { localStorage.setItem(KEY, JSON.stringify({ ...S, notice: undefined })); } catch (e) {} }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Storage is full. Back up and remove some notes.'); } };

  // ---------- text helpers (identical rules to 2.0) ----------
  const STOP = new Set('the and for are but not you all any can had her was one our out get has him his how its may new now see two who did does this that with from have they will your what when which about into than them then there these those also been being were their would could should just more most such only other some very over under after before'.split(' '));
  const tokens = (t) => (String(t).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w));
  const sentences = (t) => String(t).replace(/\r/g, '').split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-*•]\s)/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 3);
  const hash = (s) => { let h = 5381; for (let n = 0; n < s.length; n++) h = ((h << 5) + h) ^ s.charCodeAt(n); return (h >>> 0).toString(36); };
  function cardsFor(unitId) {
    const out = [], seen = new Set(), add = (c) => { const k = c.front.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push({ ...c, id: hash(c.unitId + k) }); };
    for (const f of S.files) if (f.unitId === unitId) for (const s of sentences(f.text)) {
      if (s.length < 25 || s.length > 280) continue;
      const g = s.match(/^([^:]{2,60}):\s+(.{5,})$/), m = s.match(/^(.{2,60}?)\s+(?:is|are|means|refers to)\s+(.{5,}?)\.?$/i);
      if (g) add({ unitId, front: `Define: ${g[1].trim()}`, back: g[2].replace(/\.$/, '').trim(), source: f.name, kind: 'def' });
      else if (m) add({ unitId, front: `Define: ${m[1].trim()}`, back: m[2].replace(/\.$/, '').trim(), source: f.name, kind: 'def' });
      else { const words = (s.match(/\b[A-Za-z]{6,}\b/g) || []).filter((w) => !STOP.has(w.toLowerCase())); if (s.split(' ').length < 6 || !words.length) continue;
        const w = words.reduce((a, b) => (b.length > a.length ? b : a)); add({ unitId, front: s.replace(new RegExp(`\\b${w}\\b`), '_____'), back: w, source: f.name, kind: 'cloze' }); }
      if (out.length >= 300) return out;
    }
    return out;
  }
  function passages(unitId, words) {
    const out = [];
    for (const f of S.files) { if (unitId && f.unitId !== unitId) continue; let buf = [], c = 0, n = 0;
      const push = () => { if (buf.length) out.push({ id: `${f.id}-${n++}`, fileName: f.name, unitId: f.unitId, text: buf.join(' ') }); buf = []; c = 0; };
      for (const s of sentences(f.text)) { const w = s.split(' ').length; if (c + w > words && buf.length) push(); buf.push(s); c += w; } push(); }
    return out;
  }
  function search(ps, q, k) {
    const terms = [...new Set(tokens(q))]; if (!terms.length || !ps.length) return [];
    const toks = ps.map((p) => tokens(p.text)), N = toks.length, avg = toks.reduce((a, t) => a + t.length, 0) / N || 1, k1 = 1.2, b = 0.75, res = [];
    toks.forEach((t, i) => { let sc = 0; const hit = []; for (const w of terms) { const tf = t.filter((x) => x === w).length; if (!tf) continue; const df = toks.filter((x) => x.includes(w)).length, idf = Math.log(1 + (N - df + 0.5) / (df + 0.5)); sc += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * t.length) / avg)); hit.push(w); } if (sc > 0) res.push({ p: ps[i], score: sc, hit }); });
    return res.sort((a, b2) => b2.score - a.score).slice(0, k);
  }

  // ---------- scheduling: SM-2, compatible with 2.0's {interval, due} ----------
  const isDue = (id, now = Date.now()) => { const p = S.progress[id]; return !p || p.due <= now; };
  function schedule(prev, grade, now = Date.now()) {
    let ease = prev && prev.ease ? prev.ease : 2.5, reps = prev ? (prev.reps ?? (prev.interval > 0 ? 2 : 0)) : 0, iv = prev ? prev.interval || 0 : 0;
    if (grade === 'again') return { interval: 0, due: now + 60e3, ease: Math.max(1.3, ease - 0.2), reps: 0 };
    const q = { hard: 3, good: 4, easy: 5 }[grade];
    ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    if (reps === 0) iv = grade === 'easy' ? 4 : 1; else if (reps === 1) iv = grade === 'hard' ? 3 : 6; else iv = Math.max(iv + 1, Math.round(iv * (grade === 'hard' ? 1.2 : ease) * (grade === 'easy' ? 1.3 : 1)));
    return { interval: iv, due: now + iv * DAY, ease: Math.round(ease * 100) / 100, reps: reps + 1 };
  }
  const ivLabel = (p) => (p.interval === 0 ? '1 min' : p.interval === 1 ? '1 day' : p.interval < 30 ? p.interval + ' days' : Math.round(p.interval / 30) + ' mo');

  // ---------- utilities ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function streak() { const set = new Set(S.studyDays); let n = 0; const d = new Date(); if (!set.has(dayKey())) d.setDate(d.getDate() - 1); while (set.has(dayKey(d.getTime()))) { n++; d.setDate(d.getDate() - 1); } return n; }
  function markStudy(right) { const k = dayKey(); if (!S.studyDays.includes(k)) S.studyDays = [...S.studyDays, k].slice(-400); S.reviewLog[k] = (S.reviewLog[k] || 0) + 1; const r = (S.results[k] ||= { r: 0, w: 0 }); right ? r.r++ : r.w++; }
  function remembered() { let r = 0, w = 0; for (let i = 0; i < 30; i++) { const x = S.results[dayKey(Date.now() - i * DAY)]; if (x) { r += x.r; w += x.w; } } return r + w ? Math.round((r / (r + w)) * 100) : null; }
  let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }
  const unitById = (id) => S.units.find((u) => u.id === id);
  function unitStats(u) { const cs = cardsFor(u.id), now = Date.now(); let m = 0; for (const c of cs) { const p = S.progress[c.id]; if (p && p.interval >= 8) m++; } return { cards: cs.length, due: cs.filter((c) => isDue(c.id, now)).length, mastered: m, files: S.files.filter((f) => f.unitId === u.id).length }; }
  function allDue() { const out = []; for (const u of S.units) for (const c of cardsFor(u.id)) if (isDue(c.id)) out.push(c); return out; }
  const ICON = { gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>', back: '<path d="M15 5l-7 7 7 7"/>' };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

  // ---------- views ----------
  const ui = { filter: 'all', mode: 'cards', session: null, quiz: null, ask: { q: '', res: [], ai: null, busy: false } };
  const route = () => { const h = location.hash.replace(/^#\/?/, '') || ({ Home: 'today', Units: 'units', Cards: 'cards', Ask: 'ask' }[S.settings.startView] || 'today'); const [v, id] = h.split('/'); return { v, id }; };
  function render() {
    const r = document.documentElement; r.dataset.theme = S.settings.theme === 'system' ? 'auto' : S.settings.theme; r.dataset.size = S.settings.textSize;
    const { v, id } = route(); const tab = { today: 'today', units: 'units', unit: 'units', cards: 'cards', ask: 'ask' }[v] || '';
    $('#tabs').innerHTML = [['today', 'Today'], ['units', 'Units'], ['cards', 'Cards'], ['ask', 'Ask']].map(([k, l]) => `<a href="#${k}"${tab === k ? ' aria-current="page"' : ''}>${l}</a>`).join('');
    $('#tabs').hidden = v === 'settings'; $('#gear').innerHTML = svg(v === 'settings' ? 'back' : 'gear'); $('#gear').setAttribute('aria-label', v === 'settings' ? 'Back' : 'Settings');
    $('#main').innerHTML = ({ today: vToday, units: vUnits, unit: () => vUnit(id), cards: vCards, ask: vAsk, settings: vSettings }[v] || vToday)();
    document.title = 'Recall Notes';
  }
  function heatmap() { let html = ''; const start = Date.now() - 83 * DAY; for (let w = 0; w < 12; w++) { html += '<div class="wk">'; for (let d = 0; d < 7; d++) { const n = S.reviewLog[dayKey(start + (w * 7 + d) * DAY)] || 0; html += `<i class="${n >= 30 ? 'l3' : n >= 10 ? 'l2' : n ? 'l1' : ''}" title="${n}"></i>`; } html += '</div>'; } return `<div class="heat" aria-label="Reviews over the last 12 weeks">${html}</div>`; }
  function vToday() {
    const due = allDue().length, st = streak(), rm = remembered(), ex = S.settings.examDate, days = ex ? Math.ceil((new Date(ex + 'T00:00:00') - new Date(dayKey() + 'T00:00:00')) / DAY) : null;
    const hr = new Date().getHours(), part = hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening';
    const recent = S.units.slice().sort((a, b) => (b.lastStudied || b.createdAt || 0) - (a.lastStudied || a.createdAt || 0)).slice(0, 4);
    if (!S.units.length) return `${S.notice ? `<p class="card small">${esc(S.notice)}</p>` : ''}<div class="empty"><h3>Start with <span class="hl">one unit</span></h3><p class="muted">A unit is a topic, like "Cell division". Add notes to it and Recall turns them into flashcards and a quiz.</p><p style="margin-top:14px"><a class="btn solid" href="#units">Create a unit</a></p></div>`;
    return `${S.notice ? `<p class="card small">${esc(S.notice)}</p>` : ''}<p class="muted small">Good ${part}</p>
      <h1 class="hello">${due ? `You have <span class="hl">${plural(due, 'card')}</span> due` : 'All caught up. <span class="hl">Nice.</span>'}</h1>
      <div class="stats"><div><b>${st}</b><span>day streak</span></div><div><b>${rm == null ? '—' : rm + '%'}</b><span>remembered (30 days)</span></div><div><b>${days == null ? '—' : days < 0 ? 'done' : days + ' d'}</b><span>${ex ? 'until the exam' : 'set an exam date'}</span></div></div>
      <button type="button" class="go" data-a="reviewAll" ${due ? '' : 'disabled'}>Start review <small>≈ ${Math.max(1, Math.round(Math.min(due, S.settings.dailyGoal || due) * 0.4))} min →</small></button>
      <h2>Continue</h2><div class="list">${recent.map(unitRow).join('')}</div>
      <div class="card"><div class="between" style="margin-bottom:10px"><h3>Last 12 weeks</h3><span class="small muted">${Object.values(S.reviewLog).reduce((a, b) => a + b, 0)} reviews</span></div>${heatmap()}</div>`;
  }
  function unitRow(u) { const s = unitStats(u); return `<a class="unit" href="#unit/${u.id}"><span class="tab" aria-hidden="true"></span><span class="tx"><b>${esc(u.name)}</b><small>${plural(s.cards, 'card')} · ${s.due} due · ${plural(s.files, 'note')}</small></span><span class="star${u.favorite ? ' on' : ''}" aria-label="${u.favorite ? 'Favourite' : ''}">${u.favorite ? '★' : ''}</span></a>`; }
  function vUnits() {
    let us = S.units.slice(); if (ui.filter === 'fav') us = us.filter((u) => u.favorite); if (ui.filter === 'recent') us.sort((a, b) => (b.lastStudied || 0) - (a.lastStudied || 0));
    return `<form class="row" data-f="newUnit"><input type="text" name="name" placeholder="New unit, e.g. Soil chemistry" aria-label="New unit name" style="flex:1" maxlength="60"><button class="btn solid">Create</button></form>
      <div class="chips">${[['all', 'All units'], ['fav', 'Favourites'], ['recent', 'Recent']].map(([k, l]) => `<button type="button" class="chip" data-a="filter" data-k="${k}" aria-pressed="${ui.filter === k}">${l}</button>`).join('')}</div>
      <div class="list">${us.map(unitRow).join('') || '<div class="empty"><p class="muted">No units here yet.</p></div>'}</div>`;
  }
  function vUnit(id) {
    const u = unitById(id); if (!u) return '<div class="empty"><p>That unit no longer exists.</p></div>'; const s = unitStats(u), fs = S.files.filter((f) => f.unitId === id);
    return `<div class="between"><h1>${esc(u.name)}</h1><button type="button" class="iconbtn" data-a="fav" data-id="${id}" aria-label="${u.favorite ? 'Remove from favourites' : 'Add to favourites'}" style="font-size:1.3rem;color:${u.favorite ? '#E0A100' : 'var(--muted)'}">${u.favorite ? '★' : '☆'}</button></div>
      <div class="stats"><div><b>${s.cards}</b><span>cards</span></div><div><b>${s.due}</b><span>due now</span></div><div><b>${S.quizBest[id] != null ? S.quizBest[id] + '%' : '—'}</b><span>best quiz</span></div></div>
      <div class="card"><div class="between small"><span>Mastered</span><span>${s.mastered} of ${s.cards}</span></div><div class="bar" style="margin-top:6px"><i style="width:${s.cards ? (s.mastered / s.cards) * 100 : 0}%"></i></div></div>
      <div class="row"><button type="button" class="btn solid" data-a="review" data-id="${id}" ${s.cards ? '' : 'disabled'}>Review ${s.due ? s.due + ' due' : 'all'}</button><button type="button" class="btn" data-a="quiz" data-id="${id}" ${s.cards >= 4 ? '' : 'disabled'}>Quiz</button><a class="btn" href="#ask" data-a="askIn" data-id="${id}">Ask</a></div>
      <div class="card"><div class="between" style="margin-bottom:6px"><h3>Notes</h3><span class="row"><button type="button" class="btn small" data-a="paste" data-id="${id}">Write</button><label class="btn small solid">Import<input type="file" class="sr" multiple accept=".txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.pdf" data-import="${id}"></label></span></div>
      ${fs.map((f) => `<div class="file"><span><b>${esc(f.name)}</b><small>${(f.kind || 'text').toUpperCase()} · ${Math.round(f.text.length / 5)} words</small></span><button type="button" class="btn small" data-a="viewFile" data-id="${f.id}">Read</button><button type="button" class="btn small danger" data-a="delFile" data-id="${f.id}" aria-label="Delete ${esc(f.name)}">×</button></div>`).join('') || '<p class="muted small">Import TXT, Markdown, PDF, CSV, JSON or HTML, or write a note. Lines like "Term: meaning" or "X is Y" become flashcards.</p>'}</div>
      <div class="row"><button type="button" class="btn small" data-a="rename" data-id="${id}">Rename</button><button type="button" class="btn small danger" data-a="delUnit" data-id="${id}">Delete unit</button></div>`;
  }
  function focusBtn() { const f = ui.focus; if (!f) return `<button type="button" class="focus" data-a="focus">Focus ${S.settings.focusMin}:00</button>`; const left = Math.max(0, f.end - Date.now()), m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000); return `<button type="button" class="focus on" data-a="focus" id="focusBtn">${f.brk ? 'Break' : 'Focus'} ${m}:${String(s).padStart(2, '0')}</button>`; }
  function vCards() {
    const ses = ui.session, qz = ui.quiz;
    if (qz) return vQuiz();
    if (!ses) { const due = allDue().length; return `<h1>Study <span class="hl">flashcards</span></h1><p class="muted">Pick a unit, or review everything that is due.</p>
      <button type="button" class="go" data-a="reviewAll" ${due ? '' : 'disabled'}>Review all due <small>${due}</small></button>
      <div class="list">${S.units.map((u) => { const s = unitStats(u); return `<button type="button" class="unit" data-a="review" data-id="${u.id}"><span class="tab"></span><span class="tx"><b>${esc(u.name)}</b><small>${s.due} due of ${s.cards}</small></span></button>`; }).join('') || '<div class="empty"><p class="muted">Create a unit and add notes first.</p><p style="margin-top:10px"><a class="btn solid" href="#units">Go to Units</a></p></div>'}</div>`; }
    const c = ses.cards[ses.i];
    if (!c) return `<div class="empty"><h3>Session done</h3><p class="muted">${ses.right} remembered, ${ses.wrong} to see again soon.</p><p style="margin-top:12px" class="row" ><button type="button" class="btn solid" data-a="endSession">Back</button></p></div>`;
    const p = S.progress[c.id], pv = ['again', 'hard', 'good', 'easy'].map((g) => [g, ivLabel(schedule(p, g))]);
    return `<div class="between"><span class="muted small">Card ${ses.i + 1} of ${ses.cards.length}</span>${focusBtn()}</div>
      <div class="stage"><div class="flip${ses.flipped ? ' back' : ''}" data-a="flip" role="button" tabindex="0" aria-label="${ses.flipped ? 'Answer shown' : 'Show answer'}">
        <div class="face"><span class="lab">${esc((unitById(c.unitId) || {}).name || '')} · ${c.kind === 'def' ? 'define' : 'fill the gap'}</span><p class="q">${esc(c.front)}</p><span class="src">${esc(c.source)}</span></div>
        <div class="face b"><span class="lab">Answer · tap to flip back</span><p class="q">${esc(c.back)}</p><span class="src">${esc(c.source)}</span></div></div></div>
      ${ses.flipped ? `<div class="grades">${pv.map(([g, l]) => `<button type="button" class="g-${g}" data-a="grade" data-g="${g}">${g[0].toUpperCase() + g.slice(1)}<small>${l}</small></button>`).join('')}</div>` : `<button type="button" class="go" data-a="flip">Show answer</button>`}
      <button type="button" class="btn small" data-a="endSession">End session</button>`;
  }
  function vQuiz() {
    const qz = ui.quiz, c = qz.cards[qz.i];
    if (!c) { const pct = Math.round((qz.right / qz.cards.length) * 100); return `<div class="empty"><h3>Quiz score <span class="hl">${pct}%</span></h3><p class="muted">${qz.right} of ${qz.cards.length} right.${S.quizBest[qz.unit] === pct ? ' New best.' : ''}</p><p style="margin-top:12px" class="row"><button type="button" class="btn solid" data-a="quiz" data-id="${qz.unit}">Try again</button><button type="button" class="btn" data-a="endQuiz">Done</button></p></div>`; }
    return `<div class="between"><span class="muted small">Question ${qz.i + 1} of ${qz.cards.length} · ${qz.right} right</span>${focusBtn()}</div>
      <div class="card"><p style="font:500 1.125rem/1.4 var(--serif)">${esc(c.front)}</p>${S.settings.showHints ? `<p class="small muted" style="margin-top:6px">Hint: from ${esc(c.source)}</p>` : ''}</div>
      <div class="opts">${qz.opts.map((o, k) => `<button type="button" data-a="pick" data-k="${k}" class="${qz.picked != null ? (o === c.back ? 'right' : k === qz.picked ? 'wrong' : '') : ''}" ${qz.picked != null ? 'disabled' : ''}>${esc(o)}</button>`).join('')}</div>
      ${qz.picked != null ? `<button type="button" class="go" data-a="nextQ">Next →</button>` : ''}`;
  }
  function vAsk() {
    const a = ui.ask, unit = unitById(a.unit) || null, saved = S.saved.slice(0, 6);
    return `<h1>Ask <span class="hl">your notes</span></h1>
      <form class="row" data-f="ask"><select name="unit" aria-label="Unit" style="flex:1 1 140px"><option value="">All units</option>${S.units.map((u) => `<option value="${u.id}"${a.unit === u.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select><input type="search" name="q" value="${esc(a.q)}" placeholder="e.g. what happens in anaphase" aria-label="Question" style="flex:3 1 220px"><button class="btn solid">Ask</button></form>
      ${a.ai ? `<div class="card"><h3>${a.ai.ok ? 'Answer' : 'The AI could not answer'}</h3><p class="answer" style="margin-top:6px">${esc(a.ai.text)}</p>${a.ai.ok ? '<p class="small muted" style="margin-top:8px">AI-generated from the passages below. It can be wrong, so check it against your notes.</p><p class="row" style="margin-top:10px"><button type="button" class="btn small" data-a="saveAns">Save answer</button></p>' : ''}</div>` : a.busy ? '<div class="card thinking" role="status"><p class="muted small">Writing an answer from your notes…</p><i></i><i></i><i></i></div>' : ''}
      ${a.q && !a.res.length ? '<div class="empty"><p class="muted">Nothing in your notes matches that. Try other words.</p></div>' : ''}
      ${a.res.map((r, i) => `<div class="passage"><p>${markTerms(r.p.text, r.hit)}</p><small>[${i + 1}] ${esc(r.p.fileName)}</small></div>`).join('')}
      ${!a.q && saved.length ? `<h2>Saved answers</h2>${saved.map((s) => `<div class="card"><b>${esc(s.question)}</b><small class="muted" style="display:block">AI-generated answer</small><p class="answer small" style="margin-top:4px">${esc(s.answer)}</p><p class="row" style="margin-top:8px"><button type="button" class="btn small danger" data-a="delSaved" data-id="${s.id}">Remove</button></p></div>`).join('')}` : ''}
      ${S.settings.aiEngine === 'off' ? '<p class="small muted">Searching on this phone. Add an AI service in Settings for written answers.</p>' : ''}`;
  }
  function markTerms(t, hit) { let h = esc(t); for (const w of hit) h = h.replace(new RegExp(`\\b(${w}\\w*)`, 'gi'), '<mark>$1</mark>'); return h; }
  function vSettings() {
    const s = S.settings, sel = (k, opts) => `<select data-set="${k}" aria-label="${k}">${opts.map(([v, l]) => `<option value="${v}"${String(s[k]) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const num = (k, min, max) => `<input type="number" data-set="${k}" value="${s[k]}" min="${min}" max="${max}" inputmode="numeric" aria-label="${k}">`;
    const t = `${String(s.reminderHour).padStart(2, '0')}:${String(s.reminderMinute).padStart(2, '0')}`;
    return `<h1>Settings</h1>
      <div class="sgroup"><h2>Study</h2><div class="slist"><div class="srow"><span>Cards per session (0 = all due)</span>${num('dailyGoal', 0, 500)}</div><div class="srow"><span>Quiz length</span>${num('quizLength', 4, 50)}</div><div class="srow"><label for="sh">Show hints</label><input id="sh" type="checkbox" data-set="showHints" ${s.showHints ? 'checked' : ''}></div><div class="srow"><span>Exam date</span><input type="date" data-set="examDate" value="${esc(s.examDate)}"></div><div class="srow"><span>Focus / break minutes</span><span class="row" style="flex-wrap:nowrap">${num('focusMin', 5, 90)}${num('breakMin', 1, 30)}</span></div><div class="srow"><span>Open on</span>${sel('startView', [['Home', 'Today'], ['Units', 'Units'], ['Cards', 'Cards'], ['Ask', 'Ask']])}</div></div></div>
      <div class="sgroup"><h2>Reminders</h2><div class="slist"><div class="srow"><label for="rem">Daily reminder</label><input id="rem" type="checkbox" data-set="reminderOn" ${s.reminderOn ? 'checked' : ''}></div><div class="srow"><span>Time</span><input type="time" data-set="reminderTime" value="${t}"></div></div></div>
      <div class="sgroup"><h2>Ask your notes</h2><div class="slist"><div class="srow"><span>Results to show</span>${num('resultCount', 1, 10)}</div><div class="srow"><span>Passage length (words)</span>${num('passageWords', 40, 400)}</div><div class="srow"><span>Written answers</span>${sel('aiEngine', [['off', 'Off: search only'], ['api', 'AI service (online)']])}</div>
        ${s.aiEngine === 'api' ? `<div class="srow"><span>Endpoint</span><input type="url" data-set="aiEndpoint" value="${esc(s.aiEndpoint)}"></div><div class="srow"><span>API key</span><input type="password" data-set="aiKey" value="${esc(s.aiKey)}" autocomplete="off"></div><div class="srow"><span>Model</span><input type="text" data-set="aiModel" value="${esc(s.aiModel)}"></div>` : ''}</div>
        ${s.aiEngine === 'api' ? '<p class="small muted">Only the question and the matching passages are sent to this service, over https. The key stays on this phone.</p>' : ''}</div>
      <div class="sgroup"><h2>Look</h2><div class="slist"><div class="srow"><span>Theme</span>${sel('theme', [['system', 'Follow phone'], ['light', 'Light'], ['dark', 'Dark']])}</div><div class="srow"><span>Text size</span>${sel('textSize', [['small', 'Small'], ['medium', 'Standard'], ['large', 'Large']])}</div></div></div>
      <div class="sgroup"><h2>Data</h2><div class="slist"><div class="srow"><span>Back up now</span><button type="button" class="btn small solid" data-a="backup">Save</button></div><div class="srow"><span>Restore from file</span><label class="btn small">Choose<input type="file" class="sr" accept=".json,application/json" data-restore></label></div><div class="srow"><span>Erase everything</span><button type="button" class="btn small danger" data-a="wipe">Erase</button></div><div class="srow"><span>Privacy</span><button type="button" class="btn small" data-a="privacy">Read</button></div></div>
        <p class="small muted">Everything stays on this phone. Backups include units, notes, progress and settings, but not your AI key.</p></div>`;
  }

  // ---------- sessions ----------
  function startReview(cards) { if (!cards.length) return toast('Nothing to review.'); const n = S.settings.dailyGoal > 0 ? S.settings.dailyGoal : cards.length; ui.session = { cards: cards.slice(0, n), i: 0, flipped: false, right: 0, wrong: 0 }; ui.quiz = null; location.hash = 'cards'; render(); }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function startQuiz(id) { const cs = cardsFor(id); if (cs.length < 4) return toast('A quiz needs at least 4 cards.'); const pick = shuffle(cs.slice()).slice(0, S.settings.quizLength); ui.quiz = { unit: id, cards: pick, all: cs, i: 0, right: 0, picked: null, opts: optsFor(pick[0], cs) }; ui.session = null; location.hash = 'cards'; render(); }
  function optsFor(c, all) { const others = shuffle(all.filter((x) => x.back !== c.back && x.kind === c.kind).map((x) => x.back)); const pool = [...new Set(others)].slice(0, 3); if (pool.length < 3) pool.push(...shuffle(all.filter((x) => x.back !== c.back).map((x) => x.back)).filter((x) => !pool.includes(x)).slice(0, 3 - pool.length)); return shuffle([c.back, ...pool]); }
  function touchUnit(id) { const u = unitById(id); if (u) u.lastStudied = Date.now(); }

  // ---------- files ----------
  let pdfReady = null;
  function loadPdf() { if (!pdfReady) pdfReady = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'pdfjs/pdf.min.js'; s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.js'; res(window.pdfjsLib); }; s.onerror = () => { pdfReady = null; rej(new Error('The PDF reader could not load')); }; document.head.appendChild(s); }); return pdfReady; }
  async function readFile(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') { const lib = await loadPdf(); const doc = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise; const pages = []; for (let p = 1; p <= doc.numPages; p++) { const tc = await (await doc.getPage(p)).getTextContent(); pages.push(tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('')); } return { text: pages.join('\n\n'), kind: 'pdf' }; }
    const raw = await f.text();
    if (ext === 'html' || ext === 'htm') { const d = new DOMParser().parseFromString(raw, 'text/html'); d.querySelectorAll('script,style').forEach((n) => n.remove()); return { text: d.body.innerText || d.body.textContent || '', kind: 'html' }; }
    if (ext === 'json') { try { return { text: JSON.stringify(JSON.parse(raw), null, 1).replace(/[{}[\]",]/g, ' '), kind: 'json' }; } catch (e) { return { text: raw, kind: 'json' }; } }
    return { text: raw, kind: ext === 'csv' || ext === 'tsv' ? ext : ext === 'md' || ext === 'markdown' ? 'md' : 'txt' };
  }
  async function importFiles(unitId, list) {
    const ok = [], bad = []; toast('Reading files…');
    for (const f of Array.from(list)) { try { const { text, kind } = await readFile(f); if (!text.trim()) { bad.push(f.name + ' has no readable text'); continue; } ok.push({ id: uid(), unitId, name: f.name, kind, text, addedAt: Date.now() }); } catch (e) { bad.push((e && e.message) || f.name + ' could not be read'); } }
    if (ok.length) { S.files = [...ok, ...S.files]; save(); }
    render(); toast(bad.length ? `Imported ${ok.length}. ${bad[0]}` : `Imported ${plural(ok.length, 'file')}`);
  }
  let sheetT; const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function sheet(html) { const s = $('#sheet'); clearTimeout(sheetT); s.classList.remove('out'); s.innerHTML = `<div role="dialog" aria-modal="true">${html}</div>`; s.hidden = false; const f = s.querySelector('input,textarea,button'); if (f) f.focus(); }
  const closeSheet = () => { const s = $('#sheet'); if (s.hidden) return; clearTimeout(sheetT); const done = () => { s.hidden = true; s.innerHTML = ''; s.classList.remove('out'); }; if (still) return done(); s.classList.add('out'); sheetT = setTimeout(done, 200); };

  // ---------- AI (optional, https only, through the native bridge on Android) ----------
  const pending = new Map();
  window.__recallResolve = (id, ok, text) => { const p = pending.get(id); if (!p) return; pending.delete(id); ok ? p.resolve(text) : p.reject(new Error(text)); };
  function post(url, headers, body) { if (window.RecallNative && typeof window.RecallNative.postJson === 'function') { const id = Math.random().toString(36).slice(2); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); window.RecallNative.postJson(id, url, JSON.stringify(headers), body); }); } return fetch(url, { method: 'POST', headers, body }).then(async (r) => { const t = await r.text(); if (!r.ok) throw new Error('The AI service returned ' + r.status); return t; }); }
  async function aiAnswer(q, res) {
    const s = S.settings; if (!/^https:\/\//i.test(s.aiEndpoint.trim())) throw new Error('Add an https endpoint in Settings → Ask your notes');
    const ctx = res.slice(0, s.aiPassages || 5).map((r, i) => `[${i + 1}] (${r.p.fileName})\n${r.p.text}`).join('\n\n');
    const headers = { 'Content-Type': 'application/json' }; if (s.aiKey.trim()) headers.Authorization = 'Bearer ' + s.aiKey.trim();
    const body = JSON.stringify({ model: s.aiModel || 'gpt-4o-mini', temperature: 0.2, messages: [{ role: 'system', content: "You answer questions using ONLY the numbered passages from the user's notes. Cite the passages you used like [1]. If the passages do not contain the answer, say you cannot find it in the notes. Be concise and clear." }, { role: 'user', content: `Passages:\n${ctx}\n\nQuestion: ${q}` }] });
    const d = JSON.parse(await post(s.aiEndpoint.trim(), headers, body)); if (d.error) throw new Error(d.error.message || 'The AI service reported an error');
    const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content; if (!t) throw new Error('The AI service sent an empty answer'); return String(t).trim();
  }

  // ---------- events ----------
  const A = {
    reviewAll() { startReview(allDue()); },
    review(d) { const cs = cardsFor(d.id), due = cs.filter((c) => isDue(c.id)); touchUnit(d.id); save(); startReview(due.length ? due : cs); },
    quiz(d) { touchUnit(d.id); save(); startQuiz(d.id); },
    flip() { if (ui.session) { ui.session.flipped = !ui.session.flipped; render(); } },
    grade(d) { const ses = ui.session, c = ses.cards[ses.i]; S.progress[c.id] = schedule(S.progress[c.id], d.g); const right = d.g !== 'again'; markStudy(right); right ? ses.right++ : (ses.wrong++, (S.missed[c.id] = (S.missed[c.id] || 0) + 1), ses.cards.push(c)); ses.i++; ses.flipped = false; save(); render(); },
    endSession() { ui.session = null; render(); },
    pick(d) { const qz = ui.quiz, c = qz.cards[qz.i]; qz.picked = Number(d.k); const right = qz.opts[qz.picked] === c.back; if (right) qz.right++; else S.missed[c.id] = (S.missed[c.id] || 0) + 1; markStudy(right); save(); render(); },
    nextQ() { const qz = ui.quiz; qz.i++; qz.picked = null; if (qz.cards[qz.i]) qz.opts = optsFor(qz.cards[qz.i], qz.all); else { const pct = Math.round((qz.right / qz.cards.length) * 100); S.quizBest[qz.unit] = Math.max(pct, S.quizBest[qz.unit] || 0); save(); } render(); },
    endQuiz() { ui.quiz = null; render(); },
    filter(d) { ui.filter = d.k; render(); },
    fav(d) { const u = unitById(d.id); u.favorite = !u.favorite; save(); render(); },
    askIn(d) { ui.ask.unit = d.id; },
    paste(d) { sheet(`<h2>Write a note</h2><form data-f="note" data-id="${d.id}"><div class="field"><label for="nt">Title</label><input id="nt" type="text" name="title" maxlength="60" placeholder="e.g. Lecture 3"></div><div class="field"><label for="nb">Note</label><textarea id="nb" name="body" rows="8" placeholder="Mitosis: division of one cell into two identical cells."></textarea></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn solid">Save note</button></div></form>`); },
    viewFile(d) { const f = S.files.find((x) => x.id === d.id); sheet(`<h2>${esc(f.name)}</h2><p class="answer" style="max-height:60dvh;overflow:auto">${esc(f.text.slice(0, 20000))}</p><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn solid" data-a="close">Close</button></div>`); },
    delFile(d) { if (!confirm('Delete this note? Cards made from it go too.')) return; S.files = S.files.filter((f) => f.id !== d.id); save(); render(); },
    rename(d) { const u = unitById(d.id); const n = prompt('Rename unit', u.name); if (n && n.trim()) { u.name = n.trim().slice(0, 60); save(); render(); } },
    delUnit(d) { if (!confirm('Delete this unit, its notes and saved answers?')) return; S.units = S.units.filter((u) => u.id !== d.id); S.files = S.files.filter((f) => f.unitId !== d.id); S.saved = S.saved.filter((x) => x.unitId !== d.id); save(); location.hash = 'units'; },
    close: closeSheet,
    saveAns() { const a = ui.ask; S.saved = [{ id: uid(), unitId: a.unit || '', question: a.q, answer: a.ai.text, sources: a.res.map((r) => r.p.fileName), savedAt: Date.now() }, ...S.saved].slice(0, 300); save(); toast('Answer saved'); },
    delSaved(d) { S.saved = S.saved.filter((x) => x.id !== d.id); save(); render(); },
    focus() { if (ui.focus) { clearInterval(ui.focus.t); ui.focus = null; render(); return; } const tick = () => { const b = document.getElementById('focusBtn'); if (Date.now() >= ui.focus.end) { const brk = !ui.focus.brk; ui.focus.brk = brk; ui.focus.end = Date.now() + (brk ? S.settings.breakMin : S.settings.focusMin) * 60e3; toast(brk ? 'Focus block done. Take a short break.' : 'Break over. Back to it.'); } if (b) b.outerHTML = focusBtn(); }; ui.focus = { end: Date.now() + S.settings.focusMin * 60e3, brk: false }; ui.focus.t = setInterval(tick, 1000); render(); },
    backup() { const copy = JSON.parse(JSON.stringify(S)); copy.settings.aiKey = ''; delete copy.notice; const name = `recall-notes-backup-${dayKey()}.json`, text = JSON.stringify(copy, null, 2);
      if (window.RecallNative && typeof window.RecallNative.saveFile === 'function') { window.RecallNative.saveFile(name, 'application/json', text); return; }
      const u = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); toast('Backup saved'); },
    privacy() { sheet(`<h2>Privacy</h2><div class="prose"><p><b>What is stored.</b> Your units, notes, flashcard progress and settings are stored on this phone only. There is no account and no tracking or advertising.</p><p><b>What leaves the phone.</b> Nothing, unless you turn on an AI service in Settings. Then, each time you ask a question, the question and the matching passages from your notes are sent over https to the service you chose, using your own key. That service's privacy terms apply to what it receives.</p><p><b>Backups.</b> A backup is a file you save or share yourself. It never includes your AI key.</p><p><b>Deleting.</b> "Erase everything" removes all units, notes, progress and your AI key from this phone. Uninstalling the app does the same.</p></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn solid" data-a="close">Close</button></div>`); },
    wipe() { if (!confirm('Erase all units, notes, progress and your AI key on this phone? This cannot be undone without a backup.')) return; const keep = { ...S.settings, aiKey: '' }; S = blank(); S.settings = keep; save(); location.hash = 'today'; render(); },
  };
  document.addEventListener('click', (e) => { const t = e.target.closest('[data-a]'); if (!t) return; if (t.dataset.a === 'askIn') { A.askIn(t.dataset); return; } e.preventDefault(); const f = A[t.dataset.a]; if (f) f(t.dataset); });
  document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.flip')) { e.preventDefault(); A.flip(); } if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  document.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, fd = new FormData(f);
    if (f.dataset.f === 'newUnit') { const n = String(fd.get('name') || '').trim(); if (!n) return toast('Give the unit a name first'); const u = { id: uid(), name: n.slice(0, 60), favorite: false, createdAt: Date.now() }; S.units = [u, ...S.units]; save(); location.hash = 'unit/' + u.id; toast(`Created “${n}”`); }
    if (f.dataset.f === 'note') { const body = String(fd.get('body') || '').trim(); if (!body) return toast('Write something first'); S.files = [{ id: uid(), unitId: f.dataset.id, name: String(fd.get('title') || '').trim() || 'Note ' + dayKey(), kind: 'note', text: body, addedAt: Date.now() }, ...S.files]; save(); closeSheet(); render(); toast('Note saved'); }
    if (f.dataset.f === 'ask') { const a = ui.ask; a.q = String(fd.get('q') || '').trim(); a.unit = String(fd.get('unit') || ''); a.ai = null; a.res = a.q ? search(passages(a.unit || null, S.settings.passageWords), a.q, S.settings.resultCount) : [];
      if (a.q && a.res.length && S.settings.aiEngine === 'api') { a.busy = true; render(); try { a.ai = { ok: true, text: await aiAnswer(a.q, a.res) }; } catch (err) { a.ai = { ok: false, text: err.message || 'The AI could not answer' }; } a.busy = false; }
      render(); }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.import) { await importFiles(t.dataset.import, t.files); t.value = ''; return; }
    if (t.hasAttribute('data-restore')) { const file = t.files[0]; if (!file) return; try { const o = JSON.parse(await file.text()); if (!o || !Array.isArray(o.units) || !Array.isArray(o.files)) throw new Error(); const key = S.settings.aiKey; S = normalise(o); if (!S.settings.aiKey) S.settings.aiKey = key; save(); render(); toast('Backup restored: ' + plural(S.units.length, 'unit')); } catch (err) { toast('That file is not a Recall Notes backup.'); } t.value = ''; return; }
    const k = t.dataset.set; if (!k) return; const s = S.settings;
    if (k === 'reminderTime') { const [h, m] = String(t.value || '19:00').split(':').map(Number); s.reminderHour = h; s.reminderMinute = m; }
    else if (t.type === 'checkbox') s[k] = t.checked; else if (t.type === 'number') s[k] = Math.max(Number(t.min) || 0, Math.min(Number(t.max) || 999, Number(t.value) || 0)); else s[k] = t.value;
    if (k === 'reminderOn' && s.reminderOn && window.RecallNative && window.RecallNative.requestNotifications) window.RecallNative.requestNotifications();
    if ((k === 'reminderOn' || k === 'reminderTime') && window.RecallNative && window.RecallNative.setReminder) window.RecallNative.setReminder(!!s.reminderOn, s.reminderHour, s.reminderMinute);
    save(); if (['theme', 'textSize', 'aiEngine'].includes(k)) render();
  });
  $('#gear').addEventListener('click', () => { if (route().v === 'settings') history.length > 1 ? history.back() : (location.hash = 'today'); else location.hash = 'settings'; });
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  render();
})();
