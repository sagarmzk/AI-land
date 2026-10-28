'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const api = window.ai || {};

const island = $('#island');
const ringWrap = $('.ring-wrap');
const ringFill = $('#ringFill');
const cover = $('#cover');
const coverImg = $('#coverImg');

const TIMER_CIRC = 2 * Math.PI * 52;
const GIB = 1024 ** 3;
const VIEWS = ['player', 'shelf', 'timer', 'system'];

const state = {
  expanded: false,
  suppressExpand: false,
  draggingOut: false,
  editing: false,
  updateOpen: false,
  meeting: null,
  view: 'player',
  media: { active: false },
  baseAt: performance.now(),
  shelf: [],
  stats: null,
  cpuHistory: [],
  calendar: null,
  update: {
    status: 'disabled',
    currentVersion: '',
    version: null,
    notes: '',
    size: 0,
    sizeLabel: '',
    publishedAt: '',
    progress: 0,
    error: null
  },
  timer: {
    duration: 15 * 60000,
    remaining: 15 * 60000,
    endsAt: 0,
    running: false,
    done: false,
    preset: 15
  },
  capture: new URLSearchParams(location.search).has('capture')
};

let demoFiles = null;
let collapseTimer = null;
let hitboxRaf = null;
let hitboxUntil = 0;
let lastHitboxSent = null;
let lastMediaKey = '';

/* ---------------- window / hitbox ---------------- */

function syncHitbox() {
  if (!api.setHitbox) return;
  const rect = island.getBoundingClientRect();
  const next = {
    x: Math.round(window.screenX + rect.left - 10),
    y: Math.round(window.screenY + rect.top - 6),
    w: Math.round(rect.width + 20),
    h: Math.round(rect.height + 12)
  };
  if (
    lastHitboxSent &&
    next.x === lastHitboxSent.x &&
    next.y === lastHitboxSent.y &&
    next.w === lastHitboxSent.w &&
    next.h === lastHitboxSent.h
  ) {
    return;
  }
  lastHitboxSent = next;
  api.setHitbox(next);
}

function hitboxLoop() {
  hitboxRaf = requestAnimationFrame(() => {
    syncHitbox();
    if (performance.now() < hitboxUntil) hitboxLoop();
    else hitboxRaf = null;
  });
}

function trackHitbox(ms = 900) {
  hitboxUntil = performance.now() + ms;
  if (!hitboxRaf) hitboxLoop();
}

function expand() {
  if (state.expanded) return;
  state.expanded = true;
  island.classList.add('expanded');
  trackHitbox(950);
}

function collapse(force = false) {
  if (state.editing || state.updateOpen) return;
  if (!state.expanded) return;
  state.expanded = false;
  island.classList.remove('expanded', 'drop-active');
  trackHitbox(950);
  if (force) state.suppressExpand = true;
}

/* ---------------- formatting ---------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad(num) {
  return String(num).padStart(2, '0');
}

function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtTimer(ms) {
  return fmtTime(Math.ceil(Math.max(0, ms) / 1000));
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
}

function fmtRate(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value < 1024) return `${Math.round(value)} Б/с`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} КБ/с`;
  return `${(value / 1024 ** 2).toFixed(1)} МБ/с`;
}

function fmtUptime(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function fmtClockTime(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function prettyApp(appId) {
  const id = String(appId || '').toLowerCase();
  if (!id) return '';
  if (id.includes('spotify')) return 'Spotify';
  if (id.includes('chrome')) return 'Chrome';
  if (id.includes('msedge')) return 'Edge';
  if (id.includes('firefox')) return 'Firefox';
  if (id.includes('yandex')) return 'Яндекс Музыка';
  if (id.includes('vlc')) return 'VLC';
  if (id.includes('foobar')) return 'foobar2000';
  if (id.includes('aimp')) return 'AIMP';
  if (id.includes('zune') || id.includes('mediaplayer') || id.includes('music')) return 'Media Player';
  return '';
}

/* ---------------- clock ---------------- */

function tickClock() {
  $('#clock').textContent = fmtClockTime(new Date());
}

/* ---------------- views ---------------- */

function setView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  const index = VIEWS.indexOf(view);
  $('#tabGlider').style.setProperty('--i', index);
  $$('.tab').forEach((tab) => {
    const active = tab.dataset.tab === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $$('.view').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.view === view);
  });
  island.dataset.view = view;
  if (view === 'timer' && api.requestCalendar) api.requestCalendar();
  if (view === 'system' && state.stats) renderStats();
}

/* ---------------- media ---------------- */

function currentPosition() {
  const media = state.media;
  if (!media || !media.active) return 0;
  const base = Number(media.position) || 0;
  const duration = Number(media.duration) || 0;
  if (media.status !== 'playing') return base;
  const position = base + (performance.now() - state.baseAt) / 1000;
  return duration > 0 ? Math.min(position, duration) : position;
}

