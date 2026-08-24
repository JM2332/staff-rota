'use strict';

const firebaseConfig = {
  apiKey: "AIzaSyBKke79XIKoBYbxsJctsU_WZxxHassBQJc",
  authDomain: "kml-staff-rota.firebaseapp.com",
  projectId: "kml-staff-rota",
  storageBucket: "kml-staff-rota.firebasestorage.app",
  messagingSenderId: "884114551954",
  appId: "1:884114551954:web:640d1c1c13c55ed229e24b"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const MANAGER_EMAIL = 'manager@kmlfoodservice.internal';
const ADMIN_EMAIL = 'jacob@kmlfoodservice.internal';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// EmailJS - fill these in once the free account at emailjs.com is set up.
// Publish notifications are silently skipped (console-warned) until then.
const EMAILJS_SERVICE_ID = '';
const EMAILJS_TEMPLATE_ID = '';
const EMAILJS_PUBLIC_KEY = '';
const NOTIFY_EMAILS = ['jakemawby23@gmail.com', 'oliver@kmlfoodservice.com'];
const APP_URL = 'https://jm2332.github.io/staff-rota/';
if (EMAILJS_PUBLIC_KEY) emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });

let selectedLoginRole = 'manager';
let currentRole = null; // 'manager' | 'admin', set after login
let booted = false;

let drivers = [];             // [{id, name, active}]
let weeksById = new Map();    // weekId -> week doc data
let currentWeekId = null;
let currentShifts = [];       // shifts for the open week
let currentPhotos = [];       // photos for the open week
let currentAmendments = [];
let currentPhotoIndex = 0;

let unsubDrivers = null, unsubWeeks = null, unsubShifts = null, unsubAmendments = null, unsubPhotos = null;

// ---------- date helpers ----------

