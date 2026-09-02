(() => {
'use strict';

/* ---------- config ----------
   Put your Ko-fi / Buy Me a Coffee page here, e.g. 'https://ko-fi.com/yourname'.
   While it is empty the support links stay hidden, so nothing ships as a dead link. */
const SUPPORT_URL = 'https://ko-fi.com/chrispecoraro';

/* ---------- constants ---------- */
const PEAKS_PER_SEC = 400;                    // waveform resolution (min/max pairs per second)
const DECODE_RATE = 8000;                     // decode at low rate: fast, low memory, plenty for peaks
const AUTO_DECODE_MAX = 200 * 1024 * 1024;    // above this, ask before decoding
const LS_PREFIX = 'theshed:';
const LEGACY_PREFIX = 'videolearner:';         // keys saved under the app's old name
const FRAME = 1 / 30;

/* ---------- elements ---------- */
const $ = s => document.querySelector(s);
const media     = $('#media');
const wave      = $('#wave');
const wctx      = wave.getContext('2d');
const el = {
  fileInput:$('#fileInput'), filename:$('#filename'), audioTitle:$('#audioTitle'), audioTime:$('#audioTime'),
  waveStatus:$('#waveStatus'), decodeBtn:$('#decodeBtn'),
  playBtn:$('#playBtn'), curTime:$('#curTime'), durTime:$('#durTime'),
  speed:$('#speed'), speedOut:$('#speedOut'), pitch:$('#pitch'), volume:$('#volume'),
  aTime:$('#aTime'), bTime:$('#bTime'), loopLen:$('#loopLen'), loopOn:$('#loopOn'),
  reps:$('#reps'), rampOn:$('#rampOn'), rampStart:$('#rampStart'), rampStep:$('#rampStep'),
  rampEvery:$('#rampEvery'), rampMax:$('#rampMax'), rest:$('#rest'),
  loopList:$('#loopList'), loopCount:$('#loopCount'), help:$('#help'),
};

/* ---------- state ---------- */
const S = {
  file:null, key:null, url:null, duration:0,
  peaks:null,                 // {min:Float32Array, max:Float32Array, pps:number}
  viewStart:0, viewSpan:0,    // visible time window
  a:null, b:null,
  reps:0, resting:false, restTimer:null,
  drag:null, activeLoop:null,
  loops:[],
  decoding:false,
};

/* ---------- helpers ---------- */
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function fmt(t){
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
  return m + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}
function fmtShort(t){
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = t % 60;
  return m + ':' + s.toFixed(1).padStart(4, '0');
}

/* ---------- file loading ---------- */
function loadFile(file){
  if (!file) return;
  if (S.url) URL.revokeObjectURL(S.url);
  stopRest();

  S.file = file;
  S.key = LS_PREFIX + file.name + '::' + file.size;
  S.url = URL.createObjectURL(file);
  S.peaks = null; S.a = null; S.b = null; S.reps = 0; S.activeLoop = null; S.loops = [];

  media.src = S.url;
  media.load();

  el.filename.textContent = file.name;
  el.audioTitle.textContent = file.name;
  el.reps.textContent = '0';
  document.body.classList.add('has-file');
  el.waveStatus.textContent = '';
  el.decodeBtn.hidden = true;
  renderLoops(); renderLoopFields();
}

media.addEventListener('loadedmetadata', () => {
  S.duration = isFinite(media.duration) ? media.duration : 0;
  S.viewStart = 0; S.viewSpan = S.duration || 1;
  el.durTime.textContent = fmt(S.duration);

  const isVideo = media.videoWidth > 0;
  document.body.classList.toggle('has-video', isVideo);
  document.body.classList.toggle('has-audio', !isVideo);

  applySpeed(+el.speed.value);
  media.volume = +el.volume.value / 100;
  restoreDoc();
  draw();

  if (S.file.size <= AUTO_DECODE_MAX) decodeWaveform();
  else {
    el.waveStatus.textContent = 'Large file - waveform not generated automatically.';
    el.decodeBtn.hidden = false;
  }
});

media.addEventListener('error', () => {
  el.waveStatus.textContent = 'This browser could not play that file (unsupported codec or container).';
});

/* ---------- waveform decoding ---------- */
async function decodeWaveform(){
  if (!S.file || S.decoding) return;
  S.decoding = true;
  el.decodeBtn.hidden = true;
  el.waveStatus.textContent = 'Reading file...';
  try {
    const buf = await S.file.arrayBuffer();
    el.waveStatus.textContent = 'Decoding audio...';
    let audio;
    try {
      const off = new OfflineAudioContext(1, 1, DECODE_RATE);
      audio = await off.decodeAudioData(buf);
    } catch (e) {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      audio = await ac.decodeAudioData(buf);
      ac.close();
    }
    S.peaks = buildPeaks(audio);
    el.waveStatus.textContent = '';
  } catch (err) {
    console.warn(err);
    el.waveStatus.textContent = 'No waveform for this file - the timeline still works.';
  }
  S.decoding = false;
  draw();
}

function buildPeaks(audio){
  const chans = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  const n = audio.length;
  const buckets = Math.max(1, Math.ceil(audio.duration * PEAKS_PER_SEC));
  const per = n / buckets;
  const mn = new Float32Array(buckets), mx = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++){
    const s0 = Math.floor(i * per), s1 = Math.min(n, Math.floor((i + 1) * per));
    let lo = 0, hi = 0;
    for (let s = s0; s < s1; s++){
      let v = 0;
      for (let c = 0; c < chans.length; c++) v += chans[c][s];
      v /= chans.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mn[i] = lo; mx[i] = hi;
  }
  // normalize so quiet recordings still read well
  let peak = 0;
  for (let i = 0; i < buckets; i++) peak = Math.max(peak, mx[i], -mn[i]);
  if (peak > 0 && peak < 0.98){
    const g = 0.98 / peak;
    for (let i = 0; i < buckets; i++){ mn[i] *= g; mx[i] *= g; }
  }
  return { min:mn, max:mx, pps: buckets / audio.duration };
}

/* ---------- drawing ---------- */
function tToX(t, w){ return (t - S.viewStart) / S.viewSpan * w; }
function xToT(x, w){ return S.viewStart + (x / w) * S.viewSpan; }

function draw(){
  const w = wave.clientWidth, h = wave.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (wave.width !== Math.round(w * dpr) || wave.height !== Math.round(h * dpr)){
    wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr);
  }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);

  const rulerH = 18, mid = rulerH + (h - rulerH) / 2, half = (h - rulerH) / 2 - 4;

  wctx.fillStyle = '#12171f'; wctx.fillRect(0, 0, w, h);
  wctx.fillStyle = '#0f141b'; wctx.fillRect(0, 0, w, rulerH);

  if (!S.duration){
    wctx.fillStyle = '#5b6674';
    wctx.font = '12px system-ui,sans-serif';
    wctx.textAlign = 'center';
    wctx.fillText('Load a file to see its timeline', w / 2, h / 2);
    return;
  }

  // loop region
  if (S.a != null && S.b != null && S.b > S.a){
    const x0 = tToX(S.a, w), x1 = tToX(S.b, w);
    wctx.fillStyle = 'rgba(76,194,255,.13)';
    wctx.fillRect(x0, rulerH, x1 - x0, h - rulerH);
  }

  // waveform / baseline
  if (S.peaks){
    const mn = S.peaks.min, mx = S.peaks.max, pps = S.peaks.pps, N = mn.length;
    wctx.strokeStyle = '#5f87a8'; wctx.lineWidth = 1;
    wctx.beginPath();
    for (let x = 0; x < w; x++){
      let i0 = Math.floor(xToT(x, w) * pps), i1 = Math.floor(xToT(x + 1, w) * pps);
      if (i1 <= i0) i1 = i0 + 1;
      if (i1 <= 0 || i0 >= N) continue;
      i0 = Math.max(0, i0); i1 = Math.min(N, i1);
      let lo = 1, hi = -1;
      for (let i = i0; i < i1; i++){ if (mn[i] < lo) lo = mn[i]; if (mx[i] > hi) hi = mx[i]; }
      if (hi < lo) continue;
      const yTop = mid - hi * half, yBot = mid - lo * half;
      wctx.moveTo(x + 0.5, yTop);
      wctx.lineTo(x + 0.5, Math.max(yBot, yTop + 1));
    }
    wctx.stroke();
  } else {
    wctx.strokeStyle = '#2c3542'; wctx.lineWidth = 2;
    wctx.beginPath(); wctx.moveTo(0, mid); wctx.lineTo(w, mid); wctx.stroke();
  }

  // ruler
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const step = steps.find(s => S.viewSpan / s <= 10) || 3600;
  wctx.strokeStyle = '#242c38'; wctx.fillStyle = '#7c8899';
  wctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
  wctx.textAlign = 'left';
  for (let t = Math.ceil(S.viewStart / step) * step; t < S.viewStart + S.viewSpan; t += step){
    const x = Math.round(tToX(t, w)) + 0.5;
    wctx.beginPath(); wctx.moveTo(x, 0); wctx.lineTo(x, h); wctx.stroke();
    wctx.fillText(fmtShort(t), x + 3, 12);
  }

  // A / B markers
  const marker = (t, color, label) => {
    const x = Math.round(tToX(t, w)) + 0.5;
    if (x < -20 || x > w + 20) return;
    wctx.strokeStyle = color; wctx.lineWidth = 2;
    wctx.beginPath(); wctx.moveTo(x, rulerH); wctx.lineTo(x, h); wctx.stroke();
    wctx.fillStyle = color;
    wctx.fillRect(label === 'A' ? x : x - 14, rulerH, 14, 13);
    wctx.fillStyle = '#06212f';
    wctx.font = 'bold 10px system-ui,sans-serif';
    wctx.textAlign = 'center';
    wctx.fillText(label, x + (label === 'A' ? 7 : -7), rulerH + 10);
  };
  if (S.a != null) marker(S.a, '#4cc2ff', 'A');
  if (S.b != null) marker(S.b, '#ffb454', 'B');

  // playhead
  const px = Math.round(tToX(media.currentTime, w)) + 0.5;
  wctx.strokeStyle = '#ffffff'; wctx.lineWidth = 1.5;
  wctx.beginPath(); wctx.moveTo(px, 0); wctx.lineTo(px, h); wctx.stroke();
}