function updatePlayIcon() {
  const playing = !!state.media.active && state.media.status === 'playing';
  $('.ic-play').classList.toggle('is-hidden', playing);
  $('.ic-pause').classList.toggle('is-hidden', !playing);
  $('#playBtn').setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
}

function updateProgress() {
  const media = state.media;
  const duration = Number(media.duration) || 0;
  const position = currentPosition();
  const fraction = duration > 0 ? clamp(position / duration, 0, 1) : 0;
  $('#progressFill').style.width = `${fraction * 100}%`;
  $('#progressKnob').style.left = `${fraction * 100}%`;
  $('#timeNow').textContent = fmtTime(position);
  $('#timeTotal').textContent = fmtTime(duration);
}

function applyMedia(media) {
  if (!media) return;
  state.media = media;
  state.baseAt = performance.now();
  const active = !!media.active;
  const playing = active && media.status === 'playing';

  const key = [active, media.title, media.artist, media.album, media.app, media.status].join('|');
  if (key === lastMediaKey) {
    if (state.expanded && state.view === 'player') updateProgress();
    return;
  }
  lastMediaKey = key;

  island.classList.toggle('is-playing', playing);
  island.classList.toggle('has-media', active);

  if (!active) {
    $('#trackTitle').textContent = 'Ничего не играет';
    $('#trackArtist').textContent = 'Включите музыку — трек появится здесь';
    $('#trackMeta').textContent = 'SMTC · SYSTEM MEDIA';
    cover.classList.remove('has-art', 'has-badge');
    coverImg.removeAttribute('src');
    $('#sourceBadge').textContent = '';
    updatePlayIcon();
    updateProgress();
    renderStatus();
    return;
  }

  $('#trackTitle').textContent = media.title || 'Без названия';
  $('#trackArtist').textContent = media.artist || 'Неизвестный исполнитель';

  const appName = prettyApp(media.app);
  $('#trackMeta').textContent = media.album || (appName ? `${appName} · Windows` : 'Windows Media');
  $('#sourceBadge').textContent = appName || 'Плеер';
  cover.classList.toggle('has-badge', true);

  updatePlayIcon();
  updateProgress();
  renderStatus();
}

function applyArt(art) {
  if (!art || !art.dataUrl) {
    cover.classList.remove('has-art');
    coverImg.removeAttribute('src');
    return;
  }
  coverImg.src = art.dataUrl;
  cover.classList.add('has-art');
}

function togglePlay() {
  const media = state.media;
  if (!media.active) return;
  const wasPlaying = media.status === 'playing';
  media.position = currentPosition();
  media.status = wasPlaying ? 'paused' : 'playing';
  state.baseAt = performance.now();
  api.mediaControl && api.mediaControl('toggle');
  updatePlayIcon();
  island.classList.toggle('is-playing', !wasPlaying);
  updateProgress();
  renderStatus();
}

function seekFromEvent(event) {
  const media = state.media;
  if (!media.active) return;
  const duration = Number(media.duration) || 0;
  if (duration <= 0) return;
  const rect = $('#progress').getBoundingClientRect();
  const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const target = fraction * duration;
  media.position = target;
  state.baseAt = performance.now();
  api.mediaControl && api.mediaControl(`seek:${target.toFixed(1)}`);
  updateProgress();
}

/* ---------------- updates ---------------- */

function fmtUpdateDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function updateChipLabel(update) {
  if (update.status === 'downloading') return `${update.progress || 0}%`;
  if (update.status === 'installing') return 'Установка…';
  if (update.status === 'ready') return `Установить ${update.version}`;
  if (update.status === 'error') return 'Ошибка обновления';
  return `Обновить ${update.version}`;
}

