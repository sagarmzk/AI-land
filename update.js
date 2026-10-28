'use strict';

const { app, net, Notification, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const pkg = require('./package.json');

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 20 * 1000;
const REQUEST_TIMEOUT = 15 * 1000;
const API_VERSION = '2022-11-28';

function parseVersion(value) {
  const clean = String(value || '')
    .trim()
    .replace(/^v/i, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '—';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} КБ`;
  return `${(value / 1024 ** 2).toFixed(1)} МБ`;
}

function safeFileName(name, fallback) {
  const base = path.basename(String(name || ''));
  return /^[A-Za-z0-9._-]+$/.test(base) ? base : fallback;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = function createUpdater(options) {
  const { getWindow, send, store, persist, rebuildTray, openPanel } = options;

  const repo = String(
    process.env.AILAND_UPDATE_REPO || (pkg.update && pkg.update.repo) || ''
  ).trim();
  const enabled =
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    (app.isPackaged || process.env.AILAND_UPDATE_DEV === '1') &&
    !process.argv.includes('--capture');

  const updatesDir = path.join(app.getPath('userData'), 'updates');
  let timer = null;
  let currentAsset = null;
  let currentFile = null;
  let lastNotified = '';
  let disposed = false;

  let state = {
    status: enabled ? 'idle' : 'disabled',
    currentVersion: app.getVersion(),
    version: null,
    notes: '',
    size: 0,
    publishedAt: '',
    progress: 0,
    error: null,
    checkedAt: 0
  };

  function publicState() {
    return {
      status: state.status,
      currentVersion: state.currentVersion,
      version: state.version,
      notes: state.notes,
      size: state.size,
      sizeLabel: formatBytes(state.size),
      publishedAt: state.publishedAt,
      progress: state.progress,
      error: state.error,
      checkedAt: state.checkedAt
    };
  }

  function broadcast() {
    send('update:state', publicState());
    if (typeof rebuildTray === 'function') rebuildTray();
  }

  function patch(next) {
    state = { ...state, ...next };
    broadcast();
  }

  function markChecked() {
    if (!store.update || typeof store.update !== 'object') store.update = {};
    store.update.lastCheckAt = Date.now();
    if (typeof persist === 'function') persist();
  }

  function friendlyError(error) {
    const code = error && error.code;
    if (code === 'RATE_LIMITED') return 'GitHub временно ограничил запросы. Попробуйте позже.';
    if (code === 'NO_RELEASES') return 'В репозитории пока нет релизов.';
    if (code === 'NO_ASSET') return 'В релизе нет установщика для Windows.';
    if (code === 'HASH_MISMATCH') return 'Файл обновления повреждён. Попробуйте ещё раз.';
    if (code === 'HTTP_404') return 'Релизы не найдены.';
    return 'Не удалось связаться с GitHub. Проверьте подключение к сети.';
  }

  function fail(error, manual) {
    const message = friendlyError(error);
    if (state.status === 'available' || state.status === 'ready') {
      state.error = message;
      broadcast();
    } else {
      patch({ status: 'error', error: message, progress: 0 });
    }
    if (manual) {
      const win = getWindow && getWindow();
      const box = {
        type: 'warning',
        title: 'AIland',
        message: 'Не удалось проверить обновления',
        detail: message,
        buttons: ['ОК']
      };
      (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)).catch(() => {});
    }
  }

  async function fetchLatest() {
    const response = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `AIland/${app.getVersion()}`,
        'X-GitHub-Api-Version': API_VERSION
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });

    if (response.status === 404) {
      const error = new Error('no releases');
      error.code = 'NO_RELEASES';
      throw error;
    }
    if (response.status === 403 || response.status === 429) {
      const error = new Error('rate limited');
      error.code = 'RATE_LIMITED';
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`http ${response.status}`);
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    return response.json();
  }

  function pickAsset(release, version) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const exact = `ailand-setup-${version}.exe`.toLowerCase();
    const asset =
      assets.find((item) => String(item.name || '').toLowerCase() === exact) ||
      assets.find((item) => /^ailand-setup-.*\.exe$/i.test(String(item.name || ''))) ||
      assets.find((item) => /setup.*\.exe$/i.test(String(item.name || '')));

    if (!asset || !asset.browser_download_url) {
      const error = new Error('no asset');
      error.code = 'NO_ASSET';
      throw error;
    }

    let url;
    try {
      url = new URL(asset.browser_download_url);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com') {
      const error = new Error('bad asset url');
      error.code = 'BAD_ASSET';
      throw error;
    }

    const digest = String(asset.digest || '')
      .replace(/^sha256:/i, '')
      .toLowerCase();
    return {
      name: safeFileName(asset.name, `AIland-Setup-${version}.exe`),
      size: Number(asset.size) || 0,
      url: url.toString(),
      digest: /^[a-f0-9]{64}$/.test(digest) ? digest : ''
    };
  }

  function updatePathFor(asset) {
    return path.join(updatesDir, asset.name);
  }

  async function reuseExisting(asset) {
    const file = updatePathFor(asset);
    try {
      if (!fs.existsSync(file)) return false;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size <= 0) return false;
      if (asset.size && stat.size !== asset.size) {
        fs.rmSync(file, { force: true });
        return false;
      }
      if (asset.digest) {
        const digest = await hashFile(file);
        if (digest !== asset.digest) {
          fs.rmSync(file, { force: true });
          return false;
        }
      }
      currentFile = file;
      return true;
    } catch {
      return false;
    }
  }

  async function check({ manual = false } = {}) {
    if (!enabled || disposed) {
      if (manual) {
        const win = getWindow && getWindow();
        const box = {
          type: 'info',
          title: 'AIland',
          message: 'Автообновление не настроено',
          detail: 'В сборке не указан GitHub-репозиторий для обновлений.',
          buttons: ['ОК']
        };
        (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)).catch(() => {});
      }
      return;
    }
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'installing') return;
    if (manual && state.status === 'ready') {
      if (typeof openPanel === 'function') openPanel();
      return;
    }

    patch({ status: 'checking', error: null, progress: 0 });

    try {
      const release = await fetchLatest();
      const tag = String(release.tag_name || '');
      const version = tag.replace(/^v/i, '');
      const notes = String(release.body || '').slice(0, 1200);
      const publishedAt = String(release.published_at || '');
      markChecked();

      if (!parseVersion(version) || !isNewer(version, app.getVersion())) {
        state = { ...state, status: 'current', version, notes, publishedAt, checkedAt: Date.now(), error: null };
        broadcast();
        if (manual) {
          const win = getWindow && getWindow();
          const box = {
            type: 'info',
            title: 'AIland',
            message: 'У вас последняя версия',
            detail: `Установлена версия ${app.getVersion()}.`,
            buttons: ['ОК']
          };
          (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)).catch(() => {});
        }
        return;
      }

      const asset = pickAsset(release, version);
      currentAsset = asset;
      currentFile = null;
      state = {
        ...state,
        status: 'available',
        version,
        notes,
        size: asset.size,
        publishedAt,
        progress: 0,
        error: null,
        checkedAt: Date.now()
      };
      broadcast();

      if (await reuseExisting(asset)) {
        patch({ status: 'ready', progress: 100 });
      } else if (lastNotified !== version) {
        lastNotified = version;
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: `AIland ${version}`,
            body: 'Доступно обновление. Нажмите, чтобы открыть.'
          });
          notification.on('click', () => {
            if (typeof openPanel === 'function') openPanel();
          });
          notification.show();
        }
      }
    } catch (error) {
      if (manual) fail(error, true);
      else if (state.status !== 'available' && state.status !== 'ready') {
        state = { ...state, status: 'idle', error: friendlyError(error) };
        broadcast();
      }
    }
  }

  function downloadAsset(asset, targetPath) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const partPath = `${targetPath}.part`;
      try {
        fs.rmSync(partPath, { force: true });
      } catch {
        /* ignore */
      }

      const hash = createHash('sha256');
      const file = fs.createWriteStream(partPath);
      const total = Number(asset.size) || 0;
      let received = 0;
      let lastSent = 0;
      let settled = false;
      let request = null;

      const cleanup = () => {
        try {
          file.destroy();
        } catch {
          /* ignore */
        }
        try {
          fs.rmSync(partPath, { force: true });
        } catch {
          /* ignore */
        }
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const finish = () => {
        if (settled) return;
        const digest = hash.digest('hex');
        if (asset.digest && digest !== asset.digest) {
          const error = new Error('hash mismatch');
          error.code = 'HASH_MISMATCH';
          fail(error);
          return;
        }
        settled = true;
        try {
          fs.rmSync(targetPath, { force: true });
          fs.renameSync(partPath, targetPath);
          resolve({ path: targetPath, size: received });
        } catch (error) {
          reject(error);
        }
      };

      request = net.request({ method: 'GET', url: asset.url, redirect: 'follow' });
      request.setHeader('User-Agent', `AIland/${app.getVersion()}`);
      request.setHeader('Accept', 'application/octet-stream');

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          const error = new Error(`http ${response.statusCode}`);
          error.code = response.statusCode === 404 ? 'HTTP_404' : 'HTTP_ERROR';
          fail(error);
          return;
        }

        response.on('data', (chunk) => {
          if (settled) return;
          received += chunk.length;
          hash.update(chunk);
          if (!file.write(chunk)) {
            try {
              response.pause();
              file.once('drain', () => response.resume());
            } catch {
              /* ignore */
            }
          }
          const now = Date.now();
          if (now - lastSent > 220 || (total && received >= total)) {
            lastSent = now;
            const ratio = total ? Math.min(1, received / total) : 0;
            state = { ...state, progress: Math.round(ratio * 100) };
            send('update:state', publicState());
          }
        });

        response.on('end', () => {
          if (settled) return;
          file.end(() => finish());
        });

        response.on('aborted', () => fail(new Error('aborted')));
        response.on('error', fail);
      });

      request.on('error', fail);
      request.end();
    });
  }

  async function download() {
    if (!enabled || disposed) return;
    if (state.status === 'downloading' || state.status === 'installing') return;
    if (state.status === 'ready') {
      if (typeof openPanel === 'function') openPanel();
      return;
    }
    if (!currentAsset) {
      check({ manual: true });
      return;
    }

    patch({ status: 'downloading', progress: 0, error: null });
    try {
      const target = updatePathFor(currentAsset);
      currentFile = await downloadAsset(currentAsset, target);
      currentFile = currentFile.path;
      patch({ status: 'ready', progress: 100 });
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'AIland',
          body: `Обновление ${state.version} загружено. Перезапустите приложение.`
        });
        notification.on('click', () => {
          if (typeof openPanel === 'function') openPanel();
        });
        notification.show();
      }
    } catch (error) {
      fail(error, false);
    }
  }

  function install() {
    if (state.status !== 'ready' || !currentFile || !fs.existsSync(currentFile)) return;
    patch({ status: 'installing', progress: 100, error: null });

    const installDir = path.join(
      process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'),
      'AIland'
    );
    const helper = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const setup = process.env.AILAND_SETUP;',
      'const dir = process.env.AILAND_INSTALL_DIR;',
      "const child = spawn(setup, ['--silent'], { stdio: 'ignore', windowsHide: true });",
      "child.on('exit', () => {",
      '  setTimeout(() => {',
      "    const exe = path.join(dir, 'AIland.exe');",
      '    if (!fs.existsSync(exe)) return;',
      "    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();",
      '  }, 1500);',
      '});'
    ].join('\n');

    try {
      const child = spawn(process.execPath, ['-e', helper], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          AILAND_SETUP: currentFile,
          AILAND_INSTALL_DIR: installDir
        }
      });
      child.unref();
    } catch (error) {
      patch({
        status: 'error',
        error: 'Не удалось запустить установщик. Запустите AIland-Setup вручную.'
      });
      return;
    }

    setTimeout(() => {
      app.isQuitting = true;
      app.quit();
    }, 700);
  }

  function trayItems() {
    if (!enabled) return [];
    const items = [
      {
        label: state.status === 'checking' ? 'Проверка обновлений…' : 'Проверить обновления',
        enabled: state.status !== 'checking' && state.status !== 'downloading' && state.status !== 'installing',
        click: () => check({ manual: true })
      }
    ];
    if (state.status === 'available') {
      items.push({
        label: `Скачать обновление ${state.version}`,
        click: () => download()
      });
    } else if (state.status === 'downloading') {
      items.push({ label: `Загрузка обновления · ${state.progress}%`, enabled: false });
    } else if (state.status === 'ready') {
      items.push({
        label: `Перезапустить и установить ${state.version}`,
        click: () => install()
      });
    } else if (state.status === 'error' && state.error) {
      items.push({ label: state.error, enabled: false });
    }
    return items;
  }

  function cleanup() {
    try {
      if (!fs.existsSync(updatesDir)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(updatesDir)) {
        const file = path.join(updatesDir, name);
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          if (name.endsWith('.part') || now - stat.mtimeMs > 14 * 24 * 60 * 60 * 1000) {
            fs.rmSync(file, { force: true });
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  function init() {
    if (!enabled) {
      broadcast();
      return;
    }
    cleanup();
    setTimeout(() => check({ manual: false }), FIRST_CHECK_DELAY);
    timer = setInterval(() => check({ manual: false }), CHECK_INTERVAL);
  }

  function dispose() {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    init,
    dispose,
    check,
    download,
    install,
    trayItems,
    getState: publicState,
    enabled: () => enabled
  };
};