function pad(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDateStr(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(dateStr, n) { const d = parseDateStr(dateStr); d.setDate(d.getDate() + n); return toDateStr(d); }
function mondayOf(dateStr) { const d = parseDateStr(dateStr); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return toDateStr(d); }
function nextMonday() {
  const today = toDateStr(new Date());
  const m = mondayOf(today);
  return m === today ? m : addDays(m, 7);
}
function fmtDateShort(dateStr) { return parseDateStr(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
function fmtDayFull(dateStr) { return parseDateStr(dateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
function fmtRange(weekStart) {
  const end = addDays(weekStart, 6);
  return `${fmtDateShort(weekStart)} - ${fmtDateShort(end)} ${parseDateStr(end).getFullYear()}`;
}
function fmtWhen(ts) {
  if (!ts || !ts.toDate) return '';
  return ts.toDate().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function roleLabel(r) { return r === 'admin' ? 'Jake/Oliver' : 'Manager'; }

// ---------- image compression ----------

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function canvasDataUrl(img, maxDim, quality) {
  let w = img.width, h = img.height;
  if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
  else if (h >= w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}
function approxBytes(dataUrl) { return Math.round(dataUrl.length * 0.75); }

async function compressPhoto(file) {
  const raw = await readFileAsDataUrl(file);
  const img = await loadImage(raw);
  let quality = 0.72, maxDim = 1400, dataUrl = canvasDataUrl(img, maxDim, quality);
  let attempts = 0;
  while (approxBytes(dataUrl) > 850000 && attempts < 5) {
    quality = Math.max(0.35, quality - 0.12);
    maxDim = Math.max(700, Math.round(maxDim * 0.85));
    dataUrl = canvasDataUrl(img, maxDim, quality);
    attempts++;
  }
  const thumb = canvasDataUrl(img, 140, 0.55);
  return { dataUrl, thumb };
}

// ---------- login gate ----------

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginPasscode = document.getElementById('login-passcode');
const loginError = document.getElementById('login-error');

document.querySelectorAll('.role-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedLoginRole = btn.dataset.role;
  });
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = loginForm.querySelector('button[type=submit]');
  btn.disabled = true;
  loginError.textContent = '';
  const email = selectedLoginRole === 'admin' ? ADMIN_EMAIL : MANAGER_EMAIL;
  try {
    await auth.signInWithEmailAndPassword(email, loginPasscode.value);
  } catch (err) {
    loginError.textContent = 'Incorrect passcode.';
  } finally {
    btn.disabled = false;
  }
});

auth.onAuthStateChanged(user => {
  if (user) {
    currentRole = user.email === ADMIN_EMAIL ? 'admin' : 'manager';
    document.getElementById('role-badge').textContent = roleLabel(currentRole);
    loginOverlay.classList.add('hidden');
    loginPasscode.value = '';
    if (!booted) { booted = true; init(); }
    subscribeDrivers();
    subscribeWeeks();
  } else {
    loginOverlay.classList.remove('hidden');
    if (unsubDrivers) unsubDrivers();
    if (unsubWeeks) unsubWeeks();
    closeWeekOverlay();
  }
});

// ---------- change passcode ----------

document.getElementById('change-passcode-btn').addEventListener('click', () => {
  document.getElementById('passcode-role-label').textContent = roleLabel(currentRole);
  document.getElementById('passcode-current').value = '';
  document.getElementById('passcode-new').value = '';
  document.getElementById('passcode-confirm').value = '';
  document.getElementById('passcode-error').textContent = '';
  openOverlay('passcode-overlay');
});

document.getElementById('logout-btn').addEventListener('click', () => auth.signOut());

document.getElementById('passcode-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('passcode-error');
  errEl.textContent = '';
  const current = document.getElementById('passcode-current').value;
  const a = document.getElementById('passcode-new').value;
  const b = document.getElementById('passcode-confirm').value;
  if (a !== b) { errEl.textContent = "New passcodes don't match."; return; }
  const btn = document.querySelector('#passcode-form button[type=submit]');
  btn.disabled = true;
  try {
    const cred = firebase.auth.EmailAuthProvider.credential(auth.currentUser.email, current);
    await auth.currentUser.reauthenticateWithCredential(cred);
    await auth.currentUser.updatePassword(a);
    closeOverlayEl('passcode-overlay');
  } catch (err) {
    if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-login-credentials') {
      errEl.textContent = 'Current passcode is incorrect.';
    } else {
      errEl.textContent = 'Could not update passcode: ' + err.message;
    }
  } finally {
    btn.disabled = false;
  }
});

// ---------- overlays ----------

function openOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
function closeOverlayEl(id) { document.getElementById(id).classList.add('hidden'); }

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeOverlayById(btn.dataset.close));
});
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlayById(ov.id); });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.overlay:not(.hidden)').forEach(ov => closeOverlayById(ov.id));
});
function closeOverlayById(id) {
  if (id === 'week-overlay') { closeWeekOverlay(); return; }
  closeOverlayEl(id);
}

// ---------- tabs ----------

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ---------- drivers ----------

function subscribeDrivers() {
  if (unsubDrivers) unsubDrivers();
  unsubDrivers = db.collection('drivers').orderBy('name').onSnapshot(snap => {
    drivers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDrivers();
    if (currentWeekId) renderRotaGrid();
  }, err => console.error('drivers snapshot error', err));
}