function renderUpdate() {
  const update = state.update;
  const chip = $('#updateChip');
  const noticeable = ['available', 'downloading', 'ready', 'installing', 'error'].includes(update.status);
  chip.hidden = !(noticeable && update.version);
  if (!chip.hidden) {
    $('#updateChipText').textContent = updateChipLabel(update);
    chip.title =
      update.status === 'ready'
        ? `Обновление ${update.version} загружено`
        : update.status === 'error'
          ? update.error || 'Ошибка обновления'
          : `Доступно обновление ${update.version}`;
  }

  renderStatus();
  if (!state.updateOpen) return;

  const version = update.version || '';
  $('#updateVersion').textContent = version
    ? `Версия ${version} · сейчас ${update.currentVersion}`
    : update.currentVersion
      ? `Установлена ${update.currentVersion}`
      : '—';

  const notes = $('#updateNotes');
  notes.textContent = update.notes || '';

  const wrap = $('#updateProgressWrap');
  const fill = $('#updateProgressFill');
  const showProgress = update.status === 'downloading' || update.status === 'installing';
  wrap.hidden = !showProgress;
  fill.style.width = `${update.progress || 0}%`;

  const action = $('#updateAction');
  const later = $('#updateLater');
  const meta = $('#updateMeta');
  action.disabled = false;
  later.hidden = false;
  later.textContent = 'Позже';

  switch (update.status) {
    case 'checking':
      meta.textContent = 'Проверяем GitHub…';
      action.textContent = 'Проверка…';
      action.disabled = true;
      later.textContent = 'Закрыть';
      break;
    case 'available': {
      const parts = [];
      if (update.sizeLabel) parts.push(update.sizeLabel);
      const date = fmtUpdateDate(update.publishedAt);
      if (date) parts.push(`от ${date}`);
      meta.textContent = parts.join(' · ') || 'Новая версия готова к загрузке.';
      action.textContent = 'Скачать обновление';
      break;
    }
    case 'downloading':
      meta.textContent = `Загрузка · ${update.progress || 0}%`;
      action.textContent = 'Скачивание…';
      action.disabled = true;
      later.textContent = 'Скрыть';
      break;
    case 'ready':
      meta.textContent = 'Загружено. Приложение перезапустится и установит обновление.';
      action.textContent = 'Перезапустить и установить';
      break;
    case 'installing':
      meta.textContent = update.progress >= 100 ? 'Устанавливаем обновление…' : 'Подготовка…';
      action.textContent = 'Установка…';
      action.disabled = true;
      later.hidden = true;
      break;
    case 'current':
      meta.textContent = `Установлена последняя версия ${update.currentVersion}.`;
      action.textContent = 'Проверить снова';
      later.textContent = 'Закрыть';
      break;
    case 'error':
      meta.textContent = update.error || 'Не удалось получить обновление.';
      action.textContent = update.version ? 'Повторить' : 'Проверить снова';
      later.textContent = 'Закрыть';
      break;
    case 'disabled':
      meta.textContent = 'Автообновление не настроено в этой сборке.';
      action.textContent = 'Закрыть';
      break;
    default:
      meta.textContent = 'Проверка ещё не выполнялась.';
      action.textContent = 'Проверить обновления';
  }
}

function applyUpdate(update) {
  if (!update || typeof update !== 'object') return;
  state.update = { ...state.update, ...update };
  renderUpdate();
}

function openUpdatePanel() {
  state.updateOpen = true;
  expand();
  $('#updateEditor').hidden = false;
  renderUpdate();
  trackHitbox(1500);
}

function closeUpdatePanel() {
  state.updateOpen = false;
  $('#updateEditor').hidden = true;
  renderStatus();
  trackHitbox(600);
}

function runUpdateAction() {
  const status = state.update.status;
  if (status === 'available') {
    if (api.updateDownload) api.updateDownload();
    return;
  }
  if (status === 'ready') {
    if (api.updateInstall) api.updateInstall();
    return;
  }
  if (status === 'disabled') {
    closeUpdatePanel();
    return;
  }
  if (status === 'checking' || status === 'downloading' || status === 'installing') return;
  if (status === 'error' && state.update.version) {
    if (api.updateDownload) api.updateDownload();
    return;
  }
  if (api.updateCheck) api.updateCheck();
}

/* ---------------- status line ---------------- */

function timerRemaining() {
  const timer = state.timer;
  if (timer.running) return Math.max(0, timer.endsAt - Date.now());
  return Math.max(0, timer.remaining);
}

function renderStatus() {
  const el = $('#statusText');
  const timer = state.timer;
  if (timer.running) {
    el.textContent = `Фокус · ${fmtTimer(timerRemaining())}`;
    return;
  }
  if (timer.done) {
    el.textContent = 'Таймер завершён';
    return;
  }
  const media = state.media;
  if (media.active) {
    const title = media.title || 'Без названия';
    el.textContent = media.status === 'playing' ? title : `Пауза · ${title}`;
    return;
  }
  if (state.update.status === 'available' || state.update.status === 'ready') {
    el.textContent = state.update.status === 'ready' ? 'Обновление загружено' : `Обновление ${state.update.version}`;
    return;
  }
  el.textContent = 'Готов к работе';
}

/* ---------------- timer ---------------- */

function presetFor(duration) {
  const minutes = Math.round(duration / 60000);
  return [5, 15, 25, 45].includes(minutes) ? minutes : 15;
}

