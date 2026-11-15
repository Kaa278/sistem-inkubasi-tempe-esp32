/* ── DASHBOARD IOT - SISTEM INKUBASI ADAPTIF ──────────────────────────── */

/* ── FIREBASE CONFIGURATION ── */
const firebaseConfig = {
  apiKey: "AIzaSyD0oflaBvFLrkY-G9lL4u48WxrcF_SoGg4",
  authDomain: "iot-tempe.firebaseapp.com",
  databaseURL: "https://iot-tempe-default-rtdb.firebaseio.com",
  projectId: "iot-tempe",
  storageBucket: "iot-tempe.firebasestorage.app",
};

const DB_PATH = 'inkubator';
const ESP_TIMEOUT_MS = 5000; // 5 detik tidak ada kabar dari ESP32 -> Offline

/* ── STATE MANAGEMENT ── */
const state = {
  espOnline: false,    // Status koneksi nyata dari ESP32
  lastEspUpdate: 0,    // Timestamp (ms) terakhir ESP32 mengirim data
  fanOn: false,        // Status fisik relay kipas (kipasAktif di ESP32)
  lampOn: false,       // Status fisik relay lampu (lampuAktif di ESP32)
  manualFan: false,    // Saklar manual kipas (manualKipasOn di ESP32)
  manualLamp: false,   // Saklar manual lampu (manualLampuOn di ESP32)
  stopOn: false,       // Saklar darurat STOP (sistemStop di ESP32)
  sensorValid: true,
  modeKontrol: 'AUTO',
  statusInkubasi: 'Inisialisasi',
  core: 0.0,
  room: 0.0,
  hum: 0.0,
  tIncubation: 0,
  tHeat: 0,
  tFan: 0,
};

let dbWriteControl = null;
let isUpdatingFromFirebase = false;

/* ── LIVE CLOCK & DATE ── */
function updateClock() {
  const n = new Date();
  const pad = v => String(v).padStart(2, '0');
  
  const clockEl = document.getElementById('live-clock');
  if (clockEl) {
    clockEl.textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
  }
  
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  
  const dateEl = document.getElementById('live-date');
  if (dateEl) {
    dateEl.textContent = `${days[n.getDay()]}, ${n.getDate()} ${months[n.getMonth()]} ${n.getFullYear()}`;
  }
}

function updateFooterTime() {
  const n = new Date();
  const pad = v => String(v).padStart(2, '0');
  const footerTimeEl = document.getElementById('footer-time');
  if (footerTimeEl) {
    footerTimeEl.textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
  }
}

/* ── ESP32 CONNECTION STATUS BADGE ── */
function applyConnectionState() {
  const clockCard = document.getElementById('live-clock')?.closest('.card');
  const badgeCard = clockCard?.previousElementSibling;
  if (!badgeCard) return;

  const pingDot = badgeCard.querySelector('.animate-ping');
  const solidDot = badgeCard.querySelector('.relative.inline-flex');
  const textEl = badgeCard.querySelector('span.text-xs');

  if (state.espOnline) {
    badgeCard.className = 'card flex items-center gap-2 px-3 py-1.5 border border-green-100';
    if (pingDot) pingDot.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75';
    if (solidDot) solidDot.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500';
    if (textEl) {
      textEl.className = 'text-xs font-semibold text-green-700';
      textEl.textContent = 'Online · Connected';
    }
  } else {
    badgeCard.className = 'card flex items-center gap-2 px-3 py-1.5 border border-red-200 bg-red-50/40';
    if (pingDot) pingDot.className = 'animate-ping hidden absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75';
    if (solidDot) solidDot.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500';
    if (textEl) {
      textEl.className = 'text-xs font-semibold text-red-600';
      textEl.textContent = 'Offline · Disconnected';
    }
  }
}

