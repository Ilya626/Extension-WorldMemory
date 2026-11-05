// Standalone native lorebooks use a document picker, never the image/card path.
export function installWIImport({ ctx, nativeWI }) {
    const picker = document.getElementById('wm_wi_json_file');
    const choose = document.getElementById('wm_wi_json_pick');
    const paste = document.getElementById('wm_wi_json_import_text');
    const output = document.getElementById('wm_wi_json_status');
    const title = document.getElementById('wm_wi_json_name');
    const text = document.getElementById('wm_wi_json_text');
    let importing = false;

    async function importBook(read, suggestedName = '') {
        if (importing) return;
        importing = true; choose.disabled = paste.disabled = true;
        output.textContent = 'Чтение WI JSON…';
        try {
            const source = (await read()).replace(/^\uFEFF/, '');
            let book;
            try { book = JSON.parse(source); }
            catch { throw new Error('Не удалось прочитать JSON. Выберите файл книги WI или вставьте его полный текст.'); }
            if (!book || typeof book !== 'object' || !book.entries || typeof book.entries !== 'object' || Array.isArray(book.entries))
                throw new Error('Нужна native WI-книга JSON с объектом entries. Карточки PNG и полные игры импортируются отдельной кнопкой «Импорт всего».');
            const { getSanitizedFilename } = await import('/scripts/utils.js');
            const requested = suggestedName || title.value.trim() || (typeof book.name === 'string' ? book.name : '') || 'World Info';
            const base = await getSanitizedFilename(requested.replace(/\s+Import_\(\d+\)$/i, ''));
            if (!base) throw new Error('Укажите название книги.');
            await nativeWI.updateWorldInfoList();
            const occupied = new Set(nativeWI.world_names.map(name => name.toLocaleLowerCase()));
            let name = base, number = 1;
            while (occupied.has(name.toLocaleLowerCase())) name = `${base} Import_(${number++})`;
            // Native import stores the supplied JSON directly, including unknown
            // top-level and entry fields. Do not convert through another format.
            const form = new FormData();
            form.append('avatar', new File([source], `${name}.json`, { type: 'application/json' }));
            const context = ctx();
            const response = await fetch('/api/worldinfo/import', { method: 'POST',
                headers: context.getRequestHeaders({ omitContentType: true }), body: form });
            if (!response.ok) throw new Error(`Не удалось импортировать WI (HTTP ${response.status}).`);
            const result = await response.json();
            if (!result.name) throw new Error('ST не подтвердил импорт книги.');
            await nativeWI.updateWorldInfoList();
            output.textContent = `Книга «${result.name}» импортирована: ${Object.keys(book.entries).length} записей. Она доступна в World Info; подключите её к персонажу через Additional Lorebooks.`;
        } catch (error) {
            output.textContent = error.message;
        } finally {
            importing = false; choose.disabled = paste.disabled = false;
        }
    }

    choose.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
        const file = picker.files[0];
        if (file) await importBook(() => file.text(), file.name.replace(/\.(json|lorebook|txt)$/i, ''));
        picker.value = '';
    });
    paste.addEventListener('click', () => { void importBook(() => text.value); });
}
