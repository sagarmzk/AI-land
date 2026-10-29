'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const params = new URLSearchParams(location.search);
const demo = params.has('demo');

const island = $('#island');
const audio = $('#audio');
const fileInput = $('#fileInput');

const TASKS_KEY = 'ailand.tasks.v1';
const TIMER_KEY = 'ailand.timer.v1';
const RING_CIRC = 2 * Math.PI * 52;
const VIEWS = ['player', 'tasks', 'timer'];

const state = {
  expanded: false,
  view: 'player',
  tasks: loadTasks(),
  tracks: [],
  current: -1,
  playing: false,
  demoTasks: false,
  timer: loadTimer(),
  timerTick: null,
  audioCtx: null
};

/* ---------------- storage ---------------- */

function loadTasks() {
  try {
    const raw = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((task) => task && typeof task.text === 'string' && task.text.trim())
      .slice(0, 60)
      .map((task) => ({
        id: String(task.id || Math.random().toString(36).slice(2)),
        text: task.text.trim().slice(0, 120),
        done: !!task.done
      }));
  } catch {
    return [];
  }
}

function saveTasks() {
  if (state.demoTasks) return;
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(state.tasks));
  } catch {
    /* storage full or blocked */
  }
}

function loadTimer() {
  const base = { duration: 15 * 60000, remaining: 15 * 60000, endsAt: 0, running: false, done: false, preset: 15 };
  try {
    const raw = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return base;
    if (Number(raw.duration) > 0) base.duration = Number(raw.duration);
    if (Number(raw.preset) > 0) base.preset = Number(raw.preset);
    if (raw.running && Number(raw.endsAt) > Date.now()) {
      base.running = true;
      base.endsAt = Number(raw.endsAt);
      base.remaining = base.endsAt - Date.now();
    } else if (raw.running) {
      base.running = false;
      base.done = true;
      base.remaining = 0;
    } else {
      base.done = !!raw.done;
      base.remaining = base.done ? 0 : clamp(Number(raw.remaining) || base.duration, 0, base.duration);
    }
    return base;
  } catch {
    return base;
  }
}

function saveTimer() {
  const timer = state.timer;
  try {
    localStorage.setItem(
      TIMER_KEY,
      JSON.stringify({
        duration: timer.duration,
        remaining: timerRemaining(),
        endsAt: timer.endsAt,
        running: timer.running,
        done: timer.done,
        preset: timer.preset
      })
    );
  } catch {
    /* storage blocked */
  }
}

/* ---------------- helpers ---------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pluralTasks(count) {
  if (count === 0) return 'пусто';
  return `${count} ${count === 1 ? 'задача' : count >= 2 && count <= 4 ? 'задачи' : 'задач'}`;
}

/* ---------------- island state ---------------- */

function expand() {
  if (state.expanded) return;
  state.expanded = true;
  island.classList.add('expanded');
  renderStatus();
  resizePanel();
  setTimeout(() => resizePanel(), 620);
}

function collapse() {
  if (!state.expanded) return;
  state.expanded = false;
  island.classList.remove('expanded');
  renderStatus();
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  $('#tabGlider').style.setProperty('--i', VIEWS.indexOf(view));
  $$('.tab').forEach((tab) => {
    const active = tab.dataset.tab === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $$('.view').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.view === view);
  });
  island.dataset.view = view;
  renderStatus();
  resizePanel();
}

function resizePanel() {
  if (!state.expanded) return;
  const view = $('.view.is-active');
  if (!view) return;

  const list = view.querySelector('.task-list, .playlist');
  if (list) list.style.maxHeight = '';

  // bar 58 + tabs 42 + tabs margin 2 + views margins 22 + shell borders 2
  const chrome = 126;
  const max = Math.round(window.innerHeight * 0.8);
  let height = chrome + view.offsetHeight;

  if (height > max && list) {
    const overflow = height - max;
    list.style.maxHeight = `${Math.max(96, list.offsetHeight - overflow)}px`;
    height = chrome + view.offsetHeight;
  }

  island.style.setProperty('--panel-h', `${Math.round(clamp(height, 220, max))}px`);
  if (list) list.classList.toggle('is-scroll', list.scrollHeight > list.clientHeight + 1);
}

/* ---------------- status ---------------- */

function timerRemaining() {
  const timer = state.timer;
  if (timer.running) return Math.max(0, timer.endsAt - Date.now());
  return Math.max(0, timer.remaining);
}

function currentTrack() {
  return state.current >= 0 ? state.tracks[state.current] : null;
}