function checkEspWatchdog() {
  const isAlive = state.lastEspUpdate > 0 && (Date.now() - state.lastEspUpdate) <= ESP_TIMEOUT_MS;
  if (isAlive !== state.espOnline) {
    state.espOnline = isAlive;
    applyConnectionState();
  }
}

/* ── TIMER FORMATTER (HH:MM:SS) ── */
function formatTime(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function updateTimerUI() {
  const incEl = document.getElementById('timer-incubation');
  const heatEl = document.getElementById('timer-heat');
  const fanEl = document.getElementById('timer-fan-dur');

  if (incEl) incEl.textContent = formatTime(state.tIncubation);
  if (heatEl) heatEl.textContent = formatTime(state.tHeat);
  if (fanEl) fanEl.textContent = formatTime(state.tFan);

  // 1. Lama Inkubasi: Target 30 jam (30 * 3600 = 108000 detik)
  const TARGET_30_JAM_SEC = 30 * 3600;
  const incPct = Math.min(100, Math.max(0, Math.round((state.tIncubation / TARGET_30_JAM_SEC) * 100)));
  const pctIncEl = document.getElementById('pct-incubation');
  const barIncEl = document.getElementById('bar-incubation');
  if (pctIncEl) pctIncEl.textContent = `${incPct}% Target`;
  if (barIncEl) barIncEl.style.width = `${incPct}%`;

  // 2. Durasi Pemanasan: Tanpa persen, hanya status Aktif
  const isHeatActive = state.lampOn && !state.stopOn;
  const badgeHeatEl = document.getElementById('badge-heat');
  const barHeatEl = document.getElementById('bar-heat');
  if (badgeHeatEl) {
    badgeHeatEl.textContent = 'Aktif';
    badgeHeatEl.className = isHeatActive
      ? 'text-[10px] font-bold text-orange-700 bg-orange-100 px-1.5 py-0.5 rounded transition-colors'
      : 'text-[10px] font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded transition-colors';
  }
  if (barHeatEl) {
    barHeatEl.style.width = isHeatActive ? '100%' : '0%';
  }

  // 3. Durasi Kipas: Tanpa persen, hanya status Aktif
  const isFanActive = state.fanOn && !state.stopOn;
  const badgeFanEl = document.getElementById('badge-fan');
  const barFanEl = document.getElementById('bar-fan');
  if (badgeFanEl) {
    badgeFanEl.textContent = 'Aktif';
    badgeFanEl.className = isFanActive
      ? 'text-[10px] font-bold text-sky-700 bg-sky-100 px-1.5 py-0.5 rounded transition-colors'
      : 'text-[10px] font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded transition-colors';
  }
  if (barFanEl) {
    barFanEl.style.width = isFanActive ? '100%' : '0%';
  }
}

/* ── TIMER TICK (EVERY SECOND) ── */
function startTimers() {
  setInterval(() => {
    checkEspWatchdog();
    if (!state.espOnline || state.stopOn) return;

    state.tIncubation++;
    if (state.lampOn) state.tHeat++;
    if (state.fanOn)  state.tFan++;

    updateTimerUI();
  }, 1000);
}

/* ── SENSOR UI RENDERER ── */
function setGauge(id, pct) {
  const el = document.getElementById(id);
  if (el) {
    const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
    el.style.strokeDashoffset = 314 - (314 * clamped) / 100;
  }
}

function updateSensorUI() {
  // 1. Suhu Inti Tempe
  const cPct = state.sensorValid ? Math.min(100, Math.max(0, Math.round((state.core / 40) * 100))) : 0;
  const valCore = document.getElementById('val-core');
  const pctCore = document.getElementById('pct-core');
  const barCore = document.getElementById('bar-core');
  if (valCore) valCore.textContent = state.sensorValid ? state.core.toFixed(1) : '--.-';
  if (pctCore) pctCore.textContent = `${cPct}%`;
  if (barCore) barCore.style.width = `${cPct}%`;
  setGauge('gauge-core', cPct);

  // 2. Suhu Ruang
  const rPct = state.sensorValid ? Math.min(100, Math.max(0, Math.round((state.room / 42) * 100))) : 0;
  const valRoom = document.getElementById('val-room');
  const pctRoom = document.getElementById('pct-room');
  const barRoom = document.getElementById('bar-room');
  if (valRoom) valRoom.textContent = state.sensorValid ? state.room.toFixed(1) : '--.-';
  if (pctRoom) pctRoom.textContent = `${rPct}%`;
  if (barRoom) barRoom.style.width = `${rPct}%`;
  setGauge('gauge-room', rPct);

  // 3. Kelembapan Ruang
  const hPct = state.sensorValid ? Math.min(100, Math.max(0, Math.round(state.hum))) : 0;
  const valHum = document.getElementById('val-hum');
  const pctHum = document.getElementById('pct-hum');
  const barHum = document.getElementById('bar-hum');
  if (valHum) valHum.textContent = state.sensorValid ? state.hum.toFixed(1) : '--.-';
  if (pctHum) pctHum.textContent = `${hPct}%`;
  if (barHum) barHum.style.width = `${hPct}%`;
  setGauge('gauge-hum', hPct);
}

/* ── TOGGLE HANDLER ── */
function handleToggle(which) {
  if (isUpdatingFromFirebase) return;

  if (which !== 'stop' && state.stopOn) {
    const el = document.getElementById('toggle-' + which);
    if (el) el.checked = false;
    return;
  }

  const fanToggle = document.getElementById('toggle-fan');
  const lampToggle = document.getElementById('toggle-lamp');
  const stopToggle = document.getElementById('toggle-stop');

  if (which === 'fan') {
    state.manualFan = fanToggle ? fanToggle.checked : false;
    // Sesuai logika pengaman ESP32: kipas & lampu tidak boleh ON bersamaan
    if (state.manualFan) {
      state.manualLamp = false;
      if (lampToggle) lampToggle.checked = false;
    }
    state.fanOn = state.manualFan;
    if (state.manualFan) state.lampOn = false;
  }

  if (which === 'lamp') {
    state.manualLamp = lampToggle ? lampToggle.checked : false;
    // Sesuai logika pengaman ESP32: kipas & lampu tidak boleh ON bersamaan
    if (state.manualLamp) {
      state.manualFan = false;
      if (fanToggle) fanToggle.checked = false;
    }
    state.lampOn = state.manualLamp;
    if (state.manualLamp) state.fanOn = false;
  }

  if (which === 'stop') {
    state.stopOn = stopToggle ? stopToggle.checked : false;
    if (state.stopOn) {
      state.manualFan = false;
      state.manualLamp = false;
      state.fanOn = false;
      state.lampOn = false;
      if (fanToggle) fanToggle.checked = false;
      if (lampToggle) lampToggle.checked = false;
    }
  }

  applyStopState();
  applyFanState();
  applyLampState();

  if (typeof dbWriteControl === 'function') {
    dbWriteControl({
      manualFan: state.manualFan,
      manualLamp: state.manualLamp,
      stop: state.stopOn,
    });
  }
}

window.handleToggle = handleToggle;

/* ── APPLY FAN VISUALS ── */
function applyFanState() {
  const on = state.fanOn && !state.stopOn;
  const manualOn = state.manualFan && !state.stopOn;
  
  const lblFan = document.getElementById('lbl-fan');
  if (lblFan) {
    lblFan.textContent = manualOn
      ? 'Aktif — berputar'
      : (on ? 'Otomatis — berputar' : 'Tidak aktif');
  }

  const iconFan = document.getElementById('icon-fan');
  if (iconFan) iconFan.style.background = (manualOn || on) ? '#dcfce7' : '';

  const actFan = document.getElementById('act-fan');
  if (actFan) {
    actFan.style.borderColor = on ? '#86efac' : '';
    actFan.style.background = on ? '#f0fdf4' : '';
  }

  const fanAnim = document.getElementById('fan-anim');
  if (fanAnim) fanAnim.style.background = on ? '#dcfce7' : '';

  const svg = document.getElementById('fan-svg');
  if (svg) {
    svg.setAttribute('stroke', on ? '#16a34a' : '#9ca3af');
    svg.style.animation = on ? 'spin 1.2s linear infinite' : '';
  }

  const ledFan = document.getElementById('led-fan');
  if (ledFan) ledFan.className = 'led ' + (on ? 'on-green' : 'off');

  const lblActFan = document.getElementById('lbl-act-fan');
  if (lblActFan) {
    lblActFan.textContent = on ? 'AKTIF' : 'MATI';
    lblActFan.style.color = on ? '#16a34a' : '#9ca3af';
  }

  const rpmFan = document.getElementById('rpm-fan');
  if (rpmFan) {
    rpmFan.textContent = on ? '1200 RPM' : '0 RPM';
    rpmFan.style.color = on ? '#16a34a' : '#9ca3af';
  }

  updateTimerUI();
}

/* ── APPLY LAMP VISUALS ── */
function applyLampState() {
  const on = state.lampOn && !state.stopOn;
  const manualOn = state.manualLamp && !state.stopOn;

  const lblLamp = document.getElementById('lbl-lamp');
  if (lblLamp) {
    lblLamp.textContent = manualOn
      ? 'Aktif — menyala'
      : (on ? 'Otomatis — menyala' : 'Tidak aktif');
  }

  const iconLamp = document.getElementById('icon-lamp');
  if (iconLamp) iconLamp.style.background = (manualOn || on) ? '#fef3c7' : '';

  const actLamp = document.getElementById('act-lamp');
  if (actLamp) {
    actLamp.style.borderColor = on ? '#fcd34d' : '';
    actLamp.style.background = on ? '#fffbeb' : '';
  }

  const lampAnim = document.getElementById('lamp-anim');
  if (lampAnim) {
    lampAnim.style.background = on ? '#fef3c7' : '';
    lampAnim.style.boxShadow = on ? '0 0 16px rgba(251, 191, 36, 0.6)' : '';
  }

  const lampSvg = document.getElementById('lamp-svg');
  if (lampSvg) lampSvg.setAttribute('stroke', on ? '#f59e0b' : '#9ca3af');

  const ledLamp = document.getElementById('led-lamp');
  if (ledLamp) ledLamp.className = 'led ' + (on ? 'on-amber' : 'off');

  const lblActLamp = document.getElementById('lbl-act-lamp');
  if (lblActLamp) {
    lblActLamp.textContent = on ? 'AKTIF' : 'MATI';
    lblActLamp.style.color = on ? '#d97706' : '#9ca3af';
  }

  const wattLamp = document.getElementById('watt-lamp');
  if (wattLamp) {
    wattLamp.textContent = on ? '60 W' : '0 W';
    wattLamp.style.color = on ? '#d97706' : '#9ca3af';
  }

  updateTimerUI();
}

/* ── APPLY EMERGENCY STOP ── */
function applyStopState() {
  const on = state.stopOn;
  const lblStop = document.getElementById('lbl-stop');
  if (lblStop) {
    lblStop.textContent = on ? '⚠ SISTEM DIHENTIKAN PAKSA' : 'Sistem berjalan normal';
  }

  const banner = document.getElementById('emergency-banner');
  if (banner) {
    banner.classList.toggle('hidden', !on);
  }

  applyFanState();
  applyLampState();
}

/* ── FIREBASE REALTIME DATABASE INTEGRATION ── */
async function initFirebase() {
  try {
    const [{ initializeApp }, { getDatabase, ref, onValue, update }, { getAuth, signInAnonymously }] =
      await Promise.all([
        import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/13.1.0/firebase-database.js'),
        import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js'),
      ]);

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getDatabase(app);

    // Login Anonymous Auth agar sesuai dengan Security Rules (auth != null)
    try {
      await signInAnonymously(auth);
    } catch (authErr) {
      console.warn('[Firebase Auth] Pastikan Anonymous Sign-In aktif di Firebase Console:', authErr.message);
    }

    const inkubatorRef = ref(db, DB_PATH);
    const controlRef = ref(db, `${DB_PATH}/control`);

    dbWriteControl = (controlPayload) => {
      update(controlRef, controlPayload).catch((err) => {
        console.error('[Firebase Write Error]', err);
      });
    };

    onValue(
      inkubatorRef,
      (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        isUpdatingFromFirebase = true;

        // 1. Data Sensor (DS18B20 & DHT22)
        if (data.sensor) {
          state.sensorValid = data.sensor.valid !== false;
          if (typeof data.sensor.core === 'number' && !Number.isNaN(data.sensor.core)) {
            state.core = data.sensor.core;
          }
          if (typeof data.sensor.room === 'number' && !Number.isNaN(data.sensor.room)) {
            state.room = data.sensor.room;
          }
          if (typeof data.sensor.hum === 'number' && !Number.isNaN(data.sensor.hum)) {
            state.hum = data.sensor.hum;
          }
          updateSensorUI();
        }

        // 2. Kontrol Manual (Saklar Override)
        if (data.control) {
          state.manualFan = Boolean(data.control.manualFan);
          state.manualLamp = Boolean(data.control.manualLamp);
          state.stopOn = Boolean(data.control.stop);

          const fanToggle = document.getElementById('toggle-fan');
          const lampToggle = document.getElementById('toggle-lamp');
          const stopToggle = document.getElementById('toggle-stop');

          if (fanToggle) fanToggle.checked = state.manualFan;
          if (lampToggle) lampToggle.checked = state.manualLamp;
          if (stopToggle) stopToggle.checked = state.stopOn;
        }

        // 3. Status Aktuator Fisik (Relay Kipas & Lampu)
        if (state.stopOn) {
          state.fanOn = false;
          state.lampOn = false;
        } else if (state.manualFan) {
          state.fanOn = true;
          state.lampOn = false;
        } else if (state.manualLamp) {
          state.fanOn = false;
          state.lampOn = true;
        } else if (data.actuator) {
          state.fanOn = Boolean(data.actuator.fanOn);
          state.lampOn = Boolean(data.actuator.lampOn);
        }

        // 4. Durasi & Waktu Inkubasi
        if (data.timers) {
          if (typeof data.timers.tIncubation === 'number') {
            state.tIncubation = data.timers.tIncubation;
          }
          if (typeof data.timers.tHeat === 'number') {
            state.tHeat = data.timers.tHeat;
          }
          if (typeof data.timers.tFan === 'number') {
            state.tFan = data.timers.tFan;
          }
          updateTimerUI();
        }

        // 5. Status, Mode Kontrol & Heartbeat ESP32
        if (data.status) {
          if (data.status.mode) state.modeKontrol = data.status.mode;
          if (data.status.info) state.statusInkubasi = data.status.info;
          if (typeof data.status.updatedAt === 'number') {
            state.lastEspUpdate = data.status.updatedAt;
          }
        }

        checkEspWatchdog();
        applyStopState();
        applyFanState();
        applyLampState();
        if (state.espOnline) {
          updateFooterTime();
        }

        isUpdatingFromFirebase = false;
      },
      (error) => {
        console.error('[Firebase Read Error]', error);
      }
    );
  } catch (err) {
    console.error('[Firebase Init Error]', err);
  }
}

/* ── INITIALIZATION ── */
document.addEventListener('DOMContentLoaded', () => {
  updateClock();
  applyConnectionState();
  setInterval(updateClock, 1000);
  startTimers();
  initFirebase();
});