function renderTimer() {
  const timer = state.timer;
  const remaining = timerRemaining();
  const total = timer.duration > 0 ? timer.duration : 1;
  const fraction = clamp(remaining / total, 0, 1);

  ringFill.style.strokeDashoffset = String(TIMER_CIRC * (1 - fraction));
  ringFill.style.strokeDasharray = String(TIMER_CIRC);

  const text = $('#timerText');
  text.textContent = fmtTimer(remaining);
  text.classList.toggle('is-long', remaining >= 3600000);

  let hint = 'выберите время';
  if (timer.done) hint = 'готово';
  else if (timer.running) hint = 'в работе';
  else if (remaining < timer.duration && remaining > 0) hint = 'на паузе';
  $('#timerHint').textContent = hint;

  const toggle = $('#timerToggle');
  if (timer.running) toggle.textContent = 'Пауза';
  else if (timer.done) toggle.textContent = 'Ещё раз';
  else if (remaining < timer.duration && remaining > 0) toggle.textContent = 'Продолжить';
  else toggle.textContent = 'Старт';

  ringWrap.classList.toggle('is-done', timer.done);

  $$('#presets button').forEach((button) => {
    button.classList.toggle('is-active', Number(button.dataset.min) === timer.preset);
  });

  renderStatus();
}

function saveTimer() {
  const timer = state.timer;
  if (!api.timerSave) return;
  api.timerSave({
    duration: timer.duration,
    remaining: timerRemaining(),
    endsAt: timer.endsAt,
    running: timer.running,
    done: timer.done,
    preset: timer.preset
  });
}

function startTimer() {
  const timer = state.timer;
  if (!timer.duration) return;
  let remaining = timer.done ? timer.duration : timerRemaining();
  if (!remaining || remaining <= 0) remaining = timer.duration;
  timer.remaining = remaining;
  timer.endsAt = Date.now() + remaining;
  timer.running = true;
  timer.done = false;
  saveTimer();
  renderTimer();
}

function pauseTimer() {
  const timer = state.timer;
  timer.remaining = timerRemaining();
  timer.endsAt = 0;
  timer.running = false;
  saveTimer();
  renderTimer();
}

function resetTimer() {
  const timer = state.timer;
  timer.running = false;
  timer.done = false;
  timer.endsAt = 0;
  timer.remaining = timer.duration;
  saveTimer();
  renderTimer();
}

function finishTimer() {
  const timer = state.timer;
  timer.running = false;
  timer.endsAt = 0;
  timer.remaining = 0;
  timer.done = true;
  api.timerClear && api.timerClear();
  api.timerDone && api.timerDone('Фокус');
  renderTimer();
}

function selectPreset(minutes) {
  const timer = state.timer;
  timer.preset = minutes;
  timer.duration = minutes * 60000;
  timer.remaining = timer.duration;
  timer.endsAt = 0;
  timer.running = false;
  timer.done = false;
  saveTimer();
  renderTimer();
}

function timerTick() {
  const timer = state.timer;
  if (!timer.running) return;
  const remaining = timer.endsAt - Date.now();
  if (remaining <= 0) {
    finishTimer();
    return;
  }
  timer.remaining = remaining;
  renderTimer();
}

async function restoreTimer() {
  if (!api.timerGet) {
    renderTimer();
    return;
  }
  try {
    const saved = await api.timerGet();
    if (saved && typeof saved === 'object') {
      const timer = state.timer;
      if (Number(saved.duration) > 0) timer.duration = Number(saved.duration);
      if (Number(saved.preset) > 0) timer.preset = Number(saved.preset);
      if (saved.running && Number(saved.endsAt) > Date.now()) {
        timer.running = true;
        timer.endsAt = Number(saved.endsAt);
      } else if (saved.running) {
        timer.running = false;
        timer.done = true;
        timer.remaining = 0;
      } else {
        timer.running = false;
        timer.done = !!saved.done;
        timer.remaining = timer.done ? 0 : clamp(Number(saved.remaining) || timer.duration, 0, timer.duration);
      }
      timer.preset = presetFor(timer.duration);
    }
  } catch {
    /* no saved timer */
  }
  renderTimer();
}

/* ---------------- calendar ---------------- */

