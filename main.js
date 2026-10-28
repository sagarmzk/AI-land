'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  Notification,
  shell,
  globalShortcut,
  dialog
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const createUpdater = require('./update');

const APP_ID = 'com.ailand.app';
const ROOT = __dirname;
const ASSETS = path.join(ROOT, 'assets');
const isCapture = process.argv.includes('--capture');
const isDev = process.argv.includes('--dev');

const WIN_W = 640;
const WIN_H = 420;

app.setAppUserModelId(APP_ID);

if (!isCapture && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let updater = null;
let lastHitbox = null;
let cursorInside = false;
let latestMedia = { active: false };
let latestArt = null;
let lastArtSource = '';
let latestNet = null;
let bridgeProc = null;
let bridgeRestartTimer = null;
let mediaCmdPath = null;
let netPrev = null;
let prevCpuTimes = [];
let hitboxTimer = null;
let statsTimer = null;

const STORE_PATH = path.join(app.getPath('userData'), 'store.json');
let store = { shelf: [], tasks: [], timer: null, meeting: null, update: { lastCheckAt: 0 } };

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (Array.isArray(raw.shelf)) store.shelf = raw.shelf.filter((f) => f && typeof f.path === 'string');
    if (Array.isArray(raw.tasks)) {
      store.tasks = raw.tasks
        .filter((task) => task && typeof task.text === 'string' && task.text.trim())
        .slice(0, 60)
        .map((task) => ({
          id: typeof task.id === 'string' ? task.id : randomUUID(),
          text: task.text.trim().slice(0, 120),
          done: !!task.done,
          createdAt: Number(task.createdAt) || Date.now()
        }));
    }
    if (raw.timer && typeof raw.timer === 'object') store.timer = raw.timer;
    if (raw.meeting && typeof raw.meeting === 'object') store.meeting = raw.meeting;
    if (raw.update && typeof raw.update === 'object') {
      store.update = { lastCheckAt: Number(raw.update.lastCheckAt) || 0 };
    }
  } catch {
    /* first launch */
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    /* disk unavailable */
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- shelf ---------- */

function shelfPayload() {
  return store.shelf.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    ext: f.ext,
    size: f.size,
    exists: fs.existsSync(f.path)
  }));
}

function broadcastShelf() {
  send('shelf:update', shelfPayload());
}

function addFiles(paths) {
  let added = 0;
  for (const p of paths) {
    if (!p || typeof p !== 'string') continue;
    if (store.shelf.some((f) => f.path.toLowerCase() === p.toLowerCase())) continue;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = path.extname(p).slice(1).toUpperCase() || 'FILE';
    store.shelf.unshift({
      id: randomUUID(),
      name: path.basename(p),
      path: p,
      ext: ext.slice(0, 5),
      size: stat.size,
      addedAt: Date.now()
    });
    added += 1;
    if (store.shelf.length > 24) store.shelf.pop();
  }
  if (added) {
    persist();
    broadcastShelf();
  }
  return shelfPayload();
}

function findShelfFile(id) {
  return store.shelf.find((f) => f.id === id);
}

/* ---------- tasks ---------- */

function broadcastTasks() {
  send('tasks:update', store.tasks);
}

function addTask(text) {
  const value = String(text || '').trim().slice(0, 120);
  if (!value) return store.tasks;
  store.tasks.unshift({ id: randomUUID(), text: value, done: false, createdAt: Date.now() });
  if (store.tasks.length > 60) store.tasks.length = 60;
  persist();
  broadcastTasks();
  return store.tasks;
}

/* ---------- system bridge (SMTC + network + battery) ---------- */

function stopBridge() {
  if (bridgeRestartTimer) {
    clearTimeout(bridgeRestartTimer);
    bridgeRestartTimer = null;
  }
  if (bridgeProc) {
    try {
      bridgeProc.kill();
    } catch {
      /* already gone */
    }
    bridgeProc = null;
  }
}

