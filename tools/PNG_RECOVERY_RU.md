# ST падает при запуске: JavaScript heap out of memory

Для старых больших PNG-карточек: штатный `png-chunk-text` может расходовать около гигабайта памяти при чтении metadata. Расширение ещё не успевает запуститься, поэтому одного обновления WorldMemory недостаточно.

Останови ST, если он ещё работает. В Termux перейди в каталог SillyTavern, откуда обычно его запускаешь, и выполни:

```sh
curl -fL https://raw.githubusercontent.com/Ilya626/Extension-WorldMemory/main/tools/repair-png-text-decoder.cjs -o repair-png-text-decoder.cjs && node repair-png-text-decoder.cjs
```

После `PNG decoder repaired` запусти ST своим обычным способом. `PNG decoder is already repaired` тоже означает, что исправление установлено.

Скрипт заменяет только `png-chunk-text/decode.js` на линейное чтение через Buffer и сохраняет оригинал рядом как `decode.js.worldmemory-original`. Карточки, чаты и настройки не изменяются. Новые зависимости не нужны. Повторный запуск безопасен. После обновления или переустановки зависимостей исправление может потребоваться снова.

Откат при остановленном ST:

```sh
node repair-png-text-decoder.cjs --rollback
```

Если скрипт пишет `Repair stopped`, он не стал заменять неизвестную версию decoder. Сохрани показанное сообщение.