function dayLabel(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function upcomingManual() {
  const meeting = state.meeting;
  if (!meeting) return null;
  const start = new Date(meeting.start);
  if (Number.isNaN(start.getTime())) return null;
  const duration = Math.max(5, Number(meeting.duration) || 30);
  const end = new Date(start.getTime() + duration * 60000);
  if (end.getTime() <= Date.now()) return null;
  return { subject: meeting.subject, start, end, location: '', allDay: false, manual: true };
}

function renderMeeting() {
  const wrap = $('#meeting');
  const title = $('#meetingTitle');
  const meta = $('#meetingMeta');
  const calendar = state.calendar;
  const candidates = [];

  if (calendar && calendar.available !== false && !calendar.none && calendar.subject) {
    const start = new Date(calendar.start);
    const end = new Date(calendar.end);
    if (!Number.isNaN(start.getTime())) {
      candidates.push({
        subject: calendar.subject,
        start,
        end: Number.isNaN(end.getTime()) ? null : end,
        location: calendar.location || '',
        allDay: !!calendar.allDay,
        manual: false
      });
    }
  }

  const manual = upcomingManual();
  if (manual) candidates.push(manual);
  candidates.sort((a, b) => a.start - b.start);
  const next = candidates[0];

  if (next) {
    wrap.classList.remove('is-off');
    title.textContent = next.subject;
    if (next.allDay) {
      meta.textContent = `${dayLabel(next.start)} · весь день`;
    } else {
      const range = next.end
        ? `${fmtClockTime(next.start)}–${fmtClockTime(next.end)}`
        : fmtClockTime(next.start);
      const place = next.location ? ` · ${next.location}` : '';
      meta.textContent = `${dayLabel(next.start)} · ${range}${place}${next.manual ? ' · вручную' : ''}`;
    }
    return;
  }

  wrap.classList.add('is-off');
  if (!calendar) {
    title.textContent = 'Календарь не загружен';
    meta.textContent = 'Добавьте встречу вручную';
  } else if (calendar.available === false) {
    title.textContent = 'Outlook не найден';
    meta.textContent = 'Встречи можно добавить вручную';
  } else {
    title.textContent = 'Встреч впереди нет';
    meta.textContent = 'Добавьте встречу вручную';
  }
}

function renderCalendar(calendar) {
  state.calendar = calendar;
  renderMeeting();
}

function toLocalInput(date) {
  const pad2 = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`;
}

function openMeetingEditor() {
  state.editing = true;
  const start = new Date(Date.now() + 15 * 60000);
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);
  $('#meetingStart').value = toLocalInput(start);
  $('#meetingSubject').value = state.meeting ? state.meeting.subject : '';
  $('#meetingDuration').value = state.meeting ? String(state.meeting.duration || 30) : '30';
  $('#meetingSubject').classList.remove('is-invalid');
  $('#meetingStart').classList.remove('is-invalid');
  $('#meetingEditor').hidden = false;
  expand();
  setTimeout(() => $('#meetingSubject').focus(), 40);
}

function closeMeetingEditor() {
  state.editing = false;
  $('#meetingEditor').hidden = true;
  renderMeeting();
}

function saveMeetingEditor() {
  const subject = $('#meetingSubject').value.trim();
  const startValue = $('#meetingStart').value;
  const duration = Number($('#meetingDuration').value) || 30;
  const start = new Date(startValue);
  const subjectInvalid = !subject;
  const startInvalid = !startValue || Number.isNaN(start.getTime());
  $('#meetingSubject').classList.toggle('is-invalid', subjectInvalid);
  $('#meetingStart').classList.toggle('is-invalid', startInvalid);
  if (subjectInvalid || startInvalid) return;

  const payload = { subject, start: start.toISOString(), duration };
  if (api.meetingSave) {
    api
      .meetingSave(payload)
      .then((saved) => {
        state.meeting = saved || payload;
        closeMeetingEditor();
      })
      .catch(() => {});
  } else {
    state.meeting = payload;
    closeMeetingEditor();
  }
}

/* ---------------- system ---------------- */

function renderSpark() {
  const history = state.cpuHistory;
  const spark = $('#cpuSpark');
  if (!spark) return;
  if (history.length < 2) {
    spark.setAttribute('points', '0,27 120,27');
    return;
  }
  const step = 120 / (history.length - 1);
  const points = history.map((value, index) => {
    const x = (index * step).toFixed(1);
    const y = (27 - (clamp(value, 0, 100) / 100) * 25).toFixed(1);
    return `${x},${y}`;
  });
  spark.setAttribute('points', points.join(' '));
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;

  const cpu = clamp(Number(stats.cpu) || 0, 0, 100);
  $('#cpuValue').textContent = `${Math.round(cpu)}%`;
  renderSpark();

  const memUsed = Number(stats.memUsed) || 0;
  const memTotal = Number(stats.memTotal) || 1;
  $('#memValue').textContent = `${(memUsed / GIB).toFixed(1)} ГБ`;
  $('#memBar').style.width = `${clamp((memUsed / memTotal) * 100, 0, 100)}%`;
  $('#memFoot').textContent = `${(memUsed / GIB).toFixed(1)} из ${(memTotal / GIB).toFixed(1)} ГБ`;

  const rx = Number(stats.rxBps) || 0;
  const tx = Number(stats.txBps) || 0;
  $('#netValue').textContent = fmtRate(rx + tx);
  $('#rxValue').textContent = fmtRate(rx);
  $('#txValue').textContent = fmtRate(tx);

  const diskFree = Number(stats.diskFree) || 0;
  const diskTotal = Number(stats.diskTotal) || 0;
  $('#diskValue').textContent = diskTotal ? `${(diskFree / GIB).toFixed(0)} ГБ` : '—';
  $('#diskBar').style.width = diskTotal ? `${clamp(((diskTotal - diskFree) / diskTotal) * 100, 0, 100)}%` : '0%';
  $('#uptimeValue').textContent = stats.uptime ? `Аптайм ${fmtUptime(stats.uptime)}` : '—';

  const battery = stats.battery;
  const hasBattery =
    stats.hasBattery && typeof battery === 'number' && battery >= 0 && battery <= 100;
  if (hasBattery) {
    const fill = $('#batteryFill');
    fill.style.width = `${battery}%`;
    fill.style.background = battery <= 20 ? '#ffffff' : 'rgba(255,255,255,0.55)';
    $('#batteryText').textContent = `Батарея ${Math.round(battery)}%${stats.charging ? ' · зарядка' : ''}`;
  } else {
    $('#batteryFill').style.width = '0%';
    $('#batteryText').textContent = 'Питание от сети · батареи нет';
  }
}

function applyStats(stats) {
  if (!stats) return;
  state.stats = stats;

  const cpu = clamp(Number(stats.cpu) || 0, 0, 100);
  state.cpuHistory.push(cpu);
  if (state.cpuHistory.length > 40) state.cpuHistory.shift();

  if (!state.expanded || state.view !== 'system') return;
  renderStats();
}

/* ---------------- shelf ---------------- */

function pluralFiles(count) {
  if (count === 0) return 'Пусто';
  if (count === 1) return '1 файл';
  if (count >= 2 && count <= 4) return `${count} файла`;
  return `${count} файлов`;
}

function renderShelf(files) {
  const list = Array.isArray(files) ? files : [];
  state.shelf = list;
  $('#shelfCount').textContent = pluralFiles(list.length);
  $('#shelfClearBtn').disabled = list.length === 0;

  const container = $('#shelf');
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `
      <div class="shelf-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" />
          <path d="m3 7.5 9 4.5 9-4.5" />
          <path d="M12 12v9" />
        </svg>
        <span>Полка пуста</span>
        <small>Перетащите файлы или нажмите, чтобы выбрать</small>
      </div>`;
    const empty = container.querySelector('.shelf-empty');
    if (empty) empty.addEventListener('click', pickFiles);
    return;
  }

  for (const file of list) {
    const el = document.createElement('div');
    el.className = `file${file.exists === false ? ' is-missing' : ''}`;
    el.draggable = true;
    el.title = file.path || file.name || '';
    el.innerHTML = `
      <div class="file-icon">${escapeHtml(file.ext || 'FILE')}</div>
      <div class="file-body">
        <div class="file-name">${escapeHtml(file.name || 'Файл')}</div>
        <div class="file-size">${file.exists === false ? 'файл перемещён' : fmtBytes(file.size)}</div>
      </div>
      <button class="file-x" type="button" title="Убрать с полки">×</button>`;

    el.addEventListener('click', (event) => {
      if (event.target.closest('.file-x')) return;
      if (file.path && api.shelfOpen) api.shelfOpen(file.id);
    });

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (file.path && api.shelfReveal) api.shelfReveal(file.id);
    });

    el.querySelector('.file-x').addEventListener('click', (event) => {
      event.stopPropagation();
      removeShelfFile(file.id);
    });

    el.addEventListener('dragstart', (event) => {
      event.preventDefault();
      if (!file.path || !api.shelfDrag) return;
      state.draggingOut = true;
      api.shelfDrag(file.id);
      setTimeout(() => {
        state.draggingOut = false;
      }, 1500);
    });

    container.appendChild(el);
  }

  const addTile = document.createElement('button');
  addTile.type = 'button';
  addTile.className = 'file-add';
  addTile.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
    <span>Добавить файлы</span>`;
  addTile.addEventListener('click', pickFiles);
  container.appendChild(addTile);
}

function pickFiles() {
  if (!api.shelfPick) return;
  api
    .shelfPick()
    .then((updated) => {
      if (!Array.isArray(updated)) return;
      demoFiles = null;
      renderShelf(updated);
      setView('shelf');
    })
    .catch(() => {});
}

function removeShelfFile(id) {
  if (demoFiles) {
    demoFiles = demoFiles.filter((file) => file.id !== id);
    renderShelf(demoFiles);
    return;
  }
  if (!api.shelfRemove) return;
  api.shelfRemove(id).then(renderShelf).catch(() => {});
}

function clearShelf() {
  if (demoFiles) {
    demoFiles = [];
    renderShelf(demoFiles);
    return;
  }
  if (!api.shelfClear) return;
  api.shelfClear().then(renderShelf).catch(() => {});
}

function handleDrop(event) {
  event.preventDefault();
  island.classList.remove('drop-active');
  const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
  if (!files.length || !api.shelfAdd || !api.getPathForFile) return;
  const paths = files.map((file) => api.getPathForFile(file)).filter(Boolean);
  if (!paths.length) return;
  demoFiles = null;
  api
    .shelfAdd(paths)
    .then((updated) => {
      renderShelf(updated);
      setView('shelf');
      expand();
    })
    .catch(() => {});
}

/* ---------------- events ---------------- */

function bindEvents() {
  island.addEventListener('mouseenter', () => {
    clearTimeout(collapseTimer);
    if (!state.suppressExpand) expand();
  });

  island.addEventListener('mouseleave', () => {
    state.suppressExpand = false;
    if (state.draggingOut || state.editing || state.updateOpen) return;
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      if (!state.draggingOut && !state.editing && !state.updateOpen) collapse();
    }, 420);
  });

  $('#collapseBtn').addEventListener('click', () => {
    if (state.editing) closeMeetingEditor();
    if (state.updateOpen) closeUpdatePanel();
    collapse(true);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.updateOpen) {
        closeUpdatePanel();
        return;
      }
      if (state.editing) {
        closeMeetingEditor();
        return;
      }
      collapse(true);
    }
    if (event.key === ' ' && document.activeElement === $('#progress')) {
      event.preventDefault();
      togglePlay();
    }
    if (event.key === 'ArrowRight' && document.activeElement === $('#progress')) {
      const media = state.media;
      if (media.active && media.duration > 0) {
        api.mediaControl &&
          api.mediaControl(`seek:${clamp(currentPosition() + 5, 0, media.duration).toFixed(1)}`);
        media.position = clamp(currentPosition() + 5, 0, media.duration);
        state.baseAt = performance.now();
        updateProgress();
      }
    }
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      setView(tab.dataset.tab);
      expand();
    });
  });

  $('#playBtn').addEventListener('click', togglePlay);
  $('#prevBtn').addEventListener('click', () => api.mediaControl && api.mediaControl('previous'));
  $('#nextBtn').addEventListener('click', () => api.mediaControl && api.mediaControl('next'));
  $('#progress').addEventListener('click', seekFromEvent);

  $('#presets').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-min]');
    if (button) selectPreset(Number(button.dataset.min));
  });

  $('#timerToggle').addEventListener('click', () => {
    if (state.timer.running) pauseTimer();
    else startTimer();
  });
  $('#timerReset').addEventListener('click', resetTimer);

  $('#shelfClearBtn').addEventListener('click', clearShelf);

  const openMeeting = () => openMeetingEditor();
  $('#meeting').addEventListener('click', openMeeting);
  $('#meeting').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMeeting();
    }
  });
  $('#meetingAdd').addEventListener('click', (event) => {
    event.stopPropagation();
    openMeeting();
  });
  $('#meetingSave').addEventListener('click', saveMeetingEditor);
  $('#meetingCancel').addEventListener('click', closeMeetingEditor);

  $('#updateChip').addEventListener('click', openUpdatePanel);
  $('#updateClose').addEventListener('click', closeUpdatePanel);
  $('#updateLater').addEventListener('click', closeUpdatePanel);
  $('#updateAction').addEventListener('click', runUpdateAction);

  island.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    island.classList.add('drop-active');
    expand();
  });

  island.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget || !island.contains(event.relatedTarget)) {
      island.classList.remove('drop-active');
    }
  });

  island.addEventListener('drop', handleDrop);
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());

  new ResizeObserver(() => {
    syncHitbox();
    trackHitbox(260);
  }).observe(island);
}

