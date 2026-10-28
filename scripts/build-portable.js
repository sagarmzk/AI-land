'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'release', 'AIland-portable');
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  console.error('Не найден Electron. Выполните npm install.');
  process.exit(1);
}
if (!fs.existsSync(rcedit)) {
  console.error('Не найден rcedit. Выполните npm install.');
  process.exit(1);
}

try {
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
} catch {
  console.warn('Полная очистка не удалась, занятые файлы будут сохранены.');
}

function copyTree(src, dest) {
  const stat = fs.statSync(src);
  if (!stat.isDirectory()) {
    try {
      fs.copyFileSync(src, dest);
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && fs.existsSync(dest)) {
        return;
      }
      throw err;
    }
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    copyTree(path.join(src, name), path.join(dest, name));
  }
}

fs.mkdirSync(path.dirname(outDir), { recursive: true });
copyTree(electronDist, outDir);

const portableExe = path.join(outDir, 'AIland.exe');
if (fs.existsSync(path.join(outDir, 'electron.exe'))) {
  fs.rmSync(portableExe, { force: true });
  fs.renameSync(path.join(outDir, 'electron.exe'), portableExe);
}

const appDir = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
for (const item of ['main.js', 'preload.js', 'update.js', 'package.json', 'src', 'assets', 'scripts']) {
  copyTree(path.join(root, item), path.join(appDir, item));
}

const fileVersion = `${pkg.version}.0`;
execFileSync(
  rcedit,
  [
    path.join(outDir, 'AIland.exe'),
    '--set-icon',
    path.join(root, 'assets', 'icon.ico'),
    '--set-file-version',
    fileVersion,
    '--set-product-version',
    fileVersion,
    '--set-version-string',
    'ProductName',
    'AIland',
    '--set-version-string',
    'FileDescription',
    'AIland — плавающий остров для Windows',
    '--set-version-string',
    'CompanyName',
    'AIland',
    '--set-version-string',
    'LegalCopyright',
    'MIT License'
  ],
  { stdio: 'inherit', windowsHide: true }
);

console.log(`Portable build ready: ${outDir}`);