function renderStatus() {
  const el = $('#statusText');
  const timer = state.timer;
  const track = currentTrack();
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.done).length;

  if (state.expanded) {
    if (state.view === 'tasks') {
      el.textContent = total ? `Задачи · ${done} из ${total}` : 'Задач пока нет';
      return;
    }
    if (state.view === 'timer') {
      const left = Math.ceil(timerRemaining() / 1000);
      if (timer.running) el.textContent = `Фокус · ${fmtTime(left)}`;
      else if (timer.done) el.textContent = 'Таймер завершён';
      else el.textContent = `Таймер · ${fmtTime(left)}`;
      return;
    }
    el.textContent = track ? (state.playing ? track.title : `Пауза · ${track.title}`) : 'Добавьте музыку';
    return;
  }

  if (timer.running) {
    el.textContent = `Фокус · ${fmtTime(Math.ceil(timerRemaining() / 1000))}`;
    return;
  }
  if (timer.done) {
    el.textContent = 'Таймер завершён';
    return;
  }
  if (track) {
    el.textContent = state.playing ? track.title : `Пауза · ${track.title}`;
    return;
  }
  if (total) {
    el.textContent = `Задачи · ${done} из ${total}`;
    return;
  }
  el.textContent = 'Готов к работе';
}

/* ---------------- tasks ---------------- */

function renderTasks() {
  const list = state.tasks;
  const total = list.length;
  const done = list.filter((task) => task.done).length;
  const percent = total ? Math.round((done / total) * 100) : 0;

  $('#taskPct').textContent = `${percent}%`;
  $('#taskCount').textContent = total ? `${done} из ${total}` : 'пусто';
  $('#taskFill').style.width = `${percent}%`;
  $('#tasksClearBtn').disabled = done === 0;

  const container = $('#taskList');
  container.innerHTML = '';

  if (!total) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'task-empty';
    empty.innerHTML = '<span>Задач пока нет</span><small>Добавьте первую — шкала покажет прогресс</small>';
    empty.addEventListener('click', () => $('#taskInput').focus());
    container.appendChild(empty);
    renderStatus();
    resizePanel();
    return;
  }

  for (const task of list) {
    const row = document.createElement('div');
    row.className = `task-item${task.done ? ' is-done' : ''}`;

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'task-check';
    check.setAttribute('aria-label', task.done ? 'Снять отметку' : 'Выполнено');
    check.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>';
    check.addEventListener('click', () => toggleTask(task.id));

    const text = document.createElement('div');
    text.className = 'task-text';
    text.textContent = task.text;
    text.addEventListener('click', () => toggleTask(task.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'task-x';
    remove.setAttribute('aria-label', 'Удалить задачу');
    remove.textContent = '×';
    remove.addEventListener('click', () => removeTask(task.id));

    row.append(check, text, remove);
    container.appendChild(row);
  }

  renderStatus();
  resizePanel();
}

function addTask(value) {
  const text = String(value || '').trim().slice(0, 120);
  if (!text) return;
  state.tasks.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, done: false });
  if (state.tasks.length > 60) state.tasks.length = 60;
  saveTasks();
  renderTasks();
}

function toggleTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  task.done = !task.done;
  saveTasks();
  renderTasks();
}

function removeTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  saveTasks();
  renderTasks();
}

function clearDone() {
  state.tasks = state.tasks.filter((task) => !task.done);
  saveTasks();
  renderTasks();
}

/* ---------------- player ---------------- */

function parseName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const parts = base.split(' - ').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { artist: 'AIland', title: base || 'Без названия' };
}

function renderTrack() {
  const track = currentTrack();
  $('#playBtn').classList.toggle('is-hidden', false);
  $('.ic-play').classList.toggle('is-hidden', state.playing);
  $('.ic-pause').classList.toggle('is-hidden', !state.playing);
  $('#playBtn').setAttribute('aria-label', state.playing ? 'Пауза' : 'Играть');
  island.classList.toggle('is-playing', state.playing);
  island.classList.toggle('no-track', !track);

  if (!track) {
    $('#trackTitle').textContent = 'Ничего не играет';
    $('#trackArtist').textContent = 'Добавьте музыку с iPhone';
    $('#trackMeta').textContent = 'Локальные файлы · Media Session';
    $('#coverMono').textContent = 'AI';
    return;
  }

  $('#trackTitle').textContent = track.title;
  $('#trackArtist').textContent = track.artist;
  $('#trackMeta').textContent = state.playing ? 'Играет · Media Session' : 'Пауза · Media Session';
  $('#coverMono').textContent = (track.title.match(/[A-Za-zА-Яа-я0-9]/g) || ['A']).slice(0, 2).join('').toUpperCase();
}