/* ---------------- capture / demo ---------------- */

const DEMO_COVER = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192">',
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
  '<stop stop-color="#e8e8e5"/><stop offset="1" stop-color="#2a2a2a"/>',
  '</linearGradient></defs>',
  '<rect width="192" height="192" fill="url(#g)"/>',
  '<circle cx="58" cy="66" r="48" fill="rgba(255,255,255,0.18)"/>',
  '<circle cx="146" cy="138" r="74" fill="rgba(0,0,0,0.35)"/>',
  '</svg>'
].join('');

function seedMedia() {
  if (state.media.active) return;
  applyMedia({
    active: true,
    title: 'Midnight City',
    artist: 'M83',
    album: 'Hurry Up, We’re Dreaming',
    status: 'playing',
    position: 84,
    duration: 244,
    app: 'Spotify.exe'
  });
  applyArt({ dataUrl: `data:image/svg+xml;base64,${btoa(DEMO_COVER)}` });
}

function seedShelf() {
  demoFiles = [
    { id: 'd1', name: 'AIland-концепт.pdf', ext: 'PDF', size: 2480000, path: '', exists: true },
    { id: 'd2', name: 'island-motion.fig', ext: 'FIG', size: 18200000, path: '', exists: true },
    { id: 'd3', name: 'cover-final.png', ext: 'PNG', size: 4600000, path: '', exists: true },
    { id: 'd4', name: 'demo-reel.mp4', ext: 'MP4', size: 73000000, path: '', exists: true },
    { id: 'd5', name: 'sprint-notes.md', ext: 'MD', size: 12200, path: '', exists: true },
    { id: 'd6', name: 'release.zip', ext: 'ZIP', size: 54000000, path: '', exists: true }
  ];
  renderShelf(demoFiles);
}

