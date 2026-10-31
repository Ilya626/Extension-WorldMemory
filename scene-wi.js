import { chatExchanges } from './vendor/summaryception/raw-context.js';
import { splitHint } from './history.js';
import { entryMeta, normalize } from './memory.js';

// The last completed exchange plus a new, unanswered player post. Retrieved
// history and hidden service hints must not introduce actors into the scene.
export function sceneText(chat = []) {
    const groups = chatExchanges(chat);
    const last = groups.at(-1);
    const scene = last?.hasAssistant ? [last] : [groups.findLast(group => group.hasAssistant), last];
    return scene.filter(Boolean).flatMap(group => group.indices)
        .map(index => chat[index]).filter(message => !message.is_system && !message.is_hidden)
        .map(message => `${message.name || ''}\n${splitHint(message.mes).text}`).join('\n');
}

/** Placement only, AFTER native activation, groups and token budgeting. */
export function placeSceneProfiles({ activated, catalogue = [], chat, mainNames = [], parseRegex, substitute = key => key,
    caseSensitive = false, atDepth = 4, isActivationReason = () => false }) {
    const lastUser = chat.findLastIndex(message => message.is_user && !message.is_system);
    if (lastUser < 0) return [];
    const depth = chat.length - lastUser;
    const text = sceneText(chat);
    const names = new Set([...mainNames, ...catalogue.filter(entry => entryMeta(entry)?.type === 'character')
        .map(entry => entry.comment)].map(normalize).filter(Boolean));
    const rawKeys = keys => typeof keys?.toJSON === 'function' ? keys.toJSON() : keys;
    const moved = [];
    for (const [id, entry] of activated) {
        const identityKeys = rawKeys(entry.key) || [];
        const character = entryMeta(entry)?.type === 'character' || names.has(normalize(entry.comment))
            || identityKeys.some(key => names.has(normalize(key)));
        if (!character) continue;
        const matches = (entry.key || []).some(key => {
            if (isActivationReason(key)) return false;
            const value = substitute(key)?.trim();
            if (!value) return false;
            const regex = parseRegex(value);
            if (regex) { regex.lastIndex = 0; return regex.test(text); }
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${escaped})(?![\\p{L}\\p{N}_])`,
                (entry.caseSensitive ?? caseSensitive) ? 'u' : 'iu').test(text);
        });
        if (!matches) continue;
        // Replace the scan object, never edit the loaded/persisted book object.
        activated.set(id, { ...entry, position: atDepth, depth });
        moved.push({ uid: entry.uid, world: entry.world, title: entry.comment });
    }
    return moved;
}