function startBridge() {
  stopBridge();
  mediaCmdPath = path.join(os.tmpdir(), `ailand-cmd-${process.pid}.txt`);
  try {
    fs.unlinkSync(mediaCmdPath);
  } catch {
    /* no stale command */
  }
  const script = path.join(ROOT, 'scripts', 'bridge.ps1');
  if (!fs.existsSync(script)) return;
  bridgeProc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-CommandFile', mediaCmdPath],
    { windowsHide: true }
  );
  bridgeProc.stdout.setEncoding('utf8');
  let buffer = '';
  bridgeProc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim().replace(/^\uFEFF/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      if (payload.k === 'sys') handleSysState(payload);
      else handleMediaState(payload);
    }
  });
  bridgeProc.stderr.on('data', () => {});
  bridgeProc.on('error', () => {});
  bridgeProc.on('exit', () => {
    bridgeProc = null;
    if (!app.isQuitting) bridgeRestartTimer = setTimeout(startBridge, 8000);
  });
}

function handleMediaState(state) {
  delete state.k;
  latestMedia = state;
  if (state.active && state.art) {
    if (lastArtSource !== state.art) {
      lastArtSource = state.art;
      try {
        const ext = state.art.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
        const dataUrl = `data:image/${ext};base64,${fs.readFileSync(state.art).toString('base64')}`;
        latestArt = { path: state.art, dataUrl };
        send('media:art', latestArt);
      } catch {
        latestArt = null;
      }
    }
  } else if (lastArtSource) {
    lastArtSource = '';
    latestArt = null;
    send('media:art', null);
  }
  send('media:state', state);
}

function handleSysState(payload) {
  const now = Date.now();
  if (netPrev && now > netPrev.t) {
    const dt = (now - netPrev.t) / 1000;
    payload.rxBps = Math.max(0, (payload.rx - netPrev.rx) / dt);
    payload.txBps = Math.max(0, (payload.tx - netPrev.tx) / dt);
  } else {
    payload.rxBps = 0;
    payload.txBps = 0;
  }
  netPrev = { rx: payload.rx, tx: payload.tx, t: now };
  latestNet = payload;
}

function mediaControl(action) {
  if (!bridgeProc || !mediaCmdPath) return;
  try {
    fs.writeFileSync(mediaCmdPath, String(action), 'utf8');
  } catch {
    /* bridge not ready */
  }
}

/* ---------- system stats ---------- */

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  cpus.forEach((cpu, i) => {
    const now = cpu.times;
    const prev = prevCpuTimes[i] || now;
    const idleDelta = now.idle - prev.idle;
    let sum = 0;
    for (const key of Object.keys(now)) sum += now[key] - (prev[key] || 0);
    idle += idleDelta;
    total += sum;
  });
  prevCpuTimes = cpus.map((c) => ({ ...c.times }));
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function pushStats() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const net = latestNet || {};
  const payload = {
    cpu: Math.round(sampleCpu() * 10) / 10,
    memUsed: totalMem - freeMem,
    memTotal: totalMem,
    rxBps: net.rxBps || 0,
    txBps: net.txBps || 0,
    diskFree: net.diskFree || 0,
    diskTotal: net.diskTotal || 0,
    battery: typeof net.battery === 'number' ? net.battery : null,
    charging: !!net.charging,
    hasBattery: !!net.hasBattery,
    uptime: os.uptime()
  };
  send('system:stats', payload);
}

/* ---------- overlay window ---------- */

function positionWindow() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const x = Math.round(area.x + (area.width - WIN_W) / 2);
  const y = area.y + 4;
  win.setPosition(x, y);
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.setMenu(null);

  win.loadFile(path.join(ROOT, 'src', 'index.html'), { query: isCapture ? { capture: '1' } : {} });

  win.once('ready-to-show', () => {
    positionWindow();
    win.setIgnoreMouseEvents(true, { forward: true });
    win.showInactive();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
    if (isCapture) runCapture();
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('render-process-gone', () => {
    if (!app.isQuitting) setTimeout(createWindow, 600);
  });
}

function watchCursor() {
  hitboxTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (!lastHitbox) return;
    const point = screen.getCursorScreenPoint();
    const inside =
      point.x >= lastHitbox.x &&
      point.x <= lastHitbox.x + lastHitbox.w &&
      point.y >= lastHitbox.y &&
      point.y <= lastHitbox.y + lastHitbox.h;
    if (inside !== cursorInside) {
      cursorInside = inside;
      win.setIgnoreMouseEvents(!inside, { forward: true });
    }
  }, 50);
}

