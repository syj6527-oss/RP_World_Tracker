// Local-only filtering for status panels, audit logs and director notes that are
// embedded beside RP prose. These labels may guide generation, but they are not
// story events and must not be stored as memories.

const META_BLOCK_TAG = /<(director(?:_[\w-]+)?|scene_slate(?:_[\w-]+)?|state_panel|audit(?:_[\w-]+)?)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi;

const META_LINE = /^(?:[-*•]\s*)?(?:drift\s*(?:point|reason)|boundary|scene\s*target|scene\s*purpose|scene\s*register|genre\s*audit|loaded\s*genre\s*modules|detected\s*scene\s*register|dominant\s*register|module\s*impact|scene\s*vs\s*module|module\s*audit|active\s*genres|priority|conflict|focus|camera\s*plan|continuity|seeds?|carried\s*forward|character\s*motivation|production\s*plan|status|outfit|items?|characters?|time|date|location|current\s*location|scene|시간|날짜|장소|현재\s*위치|등장인물|복장|소지품|분위기|상태)\s*[:：]/i;

const META_HEADING = /^(?:#{1,6}\s*)?(?:🎬|🎭|📍|📋|🧭|⚙️|🔍)?\s*(?:director(?:\s+audit)?(?:\s+log)?|scene\s*target|genre\s*audit|module\s*audit|active\s*genres|camera\s*plan|continuity|carried\s*forward|character\s*motivation)\s*$/i;

const DECORATION_ONLY = /^(?:[━─═=_*#·•\-\s]{4,}|<\/?(?:director|scene_slate|state_panel|audit)[^>]*>)$/i;

export function isNonNarrativeMetadataLine(value) {
    const line = String(value || '').trim();
    if (!line) return false;
    return META_LINE.test(line) || META_HEADING.test(line) || DECORATION_ONLY.test(line);
}

export function stripNonNarrativeMetadata(value) {
    let text = String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(META_BLOCK_TAG, '\n');

    const kept = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (isNonNarrativeMetadataLine(line)) continue;
        kept.push(rawLine);
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
