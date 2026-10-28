# AIland

Плавающий «остров» в стиле Dynamic Island для обычного Windows-ПК: мини-плеер, полка файлов, таймеры и встречи, монитор системы.

## Скачать

**[⬇ Последняя версия (все файлы)](https://github.com/sagarmzk/AI-land/releases/latest)**

- **Установщик:** [AIland-Setup.exe](https://github.com/sagarmzk/AI-land/releases/latest/download/AIland-Setup.exe)
- **Портативная версия (zip, без установки):** [AIland-portable.zip](https://github.com/sagarmzk/AI-land/releases/latest/download/AIland-portable.zip)

Установщик ставит AIland в `%LOCALAPPDATA%\AIland`, добавляет ярлык и поддерживает автообновление. Портативную версию достаточно распаковать и запустить `AIland.exe`.

## Автообновление

Приложение само проверяет новые релизы на GitHub при запуске и каждые 6 часов. Когда обновление найдено, в острове появляется кнопка «Обновить», а в трее — пункт «Проверить обновления». Скачивание идёт с проверкой SHA-256, установка — тихая, с перезапуском.

## Сборка из исходников

```bash
npm install
npm start          # запуск в dev-режиме
npm run pack       # портативная сборка в release/AIland-portable
npm run dist       # установщик в release/installer
npm run release -- patch --publish   # новая версия + GitHub Release
```

Лицензия: MIT.
