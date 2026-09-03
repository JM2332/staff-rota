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
const STANDARD_RUNS = ['Cannon Hall Farm', 'Sheffield 1', 'Holmfirth', 'Sheffield 2', 'Wakefield'];

// EmailJS - sends the publish notification, no backend required.
const EMAILJS_SERVICE_ID = 'service_lm99z1l';
const EMAILJS_TEMPLATE_ID = 'template_lq218u5';
const EMAILJS_PUBLIC_KEY = 'qgSt4-ksJSzM_C3Bp';
const NOTIFY_EMAILS = ['jakemawby23@gmail.com', 'oliver@kmlfoodservice.com'];
const APP_URL = 'https://jm2332.github.io/staff-rota/';
if (EMAILJS_PUBLIC_KEY) emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });

let selectedLoginRole = 'manager';
let currentRole = null; // 'manager' | 'admin', set after login
let booted = false;

let drivers = [];             // [{id, name, active}]
let runs = [];                 // [{id, name, order, active}]
let weeksById = new Map();    // weekId -> week doc data
let currentWeekId = null;
let currentAssignments = [];  // assignments (driver-on-run-on-day) for the open week
let currentPhotos = [];       // photos for the open week
let currentAmendments = [];
let currentPhotoIndex = 0;
let selectedPoolDriverId = null; // tap-to-place: driver chip currently selected in the pool

let unsubDrivers = null, unsubRuns = null, unsubWeeks = null, unsubAssignments = null, unsubAmendments = null, unsubPhotos = null;

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
    subscribeRuns();
    subscribeWeeks();
  } else {
    loginOverlay.classList.remove('hidden');
    if (unsubDrivers) unsubDrivers();
    if (unsubRuns) unsubRuns();
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
    if (currentWeekId) { renderRunGrid(); renderDriverPool(); }
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

// ---------- runs ----------

function subscribeRuns() {
  if (unsubRuns) unsubRuns();
  unsubRuns = db.collection('runs').orderBy('order').onSnapshot(snap => {
    runs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRuns();
    if (currentWeekId) renderRunGrid();
  }, err => console.error('runs snapshot error', err));
}

function renderRuns() {
  const tbody = document.getElementById('runs-tbody');
  document.getElementById('seed-runs-btn').classList.toggle('hidden', runs.length > 0);
  if (!runs.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No runs yet. Add your delivery runs to start building rotas.</td></tr>';
    return;
  }
  tbody.innerHTML = runs.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.order ?? ''}</td>
      <td><span class="pill ${r.active ? 'pill-active' : 'pill-inactive'}">${r.active ? 'Active' : 'Inactive'}</span></td>
      <td><button class="link-btn" data-edit-run="${r.id}">Edit</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-edit-run]').forEach(btn => {
    btn.addEventListener('click', () => openRunModal(runs.find(r => r.id === btn.dataset.editRun)));
  });
}

document.getElementById('add-run-btn').addEventListener('click', () => openRunModal(null));