function showUpdatePanel() {
  if (!win) {
    createWindow();
    setTimeout(() => {
      if (win) showUpdatePanel();
    }, 900);
    return;
  }
  if (!win.isVisible()) {
    positionWindow();
    win.showInactive();
  }
  send('update:show');
}

/* ---------- tray ---------- */

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: win && win.isVisible() ? 'Скрыть остров' : 'Показать остров',
      click: () => {
        if (!win) return createWindow();
        if (win.isVisible()) win.hide();
        else {
          positionWindow();
          win.showInactive();
        }
        rebuildTray();
      }
    },
    { type: 'separator' },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: win ? win.isAlwaysOnTop() : true,
      click: (item) => {
        if (!win) return;
        win.setAlwaysOnTop(item.checked, 'screen-saver');
      }
    },
    {
      label: 'Запускать при входе',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [] });
      }
    },
    { type: 'separator' },
    ...(updater && updater.enabled() ? [...updater.trayItems(), { type: 'separator' }] : []),
    {
      label: 'Выход',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function rebuildTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const candidates = ['tray.png', 'icon.png'];
  let image = nativeImage.createEmpty();
  for (const name of candidates) {
    const p = path.join(ASSETS, name);
    if (fs.existsSync(p)) {
      const loaded = nativeImage.createFromPath(p);
      if (!loaded.isEmpty()) {
        image = loaded.resize({ width: 16, height: 16 });
        break;
      }
    }
  }
  tray = new Tray(image);
  tray.setToolTip('AIland — остров поверх окон');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => {
    if (!win) createWindow();
    else if (win.isVisible()) win.hide();
    else win.showInactive();
    rebuildTray();
  });
}

/* ---------- ipc ---------- */