function renderPlaylist() {
  const container = $('#playlist');
  container.innerHTML = '';
  if (state.tracks.length < 2) {
    resizePanel();
    return;
  }

  state.tracks.forEach((track, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `track-row${index === state.current ? ' is-current' : ''}`;
    row.innerHTML = `
      <span class="row-index">${index + 1}</span>
      <span class="row-body">
        <span class="row-title"></span>
        <span class="row-sub"></span>
      </span>`;
    row.querySelector('.row-title').textContent = track.title;
    row.querySelector('.row-sub').textContent = track.artist;
    row.addEventListener('click', () => playTrack(index));
    container.appendChild(row);
  });

  resizePanel();
}

function updateSeek() {
  const seek = $('#seek');
  const track = currentTrack();
  const duration = Number(audio.duration) || Number(track && track.duration) || 0;
  const position = Number(audio.currentTime) || 0;
  const fraction = duration > 0 ? clamp(position / duration, 0, 1) : 0;
  seek.value = String(Math.round(fraction * 1000));
  seek.style.setProperty('--p', `${fraction * 100}%`);
  $('#timeNow').textContent = fmtTime(position);
  $('#timeTotal').textContent = fmtTime(duration);
}

function setMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track ? track.title : 'AIland',
      artist: track ? track.artist : '',
      album: 'AIland',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  } catch {
    /* metadata unsupported */
  }
}

function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => togglePlay(true),
    pause: () => togglePlay(false),
    previoustrack: () => skip(-1),
    nexttrack: () => skip(1),
    seekto: (details) => {
      if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime;
      updateSeek();
    }
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* action unsupported */
    }
  }
}

function playTrack(index) {
  if (index < 0 || index >= state.tracks.length) return;
  const track = state.tracks[index];
  state.current = index;
  if (track.url) {
    audio.src = track.url;
    audio.play().catch(() => {});
  }
  setMediaSession(track);
  renderTrack();
  renderPlaylist();
  updateSeek();
  renderStatus();
}

function skip(direction) {
  if (!state.tracks.length) return;
  const next = (state.current + direction + state.tracks.length) % state.tracks.length;
  playTrack(next);
}

function togglePlay(force) {
  const track = currentTrack();
  if (!track || !track.url) return;
  const shouldPlay = typeof force === 'boolean' ? force : audio.paused;
  if (shouldPlay) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

function addFiles(files) {
  const list = Array.from(files || []).filter((file) => file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name));
  if (!list.length) return;

  const wasEmpty = state.tracks.length === 0;
  for (const file of list) {
    const { title, artist } = parseName(file.name);
    state.tracks.push({ title, artist, url: URL.createObjectURL(file), name: file.name });
  }

  if (wasEmpty) {
    playTrack(0);
    togglePlay(true);
  }
  renderPlaylist();
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

  const fill = $('#ringFill');
  fill.style.strokeDasharray = String(RING_CIRC);
  fill.style.strokeDashoffset = String(RING_CIRC * (1 - fraction));

  $('#timerText').textContent = fmtTime(Math.ceil(remaining / 1000));

  let hint = 'нажмите старт';
  if (timer.done) hint = 'готово';
  else if (timer.running) hint = 'в работе';
  else if (remaining < timer.duration && remaining > 0) hint = 'на паузе';
  $('#timerHint').textContent = hint;

  const toggle = $('#timerToggle');
  if (timer.running) toggle.textContent = 'Пауза';
  else if (timer.done) toggle.textContent = 'Ещё раз';
  else if (remaining < timer.duration && remaining > 0) toggle.textContent = 'Продолжить';
  else toggle.textContent = 'Старт';

  $$('#presets button').forEach((button) => {
    button.classList.toggle('is-active', Number(button.dataset.min) === timer.preset);
  });

  renderStatus();
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
  armAudio();
  askNotifications();
  if (!state.timerTick) state.timerTick = setInterval(timerStep, 500);
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

function timerStep() {
  const timer = state.timer;
  if (!timer.running) {
    if (state.timerTick) {
      clearInterval(state.timerTick);
      state.timerTick = null;
    }
    return;
  }
  const remaining = timer.endsAt - Date.now();
  if (remaining <= 0) {
    finishTimer();
    return;
  }
  timer.remaining = remaining;
  renderTimer();
}

function finishTimer() {
  const timer = state.timer;
  timer.running = false;
  timer.endsAt = 0;
  timer.remaining = 0;
  timer.done = true;
  saveTimer();
  if (state.timerTick) {
    clearInterval(state.timerTick);
    state.timerTick = null;
  }
  renderTimer();
  chime();
  if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
  notifyDone();
}

function armAudio() {
  if (state.audioCtx) {
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
    return;
  }
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    state.audioCtx = null;
  }
}

