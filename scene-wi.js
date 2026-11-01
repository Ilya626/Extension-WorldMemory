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

const nativeMirrors = new Set(('position excludeRecursion preventRecursion delayUntilRecursion displayIndex probability useProbability depth selectiveLogic outletName group groupOverride groupWeight scanDepth caseSensitive matchWholeWords useGroupScoring automationId role vectorized sticky cooldown delay matchPersonaDescription matchCharacterDescription matchCharacterPersonality matchCharacterDepthPrompt matchScenario matchCreatorNotes triggers ignoreBudget').split(' '));
const sortedValue = value => Array.isArray(value) ? value.map(sortedValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])])) : value;

/** Compare native entries across JSON/card conversions, keeping unknown fields.
 * ST stores some native settings a second time in the card's extensions object.
 */
export function profileSignature(entry, groupScoring = false) {
    const value = { ...entry, role: entry.role ?? 0, useGroupScoring: entry.useGroupScoring ?? groupScoring,
        characterFilter: entry.characterFilter ?? { isExclude: false, names: [], tags: [] }, extensions: { ...entry.extensions } };
    delete value.world; delete value.hash;
    for (const [key, setting] of Object.entries(value.extensions)) {
        const nativeKey = key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
        if (nativeMirrors.has(nativeKey) && JSON.stringify(setting) === JSON.stringify(value[nativeKey])) delete value.extensions[key];
    }
    return JSON.stringify(sortedValue(value));
}

/** A portable card can leave the same saved profile attached under two book names.
 * Only exact copies across books are redundant; different evidence is retained.
 * This operates on the request map, never the saved books or activation rules.
 */
export function removeDuplicateProfiles(activated, groupScoring = false) {
    const seen = new Map(), removed = [];
    for (const [id, entry] of activated) {
        if (entryMeta(entry)?.type !== 'character' || !entry.world || !entry.content?.trim()) continue;
        // ST updates timed effects from this map after the event. Keep timed
        // entries in native accounting even when two books have identical text.
        if (entry.sticky || entry.cooldown) continue;
        // UID, keys, manual metadata, conditions and insertion settings must match.
        const signature = profileSignature(entry, groupScoring);
        const first = seen.get(signature);
        if (first && first.world !== entry.world) {
            activated.delete(id);
            removed.push({ uid: entry.uid, world: entry.world, title: entry.comment, keptWorld: first.world });
        } else if (!first) seen.set(signature, entry);
    }
    return removed;
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