document.getElementById('seed-runs-btn').addEventListener('click', async () => {
  const btn = document.getElementById('seed-runs-btn');
  btn.disabled = true;
  try {
    const batch = db.batch();
    STANDARD_RUNS.forEach((name, i) => {
      const ref = db.collection('runs').doc();
      batch.set(ref, { name, order: i, active: true, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
  } finally {
    btn.disabled = false;
  }
});

function openRunModal(run) {
  document.getElementById('run-modal-title').textContent = run ? 'Edit run' : 'Add run';
  document.getElementById('run-id').value = run ? run.id : '';
  document.getElementById('run-name').value = run ? run.name : '';
  document.getElementById('run-order').value = run ? (run.order ?? 0) : runs.length;
  document.getElementById('run-active').checked = run ? !!run.active : true;
  openOverlay('run-overlay');
}

document.getElementById('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('run-id').value;
  const data = {
    name: document.getElementById('run-name').value.trim(),
    order: Number(document.getElementById('run-order').value) || 0,
    active: document.getElementById('run-active').checked,
  };
  if (!data.name) return;
  if (id) {
    await db.collection('runs').doc(id).update(data);
  } else {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('runs').add(data);
  }
  closeOverlayEl('run-overlay');
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
        <div class="week-card-meta">${w.shiftCount || 0} assignment${(w.shiftCount || 0) === 1 ? '' : 's'} - ${w.photoCount || 0} photo${(w.photoCount || 0) === 1 ? '' : 's'}</div>
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
  currentAssignments = [];
  currentPhotos = [];
  currentAmendments = [];
  selectedPoolDriverId = null;
  renderWeekHeader();
  openOverlay('week-overlay');

  if (unsubAssignments) unsubAssignments();
  unsubAssignments = db.collection('weeks').doc(weekId).collection('assignments').onSnapshot(snap => {
    currentAssignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRunGrid();
  }, err => console.error('assignments snapshot error', err));

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
  if (unsubAssignments) { unsubAssignments(); unsubAssignments = null; }
  if (unsubPhotos) { unsubPhotos(); unsubPhotos = null; }
  if (unsubAmendments) { unsubAmendments(); unsubAmendments = null; }
  currentWeekId = null;
  selectedPoolDriverId = null;
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
        ${w.status === 'published' ? '<button id="unpublish-week-btn" class="btn-outline"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v8h8"/></svg>Unpublish (back to Draft)</button>' : '<button id="publish-week-btn" class="btn-primary"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>Publish rota</button>'}
        ${w.status === 'published' ? '<button id="print-week-btn" class="btn-outline"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="6" y="14" width="12" height="7"/><path d="M6 18H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2"/></svg>Print</button>' : ''}
        <button id="delete-week-btn" class="btn-danger"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Delete rota</button>
      </div>
    </div>
    <div id="week-warnings"></div>
    <div id="week-photo-strip"></div>
    <div id="week-driver-pool"></div>
    <div id="week-grid-wrap"></div>
    <div id="week-amend-wrap" class="amend-section"></div>
  `;
  el.dataset.weekId = currentWeekId;
  el.innerHTML = headerHtml;
  wireWeekHeaderActions();
  renderRunGrid();
  renderDriverPool();
  renderPhotoStrip();
  renderAmendments();
}

function wireWeekHeaderActions() {
  const btn = document.getElementById('publish-week-btn');
  if (btn) btn.addEventListener('click', publishWeek);
  const unpubBtn = document.getElementById('unpublish-week-btn');
  if (unpubBtn) unpubBtn.addEventListener('click', unpublishWeek);
  const copyBtn = document.getElementById('copy-prev-week-btn');
  if (copyBtn) copyBtn.addEventListener('click', copyFromPreviousWeek);
  const deleteBtn = document.getElementById('delete-week-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', deleteWeek);
  const printBtn = document.getElementById('print-week-btn');
  if (printBtn) printBtn.addEventListener('click', printRota);
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

async function unpublishWeek() {
  if (!confirm('Move this rota back to Draft? It stays visible to managers and admins, but no new publish email is sent until you publish it again.')) return;
  await db.collection('weeks').doc(currentWeekId).update({
    status: 'draft',
    publishedAt: firebase.firestore.FieldValue.delete(),
    publishedByRole: firebase.firestore.FieldValue.delete(),
  });
}

async function deleteWeek() {
  const w = weeksById.get(currentWeekId);
  if (!w) return;
  if (!confirm(`Delete the entire rota for ${fmtRange(w.weekStart)}? This removes all assignments, photos, and amendment history for this week. This can't be undone.`)) return;
  const btn = document.getElementById('delete-week-btn');
  if (btn) btn.disabled = true;
  try {
    const weekRef = db.collection('weeks').doc(currentWeekId);
    const [shiftsSnap, assignSnap, photosSnap, amendSnap] = await Promise.all([
      weekRef.collection('shifts').get(),
      weekRef.collection('assignments').get(),
      weekRef.collection('photos').get(),
      weekRef.collection('amendments').get(),
    ]);
    const batch = db.batch();
    shiftsSnap.docs.forEach(d => batch.delete(d.ref));
    assignSnap.docs.forEach(d => batch.delete(d.ref));
    photosSnap.docs.forEach(d => batch.delete(d.ref));
    amendSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(weekRef);
    await batch.commit();
    closeWeekOverlay();
  } finally {
    if (btn) btn.disabled = false;
  }
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
  if (!confirm(`Copy all assignments from the week of ${fmtRange(prevWeekId)} into this week?`)) return;

  const btn = document.getElementById('copy-prev-week-btn');
  if (btn) btn.disabled = true;
  try {
    const prevAssignSnap = await db.collection('weeks').doc(prevWeekId).collection('assignments').get();
    if (prevAssignSnap.empty) return;
    const weekRef = db.collection('weeks').doc(currentWeekId);
    const batch = db.batch();
    prevAssignSnap.docs.forEach(doc => {
      const a = doc.data();
      const newRef = weekRef.collection('assignments').doc();
      batch.set(newRef, {
        runId: a.runId,
        runName: a.runName,
        driverId: a.driverId,
        driverName: a.driverName,
        date: addDays(a.date, 7),
        start: a.start || null,
        note: a.note || '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedByRole: currentRole,
      });
    });
    batch.update(weekRef, { shiftCount: firebase.firestore.FieldValue.increment(prevAssignSnap.size) });
    await batch.commit();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function printRota() {
  const w = weeksById.get(currentWeekId);
  if (!w) return;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w.weekStart, i));
  const assignRunIds = new Set(currentAssignments.map(a => a.runId));
  const rowRuns = runs.filter(r => r.active || assignRunIds.has(r.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const headCells = days.map((d, i) => `<th>${DAY_LABELS[i]}<br>${fmtDateShort(d)}</th>`).join('');

  const rows = rowRuns.map(run => {
    const cells = days.map(dayStr => {
      const assigns = currentAssignments.filter(a => a.runId === run.id && a.date === dayStr);
      const cell = assigns.map(a => `${escapeHtml(a.driverName)}${a.start ? ` (${a.start})` : ''}${a.note ? ` - ${escapeHtml(a.note)}` : ''}`).join('<br>');
      return `<td>${cell}</td>`;
    }).join('');
    return `<tr><th class="print-driver-col">${escapeHtml(run.name)}</th>${cells}</tr>`;
  }).join('');

  document.getElementById('print-area').innerHTML = `
    <h1>KML Foodservice - Staff Rota</h1>
    <h2>${fmtRange(w.weekStart)}</h2>
    <table>
      <thead><tr><th></th>${headCells}</tr></thead>
      <tbody>${rows || '<tr><td colspan="8">No runs</td></tr>'}</tbody>
    </table>
    <p class="print-footer">Printed ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
  `;
  window.print();
}

// ---------- driver pool (drag source / tap-to-select) ----------

function renderDriverPool() {
  const wrap = document.getElementById('week-driver-pool');
  if (!wrap) return;
  const activeDrivers = drivers.filter(d => d.active);
  if (!activeDrivers.length) {
    wrap.innerHTML = '<p class="field-hint">No active drivers yet - add drivers first from the Drivers tab.</p>';
    return;
  }
  const selectedName = selectedPoolDriverId ? driverName(selectedPoolDriverId) : null;
  wrap.innerHTML = `
    <div class="pool-hint">${selectedName ? `Now tap "+ Assign" on a run/day slot to place <strong>${escapeHtml(selectedName)}</strong> - or tap them again to cancel.` : 'Tap a driver, then tap "+ Assign" on a run/day slot to place them. On desktop you can also drag and drop.'}</div>
    <div class="driver-pool">
      ${activeDrivers.map(d => `<div class="driver-chip${selectedPoolDriverId === d.id ? ' selected' : ''}" draggable="true" data-pool-driver="${d.id}">${escapeHtml(d.name)}</div>`).join('')}
    </div>
  `;
  wrap.querySelectorAll('[data-pool-driver]').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.poolDriver;
      selectedPoolDriverId = (selectedPoolDriverId === id) ? null : id;
      renderDriverPool();
    });
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ driverId: chip.dataset.poolDriver }));
    });
  });
}