function registerIpc() {
  ipcMain.on('ui:hitbox', (_event, rect) => {
    if (rect && typeof rect.x === 'number' && typeof rect.y === 'number' && rect.w > 0 && rect.h > 0) {
      lastHitbox = rect;
    }
  });

  ipcMain.on('ui:ready', () => {
    send('media:state', latestMedia);
    if (latestArt) send('media:art', latestArt);
    send('shelf:update', shelfPayload());
    send('tasks:update', store.tasks);
    if (updater) send('update:state', updater.getState());
    pushStats();
  });

  ipcMain.on('media:control', (_event, action) => {
    if (typeof action === 'string' && action.length < 64) mediaControl(action);
  });

  ipcMain.handle('shelf:list', () => shelfPayload());
  ipcMain.handle('shelf:add', (_event, paths) => addFiles(Array.isArray(paths) ? paths : []));

  ipcMain.handle('tasks:list', () => store.tasks);
  ipcMain.handle('tasks:add', (_event, text) => addTask(text));
  ipcMain.handle('tasks:toggle', (_event, id) => {
    const task = store.tasks.find((t) => t.id === id);
    if (task) {
      task.done = !task.done;
      persist();
      broadcastTasks();
    }
    return store.tasks;
  });
  ipcMain.handle('tasks:remove', (_event, id) => {
    store.tasks = store.tasks.filter((t) => t.id !== id);
    persist();
    broadcastTasks();
    return store.tasks;
  });
  ipcMain.handle('tasks:clearDone', () => {
    store.tasks = store.tasks.filter((t) => !t.done);
    persist();
    broadcastTasks();
    return store.tasks;
  });

  ipcMain.handle('shelf:pick', async () => {
    if (!win) return shelfPayload();
    const result = await dialog.showOpenDialog(win, {
      title: 'Добавить файлы на полку',
      buttonLabel: 'Добавить',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return shelfPayload();
    return addFiles(result.filePaths);
  });

  ipcMain.handle('shelf:remove', (_event, id) => {
    store.shelf = store.shelf.filter((f) => f.id !== id);
    persist();
    broadcastShelf();
    return shelfPayload();
  });

  ipcMain.handle('shelf:clear', () => {
    store.shelf = [];
    persist();
    broadcastShelf();
    return shelfPayload();
  });

  ipcMain.on('shelf:open', (_event, id) => {
    const file = findShelfFile(id);
    if (file) shell.openPath(file.path);
  });

  ipcMain.on('shelf:reveal', (_event, id) => {
    const file = findShelfFile(id);
    if (file) shell.showItemInFolder(file.path);
  });

  ipcMain.on('shelf:drag', (_event, id) => {
    const file = findShelfFile(id);
    if (!file || !win) return;
    const iconPath = path.join(ASSETS, 'icon.png');
    let icon = nativeImage.createEmpty();
    if (fs.existsSync(iconPath)) icon = nativeImage.createFromPath(iconPath).resize({ width: 48, height: 48 });
    try {
      win.webContents.startDrag({ file: file.path, icon });
    } catch {
      /* drag cancelled */
    }
  });

  ipcMain.handle('meeting:get', () => store.meeting || null);
  ipcMain.handle('meeting:save', (_event, meeting) => {
    if (!meeting || typeof meeting.subject !== 'string' || !meeting.start) return null;
    const subject = meeting.subject.trim().slice(0, 120);
    const start = new Date(meeting.start);
    if (!subject || Number.isNaN(start.getTime())) return null;
    const duration = Math.min(480, Math.max(5, Math.round(Number(meeting.duration) || 30)));
    store.meeting = { subject, start: start.toISOString(), duration };
    persist();
    return store.meeting;
  });

  ipcMain.handle('timer:get', () => store.timer);
  ipcMain.handle('timer:save', (_event, timer) => {
    store.timer = timer && typeof timer === 'object' ? timer : null;
    persist();
    return true;
  });
  ipcMain.handle('timer:clear', () => {
    store.timer = null;
    persist();
    return true;
  });
  ipcMain.on('timer:done', (_event, label) => {
    shell.beep();
    if (Notification.isSupported()) {
      new Notification({
        title: 'AIland',
        body: label ? `Таймер завершён: ${label}` : 'Таймер завершён'
      }).show();
    }
  });

  ipcMain.handle('update:get', () => {
    if (updater) return updater.getState();
    return { status: 'disabled', currentVersion: app.getVersion() };
  });
  ipcMain.on('update:check', () => {
    if (updater) updater.check({ manual: true });
  });
  ipcMain.on('update:download', () => {
    if (updater) updater.download();
  });
  ipcMain.on('update:install', () => {
    if (updater) updater.install();
  });

  ipcMain.on('app:quit', () => {
    app.isQuitting = true;
    app.quit();
  });
}

/* ---------- capture mode ---------- */

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCapture() {
  const outDir = path.join(ROOT, 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  await wait(1600);
  const states = ['idle', 'player', 'tasks', 'shelf', 'timer', 'system', 'meeting', 'update'];
  for (const name of states) {
    await win.webContents.executeJavaScript(
      `window.__aiCapture && window.__aiCapture(${JSON.stringify(name)})`
    );
    await wait(1100);
    const image = await win.webContents.capturePage({ x: 64, y: 0, width: 512, height: 392 });
    fs.writeFileSync(path.join(outDir, `state-${name}.png`), image.toPNG());
  }
  app.isQuitting = true;
  setTimeout(() => app.quit(), 200);
}

/* ---------- lifecycle ---------- */

app.on('second-instance', () => {
  if (win) {
    positionWindow();
    win.showInactive();
  }
});

app.whenReady().then(() => {
  loadStore();
  updater = createUpdater({
    getWindow: () => win,
    send,
    store,
    persist,
    rebuildTray: () => rebuildTray(),
    openPanel: showUpdatePanel
  });
  registerIpc();
  createWindow();
  try {
    createTray();
  } catch {
    /* tray optional */
  }
  watchCursor();
  startBridge();
  statsTimer = setInterval(pushStats, 3000);
  globalShortcut.register('Control+Alt+Space', () => send('ui:toggle'));
  globalShortcut.register('Control+Alt+I', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
  if (updater) updater.init();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (hitboxTimer) clearInterval(hitboxTimer);
  if (statsTimer) clearInterval(statsTimer);
  if (updater) updater.dispose();
  stopBridge();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (!isCapture) app.quit();
});