function seedTimer() {
  const timer = state.timer;
  timer.duration = 25 * 60000;
  timer.remaining = (18 * 60 + 42) * 1000;
  timer.endsAt = Date.now() + timer.remaining;
  timer.running = true;
  timer.done = false;
  timer.preset = 25;
  renderTimer();

  const start = new Date();
  start.setHours(16, 0, 0, 0);
  const end = new Date(start.getTime() + 45 * 60000);
  renderCalendar({
    available: true,
    subject: 'Дизайн-ревью AIland',
    start: start.toISOString(),
    end: end.toISOString(),
    location: 'Zoom',
    allDay: false
  });
}

function seedSystem() {
  const seed = [18, 22, 19, 27, 31, 26, 34, 42, 38, 33, 45, 52, 47, 41, 36, 44, 58, 54, 49, 43];
  state.cpuHistory = seed.slice();
  applyStats({
    cpu: 43.6,
    memUsed: 11.2 * GIB,
    memTotal: 32 * GIB,
    rxBps: 1.42 * 1024 ** 2,
    txBps: 320 * 1024,
    diskFree: 212 * GIB,
    diskTotal: 953 * GIB,
    battery: 87,
    charging: true,
    hasBattery: true,
    uptime: 3 * 3600 + 12 * 60
  });
}

