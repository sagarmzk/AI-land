'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createWindowsInstaller } = require('electron-winstaller');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const outputDirectory = path.join(root, 'release', 'installer');

fs.rmSync(outputDirectory, { recursive: true, force: true });

createWindowsInstaller({
  appDirectory: path.join(root, 'release', 'AIland-portable'),
  outputDirectory,
  authors: 'AIland',
  description: 'AIland — плавающий остров для Windows',
  exe: 'AIland.exe',
  name: 'AIland',
  title: 'AIland',
  setupExe: `AIland-Setup-${pkg.version}.exe`,
  setupIcon: path.join(root, 'assets', 'icon.ico'),
  noMsi: true
})
  .then(() => {
    console.log(`Installer ${pkg.version} created in release/installer`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