function renderDrivers() {
  const tbody = document.getElementById('drivers-tbody');
  if (!drivers.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">No drivers yet. Add your first driver to start building rotas.</td></tr>';
    return;
  }
  tbody.innerHTML = drivers.map(d => `
    <tr>
      <td>${escapeHtml(d.name)}</td>
      <td><span class="pill ${d.active ? 'pill-active' : 'pill-inactive'}">${d.active ? 'Active' : 'Inactive'}</span></td>
      <td><button class="link-btn" data-edit-driver="${d.id}">Edit</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-edit-driver]').forEach(btn => {
    btn.addEventListener('click', () => openDriverModal(drivers.find(d => d.id === btn.dataset.editDriver)));
  });
}

document.getElementById('add-driver-btn').addEventListener('click', () => openDriverModal(null));

function openDriverModal(driver) {
  document.getElementById('driver-modal-title').textContent = driver ? 'Edit driver' : 'Add driver';
  document.getElementById('driver-id').value = driver ? driver.id : '';
  document.getElementById('driver-name').value = driver ? driver.name : '';
  document.getElementById('driver-active').checked = driver ? !!driver.active : true;
  openOverlay('driver-overlay');
}

document.getElementById('driver-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('driver-id').value;
  const data = {
    name: document.getElementById('driver-name').value.trim(),
    active: document.getElementById('driver-active').checked,
  };
  if (!data.name) return;
  if (id) {
    await db.collection('drivers').doc(id).update(data);
  } else {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('drivers').add(data);
  }
  closeOverlayEl('driver-overlay');
});

// ---------- weeks list ----------

function subscribeWeeks() {
  if (unsubWeeks) unsubWeeks();
  unsubWeeks = db.collection('weeks').orderBy('weekStart', 'desc').onSnapshot(snap => {
    weeksById = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    renderWeeksList();
    if (currentWeekId) renderWeekHeader();
  }, err => console.error('weeks snapshot error', err));
}

function renderWeeksList() {
  const wrap = document.getElementById('weeks-list');
  const weeks = [...weeksById.values()];
  if (!weeks.length) {
    wrap.innerHTML = '<div class="table-wrap"><table><tbody><tr class="empty-row"><td>No rotas yet. Click "New rota" to set up the next few weeks.</td></tr></tbody></table></div>';
    return;
  }
  wrap.innerHTML = weeks.map(w => `
    <div class="week-card" data-open-week="${w.id}">
      ${w.thumbDataUrl
        ? `<img class="week-card-thumb" src="${w.thumbDataUrl}" alt="">`
        : `<div class="week-card-thumb-empty"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg></div>`}
      <div class="week-card-dates">
        <div class="week-card-range">${fmtRange(w.weekStart)}</div>
        <div class="week-card-meta">${w.shiftCount || 0} shift${(w.shiftCount || 0) === 1 ? '' : 's'} - ${w.photoCount || 0} photo${(w.photoCount || 0) === 1 ? '' : 's'}</div>
      </div>
      <span class="pill ${w.status === 'published' ? 'pill-published' : 'pill-draft'}">${w.status === 'published' ? 'Published' : 'Draft'}</span>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-open-week]').forEach(card => {
    card.addEventListener('click', () => openWeek(card.dataset.openWeek));
  });
}

// ---------- new rota ----------

document.getElementById('new-rota-btn').addEventListener('click', () => {
  document.getElementById('new-rota-start').value = nextMonday();
  openOverlay('new-rota-overlay');
});

document.getElementById('new-rota-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const picked = document.getElementById('new-rota-start').value;
  if (!picked) return;
  const startMonday = mondayOf(picked);
  const count = Number(document.getElementById('new-rota-count').value);
  for (let i = 0; i < count; i++) {
    const weekId = addDays(startMonday, i * 7);
    const ref = db.collection('weeks').doc(weekId);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        weekStart: weekId,
        status: 'draft',
        shiftCount: 0,
        photoCount: 0,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdByRole: currentRole,
      });
    }
  }
  closeOverlayEl('new-rota-overlay');
  openWeek(startMonday);
});

// ---------- week detail ----------

function openWeek(weekId) {
  currentWeekId = weekId;
  currentShifts = [];
  currentPhotos = [];
  currentAmendments = [];
  renderWeekHeader();
  renderRotaGrid();
  renderPhotoStrip();
  renderAmendments();
  openOverlay('week-overlay');

  if (unsubShifts) unsubShifts();
  unsubShifts = db.collection('weeks').doc(weekId).collection('shifts').onSnapshot(snap => {
    currentShifts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRotaGrid();
  }, err => console.error('shifts snapshot error', err));

  if (unsubPhotos) unsubPhotos();
  unsubPhotos = db.collection('weeks').doc(weekId).collection('photos').orderBy('uploadedAt').onSnapshot(snap => {
    currentPhotos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPhotoStrip();
  }, err => console.error('photos snapshot error', err));

  if (unsubAmendments) unsubAmendments();
  unsubAmendments = db.collection('weeks').doc(weekId).collection('amendments').orderBy('at', 'desc').limit(50).onSnapshot(snap => {
    currentAmendments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAmendments();
  }, err => console.error('amendments snapshot error', err));
}

