'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const sevenZip = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe');

const argv = process.argv.slice(2);
const publish = argv.includes('--publish');
const bump = argv.find((arg) => !arg.startsWith('--')) || 'patch';
const notesIndex = argv.indexOf('--notes');
const customNotes = notesIndex >= 0 ? argv[notesIndex + 1] : '';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...options
  });
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some((item) => !Number.isInteger(item))) {
    fail(`Некорректная текущая версия: ${current}`);
  }
  if (kind === 'major') return `${parts[0] + 1}.0.0`;
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (kind === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  fail('Укажите patch, minor, major или версию вида 1.2.3');
}

function findGh() {
  const candidates = [
    process.env.GH_BIN,
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHubCLI', 'bin', 'gh.exe'),
    'gh'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'gh') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'gh';
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = nextVersion(pkg.version, bump);
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

console.log(`AIland ${version}`);

run(process.execPath, [path.join(root, 'scripts', 'build-portable.js')]);

const zipPath = path.join(root, 'release', `AIland-${version}-portable.zip`);
fs.rmSync(zipPath, { force: true });
run(sevenZip, ['a', '-tzip', '-mx=5', zipPath, '*'], {
  cwd: path.join(root, 'release', 'AIland-portable')
});

run(process.execPath, [path.join(root, 'scripts', 'build-installer.js')]);

const setupPath = path.join(root, 'release', 'installer', `AIland-Setup-${version}.exe`);
const nupkgPath = path.join(root, 'release', 'installer', `AIland-${version}-full.nupkg`);
const releasesPath = path.join(root, 'release', 'installer', 'RELEASES');

for (const file of [setupPath, nupkgPath, releasesPath, zipPath]) {
  if (!fs.existsSync(file)) fail(`Не найден артефакт: ${file}`);
}

if (!publish) {
  console.log('\nСборка готова. Для публикации добавьте --publish.');
  console.log(`Артефакты: ${path.join(root, 'release')}`);
  process.exit(0);
}

if (!pkg.update || !pkg.update.repo) {
  fail('В package.json не задан update.repo (владелец/репозиторий).');
}

const gh = findGh();
run(gh, ['auth', 'status']);

const tag = `v${version}`;
const notes =
  customNotes ||
  `AIland ${version}.\n\n- Автообновление через GitHub Releases\n- Проверка обновлений в острове и трее`;

run('git', ['add', 'package.json', 'package-lock.json', 'main.js', 'update.js', 'preload.js', '.gitignore', 'scripts', 'src', 'assets']);
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim();
if (staged) {
  run('git', ['commit', '-m', `Release ${tag}`]);
} else {
  console.log('Изменений нет, коммит пропущен.');
}
run('git', ['tag', '-a', tag, '-m', `AIland ${version}`]);
run('git', ['push', 'origin', 'HEAD', '--tags']);
run(gh, [
  'release',
  'create',
  tag,
  setupPath,
  nupkgPath,
  releasesPath,
  zipPath,
  '--title',
  `AIland ${version}`,
  '--notes',
  notes
]);

console.log(`\nРелиз ${tag} опубликован.`);
