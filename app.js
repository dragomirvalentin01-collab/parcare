/* Parcare — ține minte unde ai parcat mașina.
 * 100% local: localStorage pentru date, IndexedDB pentru fotografii. Fără cont.
 */

'use strict';

const LS_ACTIVE = 'parcare:active';
const LS_HISTORY = 'parcare:history';
const MAX_NOTE = 200;
const HISTORY_LIMIT = 100;
const POOR_ACCURACY = 60;      // metri — peste asta GPS-ul e suspect în subsol
const PHOTO_MAX_PX = 1280;
const PHOTO_QUALITY = 0.75;

let pendingPhoto = null;      // Blob, până la salvare
let ticker = null;
let state = 'empty';

const $ = (id) => document.getElementById(id);
const els = {
  vEmpty: $('v-empty'), vParked: $('v-parked'), vHistory: $('v-history'),
  sheet: $('sheet'), panic: $('panic'), tabbar: $('tabbar'),
  note: $('note'), since: $('since'), elapsed: $('elapsed'), gpsLine: $('gps-line'),
  photoBox: $('photo-box'), photoImg: $('photo-img'), noPhoto: $('no-photo'),
  gpsState: $('gps-state'), inNote: $('in-note'),
  inPhoto: $('in-photo'), photoBtnText: $('photo-btn-text'),
  photoClear: $('btn-photo-clear'), preview: $('photo-preview'), previewImg: $('preview-img'),
  historyList: $('history-list'), statusChip: document.querySelector('.status-chip'),
  panicNote: $('panic-note'), panicImg: $('panic-img'),
};

/* ================= stocare ================= */

function getActive() {
  try { return JSON.parse(localStorage.getItem(LS_ACTIVE) || 'null'); }
  catch { return null; }
}
function setActive(spot) {
  if (spot) localStorage.setItem(LS_ACTIVE, JSON.stringify(spot));
  else localStorage.removeItem(LS_ACTIVE);
}
function getHistory() {
  try { const h = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); return Array.isArray(h) ? h : []; }
  catch { return []; }
}
function setHistory(list) {
  localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
}

/* ================= fotografii (IndexedDB) ================= */

let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open('parcare', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbPromise;
}
async function putPhoto(id, blob) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('photos', 'readwrite');
    tx.objectStore('photos').put({ id, blob });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function getPhoto(id) {
  if (!id) return null;
  const d = await db();
  return new Promise((res) => {
    const tx = d.transaction('photos', 'readonly');
    const r = tx.objectStore('photos').get(id);
    r.onsuccess = () => res(r.result ? r.result.blob : null);
    r.onerror = () => res(null);
  });
}
async function delPhoto(id) {
  if (!id) return;
  const d = await db();
  return new Promise((res) => {
    const tx = d.transaction('photos', 'readwrite');
    tx.objectStore('photos').delete(id);
    tx.oncomplete = res; tx.onerror = res;
  });
}

/* ================= imagine: comprimare ================= */

function compress(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      const scale = Math.min(1, PHOTO_MAX_PX / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob((b) => b ? res(b) : rej(new Error('compressie esuita')), 'image/jpeg', PHOTO_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('imagine necitita')); };
    img.src = url;
  });
}

/* ================= GPS ================= */

function locate() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res({ ok: false, reason: 'Geolocatia nu e suportata pe acest telefon.' });
    navigator.geolocation.getCurrentPosition(
      (p) => res({
        ok: true, lat: p.coords.latitude, lng: p.coords.longitude,
        acc: Math.round(p.coords.accuracy || 0),
      }),
      (e) => res({ ok: false, reason: describeGeoError(e) }),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}
function describeGeoError(e) {
  if (!e) return 'Locatia nu a putut fi citita.';
  if (e.code === 1) return 'Permisiunea de locatie e refuzata. Activeaza-o in setarile browserului.';
  if (e.code === 2) return 'Semnalu GPS indisponibil — probabil esti intr-un subsol.';
  if (e.code === 3) return 'Pozitia a luat prea mult timp. Incearca din nou langa o fereastra.';
  return 'Locatia nu a putut fi citita.';
}