// ---------- run grid ----------

function driverName(id) { const d = drivers.find(x => x.id === id); return d ? d.name : '(unknown driver)'; }

function renderRunGrid() {
  const wrap = document.getElementById('week-grid-wrap');
  if (!wrap || !currentWeekId) return;
  const w = weeksById.get(currentWeekId);
  const weekStart = w ? w.weekStart : currentWeekId;

  const assignRunIds = new Set(currentAssignments.map(a => a.runId));
  const rowRuns = runs.filter(r => r.active || assignRunIds.has(r.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (!rowRuns.length) {
    wrap.innerHTML = '<p class="field-hint">No runs yet - add your delivery runs first from the Runs tab, then come back to build the rota.</p>';
    renderCoverageWarnings();
    return;
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  let html = '<div class="rota-grid-wrap"><div class="rota-grid">';
  html += '<div class="rota-head"><div class="rota-driver-cell">Run</div>';
  days.forEach((d, i) => {
    html += `<div class="rota-day-cell"><div class="rota-day-name">${DAY_LABELS[i]}</div><div class="rota-day-date">${fmtDateShort(d)}</div></div>`;
  });
  html += '</div>';

  rowRuns.forEach(run => {
    html += `<div class="rota-row"><div class="rota-driver-cell">${escapeHtml(run.name)}${!run.active ? ' <span class="pill pill-inactive">Inactive</span>' : ''}</div>`;
    days.forEach(dayStr => {
      const cellAssignments = currentAssignments.filter(a => a.runId === run.id && a.date === dayStr);
      const isEmpty = cellAssignments.length === 0 && run.active && w && w.status === 'published';
      html += `<div class="rota-day-cell run-slot${isEmpty ? ' empty-warn' : ''}" data-run-id="${run.id}" data-date="${dayStr}">`;
      cellAssignments.forEach(a => {
        html += `<div class="shift-chip" draggable="true" data-assign-id="${a.id}">${escapeHtml(a.driverName)}${a.start ? `<span class="shift-note">${a.start}</span>` : ''}${a.note ? `<span class="shift-note">${escapeHtml(a.note)}</span>` : ''}</div>`;
      });
      html += `<button type="button" class="add-shift-btn" data-place-run="${run.id}" data-place-date="${dayStr}">+ Assign</button>`;
      html += '</div>';
    });
    html += '</div>';
  });
  html += '</div></div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('[data-assign-id]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openAssignModal(currentAssignments.find(a => a.id === chip.dataset.assignId));
    });
    chip.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', JSON.stringify({ assignId: chip.dataset.assignId }));
    });
  });
  wrap.querySelectorAll('[data-place-run]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (selectedPoolDriverId) {
        placeDriver(selectedPoolDriverId, btn.dataset.placeRun, btn.dataset.placeDate);
        selectedPoolDriverId = null;
        renderDriverPool();
      } else {
        alert('Tap a driver above first, then tap "+ Assign" to place them here.');
      }
    });
  });
  wrap.querySelectorAll('.run-slot').forEach(cell => {
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
      const runId = cell.dataset.runId, date = cell.dataset.date;
      if (payload.driverId) {
        placeDriver(payload.driverId, runId, date);
      } else if (payload.assignId) {
        moveAssignment(payload.assignId, runId, date);
      }
    });
  });

  renderCoverageWarnings();
}