new ResizeObserver(() => draw()).observe(wave);

/* ---------- view / zoom ---------- */
function setView(start, span){
  const dur = S.duration || 1;
  S.viewSpan = clamp(span, Math.min(0.05, dur), dur);
  S.viewStart = clamp(start, 0, Math.max(0, dur - S.viewSpan));
  draw();
}
function zoomFull(){ setView(0, S.duration || 1); }
function zoomLoop(){
  if (S.a == null || S.b == null || S.b <= S.a) return;
  const pad = (S.b - S.a) * 0.25;
  setView(S.a - pad, (S.b - S.a) + pad * 2);
}
function keepPlayheadVisible(){
  const t = media.currentTime;
  if (t < S.viewStart || t > S.viewStart + S.viewSpan) setView(t - S.viewSpan / 2, S.viewSpan);
}

/* ---------- waveform interaction ---------- */
wave.addEventListener('wheel', e => {
  if (!S.duration) return;
  e.preventDefault();
  const w = wave.clientWidth, x = e.offsetX;
  if (e.shiftKey){
    setView(S.viewStart + (e.deltaY || e.deltaX) / w * S.viewSpan, S.viewSpan);
  } else {
    const t = xToT(x, w);
    const span = S.viewSpan * (e.deltaY > 0 ? 1.25 : 0.8);
    setView(t - (x / w) * span, span);
  }
}, { passive:false });

