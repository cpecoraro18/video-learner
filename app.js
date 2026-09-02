(() => {
'use strict';

/* ---------- config ----------
   Put your Ko-fi / Buy Me a Coffee page here, e.g. 'https://ko-fi.com/yourname'.
   While it is empty the support links stay hidden, so nothing ships as a dead link. */
const SUPPORT_URL = 'https://ko-fi.com/chrispecoraro';

/* Google Analytics 4 measurement ID, e.g. 'G-ABC1234XYZ'.
   While it is empty no tracking script is loaded at all. */
const GA_MEASUREMENT_ID = '';

/* ---------- constants ---------- */
const PEAKS_PER_SEC = 400;                    // waveform resolution (min/max pairs per second)
const DECODE_RATE = 8000;                     // decode at low rate: fast, low memory, plenty for peaks
const AUTO_DECODE_MAX = 200 * 1024 * 1024;    // above this, ask before decoding
const LS_PREFIX = 'theshed:';
const LEGACY_PREFIX = 'videolearner:';         // keys saved under the app's old name
const FRAME = 1 / 30;
const FILE_LOOP_GUARD = 0.012;                // a media element reports its clock every frame
const YT_LOOP_GUARD = 0.08;                   // the YouTube embed reports it a few times a second

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
  urlInput:$('#urlInput'), loadMsg:$('#loadMsg'),
  filePresets:$('#filePresets'), rateList:$('#rateList'), pitchNote:$('#pitchNote'),
};

/* ---------- state ---------- */
const S = {
  file:null, key:null, url:null, duration:0,
  title:'', loaded:false,
  wrapping:false, wrapAt:0,     // loop-wrap latch: seeks are async on YouTube
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

/* ---------- source adapter ----------
   Everything downstream talks to `src` and never to a concrete player, so the
   transport, the loop engine and the saved sections all drive either a local
   file or a YouTube embed. The two differ in what they can actually honour:

     file     any rate from 20-200%, optional pitch preservation, real waveform
     youtube  only the rates YouTube reports, pitch always preserved, no waveform

   Each implementation exposes the same shape and reports player events through
   onSourceReady / onSourcePlay / onSourcePause / onSourceEnded. */
let src = null;

function makeFileSource(){
  media.src = S.url;
  media.load();
  return {
    kind:'file',
    rates:null,                                        // continuous - use the slider
    get currentTime(){ return media.currentTime; },
    set currentTime(t){ media.currentTime = t; },
    get paused(){ return media.paused; },
    get duration(){ return isFinite(media.duration) ? media.duration : 0; },
    play(){ const p = media.play(); return p && p.catch ? p : Promise.resolve(); },
    pause(){ media.pause(); },
    set playbackRate(r){ media.playbackRate = r; },
    setPitchPreserved(on){
      media.preservesPitch = on;
      media.mozPreservesPitch = on;
      media.webkitPreservesPitch = on;
    },
    set volume(v){ media.volume = v; },
    get muted(){ return media.muted; },
    set muted(m){ media.muted = m; },
    isVideo(){ return media.videoWidth > 0; },
    title(){ return S.file ? S.file.name : ''; },
    destroy(){ media.pause(); media.removeAttribute('src'); media.load(); },
  };
}

media.addEventListener('loadedmetadata', () => { if (src && src.kind === 'file') onSourceReady(0); });
media.addEventListener('error', () => {
  if (src && src.kind === 'file')
    setLoadMsg('This browser could not play that file (unsupported codec or container).');
});
media.addEventListener('play',  () => { if (src && src.kind === 'file') onSourcePlay(); });
media.addEventListener('pause', () => { if (src && src.kind === 'file') onSourcePause(); });
media.addEventListener('ended', () => { if (src && src.kind === 'file') onSourceEnded(); });

/* ---------- YouTube ---------- */
const YT_ENDED = 0, YT_PLAYING = 1, YT_PAUSED = 2, YT_BUFFERING = 3;
const YT_FALLBACK_RATES = [25, 50, 75, 100, 125, 150, 175, 200];
let ytApi = null, ytPlayer = null, ytError = '';

/* watch?v=ID | youtu.be/ID | /embed|shorts|live|v/ID | a bare 11-character id,
   honouring a ?t= / &start= start offset in any of the usual spellings */
function parseYouTube(text){
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return { id:s, t:0 };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s.replace(/^\/\//, ''));
  } catch (e){ return null; }
  const host = u.hostname.replace(/^(?:www|m)\./, '');
  let id = null;
  if (host === 'youtu.be'){
    id = u.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com'){
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const raw = u.searchParams.get('t') || u.searchParams.get('start') || u.hash.replace(/^#t?=?/, '');
  return { id, t: parseStart(raw) };
}
function parseStart(v){
  const m = String(v || '').match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

function loadYouTubeApi(){
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => reject(new Error('Could not reach YouTube - check the connection, or an ad blocker.'));
    document.head.appendChild(tag);
    setTimeout(() => reject(new Error('The YouTube player did not load in time.')), 15000);
  }).catch(err => { ytApi = null; throw err; });   // leave a later attempt free to retry
  return ytApi;
}

function makeYouTubePlayer(){
  return new Promise(resolve => {
    const opts = {
      host: 'https://www.youtube-nocookie.com',
      width: '100%', height: '100%',
      playerVars: { enablejsapi:1, rel:0, modestbranding:1, playsinline:1, controls:1 },
      events: {
        onReady: () => resolve(),
        onStateChange: onYtState,
        onPlaybackRateChange: onYtRate,
        onError: e => { ytError = ytErrorText(e.data); },
      },
    };
    // an origin of "null" (a file:// page) makes the API refuse to talk back
    if (/^https?:$/.test(location.protocol)) opts.playerVars.origin = location.origin;
    ytPlayer = new YT.Player('ytplayer', opts);
  });
}

function onYtState(e){
  if (!src || src.kind !== 'youtube') return;
  if (e.data === YT_PLAYING) onSourcePlay();
  else if (e.data === YT_PAUSED) onSourcePause();
  else if (e.data === YT_ENDED) onSourceEnded();
}
/* the embed keeps its own speed menu; keep our readout honest when it is used */
function onYtRate(e){
  if (!src || src.kind !== 'youtube') return;
  const pct = Math.round(e.data * 100);
  el.speed.value = clamp(pct, 20, 200);
  el.speedOut.textContent = pct + '%';
  markActiveRate();
}
function ytErrorText(code){
  if (code === 101 || code === 150) return 'The uploader does not allow this video in embeds. Only a different upload of it will work.';
  if (code === 100) return 'That video is private, age-restricted, or no longer exists.';
  if (code === 2)   return 'That video id is not valid.';
  return 'YouTube could not play that video.';
}

function makeYouTubeSource(id){
  const p = ytPlayer;
  let cached = null;
  return {
    kind:'youtube', id,
    // a freshly cued video reports a short list until it has loaded, so read it
    // live and keep the longest one seen rather than snapshotting at cue time
    get rates(){
      const raw = (p.getAvailablePlaybackRates && p.getAvailablePlaybackRates()) || [];
      const pct = raw.map(r => Math.round(r * 100)).filter(r => r >= 20 && r <= 200);
      if (pct.length > 1) cached = pct.sort((a, b) => a - b);
      return cached || YT_FALLBACK_RATES;
    },
    get currentTime(){ return p.getCurrentTime() || 0; },
    set currentTime(t){ p.seekTo(t, true); },
    get paused(){ const st = p.getPlayerState(); return st !== YT_PLAYING && st !== YT_BUFFERING; },
    get duration(){ return p.getDuration() || 0; },
    play(){ p.playVideo(); return Promise.resolve(); },
    pause(){ p.pauseVideo(); },
    set playbackRate(r){ p.setPlaybackRate(r); },
    setPitchPreserved(){ /* YouTube always preserves pitch; there is no switch */ },
    set volume(v){ p.setVolume(Math.round(v * 100)); },
    get muted(){ return p.isMuted(); },
    set muted(m){ m ? p.mute() : p.unMute(); },
    isVideo(){ return true; },
    title(){ const d = p.getVideoData && p.getVideoData(); return (d && d.title) || ('YouTube ' + id); },
    destroy(){ try { p.stopVideo(); } catch (e){} },
  };
}

function waitFor(test, ms){
  return new Promise(resolve => {
    const t0 = Date.now();
    (function poll(){
      if (test()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(poll, 100);
    })();
  });
}

/* ---------- loading ---------- */
function setLoadMsg(msg){
  el.waveStatus.textContent = msg || '';
  el.loadMsg.textContent = msg || '';
  el.loadMsg.hidden = !msg;
}
function resetDoc(){
  stopRest();
  S.peaks = null; S.a = null; S.b = null; S.reps = 0; S.activeLoop = null; S.loops = [];
  S.loaded = false; S.duration = 0; S.wrapping = false;
  el.reps.textContent = '0';
  el.decodeBtn.hidden = true;
  setLoadMsg('');
  renderLoops(); renderLoopFields();
}

function loadFile(file){
  if (!file) return;
  if (S.url) URL.revokeObjectURL(S.url);
  const prev = src; src = null;
  if (prev) prev.destroy();       // null first: its teardown events are not ours any more
  resetDoc();

  S.file = file;
  S.title = file.name;
  S.key = LS_PREFIX + file.name + '::' + file.size;
  S.url = URL.createObjectURL(file);

  el.urlInput.value = '';
  el.filename.textContent = file.name;
  el.audioTitle.textContent = file.name;
  document.body.classList.remove('has-yt', 'yt-loading');
  document.body.classList.add('has-file');

  src = makeFileSource();
  syncSpeedUI();
}

async function loadYouTube(input){
  const info = parseYouTube(input);
  if (!info){ setLoadMsg('That does not look like a YouTube link.'); return; }
  if (location.protocol === 'file:'){
    setLoadMsg('YouTube needs this page served over http(s) - use the hosted copy, or run a local server. Local files still work here.');
    return;
  }

  const prev = src; src = null;
  if (prev) prev.destroy();
  if (S.url){ URL.revokeObjectURL(S.url); S.url = null; }
  S.file = null;
  resetDoc();
  document.body.classList.add('yt-loading');
  setLoadMsg('Loading the YouTube player...');

  try {
    await loadYouTubeApi();
    if (!ytPlayer) await makeYouTubePlayer();
  } catch (err){
    document.body.classList.remove('yt-loading');
    setLoadMsg(err.message || 'Could not load the YouTube player.');
    return;
  }

  ytError = '';
  ytPlayer.cueVideoById({ videoId: info.id, startSeconds: info.t || 0 });
  src = makeYouTubeSource(info.id);
  S.key = LS_PREFIX + 'yt::' + info.id;
  S.title = 'YouTube ' + info.id;
  syncSpeedUI();

  // there is no metadata event on an embed - the duration simply turns up
  const ok = await waitFor(() => !!ytError || src.duration > 0, 15000);
  document.body.classList.remove('yt-loading');
  if (ytError){ setLoadMsg(ytError); return; }
  if (!ok){ setLoadMsg('That video did not load. It may be private, removed, or blocked from embedding.'); return; }

  S.title = src.title();
  el.urlInput.value = 'https://youtu.be/' + info.id;
  document.body.classList.add('has-file', 'has-yt');
  onSourceReady(info.t || 0);
}

/* shared by both sources: the media is playable and its duration is known */
function onSourceReady(seekTo){
  S.duration = src.duration;
  S.loaded = true;
  S.viewStart = 0; S.viewSpan = S.duration || 1;
  el.durTime.textContent = fmt(S.duration);

  const isVideo = src.isVideo();
  document.body.classList.toggle('has-video', isVideo);
  document.body.classList.toggle('has-audio', !isVideo);
  el.filename.textContent = S.title;
  el.audioTitle.textContent = S.title;

  syncSpeedUI();
  applySpeed(+el.speed.value);
  src.volume = +el.volume.value / 100;
  restoreDoc();
  if (seekTo) seek(seekTo);          // a ?t= in the link beats the remembered position
  draw();

  if (src.kind === 'youtube'){
    setLoadMsg('');
    el.waveStatus.textContent = 'No waveform for YouTube - its audio is out of reach. The timeline still works.';
  } else if (S.file.size <= AUTO_DECODE_MAX){
    decodeWaveform();
  } else {
    el.waveStatus.textContent = 'Large file - waveform not generated automatically.';
    el.decodeBtn.hidden = false;
  }
}

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
  const px = Math.round(tToX(src.currentTime, w)) + 0.5;
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
function keepPlayheadVisible(t){
  if (t == null) t = src.currentTime;
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
    if (S.a != null && S.b != null && (src.currentTime < S.a || src.currentTime > S.b)) seek(S.a);
    renderLoops();
  }
  persist(); renderLoopFields(); draw();
}
wave.addEventListener('pointerup', endDrag);
wave.addEventListener('pointercancel', () => { S.drag = null; });
wave.addEventListener('dblclick', () => { if (S.a != null && S.b != null) zoomLoop(); else zoomFull(); });

/* ---------- transport ---------- */
function loopGuard(){
  // the YouTube player only reports its clock a few times a second, so the wrap
  // point has to be a good deal looser than it is for a local media element
  return src && src.kind === 'youtube' ? YT_LOOP_GUARD : FILE_LOOP_GUARD;
}
function togglePlay(){
  if (!S.loaded) return;
  if (src.paused){
    stopRest();
    if (S.a != null && S.b != null && src.currentTime >= S.b - loopGuard()) src.currentTime = S.a;
    src.play().catch(() => {});
  } else {
    stopRest();
    src.pause();
  }
}
function seek(t){
  if (!src) return;
  src.currentTime = clamp(t, 0, S.duration || 0);
  updateTimeUI();
  draw();
}

/* the source implementations funnel their player events through these */
function onSourcePlay(){ el.playBtn.textContent = '❚❚'; }
function onSourcePause(){ el.playBtn.textContent = '▶'; draw(); }
// a loop ending at the very end of the media: 'ended' fires before tick()'s wrap check can run
function onSourceEnded(){
  if (el.loopOn.checked && S.a != null && S.b != null && S.b > S.a){
    onRepComplete();
    if (!S.resting) src.play().catch(() => {});
  }
}

/* ---------- speed ----------
   A local file plays at any rate; YouTube only honours the handful of rates it
   reports, so every speed change is snapped onto whatever the source allows and
   the UI shows the rate that actually took effect. */
function nearestRate(pct){
  if (!src || !src.rates) return clamp(pct, 20, 200);
  let best = src.rates[0];
  for (let i = 1; i < src.rates.length; i++){
    if (Math.abs(src.rates[i] - pct) < Math.abs(best - pct)) best = src.rates[i];
  }
  return best;
}
function applySpeed(pct){
  const want = nearestRate(clamp(pct, 20, 200));
  if (src){
    src.playbackRate = want / 100;
    src.setPitchPreserved(el.pitch.checked);
  }
  el.speed.value = Math.round(want);
  el.speedOut.textContent = Math.round(want) + '%';
  markActiveRate();
}
function stepSpeed(dir, fine){
  if (src && src.rates){
    const rs = src.rates;
    let i = rs.indexOf(nearestRate(+el.speed.value));
    if (i < 0) i = 0;
    applySpeed(rs[clamp(i + (dir > 0 ? 1 : -1), 0, rs.length - 1)]);
  } else {
    applySpeed(+el.speed.value + dir * (fine ? 1 : 5));
  }
  persist();
}
/* swap the continuous slider for the source's fixed rates, and vice versa */
function syncSpeedUI(){
  const fixed = !!(src && src.rates);
  el.speed.hidden = fixed;
  el.filePresets.hidden = fixed;
  el.rateList.hidden = !fixed;
  el.pitch.disabled = fixed;
  el.pitchNote.hidden = !fixed;
  if (fixed){
    el.pitch.checked = true;          // YouTube always preserves pitch, and won't be talked out of it
    el.rateList.innerHTML = '';
    src.rates.forEach(r => {
      const b = document.createElement('button');
      b.className = 'btn tiny';
      b.dataset.rate = r;
      b.textContent = r;
      b.onclick = () => { applySpeed(r); persist(); };
      el.rateList.appendChild(b);
    });
  }
  markActiveRate();
}
function markActiveRate(){
  const cur = Math.round(+el.speed.value);
  el.rateList.querySelectorAll('[data-rate]').forEach(b => {
    b.classList.toggle('on', +b.dataset.rate === cur);
  });
}

/* ---------- loop engine ---------- */
function stopRest(){
  if (S.restTimer){ clearTimeout(S.restTimer); S.restTimer = null; }
  S.resting = false;
}
function onRepComplete(){
  S.reps++;
  el.reps.textContent = S.reps;
  // seeking is asynchronous on the YouTube player, so latch until the playhead
  // has actually gone back past B - otherwise one lap counts as several reps
  S.wrapping = true; S.wrapAt = Date.now();
  if (el.rampOn.checked){
    const start = +el.rampStart.value, step = +el.rampStep.value;
    const every = Math.max(1, +el.rampEvery.value), max = +el.rampMax.value;
    applySpeed(Math.min(max, start + step * Math.floor(S.reps / every)));
  }
  const rest = +el.rest.value;
  src.currentTime = S.a;
  if (rest > 0){
    S.resting = true;
    src.pause();
    S.restTimer = setTimeout(() => {
      S.restTimer = null; S.resting = false;
      src.play().catch(() => {});
    }, rest * 1000);
  }
}

function tick(){
  requestAnimationFrame(tick);
  if (!S.loaded) return;
  const t = src.currentTime;
  const guard = loopGuard();
  if (S.wrapping && (S.b == null || t < S.b - guard || Date.now() - S.wrapAt > 1500)) S.wrapping = false;
  if (el.loopOn.checked && !S.resting && !S.wrapping && !src.paused &&
      S.a != null && S.b != null && S.b > S.a && t >= S.b - guard){
    onRepComplete();
  }
  if (src.paused) return;   // paused frames are drawn on demand by seek/setA/setB/setView
  updateTimeUI(t);
  if (!S.drag) keepPlayheadVisible(t);
  draw();
}
function updateTimeUI(t){
  if (t == null) t = src ? src.currentTime : 0;
  el.curTime.textContent = fmt(t);
  el.audioTime.textContent = fmt(t);
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
  S.a = clamp(t == null ? src.currentTime : t, 0, S.duration);
  if (S.b != null && S.b <= S.a) S.b = Math.min(S.duration, S.a + 1);
  S.reps = 0; el.reps.textContent = '0';
  renderLoopFields(); persist(); draw();
}
function setB(t){
  S.b = clamp(t == null ? src.currentTime : t, 0, S.duration);
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
      kind: src ? src.kind : 'file',
      name: S.title || '',
      loops: S.loops,
      a: S.a, b: S.b,
      speed: +el.speed.value, pitch: el.pitch.checked,
      loopOn: el.loopOn.checked, rest: +el.rest.value,
      ramp: {
        on: el.rampOn.checked, start: +el.rampStart.value, step: +el.rampStep.value,
        every: +el.rampEvery.value, max: +el.rampMax.value,
      },
      t: src.currentTime,
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
  if (typeof d.pitch === 'boolean' && !el.pitch.disabled) el.pitch.checked = d.pitch;
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
  if (typeof d.t === 'number' && d.t < S.duration - 0.5) src.currentTime = d.t;
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

/* YouTube: the bar input, a dropped link, or a link pasted anywhere on the page */
const submitUrl = () => { const v = el.urlInput.value.trim(); if (v) loadYouTube(v); };
$('#urlBtn').onclick = submitUrl;
el.urlInput.onkeydown = e => { if (e.key === 'Enter'){ e.preventDefault(); submitUrl(); } };
window.addEventListener('paste', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (text && parseYouTube(text)){ e.preventDefault(); el.urlInput.value = text.trim(); loadYouTube(text); }
});

el.playBtn.onclick = togglePlay;
$('#toStartBtn').onclick = () => { if (S.a != null){ stopRest(); seek(S.a); } };
media.addEventListener('click', togglePlay);

el.speed.oninput = () => applySpeed(+el.speed.value);
el.speed.onchange = persist;
document.querySelectorAll('[data-speed]').forEach(b => {
  b.onclick = () => { applySpeed(+b.dataset.speed); persist(); };
});
el.pitch.onchange = () => { applySpeed(+el.speed.value); persist(); };
el.volume.oninput = () => { src.volume = +el.volume.value / 100; };

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
  if (f){ loadFile(f); return; }
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text && parseYouTube(text)){ el.urlInput.value = text.trim(); loadYouTube(text); }
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
    case 'm': case 'M': src.muted = !src.muted; break;
    case 'z': case 'Z': zoomLoop(); break;
    case 'x': case 'X': zoomFull(); break;
    case 'q': case 'Q': nudge('a', -0.1); break;
    case 'w': case 'W': nudge('a',  0.1); break;
    case 'o': case 'O': nudge('b', -0.1); break;
    case 'p': case 'P': nudge('b',  0.1); break;
    case ',': seek(src.currentTime - FRAME); break;
    case '.': seek(src.currentTime + FRAME); break;
    case 'ArrowLeft':  seek(src.currentTime - big); break;
    case 'ArrowRight': seek(src.currentTime + big); break;
    case 'ArrowUp':   stepSpeed( 1, e.shiftKey); break;
    case 'ArrowDown': stepSpeed(-1, e.shiftKey); break;
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
setInterval(() => { if (S.loaded) persist(); }, 5000);

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

/* analytics: the Google tag is fetched only once GA_MEASUREMENT_ID is filled in above */
if (GA_MEASUREMENT_ID){
  const gaScript = document.createElement('script');
  gaScript.async = true;
  gaScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
  document.head.appendChild(gaScript);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function(){ window.dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);
}

migrateLegacyKeys();
renderLoops(); renderLoopFields(); draw();

/* debug handle (console: SHED.state, SHED.loadFile(file), ...) */
window.SHED = { state:S, media, loadFile, setA, setB, applySpeed, recallLoop, saveLoop, zoomLoop, zoomFull };
})();