function closeWeekOverlay() {
  closeOverlayEl('week-overlay');
  if (unsubShifts) { unsubShifts(); unsubShifts = null; }
  if (unsubPhotos) { unsubPhotos(); unsubPhotos = null; }
  if (unsubAmendments) { unsubAmendments(); unsubAmendments = null; }
  currentWeekId = null;
}

function renderWeekHeader() {
  const w = weeksById.get(currentWeekId);
  if (!w) return;
  const el = document.getElementById('week-content');
  const headerHtml = `
    <div class="week-detail-header">
      <div>
        <div class="week-detail-title">${fmtRange(w.weekStart)}</div>
        <div class="week-detail-sub">
          <span class="pill ${w.status === 'published' ? 'pill-published' : 'pill-draft'}">${w.status === 'published' ? 'Published' : 'Draft'}</span>
          &nbsp; Created by ${roleLabel(w.createdByRole)} ${fmtWhen(w.createdAt)}
          ${w.publishedAt ? `- Published by ${roleLabel(w.publishedByRole)} ${fmtWhen(w.publishedAt)}` : ''}
        </div>
      </div>
      <div class="week-detail-actions">
        ${(!w.shiftCount && weeksById.has(addDays(w.weekStart, -7))) ? '<button id="copy-prev-week-btn" class="btn-outline"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1"/><path d="M9 15h9a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2z"/></svg>Copy from previous week</button>' : ''}
        ${w.status !== 'published' ? '<button id="publish-week-btn" class="btn-primary"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>Publish rota</button>' : ''}
      </div>
    </div>
    <div id="week-warnings"></div>
    <div id="week-photo-strip"></div>
    <div id="week-grid-wrap"></div>
    <div id="week-amend-wrap" class="amend-section"></div>
  `;
  el.dataset.weekId = currentWeekId;
  el.innerHTML = headerHtml;
  wireWeekHeaderActions();
  renderRotaGrid();
  renderPhotoStrip();
  renderAmendments();
}

function wireWeekHeaderActions() {
  const btn = document.getElementById('publish-week-btn');
  if (btn) btn.addEventListener('click', publishWeek);
  const copyBtn = document.getElementById('copy-prev-week-btn');
  if (copyBtn) copyBtn.addEventListener('click', copyFromPreviousWeek);
}

async function publishWeek() {
  const w = weeksById.get(currentWeekId);
  await db.collection('weeks').doc(currentWeekId).update({
    status: 'published',
    publishedAt: firebase.firestore.FieldValue.serverTimestamp(),
    publishedByRole: currentRole,
  });
  sendPublishNotification(w ? w.weekStart : currentWeekId);
}

function sendPublishNotification(weekStart) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
    console.warn('EmailJS not configured yet - skipping publish notification.');
    return;
  }
  const params = {
    week_range: fmtRange(weekStart),
    published_by: roleLabel(currentRole),
    published_at: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    app_url: APP_URL,
  };
  NOTIFY_EMAILS.forEach(to => {
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { ...params, to_email: to })
      .catch(err => console.error('Publish notification email failed for', to, err));
  });
}