wave.addEventListener('pointerdown', e => {
  if (!S.duration) return;
  const w = wave.clientWidth, t = xToT(e.offsetX, w), px = e.offsetX;
  const near = v => v != null && Math.abs(tToX(v, w) - px) < 7;
  if (near(S.a))      S.drag = { mode:'a', moved:true };
  else if (near(S.b)) S.drag = { mode:'b', moved:true };
  else                S.drag = { mode:'new', anchor:t, moved:false };
  wave.setPointerCapture(e.pointerId);
});

wave.addEventListener('pointermove', e => {
  const w = wave.clientWidth;
  if (!S.drag){
    const px = e.offsetX;
    const near = v => v != null && Math.abs(tToX(v, w) - px) < 7;
    wave.style.cursor = (near(S.a) || near(S.b)) ? 'ew-resize' : 'crosshair';
    return;
  }
  const t = clamp(xToT(e.offsetX, w), 0, S.duration);
  if (S.drag.mode === 'a'){
    S.a = Math.min(t, S.b != null ? S.b - 0.02 : S.duration);
  } else if (S.drag.mode === 'b'){
    S.b = Math.max(t, S.a != null ? S.a + 0.02 : 0);
  } else {
    if (Math.abs(t - S.drag.anchor) * (w / S.viewSpan) > 4) S.drag.moved = true;
    if (S.drag.moved){
      S.a = Math.min(S.drag.anchor, t);
      S.b = Math.max(S.drag.anchor, t);
      S.activeLoop = null;
    }
  }
  renderLoopFields(); draw();
});