async function placeDriver(driverId, runId, date) {
  const driver = drivers.find(d => d.id === driverId);
  const run = runs.find(r => r.id === runId);
  if (!driver || !run) return;
  const existing = currentAssignments.filter(a => a.runId === runId && a.date === date);
  if (existing.length === 1 && existing[0].driverId === driverId) return; // already exactly this driver here

  const weekRef = db.collection('weeks').doc(currentWeekId);
  const batch = db.batch();
  let netCount = 0;
  let replacedName = null;
  existing.forEach(a => {
    batch.delete(weekRef.collection('assignments').doc(a.id));
    netCount -= 1;
    replacedName = a.driverName;
  });
  batch.set(weekRef.collection('assignments').doc(), {
    runId, runName: run.name,
    driverId, driverName: driver.name,
    date, start: null, note: '',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedByRole: currentRole,
  });
  netCount += 1;
  batch.update(weekRef, { shiftCount: firebase.firestore.FieldValue.increment(netCount) });
  await batch.commit();

  const w = weeksById.get(currentWeekId);
  if (w && w.status === 'published') {
    if (replacedName) {
      await logAmendment(`Swapped ${replacedName} for ${driver.name} on ${run.name} - ${fmtDayFull(date)}`);
    } else {
      await logAmendment(`Assigned ${driver.name} to ${run.name} - ${fmtDayFull(date)}`);
    }
  }
}