async function copyFromPreviousWeek() {
  const w = weeksById.get(currentWeekId);
  if (!w) return;
  const prevWeekId = addDays(w.weekStart, -7);
  const prevWeek = weeksById.get(prevWeekId);
  if (!prevWeek) return;
  if (!confirm(`Copy all shifts from the week of ${fmtRange(prevWeekId)} into this week?`)) return;

  const btn = document.getElementById('copy-prev-week-btn');
  if (btn) btn.disabled = true;
  try {
    const prevShiftsSnap = await db.collection('weeks').doc(prevWeekId).collection('shifts').get();
    if (prevShiftsSnap.empty) return;
    const weekRef = db.collection('weeks').doc(currentWeekId);
    const batch = db.batch();
    prevShiftsSnap.docs.forEach(doc => {
      const s = doc.data();
      const newRef = weekRef.collection('shifts').doc();
      batch.set(newRef, {
        driverId: s.driverId,
        date: addDays(s.date, 7),
        off: !!s.off,
        start: s.off ? null : (s.start || null),
        end: s.off ? null : (s.end || null),
        note: s.note || '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedByRole: currentRole,
      });
    });
    batch.update(weekRef, { shiftCount: firebase.firestore.FieldValue.increment(prevShiftsSnap.size) });
    await batch.commit();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- rota grid ----------

function renderRotaGrid() {
  const wrap = document.getElementById('week-grid-wrap');
  if (!wrap || !currentWeekId) return;
  const w = weeksById.get(currentWeekId);
  const weekStart = w ? w.weekStart : currentWeekId;

  const shiftDriverIds = new Set(currentShifts.map(s => s.driverId));
  const rowDrivers = drivers.filter(d => d.active || shiftDriverIds.has(d.id));

  if (!rowDrivers.length) {
    wrap.innerHTML = '<p class="field-hint">No drivers yet - add drivers first from the Drivers tab, then come back to fill in shifts.</p>';
    return;
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const activeDrivers = drivers.filter(d => d.active);
  const noCoverageDays = activeDrivers.length
    ? new Set(days.filter(d => !currentShifts.some(s => s.date === d && !s.off)))
    : new Set();

  let html = '<div class="rota-grid-wrap"><div class="rota-grid">';
  html += '<div class="rota-head"><div class="rota-driver-cell">Driver</div>';
  days.forEach((d, i) => {
    html += `<div class="rota-day-cell${noCoverageDays.has(d) ? ' warn-day' : ''}"><div class="rota-day-name">${DAY_LABELS[i]}</div><div class="rota-day-date">${fmtDateShort(d)}</div></div>`;
  });
  html += '</div>';

  rowDrivers.forEach(driver => {
    html += `<div class="rota-row"><div class="rota-driver-cell">${escapeHtml(driver.name)}${!driver.active ? ' <span class="pill pill-inactive">Inactive</span>' : ''}</div>`;
    days.forEach(dayStr => {
      const shifts = currentShifts.filter(s => s.driverId === driver.id && s.date === dayStr)
        .sort((a, b) => (a.off ? '0' : a.start || '').localeCompare(b.off ? '0' : b.start || ''));
      html += '<div class="rota-day-cell">';
      shifts.forEach(s => {
        html += `<div class="shift-chip ${s.off ? 'off' : ''}" data-shift-id="${s.id}">${s.off ? 'OFF' : `${s.start}-${s.end}`}${s.note ? `<span class="shift-note">${escapeHtml(s.note)}</span>` : ''}</div>`;
      });
      html += `<button type="button" class="add-shift-btn" data-add-driver="${driver.id}" data-add-date="${dayStr}">+ Add</button>`;
      html += '</div>';
    });
    html += '</div>';
  });
  html += '</div></div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('[data-shift-id]').forEach(chip => {
    chip.addEventListener('click', () => openShiftModal(currentShifts.find(s => s.id === chip.dataset.shiftId)));
  });
  wrap.querySelectorAll('[data-add-driver]').forEach(btn => {
    btn.addEventListener('click', () => openShiftModal(null, btn.dataset.addDriver, btn.dataset.addDate));
  });

  renderCoverageWarnings();
}

function computeCoverageWarnings() {
  const w = weeksById.get(currentWeekId);
  if (!w) return [];
  const activeDrivers = drivers.filter(d => d.active);
  if (!activeDrivers.length) return [];
  const days = Array.from({ length: 7 }, (_, i) => addDays(w.weekStart, i));
  const warnings = [];
  days.forEach(dayStr => {
    const dayShifts = currentShifts.filter(s => s.date === dayStr && !s.off);
    if (!dayShifts.length) {
      warnings.push({ type: 'no-coverage', text: `No driver rostered - ${fmtDayFull(dayStr)}` });
    }
    for (let a = 0; a < dayShifts.length; a++) {
      for (let b = a + 1; b < dayShifts.length; b++) {
        const s1 = dayShifts[a], s2 = dayShifts[b];
        if (s1.driverId === s2.driverId && s1.start && s1.end && s2.start && s2.end && s1.start < s2.end && s2.start < s1.end) {
          warnings.push({ type: 'double-booked', text: `${driverName(s1.driverId)} double-booked - ${fmtDayFull(dayStr)}: ${s1.start}-${s1.end} overlaps ${s2.start}-${s2.end}` });
        }
      }
    }
  });
  return warnings;
}

function renderCoverageWarnings() {
  const wrap = document.getElementById('week-warnings');
  if (!wrap) return;
  const warnings = computeCoverageWarnings();
  wrap.innerHTML = warnings.map(w => `<div class="alert ${w.type === 'double-booked' ? 'alert-danger' : 'alert-warn'}">${escapeHtml(w.text)}</div>`).join('');
}

function driverName(id) { const d = drivers.find(x => x.id === id); return d ? d.name : '(unknown driver)'; }
function shiftLabel(s) { return s.off ? 'OFF' : `${s.start}-${s.end}`; }

function openShiftModal(shift, driverId, dateStr) {
  const editing = !!shift;
  document.getElementById('shift-modal-title').textContent = editing ? 'Edit shift' : 'Add shift';
  document.getElementById('shift-id').value = editing ? shift.id : '';
  document.getElementById('shift-driver-id').value = editing ? shift.driverId : driverId;
  document.getElementById('shift-date').value = editing ? shift.date : dateStr;
  const dId = editing ? shift.driverId : driverId;
  const dStr = editing ? shift.date : dateStr;
  document.getElementById('shift-context').textContent = `${driverName(dId)} - ${fmtDayFull(dStr)}`;
  document.getElementById('shift-off').checked = editing ? !!shift.off : false;
  document.getElementById('shift-start').value = editing && shift.start ? shift.start : '08:00';
  document.getElementById('shift-end').value = editing && shift.end ? shift.end : '16:00';
  document.getElementById('shift-note').value = editing ? (shift.note || '') : '';
  document.getElementById('shift-delete-btn').classList.toggle('hidden', !editing);
  toggleShiftTimeFields();
  openOverlay('shift-overlay');
}

document.getElementById('shift-off').addEventListener('change', toggleShiftTimeFields);
function toggleShiftTimeFields() {
  document.getElementById('shift-time-fields').classList.toggle('hidden', document.getElementById('shift-off').checked);
}

document.getElementById('shift-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('shift-id').value;
  const driverId = document.getElementById('shift-driver-id').value;
  const date = document.getElementById('shift-date').value;
  const off = document.getElementById('shift-off').checked;
  const data = {
    driverId,
    date,
    off,
    start: off ? null : document.getElementById('shift-start').value,
    end: off ? null : document.getElementById('shift-end').value,
    note: document.getElementById('shift-note').value.trim(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedByRole: currentRole,
  };
  const w = weeksById.get(currentWeekId);
  const published = w && w.status === 'published';
  const weekRef = db.collection('weeks').doc(currentWeekId);
  const dName = driverName(driverId);
  const dayLabel = fmtDayFull(date);

  if (id) {
    const prev = currentShifts.find(s => s.id === id);
    await weekRef.collection('shifts').doc(id).update(data);
    if (published && prev) {
      await logAmendment(`Amended ${dName} - ${dayLabel}: ${shiftLabel(prev)} -> ${shiftLabel(data)}`);
    }
  } else {
    await weekRef.collection('shifts').add(data);
    await weekRef.update({ shiftCount: firebase.firestore.FieldValue.increment(1) });
    if (published) {
      await logAmendment(`Added shift for ${dName} - ${dayLabel}: ${shiftLabel(data)}`);
    }
  }
  closeOverlayEl('shift-overlay');
});

document.getElementById('shift-delete-btn').addEventListener('click', async () => {
  const id = document.getElementById('shift-id').value;
  if (!id) return;
  const prev = currentShifts.find(s => s.id === id);
  const w = weeksById.get(currentWeekId);
  const published = w && w.status === 'published';
  const weekRef = db.collection('weeks').doc(currentWeekId);
  await weekRef.collection('shifts').doc(id).delete();
  await weekRef.update({ shiftCount: firebase.firestore.FieldValue.increment(-1) });
  if (published && prev) {
    await logAmendment(`Removed shift for ${driverName(prev.driverId)} - ${fmtDayFull(prev.date)} (was ${shiftLabel(prev)})`);
  }
  closeOverlayEl('shift-overlay');
});

async function logAmendment(text) {
  await db.collection('weeks').doc(currentWeekId).collection('amendments').add({
    text,
    role: currentRole,
    at: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

function renderAmendments() {
  const wrap = document.getElementById('week-amend-wrap');
  if (!wrap) return;
  if (!currentAmendments.length) {
    wrap.innerHTML = '<h3>Amendments</h3><div class="amend-empty">No amendments yet.</div>';
    return;
  }
  wrap.innerHTML = '<h3>Amendments</h3><div class="amend-list">' + currentAmendments.map(a => `
    <div class="amend-item">${escapeHtml(a.text)}<span class="amend-when">${roleLabel(a.role)} - ${fmtWhen(a.at)}</span></div>
  `).join('') + '</div>';
}

// ---------- photos ----------

function renderPhotoStrip() {
  const wrap = document.getElementById('week-photo-strip');
  if (!wrap) return;
  let html = '<div class="photo-strip">';
  currentPhotos.forEach((p, i) => {
    html += `<img class="photo-thumb" src="${p.thumb || p.dataUrl}" data-photo-index="${i}" alt="Rota photo ${i + 1}">`;
  });
  html += '<label class="photo-add-tile" id="grid-photo-add-tile"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg><input type="file" id="grid-photo-input" accept="image/*" capture="environment" hidden></label>';
  html += '</div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('[data-photo-index]').forEach(img => {
    img.addEventListener('click', () => openPhotoViewer(Number(img.dataset.photoIndex)));
  });
  document.getElementById('grid-photo-input').addEventListener('change', handlePhotoInput);
}

async function handlePhotoInput(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const file of files) {
    await addPhoto(file);
  }
}

async function addPhoto(file) {
  const { dataUrl, thumb } = await compressPhoto(file);
  const weekRef = db.collection('weeks').doc(currentWeekId);
  await weekRef.collection('photos').add({
    dataUrl, thumb,
    uploadedAt: firebase.firestore.FieldValue.serverTimestamp(),
    uploadedByRole: currentRole,
  });
  const w = weeksById.get(currentWeekId);
  const updates = { photoCount: firebase.firestore.FieldValue.increment(1) };
  if (!w || !w.photoCount) updates.thumbDataUrl = thumb;
  await weekRef.update(updates);
}

function openPhotoViewer(index) {
  currentPhotoIndex = index;
  renderPhotoViewer();
  openOverlay('photo-overlay');
}
function renderPhotoViewer() {
  if (!currentPhotos.length) { closeOverlayEl('photo-overlay'); return; }
  const p = currentPhotos[currentPhotoIndex];
  document.getElementById('photo-full-img').src = p.dataUrl;
  document.getElementById('photo-count').textContent = `${currentPhotoIndex + 1} / ${currentPhotos.length}`;
}
document.getElementById('photo-prev').addEventListener('click', () => {
  currentPhotoIndex = (currentPhotoIndex - 1 + currentPhotos.length) % currentPhotos.length;
  renderPhotoViewer();
});
document.getElementById('photo-next').addEventListener('click', () => {
  currentPhotoIndex = (currentPhotoIndex + 1) % currentPhotos.length;
  renderPhotoViewer();
});
document.getElementById('photo-add-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const file of files) await addPhoto(file);
});

// ---------- utils ----------

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- init ----------

function init() {
  initTabs();
}