function endDrag(e){
  if (!S.drag) return;
  const w = wave.clientWidth;
  const wasNewClick = S.drag.mode === 'new' && !S.drag.moved;
  S.drag = null;
  if (wasNewClick){
    seek(clamp(xToT(e.offsetX, w), 0, S.duration));
  } else {
    S.reps = 0; el.reps.textContent = '0';
    if (S.a != null && S.b != null && (media.currentTime < S.a || media.currentTime > S.b)) seek(S.a);
    renderLoops();
  }
  persist(); renderLoopFields(); draw();
}
wave.addEventListener('pointerup', endDrag);
wave.addEventListener('pointercancel', () => { S.drag = null; });
wave.addEventListener('dblclick', () => { if (S.a != null && S.b != null) zoomLoop(); else zoomFull(); });

/* ---------- transport ---------- */
function togglePlay(){
  if (!S.file) return;
  if (media.paused){
    stopRest();
    if (S.a != null && S.b != null && media.currentTime >= S.b - 0.01) media.currentTime = S.a;
    media.play().catch(() => {});
  } else {
    stopRest();
    media.pause();
  }
}
function seek(t){
  media.currentTime = clamp(t, 0, S.duration || 0);
  updateTimeUI();
  draw();
}
media.addEventListener('play',  () => { el.playBtn.textContent = '❚❚'; });
media.addEventListener('pause', () => { el.playBtn.textContent = '▶'; draw(); });
// a loop ending at the very end of the file: 'ended' fires before tick()'s wrap check can run
media.addEventListener('ended', () => {
  if (el.loopOn.checked && S.a != null && S.b != null && S.b > S.a){
    onRepComplete();
    if (!S.resting) media.play().catch(() => {});
  }
});

function applySpeed(pct){
  const r = clamp(pct, 20, 200) / 100;
  media.playbackRate = r;
  media.preservesPitch = el.pitch.checked;
  media.mozPreservesPitch = el.pitch.checked;
  media.webkitPreservesPitch = el.pitch.checked;
  el.speed.value = Math.round(clamp(pct, 20, 200));
  el.speedOut.textContent = Math.round(clamp(pct, 20, 200)) + '%';
}
function nudgeSpeed(d){ applySpeed(+el.speed.value + d); persist(); }

/* ---------- loop engine ---------- */
function stopRest(){
  if (S.restTimer){ clearTimeout(S.restTimer); S.restTimer = null; }
  S.resting = false;
}
function onRepComplete(){
  S.reps++;
  el.reps.textContent = S.reps;
  if (el.rampOn.checked){
    const start = +el.rampStart.value, step = +el.rampStep.value;
    const every = Math.max(1, +el.rampEvery.value), max = +el.rampMax.value;
    applySpeed(Math.min(max, start + step * Math.floor(S.reps / every)));
  }
  const rest = +el.rest.value;
  media.currentTime = S.a;
  if (rest > 0){
    S.resting = true;
    media.pause();
    S.restTimer = setTimeout(() => {
      S.restTimer = null; S.resting = false;
      media.play().catch(() => {});
    }, rest * 1000);
  }
}

function tick(){
  requestAnimationFrame(tick);
  if (!S.file) return;
  if (el.loopOn.checked && !S.resting && !media.paused &&
      S.a != null && S.b != null && S.b > S.a && media.currentTime >= S.b - 0.012){
    onRepComplete();
  }
  if (media.paused) return;   // paused frames are drawn on demand by seek/setA/setB/setView
  updateTimeUI();
  if (!S.drag) keepPlayheadVisible();
  draw();
}
function updateTimeUI(){
  el.curTime.textContent = fmt(media.currentTime);
  el.audioTime.textContent = fmt(media.currentTime);
}
requestAnimationFrame(tick);