window.__aiCapture = (name) => {
  document.body.classList.add('capture-mode');
  state.suppressExpand = false;
  if (name === 'idle') {
    collapse(true);
    state.suppressExpand = false;
    return;
  }

  expand();
  if (name === 'player') {
    setView('player');
    seedMedia();
  } else if (name === 'shelf') {
    setView('shelf');
    seedShelf();
  } else if (name === 'timer') {
    setView('timer');
    seedTimer();
  } else if (name === 'system') {
    setView('system');
    seedSystem();
  } else if (name === 'meeting') {
    setView('timer');
    seedTimer();
    openMeetingEditor();
  } else if (name === 'update') {
    setView('player');
    seedMedia();
    applyUpdate({
      status: 'available',
      currentVersion: '0.1.0',
      version: '0.2.0',
      notes: '• Автообновление через GitHub Releases\n• Проверка SHA-256 и фоновая загрузка\n• Кнопка обновления в острове и трее',
      size: 133169152,
      sizeLabel: '127 МБ',
      publishedAt: new Date().toISOString(),
      progress: 0,
      error: null
    });
    openUpdatePanel();
  }
};

/* ---------------- init ---------------- */

function init() {
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => {
    if (!state.expanded || state.view !== 'player') return;
    if (state.media.active && state.media.status === 'playing') updateProgress();
  }, 500);
  setInterval(timerTick, 500);

  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('is-suspended', document.hidden);
  });

  bindEvents();
  renderShelf([]);
  renderCalendar(null);
  updatePlayIcon();
  updateProgress();
  restoreTimer();

  if (api.onMedia) api.onMedia(applyMedia);
  if (api.onArt) api.onArt(applyArt);
  if (api.onStats) api.onStats(applyStats);
  if (api.onShelf) api.onShelf(renderShelf);
  if (api.onCalendar) api.onCalendar(renderCalendar);
  if (api.onUpdate) api.onUpdate(applyUpdate);
  if (api.onUpdateShow) api.onUpdateShow(openUpdatePanel);
  if (api.onToggle) {
    api.onToggle(() => {
      state.suppressExpand = false;
      if (state.expanded) collapse(true);
      else expand();
    });
  }

  if (api.meetingGet) {
    api
      .meetingGet()
      .then((meeting) => {
        state.meeting = meeting || null;
        renderMeeting();
      })
      .catch(() => {});
  }

  if (api.shelfList) {
    api.shelfList()
      .then((files) => {
        if (!demoFiles) renderShelf(files);
      })
      .catch(() => {});
  }

  if (api.updateGet) {
    api
      .updateGet()
      .then((update) => {
        if (!state.capture) applyUpdate(update);
      })
      .catch(() => {});
  }

  if (api.requestCalendar) api.requestCalendar();
  if (api.ready) api.ready();

  setView('player');
  syncHitbox();
  trackHitbox(1400);
}

init();