/* ================= formatare ================= */

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  const azi = new Date();
  const sameDay = d.toDateString() === azi.toDateString();
  if (sameDay) return `Azi, ${fmtTime(ts)}`;
  const zile = Math.round((azi - d) / 86400000);
  if (zile === 1) return `Ieri, ${fmtTime(ts)}`;
  if (zile < 7) return `${d.getDay() === 0 ? 'Duminică' : ['Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'][d.getDay()]}, ${fmtTime(ts)}`;
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}, ${fmtTime(ts)}`;
}
function fmtDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'chiar acum';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const z = Math.floor(h / 24);
  return `${z} ${z === 1 ? 'zi' : 'zile'}`;
}

/* ================= navigare ================= */

function navigate(lat, lng) {
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  window.open(url, '_blank', 'noopener');
}
function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }

/* ================= randare ================= */

function show(which) {
  state = which;
  els.vEmpty.hidden = which !== 'empty';
  els.vParked.hidden = which !== 'parked';
  els.vHistory.hidden = which !== 'history';
  els.tabbar.hidden = false;
  const onTab = (which === 'history') ? 'history' : 'parked';
  $('tab-parked').classList.toggle('on', onTab === 'parked');
  $('tab-history').classList.toggle('on', onTab === 'history');
  if (ticker) { clearInterval(ticker); ticker = null; }
  if (which === 'parked') startTicker();
  if (which === 'history') renderHistory();
}

function startTicker() {
  const spot = getActive();
  if (!spot) return;
  els.since.textContent = fmtDate(spot.at);
  const tick = () => {
    const s = getActive();
    if (!s) { els.elapsed.textContent = '—'; return; }
    els.elapsed.textContent = fmtDuration(Date.now() - s.at);
  };
  tick();
  ticker = setInterval(tick, 30000);
}

async function renderParked() {
  const spot = getActive();
  if (!spot) return show('empty');

  els.note.textContent = spot.note || '';
  els.note.hidden = !spot.note;

  releaseUrls();
  const blob = await getPhoto(spot.photo);
  if (blob) {
    els.photoImg.src = trackUrl(URL.createObjectURL(blob));
    els.photoBox.hidden = false;
    els.noPhoto.hidden = true;
  } else {
    els.photoBox.hidden = true;
    els.noPhoto.hidden = false;
  }

  const dot = els.statusChip.querySelector('.dot');
  if (spot.lat == null) {
    dot.classList.add('bad');
    els.gpsLine.textContent = 'Fără coordonate — caută locul după notă sau fotografie.';
  } else {
    dot.classList.remove('bad');
    els.gpsLine.textContent = spot.acc > POOR_ACCURACY
      ? `Locație aproximativă (±${spot.acc} m) — în subsol GPS-ul e inexact.`
      : `Locație captată (±${spot.acc} m).`;
  }
  $('btn-nav').disabled = spot.lat == null;
  $('btn-nav').style.opacity = spot.lat == null ? .4 : 1;
  show('parked');
}

/* Object URL-urile nu se elibereaza automat. Le tinem din evidenta ca sa nu
 * cumulam la fiecare randare (utileaza mai ales istoricul cu poze). */
const objectUrls = [];
function trackUrl(url) {
  objectUrls.push(url);
  return url;
}
function releaseUrls() {
  while (objectUrls.length) {
    try { URL.revokeObjectURL(objectUrls.pop()); } catch {}
  }
}

async function renderHistory() {
  const list = getHistory();
  releaseUrls();
  els.historyList.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'Nicio parcare anterioară.';
    els.historyList.appendChild(li);
    $('btn-clear-history').hidden = true;
    return;
  }
  $('btn-clear-history').hidden = false;
  for (const item of list) {
    const li = document.createElement('li');

    const blob = await getPhoto(item.photo);
    if (blob) {
      const img = document.createElement('img');
      img.className = 'h-thumb';
      img.src = trackUrl(URL.createObjectURL(blob));
      img.alt = '';
      li.appendChild(img);
    } else {
      const d = document.createElement('div');
      d.className = 'h-thumb empty';
      d.textContent = '📍';
      li.appendChild(d);
    }

    const body = document.createElement('div');
    body.className = 'h-body';
    const when = document.createElement('div');
    when.className = 'h-when';
    when.textContent = fmtDate(item.at);
    const what = document.createElement('div');
    what.className = 'h-what';
    what.textContent = item.note || (item.lat != null ? 'fără notă' : 'doar fără locație');
    body.append(when, what);
    li.appendChild(body);

    const del = document.createElement('button');
    del.className = 'h-del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Șterge');
    del.onclick = async () => {
      await delPhoto(item.photo);
      setHistory(getHistory().filter((x) => x.id !== item.id));
      renderHistory();
    };
    li.appendChild(del);
    els.historyList.appendChild(li);
  }
}

/* ================= flux parcare ================= */

let sheetPos = { ok: false, lat: null, lng: null, acc: 0 };

function openSheet() {
  els.sheet.hidden = false;
  els.inNote.value = '';
  pendingPhoto = null;
  els.preview.hidden = true;
  els.photoClear.hidden = true;
  els.photoBtnText.textContent = '📷 Adaugă fotografie';
  els.gpsState.className = 'gps-state';
  els.gpsState.textContent = 'Se caută locația…';
  sheetPos = { ok: false, lat: null, lng: null, acc: 0 };
  locate().then((r) => {
    if (r.ok) {
      sheetPos = r;
      const className = r.acc > POOR_ACCURACY ? 'gps-state bad' : 'gps-state ok';
      els.gpsState.className = className;
      els.gpsState.textContent = r.acc > POOR_ACCURACY
        ? `Locație imprecisă (±${r.acc} m) — în subsol e normal. Notează nivelul și locul.`
        : `Locație captată (±${r.acc} m).`;
    } else {
      els.gpsState.className = 'gps-state bad';
      els.gpsState.textContent = `${r.reason} Poți salva oricum, dar notează bine locul.`;
    }
  });
  setTimeout(() => els.inNote.focus({ preventScroll: true }), 300);
}

function closeSheet() {
  els.sheet.hidden = true;
  pendingPhoto = null;
}

async function saveSpot() {
  const note = els.inNote.value.trim().slice(0, MAX_NOTE);
  const id = String(Date.now());
  if (pendingPhoto) {
    try { await putPhoto(id, pendingPhoto); } catch (e) { console.warn('fotografie', e); }
  }
  const spot = {
    id,
    at: Date.now(),
    lat: sheetPos.ok ? sheetPos.lat : null,
    lng: sheetPos.ok ? sheetPos.lng : null,
    acc: sheetPos.ok ? sheetPos.acc : 0,
    note,
    photo: pendingPhoto ? id : null,
  };
  // dacă era deja o parcare activă, o mutăm în istoric în loc să o pierdem
  const prev = getActive();
  if (prev) setHistory([{ ...prev, endedAt: Date.now() }, ...getHistory()]);

  setActive(spot);
  closeSheet();
  vibrate([18, 60, 18]);
  renderParked();
}

async function finishParking() {
  const spot = getActive();
  if (!spot) return;
  if (spot.photo) { try { await delPhoto(spot.photo); } catch {} }
  setActive(null);
  vibrate(30);
  show('empty');
}

/* ================= panică ================= */

async function openPanic() {
  const spot = getActive();
  els.panicNote.textContent = '';
  els.panicImg.hidden = true;
  if (spot) {
    els.panicNote.textContent = spot.note || '';
    const blob = await getPhoto(spot.photo);
    if (blob) { releaseUrls(); els.panicImg.src = trackUrl(URL.createObjectURL(blob)); els.panicImg.hidden = false; }
  }
  els.panic.hidden = false;
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch {}
}

/* ================= evenimente ================= */

$('btn-park').onclick = openSheet;
$('btn-cancel').onclick = closeSheet;
$('btn-save').onclick = saveSpot;
$('btn-done').onclick = finishParking;
$('btn-back').onclick = () => { const a = getActive(); show(a ? 'parked' : 'empty'); };
$('btn-history-empty').onclick = () => show('history');
$('tab-parked').onclick = () => { const a = getActive(); show(a ? 'parked' : 'empty'); };
$('tab-history').onclick = () => show('history');
$('tab-panic').onclick = openPanic;
$('btn-exit-panic').onclick = () => { els.panic.hidden = true; };

$('btn-nav').onclick = () => {
  const s = getActive();
  if (s && s.lat != null) { navigate(s.lat, s.lng); vibrate(15); }
};

$('in-photo').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    pendingPhoto = await compress(f);
    els.previewImg.src = trackUrl(URL.createObjectURL(pendingPhoto));
    els.preview.hidden = false;
    els.photoClear.hidden = false;
    els.photoBtnText.textContent = '📷 Înlocuiește fotografia';
  } catch (err) {
    alert('Nu am putut citi fotografia. Încearcă altă imagine.');
  }
  e.target.value = '';
};

els.photoClear.onclick = () => {
  pendingPhoto = null;
  els.preview.hidden = true;
  els.photoClear.hidden = true;
  els.photoBtnText.textContent = '📷 Adaugă fotografie';
};

$('btn-clear-history').onclick = async () => {
  if (!confirm('Ștergi tot istoricul? Nu se poate anula.')) return;
  for (const item of getHistory()) await delPhoto(item.photo);
  setHistory([]);
  renderHistory();
};

document.addEventListener('visibilitychange', () => {
  // dupa ce revii in tab, re-randeaza doar daca formularul nu e deschis
  if (!document.hidden && els.sheet.hidden) renderParked();
});

/* ================= pornire ================= */

function boot() {
  renderParked();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('online', () => renderParked());
}
boot();