/* ---------- loop fields ---------- */
function renderLoopFields(){
  el.aTime.textContent = S.a != null ? fmt(S.a) : '—';
  el.bTime.textContent = S.b != null ? fmt(S.b) : '—';
  el.loopLen.textContent = (S.a != null && S.b != null && S.b > S.a)
    ? (S.b - S.a).toFixed(2) + 's' : '—';
}
function setA(t){
  S.a = clamp(t == null ? media.currentTime : t, 0, S.duration);
  if (S.b != null && S.b <= S.a) S.b = Math.min(S.duration, S.a + 1);
  S.reps = 0; el.reps.textContent = '0';
  renderLoopFields(); persist(); draw();
}
function setB(t){
  S.b = clamp(t == null ? media.currentTime : t, 0, S.duration);
  if (S.a != null && S.a >= S.b) S.a = Math.max(0, S.b - 1);
  S.reps = 0; el.reps.textContent = '0';
  renderLoopFields(); persist(); draw();
}
function clearLoop(){
  S.a = S.b = null; S.activeLoop = null; S.reps = 0;
  el.reps.textContent = '0';
  stopRest(); renderLoopFields(); renderLoops(); persist(); draw();
}
function nudge(which, amt){
  if (which === 'a' && S.a != null) setA(S.a + amt);
  if (which === 'b' && S.b != null) setB(S.b + amt);
}

/* ---------- saved sections ---------- */
function saveLoop(){
  if (S.a == null || S.b == null || S.b <= S.a) return;
  const suggested = 'Section ' + (S.loops.length + 1);
  const name = prompt('Name this section:', suggested);
  if (name === null) return;
  S.loops.push({ name: name.trim() || suggested, a:S.a, b:S.b, speed:+el.speed.value });
  S.activeLoop = S.loops.length - 1;
  persist(); renderLoops();
}
function recallLoop(i){
  const L = S.loops[i];
  if (!L) return;
  S.a = L.a; S.b = L.b; S.activeLoop = i; S.reps = 0;
  el.reps.textContent = '0';
  if (L.speed) applySpeed(L.speed);
  stopRest();
  seek(L.a);
  zoomLoop(); renderLoopFields(); renderLoops(); persist();
}
function renderLoops(){
  el.loopList.innerHTML = '';
  el.loopCount.textContent = S.loops.length ? '(' + S.loops.length + ')' : '';
  if (!S.loops.length){
    const li = document.createElement('li');
    li.innerHTML = '<span class="empty">None yet - mark A/B, then "Save section".</span>';
    el.loopList.appendChild(li);
    return;
  }
  S.loops.forEach((L, i) => {
    const li = document.createElement('li');
    if (i === S.activeLoop) li.className = 'active';
    const range = fmtShort(L.a) + '–' + fmtShort(L.b) +
      (L.speed && L.speed !== 100 ? ' · ' + L.speed + '%' : '');
    li.innerHTML =
      '<span class="idx">' + (i < 9 ? i + 1 : '') + '</span>' +
      '<span class="nm" title="Play this section">' + escapeHtml(L.name) + '</span>' +
      '<span class="rg">' + range + '</span>' +
      '<button class="iconbtn" data-act="rename" title="Rename">✎</button>' +
      '<button class="iconbtn" data-act="update" title="Update to current A/B and speed">↻</button>' +
      '<button class="iconbtn" data-act="del" title="Delete">✕</button>';
    li.querySelector('.nm').onclick = () => recallLoop(i);
    li.querySelectorAll('.iconbtn').forEach(b => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'del'){
          S.loops.splice(i, 1);
          if (S.activeLoop === i) S.activeLoop = null;
          else if (S.activeLoop > i) S.activeLoop--;
        }
        if (act === 'rename'){
          const n = prompt('Rename section:', L.name);
          if (n === null) return;
          L.name = n.trim() || L.name;
        }
        if (act === 'update'){
          if (S.a == null || S.b == null) return;
          L.a = S.a; L.b = S.b; L.speed = +el.speed.value;
        }
        persist(); renderLoops();
      };
    });
    el.loopList.appendChild(li);
  });
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

