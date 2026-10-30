# Локальные эмбеддинги (необязательно)

[WorldMemory](../README_RU.md) · [English](LOCAL_EMBEDDINGS.md)

По умолчанию используются API-эмбеддинги. Эта инструкция нужна только для локального embedding service; генерация L0 по-прежнему использует подключение суммаризатора.

### Необязательная локальная EmbeddingGemma 2 Q8

На Windows из каталога установленного расширения:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\local-embeddings.ps1 install
powershell -ExecutionPolicy Bypass -File .\tools\local-embeddings.ps1 start
powershell -ExecutionPolicy Bypass -File .\tools\local-embeddings.ps1 status
```

Выберите **Search and embeddings → Embedding connection → Local embeddings**. **Local embedding URL** по умолчанию — `http://127.0.0.1:8081`; адрес должен быть доступен браузеру с ST. Launcher также принимает `stop`. Закреплённая text-only Q8-модель занимает около 310 MB; измеренный пик памяти Windows-сервера — около 394 MiB без ST, браузера и индексации.

Прерванная загрузка модели или runtime оставляет файл `.part`. Повторный `install` продолжает загрузку; готовый файл проверяется перед установкой. Windows-установщик использует системный `curl.exe`.

Включены экспериментальные инструменты Termux: `tools/local-embeddings-termux.sh` с `install`, `start`, `status`, `stop` и `tools/start-st-with-memory-termux.sh`. Реальная установка на телефоне, автозапуск, обновление и ресурсные измерения ещё не завершены; наличие скриптов не означает проверенный Termux-релиз.

Для пробного запуска нужны уже установленный SillyTavern с Node.js и эта рабочая версия расширения. Пример использует стандартную папку расширений пользователя ST; для глобальной установки путь — `$st_dir/public/scripts/extensions/third-party/Extension-WorldMemory`.

```bash
st_dir="$HOME/SillyTavern"
addon_dir="$st_dir/data/default-user/extensions/Extension-WorldMemory"
bash "$addon_dir/tools/local-embeddings-termux.sh" install
bash "$addon_dir/tools/start-st-with-memory-termux.sh" "$st_dir"
```

`install` загружает закреплённую версию модели и собирает CPU runtime. Затем совместный launcher запускает ST и локальные эмбеддинги одной командой. В WorldMemory выберите **Local embeddings** и оставьте `http://127.0.0.1:8081`, если браузер, ST и embedding service работают на этом телефоне. Для API-эмбеддингов запускайте ST обычным способом: локальная модель и компилятор не нужны. Локальный Termux-launcher остаётся preview; проверка на настоящем телефоне отложена.
