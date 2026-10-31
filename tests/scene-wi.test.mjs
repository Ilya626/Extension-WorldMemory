import test from 'node:test';
import assert from 'node:assert/strict';
import { placeSceneProfiles } from '../scene-wi.js';

const parseRegex = value => {
    const match = /^\/(.*)\/([a-z]*)$/s.exec(value);
    return match ? new RegExp(match[1], match[2]) : null;
};
const profile = (uid, name, key = [name]) => ({ uid, world: 'book', comment: name, key, content: 'Saved profile',
    constant: false, position: 4, depth: 2, role: 0, order: 180, extensions: { worldMemory: { type: 'character' } } });

test('activated scene profiles move only their request placement using expanded Russian keys', () => {
    const entry = profile(3, 'Анна', ['/(?:^|[^\\p{L}])(?:Анна|Анне|Анной)(?![\\p{L}])/iu']);
    const original = structuredClone(entry), activated = new Map([['native-entry-id', entry]]);
    const moved = placeSceneProfiles({ activated, parseRegex, chat: [
        { is_user: true, mes: 'Подхожу к Анне.' }, { is_user: false, mes: 'Она ждёт.' },
        { is_user: true, mes: 'Продолжаю разговор.' },
    ] });
    assert.equal(activated.size, 1);
    assert.deepEqual(moved, [{ uid: 3, world: 'book', title: 'Анна' }]);
    assert.deepEqual(activated.get('native-entry-id'), { ...original, position: 4, depth: 1 });
    assert.deepEqual(entry, original);
});

test('scene placement does not activate absent entries or change saved books and unrelated activated WI', () => {
    const saved = [profile(1, 'Анна'), profile(2, 'Борис')];
    const before = structuredClone(saved), activated = new Map([['boris', saved[1]]]);
    const moved = placeSceneProfiles({ activated, catalogue: saved, parseRegex, chat: [
        { is_user: true, mes: 'Раньше говорили с Борисом.' }, { is_user: false, mes: 'Старая сцена окончена.' },
        { is_user: true, mes: 'Анна входит.' }, { is_user: false, mes: 'Она здоровается.\n<memory_hint>\nkeys: Борис\n</memory_hint>' },
        { is_user: true, mes: 'Отвечаю Анне.' },
    ] });
    assert.deepEqual(moved, []);
    assert.equal(activated.size, 1);
    assert.deepEqual([...activated.values()], [before[1]]);
    assert.deepEqual(saved, before);
});