/* ---------- persistence ---------- */
function persist(){
  if (!S.key) return;
  try {
    localStorage.setItem(S.key, JSON.stringify({
      name: S.file ? S.file.name : '',
      loops: S.loops,
      a: S.a, b: S.b,
      speed: +el.speed.value, pitch: el.pitch.checked,
      loopOn: el.loopOn.checked, rest: +el.rest.value,
      ramp: {
        on: el.rampOn.checked, start: +el.rampStart.value, step: +el.rampStep.value,
        every: +el.rampEvery.value, max: +el.rampMax.value,
      },
      t: media.currentTime,
      saved: Date.now(),
    }));
  } catch (e) { /* storage full or blocked */ }
}
function restoreDoc(){
  let d = null;
  try { d = JSON.parse(localStorage.getItem(S.key) || 'null'); } catch (e) {}
  if (!d){ renderLoops(); renderLoopFields(); return; }
  S.loops = Array.isArray(d.loops) ? d.loops : [];
  S.a = typeof d.a === 'number' ? d.a : null;
  S.b = typeof d.b === 'number' ? d.b : null;
  if (typeof d.pitch === 'boolean') el.pitch.checked = d.pitch;
  if (typeof d.speed === 'number') applySpeed(d.speed);
  if (typeof d.loopOn === 'boolean') el.loopOn.checked = d.loopOn;
  if (typeof d.rest === 'number') el.rest.value = d.rest;
  if (d.ramp){
    el.rampOn.checked = !!d.ramp.on;
    el.rampStart.value = d.ramp.start != null ? d.ramp.start : 60;
    el.rampStep.value  = d.ramp.step  != null ? d.ramp.step  : 5;
    el.rampEvery.value = d.ramp.every != null ? d.ramp.every : 3;
    el.rampMax.value   = d.ramp.max   != null ? d.ramp.max   : 100;
  }
  if (typeof d.t === 'number' && d.t < S.duration - 0.5) media.currentTime = d.t;
  renderLoops(); renderLoopFields();
}
/* one-time: carry sections saved under the old app name over to the new prefix */
function migrateLegacyKeys(){
  const old = [];
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (k && k.indexOf(LEGACY_PREFIX) === 0) old.push(k);
  }
  old.forEach(k => {
    const nk = LS_PREFIX + k.slice(LEGACY_PREFIX.length);
    if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
    localStorage.removeItem(k);
  });
}

function exportAll(){
  const out = {};
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (k && k.indexOf(LS_PREFIX) === 0){
      try { out[k] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
    }
  }
  const blob = new Blob([JSON.stringify({ app:'the-shed', version:1, data:out }, null, 2)],
    { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'the-shed-sections.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importAll(file){
  try {
    const j = JSON.parse(await file.text());
    if (!j || !j.data) throw new Error('bad file');
    Object.keys(j.data).forEach(k => {
      if (k.indexOf(LS_PREFIX) === 0) localStorage.setItem(k, JSON.stringify(j.data[k]));
      else if (k.indexOf(LEGACY_PREFIX) === 0)
        localStorage.setItem(LS_PREFIX + k.slice(LEGACY_PREFIX.length), JSON.stringify(j.data[k]));
    });
    if (S.key) restoreDoc();
    alert('Sections imported.');
  } catch (e) {
    alert('Could not read that file.');
  }
}

/* ---------- wiring ---------- */
$('#openBtn').onclick = () => el.fileInput.click();
$('#dzOpen').onclick = () => el.fileInput.click();
el.fileInput.onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
el.decodeBtn.onclick = decodeWaveform;

el.playBtn.onclick = togglePlay;
$('#toStartBtn').onclick = () => { if (S.a != null){ stopRest(); seek(S.a); } };
media.addEventListener('click', togglePlay);

el.speed.oninput = () => applySpeed(+el.speed.value);
el.speed.onchange = persist;
document.querySelectorAll('[data-speed]').forEach(b => {
  b.onclick = () => { applySpeed(+b.dataset.speed); persist(); };
});
el.pitch.onchange = () => { applySpeed(+el.speed.value); persist(); };
el.volume.oninput = () => { media.volume = +el.volume.value / 100; };

$('#setA').onclick = () => setA();
$('#setB').onclick = () => setB();
$('#clearLoop').onclick = clearLoop;
$('#saveLoop').onclick = saveLoop;
document.querySelectorAll('[data-nudge]').forEach(b => {
  b.onclick = () => nudge(b.dataset.nudge, +b.dataset.amt);
});
el.loopOn.onchange = () => { stopRest(); persist(); };
$('#resetReps').onclick = () => { S.reps = 0; el.reps.textContent = '0'; };
[el.rampStart, el.rampStep, el.rampEvery, el.rampMax, el.rest].forEach(i => { i.onchange = persist; });
el.rampOn.onchange = () => {
  if (el.rampOn.checked){ S.reps = 0; el.reps.textContent = '0'; applySpeed(+el.rampStart.value); }
  persist();
};

$('#zoomLoop').onclick = zoomLoop;
$('#zoomOut').onclick = zoomFull;

$('#exportBtn').onclick = exportAll;
$('#importBtn').onclick = () => $('#importInput').click();
$('#importInput').onchange = e => { if (e.target.files[0]) importAll(e.target.files[0]); e.target.value = ''; };

$('#helpBtn').onclick = () => { el.help.hidden = false; };
$('#helpClose').onclick = () => { el.help.hidden = true; };
el.help.onclick = e => { if (e.target === el.help) el.help.hidden = true; };

/* drag & drop */
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  e.preventDefault(); dragDepth++; document.body.classList.add('dragging');
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0){ dragDepth = 0; document.body.classList.remove('dragging'); }
});
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