async function moveAssignment(assignId, newRunId, newDate) {
  const a = currentAssignments.find(x => x.id === assignId);
  if (!a) return;
  if (a.runId === newRunId && a.date === newDate) return;
  const run = runs.find(r => r.id === newRunId);
  if (!run) return;
  const weekRef = db.collection('weeks').doc(currentWeekId);
  const oldRunName = a.runName, oldDate = a.date;

  const displaced = currentAssignments.filter(x => x.runId === newRunId && x.date === newDate && x.id !== assignId);
  const batch = db.batch();
  let netCount = 0;
  let replacedName = null;
  displaced.forEach(x => {
    batch.delete(weekRef.collection('assignments').doc(x.id));
    netCount -= 1;
    replacedName = x.driverName;
  });
  batch.update(weekRef.collection('assignments').doc(assignId), {
    runId: newRunId,
    runName: run.name,
    date: newDate,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedByRole: currentRole,
  });
  if (netCount !== 0) batch.update(weekRef, { shiftCount: firebase.firestore.FieldValue.increment(netCount) });
  await batch.commit();

  const w = weeksById.get(currentWeekId);
  if (w && w.status === 'published') {
    const suffix = replacedName ? `, replacing ${replacedName}` : '';
    await logAmendment(`Moved ${a.driverName} from ${oldRunName} (${fmtDayFull(oldDate)}) to ${run.name} (${fmtDayFull(newDate)})${suffix}`);
  }
}

function computeCoverageWarnings() {
  const w = weeksById.get(currentWeekId);
  if (!w) return [];
  if (w.status !== 'published') return []; // still drafting - empty slots are expected, not a problem yet
  const activeRuns = runs.filter(r => r.active);
  if (!activeRuns.length) return [];
  const days = Array.from({ length: 7 }, (_, i) => addDays(w.weekStart, i));
  const warnings = [];
  days.forEach(dayStr => {
    activeRuns.forEach(run => {
      const has = currentAssignments.some(a => a.runId === run.id && a.date === dayStr);
      if (!has) {
        warnings.push({ text: `${run.name} has no driver assigned - ${fmtDayFull(dayStr)}` });
      }
    });
  });
  return warnings;
}

function renderCoverageWarnings() {
  const wrap = document.getElementById('week-warnings');
  if (!wrap) return;
  const warnings = computeCoverageWarnings();
  wrap.innerHTML = warnings.map(w => `<div class="alert alert-warn">${escapeHtml(w.text)}</div>`).join('');
}

// ---------- assignment edit modal ----------

function openAssignModal(assignment) {
  if (!assignment) return;
  document.getElementById('assign-id').value = assignment.id;
  document.getElementById('assign-context').textContent = `${assignment.driverName} - ${assignment.runName} - ${fmtDayFull(assignment.date)}`;
  document.getElementById('assign-start').value = assignment.start || '';
  document.getElementById('assign-note').value = assignment.note || '';
  openOverlay('assign-overlay');
}

document.getElementById('assign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('assign-id').value;
  if (!id) return;
  const prev = currentAssignments.find(a => a.id === id);
  const data = {
    start: document.getElementById('assign-start').value || null,
    note: document.getElementById('assign-note').value.trim(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedByRole: currentRole,
  };
  const weekRef = db.collection('weeks').doc(currentWeekId);
  await weekRef.collection('assignments').doc(id).update(data);
  const w = weeksById.get(currentWeekId);
  if (w && w.status === 'published' && prev) {
    await logAmendment(`Updated ${prev.driverName} on ${prev.runName} - ${fmtDayFull(prev.date)}${data.start ? ` (start ${data.start})` : ''}`);
  }
  closeOverlayEl('assign-overlay');
});

document.getElementById('assign-delete-btn').addEventListener('click', async () => {
  const id = document.getElementById('assign-id').value;
  if (!id) return;
  const prev = currentAssignments.find(a => a.id === id);
  const weekRef = db.collection('weeks').doc(currentWeekId);
  await weekRef.collection('assignments').doc(id).delete();
  await weekRef.update({ shiftCount: firebase.firestore.FieldValue.increment(-1) });
  const w = weeksById.get(currentWeekId);
  if (w && w.status === 'published' && prev) {
    await logAmendment(`Removed ${prev.driverName} from ${prev.runName} - ${fmtDayFull(prev.date)}`);
  }
  closeOverlayEl('assign-overlay');
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