function chime() {
  if (!state.audioCtx) return;
  const ctx = state.audioCtx;
  const now = ctx.currentTime;
  [880, 1320].forEach((frequency, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + index * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.16, now + index * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.18 + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + index * 0.18);
    osc.stop(now + index * 0.18 + 0.55);
  });
}

function askNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

function notifyDone() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('AIland', { body: 'Таймер завершён', icon: 'icons/icon-192.png' });
  } catch {
    /* notifications unavailable */
  }
}

/* ---------------- demo ---------------- */

function seedDemo() {
  state.demoTasks = true;
  state.tasks = [
    { id: 'd1', text: 'Собрать AIland для iPhone', done: true },
    { id: 'd2', text: 'Проверить на Safari', done: true },
    { id: 'd3', text: 'Отполировать шкалу задач', done: false },
    { id: 'd4', text: 'Добавить на домашний экран', done: false }
  ];
  renderTasks();

  state.tracks = [
    { title: 'Midnight City', artist: 'M83', url: '', name: 'M83 - Midnight City.mp3', duration: 243 },
    { title: 'Nightcall', artist: 'Kavinsky', url: '', name: 'Kavinsky - Nightcall.mp3', duration: 258 },
    { title: 'Resonance', artist: 'HOME', url: '', name: 'HOME - Resonance.mp3', duration: 213 }
  ];
  state.current = 0;
  renderTrack();
  renderPlaylist();
  updateSeek();
  renderStatus();
}

/* ---------------- events ---------------- */

function bindEvents() {
  $('#bar').addEventListener('click', (event) => {
    if (event.target.closest('.chev')) return;
    if (state.expanded) collapse();
    else expand();
  });

  $('#collapseBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    collapse();
  });

  document.addEventListener('click', (event) => {
    if (!state.expanded) return;
    if (event.composedPath().includes(island)) return;
    if (event.target.closest('#fileInput')) return;
    collapse();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.expanded) collapse();
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.tab));
  });

  $('#taskForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#taskInput');
    addTask(input.value);
    input.value = '';
    input.blur();
  });

  $('#tasksClearBtn').addEventListener('click', clearDone);

  $('#pickBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  $('#playBtn').addEventListener('click', () => togglePlay());
  $('#prevBtn').addEventListener('click', () => skip(-1));
  $('#nextBtn').addEventListener('click', () => skip(1));

  $('#seek').addEventListener('input', (event) => {
    const duration = Number(audio.duration) || 0;
    if (!duration) return;
    const fraction = Number(event.target.value) / 1000;
    event.target.style.setProperty('--p', `${fraction * 100}%`);
    audio.currentTime = fraction * duration;
  });

  $('#presets').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-min]');
    if (button) selectPreset(Number(button.dataset.min));
  });

  $('#timerToggle').addEventListener('click', () => {
    if (state.timer.running) pauseTimer();
    else startTimer();
  });
  $('#timerReset').addEventListener('click', resetTimer);

  audio.addEventListener('play', () => {
    state.playing = true;
    renderTrack();
    renderStatus();
  });
  audio.addEventListener('pause', () => {
    state.playing = false;
    renderTrack();
    renderStatus();
  });
  audio.addEventListener('ended', () => {
    state.playing = false;
    if (state.tracks.length > 1) skip(1);
    else renderTrack();
  });
  audio.addEventListener('timeupdate', updateSeek);
  audio.addEventListener('loadedmetadata', updateSeek);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      renderTimer();
      updateSeek();
    }
  });

  window.addEventListener('resize', () => {
    if (state.expanded) resizePanel();
  });
}

/* ---------------- init ---------------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function init() {
  bindEvents();
  initMediaSession();
  renderTasks();
  renderTrack();
  renderPlaylist();
  renderTimer();
  updateSeek();
  if (state.timer.running) {
    armAudio();
    state.timerTick = setInterval(timerStep, 500);
  }

  const startView = params.get('view');
  if (startView && VIEWS.includes(startView)) setView(startView);
  if (demo) seedDemo();
  if (demo || params.has('open')) expand();
  else setTimeout(() => expand(), 350);

  registerServiceWorker();
}

init();