/* keyboard */
window.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.metaKey || e.ctrlKey) return;

  const big = e.shiftKey ? 1 : e.altKey ? 0.1 : 5;
  let handled = true;
  switch (e.key){
    case ' ': togglePlay(); break;
    case 'a': case 'A': setA(); break;
    case 'b': case 'B': setB(); break;
    case 'l': case 'L': el.loopOn.checked = !el.loopOn.checked; stopRest(); persist(); break;
    case 'c': case 'C': clearLoop(); break;
    case 'r': case 'R': if (S.a != null){ stopRest(); seek(S.a); } break;
    case 's': case 'S': saveLoop(); break;
    case 'm': case 'M': media.muted = !media.muted; break;
    case 'z': case 'Z': zoomLoop(); break;
    case 'x': case 'X': zoomFull(); break;
    case 'q': case 'Q': nudge('a', -0.1); break;
    case 'w': case 'W': nudge('a',  0.1); break;
    case 'o': case 'O': nudge('b', -0.1); break;
    case 'p': case 'P': nudge('b',  0.1); break;
    case ',': seek(media.currentTime - FRAME); break;
    case '.': seek(media.currentTime + FRAME); break;
    case 'ArrowLeft':  seek(media.currentTime - big); break;
    case 'ArrowRight': seek(media.currentTime + big); break;
    case 'ArrowUp':   nudgeSpeed(e.shiftKey ? 1 : 5); break;
    case 'ArrowDown': nudgeSpeed(e.shiftKey ? -1 : -5); break;
    case '0': applySpeed(100); persist(); break;
    case '?': el.help.hidden = !el.help.hidden; break;
    case 'Escape': el.help.hidden = true; break;
    default:
      if (/^[1-9]$/.test(e.key)) recallLoop(+e.key - 1);
      else handled = false;
  }
  if (handled) e.preventDefault();
});

window.addEventListener('beforeunload', persist);
setInterval(() => { if (S.file) persist(); }, 5000);

/* support links: shown only once SUPPORT_URL is filled in above */
if (SUPPORT_URL){
  document.querySelectorAll('[data-support]').forEach(a => {
    if (a.tagName === 'A') a.href = SUPPORT_URL;
    a.hidden = false;
    const wrap = a.closest('.dz-support');
    if (wrap) wrap.hidden = false;
  });
} else {
  console.info('The Shed: set SUPPORT_URL at the top of app.js to show the "buy me a coffee" links.');
}

migrateLegacyKeys();
renderLoops(); renderLoopFields(); draw();

/* debug handle (console: SHED.state, SHED.loadFile(file), ...) */
window.SHED = { state:S, media, loadFile, setA, setB, applySpeed, recallLoop, saveLoop, zoomLoop, zoomFull };
})();
