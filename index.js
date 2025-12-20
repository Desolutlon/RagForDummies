/**
 * RagForDummies - A RAG extension for SillyTavern that actually works
 * Supports group chats with Qdrant vector storage
 */

const MODULE_NAME = 'RagForDummies';

// Whitelist/allowlist logging for this module
const MODULE_LOG_WHITELIST = [
    'Settings loaded',
    'Extension loaded successfully',
    'Container found',
    'Content found',
    'Initial check'
];

// Allow detailed confirmations and hybrid search traces
const MODULE_LOG_ALLOW_SUBSTR = [
    'Indexed message',
    'Deleted existing point',
    'Delete:',
    'Swipe:',
    'Edit:',
    'HYBRID',          // any HYBRID SEARCH header/detail
    'Run 1', 'Run 2',
    'Final', 'Score',
    'Collection:', 'Parameters:', 'Proper nouns',
    'validated results', 'dense', 'filtered',
    'Result', 'query filter', 'retrieved', 'retrieval', 'combined',
    'Query:',          // query message selection logging
    'Excluding'        // participant name exclusion logging
];

const __origConsoleLog = console.log.bind(console);
console.log = function(...args) {
    if (args.length && typeof args[0] === 'string' && args[0].startsWith('[' + MODULE_NAME + ']')) {
        const msg = args[0];
        const whitelisted = MODULE_LOG_WHITELIST.some(k => msg.indexOf(k) !== -1);
        const allowSubstr = MODULE_LOG_ALLOW_SUBSTR.some(k => msg.indexOf(k) !== -1);
        if (!whitelisted && !allowSubstr) {
            return; // suppress non-whitelisted/non-allowed module logs
        }
    }
    __origConsoleLog(...args);
};

// Extension settings with defaults
const defaultSettings = {
    enabled: true,
    qdrantLocalUrl: 'http://localhost:6333',
    embeddingProvider: 'kobold',
    koboldUrl: 'http://localhost:11434',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    openaiApiKey: '',
    openaiModel: 'text-embedding-3-small',
    retrievalCount: 5,
    similarityThreshold: 0.7,
    autoIndex: true,
    injectContext: true,
    injectionPosition: 'after_main',
    injectAfterMessages: 3,
    excludeLastMessages: 2,
    userBlacklist: ''
};

let extensionSettings = { ...defaultSettings };
let isIndexing = false;
let shouldStopIndexing = false;
let currentChatIndexed = false;
let lastMessageCount = 0;
let lastChatId = null;
let pollingInterval = null;
let indexedMessageIds = new Set();
let usePolling = false;
let eventsRegistered = false;
let lastInjectionTime = 0;
const INJECTION_DEBOUNCE_MS = 1000;

// ===========================
// Utility and NLP Functions
// ===========================

// --- The One, Master Blacklist to Rule Them All ---
const keywordBlacklist = new Set([
    // Your Original List
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose', 'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how',
    'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'upon', 'about', 'over', 'under', 'through', 'between', 'among', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there',
    'always', 'never', 'sometimes', 'often', 'usually', 'as', 'up', 'down', 'out', 'off', 'away', 'im', 'ive', 'id', 'ill', 'youre', 'youve', 'youd', 'youll', 'hes', 'shes',
    'weve', 'were', 'wed', 'well', 'theyve', 'theyre', 'theyd', 'theyll', 'isnt', 'arent', 'wasnt', 'werent', 'dont', 'doesnt', 'didnt', 'wont', 'wouldnt', 'couldnt',
    'shouldnt', 'cant', 'cannot', 'hadnt', 'hasnt', 'havent', 'lets', 'thats', 'whats', 'whos', 'hows', 'wheres', 'whens', 'whys', 'is', 'are', 'was', 'be', 'been',
    'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'say', 'said',
    'says', 'see', 'saw', 'seen', 'get', 'got', 'go', 'went', 'gone', 'come', 'came', 'know', 'knew', 'think', 'thought', 'make', 'made', 'take', 'took', 'want', 'wanted',
    'look', 'looked', 'give', 'gave', 'use', 'used', 'find', 'found', 'tell', 'told', 'let', 'put', 'keep', 'kept', 'leave', 'left', 'begin', 'began', 'seem', 'seemed',
    'help', 'helped', 'show', 'showed', 'hear', 'heard', 'play', 'played', 'run', 'ran', 'live', 'lived', 'believe', 'believed', 'hold', 'held', 'bring', 'brought',
    'write', 'wrote', 'read', 'sit', 'stand', 'lose', 'lost', 'pay', 'paid', 'meet', 'met', 'include', 'included', 'continue', 'continued', 'set', 'learn', 'learned',
    'change', 'changed', 'lead', 'led', 'understand', 'understood', 'watch', 'watched', 'follow', 'followed', 'stop', 'stopped', 'create', 'created', 'speak',
    'spoke', 'allow', 'allowed', 'add', 'added', 'spend', 'spent', 'grow', 'grew', 'open', 'opened', 'walk', 'walked', 'win', 'won', 'offer', 'offered', 'remember',
    'remembered', 'love', 'loved', 'consider', 'considered', 'appear', 'appeared', 'buy', 'bought', 'wait', 'waited', 'serve', 'served', 'die', 'died', 'send',
    'sent', 'expect', 'expected', 'build', 'built', 'stay', 'stayed', 'fall', 'fell', 'cut', 'reach', 'kill', 'killed', 'remain', 'remained', 'good', 'bad', 'great',
    'big', 'small', 'old', 'new', 'first', 'last', 'long', 'little', 'own', 'other', 'right', 'left', 'really', 'actually', 'probably', 'maybe', 'perhaps', 'definitely',
    'certainly', 'high', 'low', 'young', 'early', 'late', 'important', 'public', 'different', 'possible', 'full', 'special', 'free', 'strong', 'certain', 'real',
    'best', 'better', 'true', 'whole', 'oh', 'ah', 'um', 'uh', 'hey', 'hi', 'hello', 'bye', 'yes', 'no', 'yeah', 'yea', 'yep', 'nope', 'okay', 'ok', 'well', 'like', 'huh',
    'hmm', 'hm', 'mhm', 'ugh', 'ooh', 'oops', 'wow', 'whoa', 'god', 'omg', 'wtf', 'lol', 'lmao', 'rofl', 'today', 'tomorrow', 'yesterday', 'morning', 'afternoon', 'evening',
    'night', 'week', 'month', 'year', 'day', 'hour', 'minute', 'second', 'time', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'besides', 'however', 'although',
    'though', 'because', 'since', 'while', 'after', 'before', 'until', 'unless', 'anyway', 'anyways', 'meanwhile', 'furthermore', 'moreover', 'therefore',
    'otherwise', 'instead', 'still', 'maybe', 'perhaps', 'apparently', 'obviously', 'clearly', 'honestly', 'seriously', 'basically', 'literally', 'sure',
    'fine', 'thanks', 'thank', 'sorry', 'please', 'wait', 'stop', 'look', 'listen', 'watch', 'minor', 'major', 'nice', 'cool', 'awesome', 'amazing', 'terrible',
    'horrible', 'wonderful', 'beautiful', 'enough', 'exactly', 'absolutely', 'totally', 'completely', 'perfectly', 'simply', 'one', 'two', 'three', 'four',
    'five', 'six', 'seven', 'eight', 'nine', 'ten', 'something', 'nothing', 'everything', 'anything', 'someone', 'anyone', 'everyone', 'nobody', 'somewhere',
    'anywhere', 'everywhere', 'nowhere', 'much', 'many', 'lot', 'lots', 'bit', 'kind', 'sort', 'type', 'way', 'thing', 'things', 'stuff', 'even', 'ever', 'still',
    'already', 'yet', 'soon', 'later', 'again', 'once', 'twice', 'back', 'away', 'around', 'part', 'place', 'case', 'point', 'fact', 'hand', 'side', 'world', 'life',
    'work', 'home', 'end', 'man', 'men', 'woman', 'women', 'child', 'children', 'people', 'person', 'family', 'friend', 'friends', 'sealed', 'unsealed', 'suddenly',
    'quickly', 'slowly', 'gently', 'softly', 'quietly', 'loudly', 'smiles', 'smiling', 'smiled', 'laughs', 'laughing', 'laughed', 'sighs', 'sighing', 'sighed',
    'nods', 'nodding', 'nodded', 'shakes', 'shaking', 'shook', 'looks', 'looking', 'walks', 'walking', 'turns', 'turning', 'turned', 'stands', 'standing',
    'stood', 'sits', 'sitting', 'sat', 'grins', 'grinning', 'grinned', 'chuckles', 'chuckling', 'chuckled', 'giggles', 'giggling', 'giggled', 'pauses', 'pausing',
    'paused', 'thinks', 'thinking', 'feels', 'feeling', 'felt', 'takes', 'taking', 'gives', 'giving', 'puts', 'putting', 'gets', 'getting', 'moves', 'moving',
    'moved', 'steps', 'stepping', 'stepped', 'reaches', 'reaching', 'reached', 'pulls', 'pulling', 'pulled', 'pushes', 'pushing', 'pushed', 'holds', 'holding',
    'held', 'starts', 'starting', 'started', 'stops', 'stopping', 'stopped', 'tries', 'trying', 'tried', 'says', 'saying', 'asks', 'asking', 'asked', 'tells',
    'telling', 'replies', 'replying', 'replied', 'tilts', 'tilting', 'tilted', 'raises', 'raising', 'raised', 'lowers', 'lowering', 'lowered', 'leans', 'leaning',
    'leaned', 'rests', 'resting', 'rested', 'places', 'placing', 'placed', 'notices', 'noticing', 'noticed', 'realizes', 'realizing', 'realized', 'wonders',
    'wondering', 'wondered', 'blinks', 'blinking', 'blinked', 'stares', 'staring', 'stared', 'glances', 'glancing', 'glanced', 'whispers', 'whispering',
    'whispered', 'murmurs', 'murmuring', 'murmured', 'mutters', 'muttering', 'muttered', 'continues', 'continuing', 'continued', 'begins', 'beginning', 'began',
    'finishes', 'finishing', 'finished', 'seems', 'seeming', 'seemed', 'appears', 'appearing', 'appeared', 'sounds', 'sounding', 'sounded', 'tone', 'voice',
    'expression', 'face', 'eyes', 'head', 'body', 'arm', 'arms', 'hand', 'hands', 'finger', 'fingers', 'teasing', 'teased', 'smug', 'smugly',
    'playful', 'playfully', 'curious', 'curiously', 'nervous', 'nervously', 'soft', 'warm', 'cold', 'hot', 'light', 'dark', 'bright', 'quiet', 'loud', 'gentle',
    'rough', 'slight', 'slightly', 'brief', 'briefly', 'quick', 'slow', 'sudden', 'careful', 'carefully', 'saturdays', 'sundays', 'mondays', 'tuesdays', 'wednesdays',
    // Our new additions
    "we've", "you're", "he's", "she's", "it's", "they're",
    'yourself', 'worry', 'mr', 'mrs', 'sir', 'maam',
    // Swear words
    'fuck', 'fucking', 'fucked', 'shit', 'shitty', 'damn', 'damned', 'hell', 'ass', 'crap', 'crappy', 'bitch', 'dumbass', 'tonight', 'yesterdays', 'todays', 'tomorrows', 'tonights', 'thursdays', 'fridays', 'motherfucker', 'fucker', 'shitter', 'cunt'
]);

// Helper function to get user-defined blacklist as a Set
function getUserBlacklistSet() {
    if (!extensionSettings.userBlacklist) return new Set();
    return new Set(
        extensionSettings.userBlacklist
            .toLowerCase()
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0)
    );
}

function extractKeywords(text, excludeNames = new Set()) {
    if (typeof window.nlp === 'undefined' || !text) {
        return [];
    }

    const wordsInText = text.split(/\s+/).length;

    if (wordsInText < 100) {
        return [];
    }
    
    const baseKeywords = 5;
    const scalingFactor = 3;
    const additionalKeywords = Math.floor((wordsInText - 100) / 100) * scalingFactor;
    const limit = baseKeywords + additionalKeywords;

    const finalKeywords = new Set();
    const doc = window.nlp(text);

    const processTerm = (term) => {
        const cleaned = term.toLowerCase().replace(/[^a-z]/g, "");

        // Run the full validation gauntlet
        if (
            cleaned && cleaned.length > 2 &&
            !excludeNames.has(cleaned) &&
            !keywordBlacklist.has(cleaned) &&
            !window.nlp(cleaned).has('#Verb') &&     // Strict verb filtering
            !window.nlp(cleaned).has('#Pronoun') &&  // Strict pronoun filtering
            window.nlp(cleaned).has('#Noun')         // Must be a noun
        ) {
            finalKeywords.add(cleaned);
        }
    };

    // Get topics and quotations as potential keyword sources
    const topics = doc.topics().out('array');
    const quotes = doc.quotations().out('array');
    const potentialSources = [...topics, ...quotes];

    for (const source of potentialSources) {
        const words = source.split(/\s+/);
        for (const word of words) {
            processTerm(word);
        }
    }

    return Array.from(finalKeywords).slice(0, limit);
}

function extractProperNouns(text, excludeNames) {
    if (excludeNames === undefined) excludeNames = new Set();
    if (!text || typeof text !== 'string') return [];
    
    const properNouns = new Set();
    const sentences = text.split(/[.!?*]+|["'"]\s*/);
    
    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        if (!sentence) continue;
        
        const words = sentence.split(/\s+/);
        
        for (let j = 0; j < words.length; j++) {
            const word = words[j];
            
            if (j > 0 && /^[A-Z]/.test(word)) {
                const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");

                if (
                    cleaned && cleaned.length > 2 &&
                    !excludeNames.has(cleaned) &&
                    !keywordBlacklist.has(cleaned)
                ) {
                    properNouns.add(cleaned);
                }
            }
        }
    }
    
    return Array.from(properNouns);
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 8);
        return v.toString(16);
    });
}

function getParticipantNames(contextOrChat) {
    const names = new Set();
    let context = contextOrChat;
    if (Array.isArray(contextOrChat)) {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            context = SillyTavern.getContext();
        } else if (typeof getContext === 'function') {
            context = getContext();
        } else {
            context = null;
        }
    }
    
    if (context) {
        if (context.name1) {
            names.add(context.name1.toLowerCase());
            const parts = context.name1.toLowerCase().split(/\s+/);
            parts.forEach(p => { if (p.length >= 2) names.add(p); });
        }
        if (context.name2) {
            names.add(context.name2.toLowerCase());
            const parts = context.name2.toLowerCase().split(/\s+/);
            parts.forEach(p => { if (p.length >= 2) names.add(p); });
        }
        if (context.groups && context.groupId) {
            const group = context.groups.find(g => g.id === context.groupId);
            if (group && group.members) {
                group.members.forEach(member => {
                    if (member && member.name) {
                        names.add(member.name.toLowerCase());
                        const parts = member.name.toLowerCase().split(/\s+/);
                        parts.forEach(p => { if (p.length >= 2) names.add(p); });
                    }
                });
            }
        }
        if (context.chat && Array.isArray(context.chat)) {
            context.chat.forEach(msg => {
                if (msg.name && typeof msg.name === 'string') {
                    names.add(msg.name.toLowerCase());
                    const parts = msg.name.toLowerCase().split(/\s+/);
                    parts.forEach(p => { if (p.length >= 2) names.add(p); });
                }
            });
        }
    }
    
    if (Array.isArray(contextOrChat)) {
        contextOrChat.forEach(msg => {
            if (msg.name && typeof msg.name === 'string') {
                names.add(msg.name.toLowerCase());
                const parts = msg.name.toLowerCase().split(/\s+/);
                parts.forEach(p => { if (p.length >= 2) names.add(p); });
            }
        });
    }
    
    return names;
}

function extractQueryFilterTerms(text, excludeNames) {
    if (excludeNames === undefined) excludeNames = new Set();
    if (!text || typeof text !== 'string') return [];
    const terms = new Set();
    let cleaned = text.replace(/\*+/g, ' ').replace(/\.{2,}/g, ' ').replace(/["']/g, ' ');
    const words = cleaned.toLowerCase().split(/[^a-z0-9]+/);
    const userBlacklist = getUserBlacklistSet();
    for (const word of words) {
        if (word.length < 2 || word.length > 30) continue;
        if (excludeNames.has(word)) continue;
        if (userBlacklist.has(word)) continue;
        terms.add(word);
    }
    return Array.from(terms);
}

// ===========================
// Conversion Helpers (JSONL)
// ===========================

function convertChatToJSONL(context) {
    if (!context || !Array.isArray(context.chat)) {
        throw new Error('Invalid context: chat array missing');
    }
    const lines = [];
    const chatId = (context.chatMetadata && context.chatMetadata.chat_id_hash) || context.chat_id || Date.now().toString();
    const metadata = { chat_metadata: { chat_id_hash: chatId, ...(context.chatMetadata || {}) } };
    lines.push(JSON.stringify(metadata));
    context.chat.forEach((msg) => {
        if (!msg || typeof msg.mes === 'undefined') return;
        const payload = {
            name: msg.name || msg.character || 'Unknown', mes: msg.mes, is_user: !!msg.is_user || msg.role === 'user',
            is_system: !!msg.is_system, send_date: msg.send_date || msg.date || '', tracker: msg.tracker || {},
            extra: msg.extra || {}, present: msg.present || msg.characters_present || []
        };
        lines.push(JSON.stringify(payload));
    });
    return lines.join('\n');
}

function convertTextToJSONL(text) {
    const lines = [];
    const chatId = Date.now().toString();
    lines.push(JSON.stringify({ chat_metadata: { chat_id_hash: chatId } }));
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    rows.forEach((row) => {
        lines.push(JSON.stringify({
            name: 'User', mes: row, is_user: true, is_system: false, send_date: '',
            tracker: {}, extra: {}, present: []
        }));
    });
    return lines.join('\n');
}

// ===========================
// Qdrant Client Functions
// ===========================

async function qdrantRequest(endpoint, method = 'GET', body = null) {
    const baseUrl = extensionSettings.qdrantLocalUrl;
    const headers = { 'Content-Type': 'application/json' };
    const options = { method: method, headers: headers, body: body ? JSON.stringify(body) : null };
    try {
        const response = await fetch(baseUrl + endpoint, options);
        if (!response.ok) {
            const error = await response.text();
            throw new Error('Qdrant error: ' + response.status + ' - ' + error);
        }
        return await response.json();
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Qdrant request failed:', error);
        throw error;
    }
}

async function createCollection(collectionName, vectorSize = 1536) {
    try {
        const collections = await qdrantRequest('/collections');
        if (collections.result.collections.some(c => c.name === collectionName)) {
            console.log('[' + MODULE_NAME + '] Collection ' + collectionName + ' already exists');
            await createPayloadIndex(collectionName);
            return true;
        }
        await qdrantRequest('/collections/' + collectionName, 'PUT', { vectors: { size: vectorSize, distance: 'Cosine' } });
        console.log('[' + MODULE_NAME + '] Created collection: ' + collectionName);
        await createPayloadIndex(collectionName);
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to create collection:', error);
        throw error;
    }
}

async function createPayloadIndex(collectionName) {
    try {
        await qdrantRequest('/collections/' + collectionName + '/index', 'PUT', { field_name: 'proper_nouns', field_schema: 'keyword' });
        console.log('[' + MODULE_NAME + '] Created payload index for proper_nouns on ' + collectionName);
        return true;
    } catch (error) {
        if (error.message && error.message.indexOf('already exists') !== -1) {
            console.log('[' + MODULE_NAME + '] Payload index already exists for ' + collectionName);
            return true;
        }
        console.warn('[' + MODULE_NAME + '] Could not create payload index (non-fatal):', error.message);
        return false;
    }
}

async function upsertVectors(collectionName, points) {
    try {
        await qdrantRequest('/collections/' + collectionName + '/points', 'PUT', { points: points });
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to upsert vectors:', error);
        throw error;
    }
}

async function deleteMessageByIndex(collectionName, chatIdHash, messageIndex) {
    try {
        await qdrantRequest('/collections/' + collectionName + '/points/delete', 'POST', {
            filter: { must: [{ key: 'chat_id_hash', match: { value: chatIdHash } }, { key: 'message_index', match: { value: messageIndex } }] }, wait: true
        });
        console.log('[' + MODULE_NAME + '] Deleted existing point for message_index=' + messageIndex);
    } catch (err) {
        console.warn('[' + MODULE_NAME + '] Delete (by message_index) failed:', err.message);
    }
}

async function searchVectors(collectionName, vector, limit, scoreThreshold, properNouns, maxIndex) {
    if (limit === undefined || limit === null) limit = extensionSettings.retrievalCount || 5;
    if (scoreThreshold === undefined) scoreThreshold = extensionSettings.similarityThreshold || 0.7;
    if (properNouns === undefined) properNouns = [];
    if (maxIndex === undefined || maxIndex === null) maxIndex = 999999999;

    const denseTarget = Math.max(1, Math.ceil(limit / 2));
    const filteredTarget = limit - denseTarget;
    const denseFetch = Math.max(limit * 2, denseTarget * 4);
    const filteredFetch = Math.max(limit * 2, filteredTarget * 4);

    try {
        console.log('[' + MODULE_NAME + '] ===== HYBRID SEARCH =====');
        console.log('[' + MODULE_NAME + '] Collection: ' + collectionName);
        console.log('[' + MODULE_NAME + '] Ignoring messages with index >= ' + maxIndex);
        console.log('[' + MODULE_NAME + '] Proper nouns: ' + (properNouns.length > 0 ? properNouns.join(', ') : '(none)'));

        const rangeFilter = { key: 'message_index', range: { lt: maxIndex } };
        const denseFilter = { must: [ rangeFilter ] };

        const densePromise = qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', {
            vector: vector, limit: denseFetch, score_threshold: scoreThreshold, with_payload: true, filter: denseFilter
        });

        let filteredPromise = Promise.resolve({ result: [] });
        if (properNouns.length > 0 && filteredTarget > 0) {
            const keywordFilter = { must: [ rangeFilter, { key: 'proper_nouns', match: { any: properNouns } } ] };
            filteredPromise = qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', {
                vector: vector, limit: filteredFetch, score_threshold: scoreThreshold, with_payload: true, filter: keywordFilter
            });
        }

        const [denseResp, filteredResp] = await Promise.all([densePromise, filteredPromise]);

        const denseResults = (denseResp && denseResp.result) ? denseResp.result : [];
        const rawFiltered = (filteredResp && filteredResp.result) ? filteredResp.result : [];
        let filteredResults = [];
        if (rawFiltered.length > 0) {
            filteredResults = rawFiltered.filter(r => (r.payload && r.payload.proper_nouns || []).some(noun => properNouns.indexOf(noun) !== -1));
            console.log('[' + MODULE_NAME + '] --- Filtered Matches Detail ---');
            filteredResults.forEach(r => {
                const resultNouns = r.payload.proper_nouns || [];
                const matchedTerms = resultNouns.filter(n => properNouns.indexOf(n) !== -1);
                const idx = r.payload.message_index;
                const msgSnippet = (r.payload.full_message || '').substring(0, 50).replace(/\n/g, ' ');
                console.log(`[${MODULE_NAME}] Match (Idx: ${idx}, Score: ${r.score.toFixed(3)}) | Terms: [${matchedTerms.join(', ')}] | "${msgSnippet}..."`);
            });
            console.log('[' + MODULE_NAME + '] -----------------------------');
        }

        const seenIds = new Set();
        const finalResults = [];
        for (const r of filteredResults) {
            if (finalResults.length >= filteredTarget) break;
            if (seenIds.has(r.id)) continue;
            r._source = 'filtered';
            finalResults.push(r);
            seenIds.add(r.id);
        }
        for (const r of denseResults) {
            if (finalResults.length >= limit) break;
            if (seenIds.has(r.id)) continue;
            r._source = 'dense';
            finalResults.push(r);
            seenIds.add(r.id);
        }
        if (finalResults.length < limit) {
            for (const r of filteredResults) {
                if (finalResults.length >= limit) break;
                if (seenIds.has(r.id)) continue;
                r._source = 'filtered';
                finalResults.push(r);
                seenIds.add(r.id);
            }
        }

        finalResults.sort((a, b) => b.score - a.score);
        console.log('[' + MODULE_NAME + '] Final results: ' + finalResults.length + 
            ' (filtered: ' + finalResults.filter(r => r._source === 'filtered').length + 
            ', dense: ' + finalResults.filter(r => r._source === 'dense').length + ')');
        return finalResults;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Hybrid search failed:', error);
        return [];
    }
}
async function getCollectionInfo(collectionName) {
    try {
        return (await qdrantRequest('/collections/' + collectionName)).result;
    } catch (error) {
        return null;
    }
}

async function countPoints(collectionName) {
    try {
        const info = await getCollectionInfo(collectionName);
        return info ? info.points_count : 0;
    } catch (error) {
        return 0;
    }
}

async function deleteCollection(collectionName) {
    try {
        await qdrantRequest('/collections/' + collectionName, 'DELETE');
        console.log('[' + MODULE_NAME + '] Deleted collection: ' + collectionName);
        return true;
    } catch (error) {
        if (error.message && error.message.indexOf('404') !== -1) {
            console.log('[' + MODULE_NAME + '] Collection did not exist: ' + collectionName);
            return true;
        }
        console.error('[' + MODULE_NAME + '] Failed to delete collection:', error);
        throw error;
    }
}

async function forceReindexCurrentChat() {
    const chatId = getCurrentChatId();
    if (!chatId) throw new Error('No active chat found');
    const isGroupChat = isCurrentChatGroupChat();
    const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatId;
    console.log('[' + MODULE_NAME + '] Force re-indexing: ' + collectionName);
    updateUI('status', 'Deleting old collection...');
    await deleteCollection(collectionName);
    currentChatIndexed = false;
    lastMessageCount = 0;
    indexedMessageIds.clear();
    let context;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        context = SillyTavern.getContext();
    } else if (typeof getContext === 'function') {
        context = getContext();
    }
    if (!context || !context.chat || context.chat.length === 0) throw new Error('No chat messages to index');
    const jsonl = convertChatToJSONL(context);
    await indexChat(jsonl, chatId, isGroupChat);
    currentChatIndexed = true;
    console.log('[' + MODULE_NAME + '] Force re-index complete');
}

// ===========================
// Embedding Provider Functions
// ===========================

async function generateEmbedding(text) {
    const provider = extensionSettings.embeddingProvider;
    try {
        if (provider === 'kobold') return await generateKoboldEmbedding(text);
        if (provider === 'ollama') return await generateOllamaEmbedding(text);
        if (provider === 'openai') return await generateOpenAIEmbedding(text);
        throw new Error('Unknown embedding provider: ' + provider);
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to generate embedding:', error);
        throw error;
    }
}
async function generateKoboldEmbedding(text) {
    const isArray = Array.isArray(text);
    const input = isArray ? text : [text];
    const response = await fetch(extensionSettings.koboldUrl + '/api/v1/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: input, model: "text-embedding-ada-002" })
    });
    if (!response.ok) throw new Error('KoboldCpp API error: ' + response.status + ' - ' + await response.text());
    const data = await response.json();
    return isArray ? data.data.map(d => d.embedding) : data.data[0].embedding;
}
async function generateOllamaEmbedding(text) {
    const isArray = Array.isArray(text);
    if (isArray) return Promise.all(text.map(t => generateOllamaEmbedding(t)));
    const response = await fetch(extensionSettings.ollamaUrl + '/api/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: extensionSettings.ollamaModel, prompt: text })
    });
    if (!response.ok) throw new Error('Ollama API error: ' + response.status);
    const data = await response.json();
    return data.embedding;
}
async function generateOpenAIEmbedding(text) {
    const isArray = Array.isArray(text);
    const input = isArray ? text : [text];
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + extensionSettings.openaiApiKey },
        body: JSON.stringify({ model: extensionSettings.openaiModel, input: input })
    });
    if (!response.ok) throw new Error('OpenAI API error: ' + response.status);
    const data = await response.json();
    const embeddings = data.data.map(d => d.embedding);
    return isArray ? embeddings : embeddings[0];
}

// ===========================
// JSONL Parsing and Indexing
// ===========================

function parseJSONL(jsonlContent) {
    const lines = jsonlContent.trim().split('\n');
    const messages = [];
    let chatMetadata = null;
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed.chat_metadata) chatMetadata = parsed.chat_metadata;
            else if (parsed.mes) messages.push(parsed);
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Failed to parse JSONL line:', error);
        }
    }
    return { chatMetadata, messages };
}

function buildEmbeddingText(message, tracker) {
    const parts = ['[Character: ' + message.name + ']'];
    if (tracker) {
        if (tracker.Time) parts.push('[Time: ' + tracker.Time + ']');
        if (tracker.Topics && tracker.Topics.PrimaryTopic) parts.push('[Topic: ' + tracker.Topics.PrimaryTopic + ']');
        if (tracker.Topics && tracker.Topics.EmotionalTone) parts.push('[Tone: ' + tracker.Topics.EmotionalTone + ']');
    }
    if (message.extra && message.extra.qvink_memory && message.extra.qvink_memory.memory) {
        parts.push('\nSummary: ' + message.extra.qvink_memory.memory);
    }
    parts.push('\nMessage: ' + message.mes);
    return parts.join(' ');
}

function extractPayload(message, messageIndex, chatIdHash, participantNames) {
    const tracker = message.tracker || {};
    let charactersPresent = (message.present && Array.isArray(message.present))
        ? message.present.map(avatar => avatar.replace(/\.png$/, ''))
        : (tracker.CharactersPresent && Array.isArray(tracker.CharactersPresent) ? tracker.CharactersPresent : []);

    if (message.name && message.name !== 'User' && !charactersPresent.some(cp => String(cp).toLowerCase() === String(message.name).toLowerCase())) {
        charactersPresent.push(message.name);
    }
    
    // --- Normalize asterisk emphasis before keyword extraction ---
    // Fixes "like*your*" → "like your" to prevent fused word indexing
    const normalizedMessage = (message.mes || '').replace(/(\w)\*+(\w)/g, '$1 $2');
    
    // --- The Unified Keyword Pipeline ---
    const properNounCandidates = extractProperNouns(normalizedMessage, participantNames);
    const commonKeywordCandidates = extractKeywords(normalizedMessage, participantNames);

    const allKeywords = new Set([...properNounCandidates, ...commonKeywordCandidates]);
    // --- End Pipeline ---

    const summary = (message.extra && message.extra.qvink_memory && message.extra.qvink_memory.memory) ? message.extra.qvink_memory.memory : '';
    
    return {
        chat_id_hash: chatIdHash, message_index: messageIndex, character_name: message.name, is_user: !!message.is_user,
        timestamp: message.send_date || '', summary: summary, full_message: message.mes, characters_present: charactersPresent,
        topic: (tracker.Topics && tracker.Topics.PrimaryTopic) || '', emotional_tone: (tracker.Topics && tracker.Topics.EmotionalTone) || '',
        location: (tracker.Characters && tracker.Characters[message.name] && tracker.Characters[message.name].Location) || '',
        proper_nouns: Array.from(allKeywords)
    };
}


function getQueryMessage(context, idxOverride, generationType) {
    if (idxOverride === undefined) idxOverride = null;
    if (generationType === undefined) generationType = 'normal';
    
    if (!context || !context.chat || !Array.isArray(context.chat) || context.chat.length === 0) return null;
    if (idxOverride !== null && idxOverride >= 0 && idxOverride < context.chat.length) {
        const m = context.chat[idxOverride];
        if (m && m.mes && m.mes.trim() && !m.is_system) return m;
    }
    let lastMsgIdx = -1;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (!msg || !msg.mes || !msg.mes.trim() || msg.is_system) continue;
        lastMsgIdx = i;
        break;
    }
    if (lastMsgIdx === -1) return null;
    const lastMsg = context.chat[lastMsgIdx];
    const isSwipeOrRegen = generationType === 'swipe' || generationType === 'regenerate' || generationType === 'continue';
    if (isSwipeOrRegen && !lastMsg.is_user && lastMsgIdx > 0) {
        for (let i = lastMsgIdx - 1; i >= 0; i--) {
            const prevMsg = context.chat[i];
            if (!prevMsg || !prevMsg.mes || !prevMsg.mes.trim() || prevMsg.is_system) continue;
            console.log('[' + MODULE_NAME + '] Query: ' + generationType + ' detected - using PREVIOUS message (idx ' + i + ')');
            return prevMsg;
        }
    }
    console.log('[' + MODULE_NAME + '] Query: Using last message (idx ' + lastMsgIdx + ', ' + (lastMsg.is_user ? 'user' : lastMsg.name || 'char') + ')');
    return lastMsg;
}

async function indexChat(jsonlContent, chatIdHash, isGroupChat = false) {
    if (isIndexing) {
        console.log('[' + MODULE_NAME + '] Already indexing, please wait...');
        return false;
    }
    isIndexing = true;
    shouldStopIndexing = false;
    console.log('[' + MODULE_NAME + '] Starting indexing process...');
    updateUI('status', 'Preparing to index...');
    showStopButton();
    
    try {
        const { messages } = parseJSONL(jsonlContent);
        if (messages.length === 0) throw new Error('No messages found in chat');

        const participantNames = getParticipantNames(messages);
        console.log('[' + MODULE_NAME + '] Excluding participant names: ' + Array.from(participantNames).join(', '));
        
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;
        const existingPoints = await countPoints(collectionName);
        if (existingPoints >= messages.length) {
            console.log('[' + MODULE_NAME + '] Collection already fully indexed (' + existingPoints + ' points)');
            updateUI('status', 'Chat already indexed (' + existingPoints + ' messages)');
            isIndexing = false;
            hideStopButton();
            return true;
        }
        
        console.log('[' + MODULE_NAME + '] Need to index ' + messages.length + ' messages (existing: ' + existingPoints + ')');
        updateUI('status', 'Getting embedding dimensions...');
        const vectorSize = (await generateEmbedding(buildEmbeddingText(messages[0], messages[0].tracker))).length;
        await createCollection(collectionName, vectorSize);
        
        const EMBEDDING_BATCH_SIZE = 1024;
        const upsertBatchSize = 10;
        
        for (let batchStart = 0; batchStart < messages.length; batchStart += EMBEDDING_BATCH_SIZE) {
            if (shouldStopIndexing) {
                console.log('[' + MODULE_NAME + '] Indexing stopped by user.');
                updateUI('status', 'Stopped at ' + batchStart + '/' + messages.length);
                isIndexing = false;
                hideStopButton();
                return false;
            }
            
            const batchEnd = Math.min(batchStart + EMBEDDING_BATCH_SIZE, messages.length);
            const batchMessages = messages.slice(batchStart, batchEnd);
            updateUI('status', 'Indexing ' + batchStart + '-' + batchEnd + '/' + messages.length + '...');
            
            const embeddingTexts = batchMessages.map(msg => buildEmbeddingText(msg, msg.tracker));
            const embeddings = await generateEmbedding(embeddingTexts);
            
            const points = [];
            for (let i = 0; i < batchMessages.length; i++) {
                const message = batchMessages[i];
                const messageIndex = batchStart + i;
                const payload = extractPayload(message, messageIndex, chatIdHash, participantNames);
                points.push({ id: generateUUID(), vector: embeddings[i], payload: payload });
                if (points.length >= upsertBatchSize) {
                    await upsertVectors(collectionName, [...points]);
                    points.length = 0;
                }
            }
            if (points.length > 0) {
                await upsertVectors(collectionName, points);
            }
        }
        
        updateUI('status', 'Successfully indexed ' + messages.length + ' messages!');
        console.log('[' + MODULE_NAME + '] Successfully indexed ' + messages.length + ' messages');
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Indexing failed:', error);
        updateUI('status', 'Indexing failed: ' + error.message);
    } finally {
        isIndexing = false;
        shouldStopIndexing = false;
        hideStopButton();
    }
}


async function indexSingleMessage(message, chatIdHash, messageIndex, isGroupChat = false) {
    try {
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;
        const participantNames = getParticipantNames(null);
        const embedding = await generateEmbedding(buildEmbeddingText(message, message.tracker));
        const payload = extractPayload(message, messageIndex, chatIdHash, participantNames);
        const point = { id: generateUUID(), vector: embedding, payload: payload };
        await upsertVectors(collectionName, [point]);
        console.log('[' + MODULE_NAME + '] Indexed message ' + messageIndex);
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to index message:', error);
        return false;
    }
}

// ===========================
// Context Retrieval
// ===========================

async function retrieveContext(query, chatIdHash, isGroupChat = false) {
    try {
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            context = SillyTavern.getContext();
        } else if (typeof getContext === 'function') {
            context = getContext();
        }
        
        const excludeCount = extensionSettings.excludeLastMessages !== undefined ? extensionSettings.excludeLastMessages : 2;
        const maxIndex = (context && context.chat) ? Math.max(0, context.chat.length - excludeCount) : 999999999;
        
        const participantNames = getParticipantNames(null);
        const queryFilterTerms = extractQueryFilterTerms(query, participantNames);
        const queryEmbedding = await generateEmbedding(query);
        
        const results = await searchVectors(collectionName, queryEmbedding, extensionSettings.retrievalCount, extensionSettings.similarityThreshold, queryFilterTerms, maxIndex);
        
        if (results.length === 0) {
            console.log('[' + MODULE_NAME + '] No relevant context found');
            return '';
        }

        const activeChar = getActiveCharacterName();
        let filteredByPresence = results;
        if (activeChar) {
            const target = activeChar.toLowerCase();
            filteredByPresence = results.filter(r => (r.payload.characters_present || []).some(name => String(name).toLowerCase() === target));
            if (filteredByPresence.length !== results.length) {
                console.log('[' + MODULE_NAME + '] Filtered out ' + (results.length - filteredByPresence.length) + ' result(s) where "' + activeChar + '" was not present');
            }
        }
        if (filteredByPresence.length === 0) {
            console.log('[' + MODULE_NAME + '] No context left after characters_present filter');
            return '';
        }
        
        console.log('[' + MODULE_NAME + '] Retrieved ' + filteredByPresence.length + ' messages with scores:', filteredByPresence.map(r => r.score.toFixed(3)).join(', '));
        
        const contextParts = filteredByPresence.map(result => {
            const p = result.payload;
            const score = result.score;
            let text = `\n[Character: ${p.character_name}]\n[Time: ${p.timestamp}]\n[Relevance Score: ${score.toFixed(3)} (${result._source || 'unknown'})]`;
            if (p.summary) text += `\n\nSummary: ${p.summary}`;
            text += `\n\nFull Message: ${p.full_message}`;
            return text;
        });
        
        const contextString = '\n\n========== RELEVANT PAST CONTEXT FROM RAG ==========\n' + contextParts.join('\n\n-------------------\n') + '\n\n========== END RAG CONTEXT ==========\n\n';
        console.log('[' + MODULE_NAME + '] Formatted context with full metadata (' + contextString.length + ' chars)');
        return contextString;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Context retrieval failed:', error);
        return '';
    }
}

// ===========================
// SillyTavern Integration
// ===========================

function getCurrentChatId() {
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        return (context && context.chatMetadata && context.chatMetadata.chat_id_hash) || (context && context.chat_id) || null;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Error getting chat ID:', error);
        return null;
    }
}
function getActiveCharacterName() {
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        if (!context) return null;
        return context.character?.name || context.chatMetadata?.character_name || context.main?.name || null;
    } catch (e) {
        console.warn('[' + MODULE_NAME + '] getActiveCharacterName failed:', e);
    }
    return null;
}
function isCurrentChatGroupChat() {
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        return context && context.groupId !== null && context.groupId !== undefined;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Error checking group chat:', error);
        return false;
    }
}
async function onChatLoaded() {
    currentChatIndexed = false;
    lastMessageCount = 0;
    indexedMessageIds.clear();
    const chatId = getCurrentChatId();
    lastChatId = chatId;
    console.log('[' + MODULE_NAME + '] Chat loaded. Chat ID:', chatId);
    updateUI('status', 'Chat loaded - checking index...');
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        if (context && context.chat) lastMessageCount = context.chat.length;
        if (chatId) {
            const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
            const pointCount = await countPoints(collectionName);
            if (pointCount > 0) {
                currentChatIndexed = true;
                updateUI('status', 'Indexed (' + pointCount + ' messages)');
            } else {
                updateUI('status', 'Ready to index');
            }
        }
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Error in onChatLoaded:', error);
    }
}
async function onMessageSent(messageData) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const isGroupChat = isCurrentChatGroupChat();
    if (!currentChatIndexed && typeof SillyTavern !== 'undefined') {
        try {
            const context = SillyTavern.getContext();
            if (context.chat && context.chat.length > 0) {
                await indexChat(convertChatToJSONL(context), chatId, isGroupChat);
                currentChatIndexed = true;
            }
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Auto-indexing failed:', error);
        }
    }
    if (messageData && currentChatIndexed) {
        await indexSingleMessage(messageData, chatId, SillyTavern.getContext().chat.length - 1, isGroupChat);
    }
}
async function onMessageReceived(messageData) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    if (currentChatIndexed && typeof SillyTavern !== 'undefined') {
        try {
            const context = SillyTavern.getContext();
            if (context.chat && context.chat.length > 0) {
                const messageIndex = context.chat.length - 1;
                if (!indexedMessageIds.has(messageIndex)) {
                    await indexSingleMessage(context.chat[messageIndex], chatId, messageIndex, isCurrentChatGroupChat());
                    indexedMessageIds.add(messageIndex);
                    lastMessageCount = context.chat.length;
                }
            }
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Failed to index received message:', error);
        }
    }
}
async function onMessageSwiped(data) {
    if (!extensionSettings.enabled) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
    let targetIndex = (typeof data === 'number') ? data : (data && typeof data.index === 'number' ? data.index : null);
    (async () => {
        try {
            if (!currentChatIndexed && await countPoints(collectionName) === 0) return;
            currentChatIndexed = true;
            const context = await (async (idx, maxWaitMs = 2500) => {
                const start = Date.now();
                const readCtx = () => {
                    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : (typeof getContext === 'function' ? getContext() : null);
                    return { ctx, mes: (ctx?.chat?.[idx])?.mes || null };
                };
                const { mes: initial } = readCtx();
                let lastSeen = initial, stableCount = 0;
                while (Date.now() - start < maxWaitMs) {
                    await new Promise(res => setTimeout(res, 100));
                    const { ctx, mes } = readCtx();
                    if (!ctx?.chat?.[idx] || (mes === initial)) continue;
                    if (mes === lastSeen) stableCount++; else { stableCount = 1; lastSeen = mes; }
                    if (stableCount >= 2) { await new Promise(res => setTimeout(res, 100)); return ctx; }
                }
                return readCtx().ctx;
            })(targetIndex !== null ? targetIndex : (SillyTavern.getContext()?.chat.length - 1 || 0));
            if (!context?.chat?.length) return;
            if (targetIndex === null || targetIndex < 0 || targetIndex >= context.chat.length) targetIndex = context.chat.length - 1;
            const message = context.chat[targetIndex];
            if (!message) return;
            await deleteMessageByIndex(collectionName, chatId, targetIndex);
            await indexSingleMessage(message, chatId, targetIndex, isCurrentChatGroupChat());
            indexedMessageIds.add(targetIndex);
            console.log('[' + MODULE_NAME + '] Swipe: re-indexed message ' + targetIndex);
        } catch (err) {
            console.error('[' + MODULE_NAME + '] Swipe reindex failed:', err);
        }
    })();
}
async function onMessageDeleted(data) {
    if (!extensionSettings.enabled) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
    if (!currentChatIndexed) {
        try { if (await countPoints(collectionName) === 0) return; currentChatIndexed = true; } catch (e) { return; }
    }
    const messageIndex = typeof data === 'number' ? data : null;
    if (messageIndex === null) return;
    await deleteMessageByIndex(collectionName, chatId, messageIndex);
    indexedMessageIds.delete(messageIndex);
}
async function onMessageEdited(data) {
    if (!extensionSettings.enabled) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
    if (!currentChatIndexed) {
        try { if (await countPoints(collectionName) === 0) return; currentChatIndexed = true; } catch (e) { return; }
    }
    const messageIndex = typeof data === 'number' ? data : (data && typeof data.index === 'number' ? data.index : null);
    if (messageIndex === null) return;
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        if (!context?.chat?.[messageIndex]) return;
        const message = context.chat[messageIndex];
        await deleteMessageByIndex(collectionName, chatId, messageIndex);
        await indexSingleMessage(message, chatId, messageIndex, isCurrentChatGroupChat());
        console.log('[' + MODULE_NAME + '] Edit: re-indexed message ' + messageIndex);
    } catch (err) {
        console.error('[' + MODULE_NAME + '] Edit reindex failed:', err);
    }
}
async function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(async () => {
        try {
            if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
            const chatId = getCurrentChatId();
            if (!chatId) return;
            let context = null;
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
            else if (typeof getContext === 'function') context = getContext();
            if (!context?.chat) return;
            const isGroupChat = isCurrentChatGroupChat();
            if (!currentChatIndexed) {
                if (context.chat.length === 0) return;
                await indexChat(convertChatToJSONL(context), chatId, isGroupChat);
                currentChatIndexed = true;
                lastMessageCount = context.chat.length;
                return;
            }
            if (context.chat.length > lastMessageCount) {
                for (let i = lastMessageCount; i < context.chat.length; i++) {
                    await indexSingleMessage(context.chat[i], chatId, i, isGroupChat);
                    indexedMessageIds.add(i);
                }
                lastMessageCount = context.chat.length;
            }
        } catch (e) {
            console.warn('[' + MODULE_NAME + '] Polling error:', e.message);
        }
    }, 3000);
}
async function injectContextWithSetExtensionPrompt(generationType) {
    if (!extensionSettings.enabled || !extensionSettings.injectContext) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    if (!currentChatIndexed) {
        const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
        try {
            if (await countPoints(collectionName) > 0) currentChatIndexed = true;
            else return;
        } catch (e) { return; }
    }
    let context = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
    else if (typeof getContext === 'function') context = getContext();
    if (!context?.chat?.length || !context.setExtensionPrompt) return;
    const lastMessage = getQueryMessage(context, null, generationType);
    if (!lastMessage?.mes) return;
    const retrievedContext = await retrieveContext(lastMessage.mes.substring(0, 1000), chatId, isCurrentChatGroupChat());
    if (!retrievedContext) return;
    let position = 1, depth = 4;
    if (extensionSettings.injectionPosition === 'before_main') { position = 0; depth = 0; }
    else if (extensionSettings.injectionPosition === 'after_main') { position = 1; depth = 0; }
    else if (extensionSettings.injectionPosition === 'after_messages') { position = 1; depth = extensionSettings.injectAfterMessages || 3; }
    const formattedContext = '[Relevant context from earlier in conversation:\n' + retrievedContext + '\n]';
    try {
        context.setExtensionPrompt(MODULE_NAME, formattedContext, position, depth);
        updateUI('status', 'Context injected (' + retrievedContext.length + ' chars)');
    } catch (e) {
        console.error('[' + MODULE_NAME + '] setExtensionPrompt failed:', e);
    }
}
async function injectContextBeforeGeneration(data) {
    if (Date.now() - lastInjectionTime < INJECTION_DEBOUNCE_MS || !data?.chat?.length || data.chat.length <= 5 || !extensionSettings.enabled || !extensionSettings.injectContext) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    if (!currentChatIndexed) {
        const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
        try { if (await countPoints(collectionName) > 0) currentChatIndexed = true; else return; } catch (e) { return; }
    }
    let context = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
    else if (typeof getContext === 'function') context = getContext();
    if (!context?.chat?.length) return;
    const lastMessage = getQueryMessage(context, null, 'normal');
    if (!lastMessage?.mes) return;
    const retrievedContext = await retrieveContext(lastMessage.mes.substring(0, 1000), chatId, isCurrentChatGroupChat());
    if (!retrievedContext) return;
    const ragMessage = { role: 'system', content: '[Relevant context from earlier in conversation:\n' + retrievedContext + '\n]' };
    let insertIndex = 0;
    if (extensionSettings.injectionPosition === 'before_main') insertIndex = 0;
    else if (extensionSettings.injectionPosition === 'after_main') {
        for (let i = 0; i < data.chat.length; i++) {
            if (data.chat[i].role === 'user' || data.chat[i].role === 'assistant') { insertIndex = i; break; }
            insertIndex = i + 1;
        }
    } else if (extensionSettings.injectionPosition === 'after_messages') {
        insertIndex = Math.max(0, data.chat.length - (extensionSettings.injectAfterMessages || 3));
    }
    data.chat.splice(insertIndex, 0, ragMessage);
    lastInjectionTime = Date.now();
    updateUI('status', 'Context injected (' + retrievedContext.length + ' chars)');
}

// ===========================
// UI Functions
// ===========================

function showStopButton() {
    const btn = document.getElementById('ragfordummies_stop_indexing');
    if (btn) btn.classList.add('active');
}
function hideStopButton() {
    const btn = document.getElementById('ragfordummies_stop_indexing');
    if (btn) btn.classList.remove('active');
}
function updateUI(element, value) {
    const el = document.getElementById('ragfordummies_' + element);
    if (el) {
        if (element === 'status') el.textContent = value;
        else el.value = value;
    }
}
function createSettingsUI() {
    const html = `
        <div id="ragfordummies_container" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>RagForDummies</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="ragfordummies-settings">
                    <div class="ragfordummies-section"><label class="checkbox_label"><input type="checkbox" id="ragfordummies_enabled" ${extensionSettings.enabled ? 'checked' : ''} />Enable RAG</label></div>
                    <div class="ragfordummies-section"><h4>Qdrant Configuration</h4><label><span>Local URL:</span><input type="text" id="ragfordummies_qdrant_local_url" value="${extensionSettings.qdrantLocalUrl}" placeholder="http://localhost:6333" /></label></div>
                    <div class="ragfordummies-section"><h4>Embedding Provider</h4><label><span>Provider:</span><select id="ragfordummies_embedding_provider"><option value="kobold" ${extensionSettings.embeddingProvider === 'kobold' ? 'selected' : ''}>KoboldCpp</option><option value="ollama" ${extensionSettings.embeddingProvider === 'ollama' ? 'selected' : ''}>Ollama</option><option value="openai" ${extensionSettings.embeddingProvider === 'openai' ? 'selected' : ''}>OpenAI</option></select></label><label id="ragfordummies_kobold_settings" style="${extensionSettings.embeddingProvider === 'kobold' ? '' : 'display:none'}"><span>KoboldCpp URL:</span><input type="text" id="ragfordummies_kobold_url" value="${extensionSettings.koboldUrl}" placeholder="http://localhost:11434" /></label><div id="ragfordummies_ollama_settings" style="${extensionSettings.embeddingProvider === 'ollama' ? '' : 'display:none'}"><label><span>Ollama URL:</span><input type="text" id="ragfordummies_ollama_url" value="${extensionSettings.ollamaUrl}" placeholder="http://localhost:11434" /></label><label><span>Ollama Model:</span><input type="text" id="ragfordummies_ollama_model" value="${extensionSettings.ollamaModel}" placeholder="nomic-embed-text" /></label></div><div id="ragfordummies_openai_settings" style="${extensionSettings.embeddingProvider === 'openai' ? '' : 'display:none'}"><label><span>OpenAI API Key:</span><input type="password" id="ragfordummies_openai_api_key" value="${extensionSettings.openaiApiKey}" placeholder="sk-..." /></label><label><span>OpenAI Model:</span><input type="text" id="ragfordummies_openai_model" value="${extensionSettings.openaiModel}" placeholder="text-embedding-3-small" /></label></div></div>
                    <div class="ragfordummies-section"><h4>RAG Settings</h4><label><span>Retrieval Count:</span><input type="number" id="ragfordummies_retrieval_count" value="${extensionSettings.retrievalCount}" min="1" max="20" /></label><label><span>Similarity Threshold:</span><input type="number" id="ragfordummies_similarity_threshold" value="${extensionSettings.similarityThreshold}" min="0" max="1" step="0.1" /></label><label><span>Exclude Recent Messages:</span><input type="number" id="ragfordummies_exclude_last_messages" value="${extensionSettings.excludeLastMessages}" min="0" max="10" /><small style="opacity:0.7; display:block; margin-top:5px;">Prevent RAG from fetching the messages currently in context (usually 2)</small></label><label class="checkbox_label"><input type="checkbox" id="ragfordummies_auto_index" ${extensionSettings.autoIndex ? 'checked' : ''} />Auto-index on first message</label><label class="checkbox_label"><input type="checkbox" id="ragfordummies_inject_context" ${extensionSettings.injectContext ? 'checked' : ''} />Inject context into prompt</label></div>
                    <div class="ragfordummies-section"><h4>Custom Keyword Blacklist</h4><label><span>Blacklisted Terms (comma-separated):</span><input type="text" id="ragfordummies_user_blacklist" value="${extensionSettings.userBlacklist || ''}" placeholder="baka, sweetheart, darling" /></label><small style="opacity:0.7; display:block; margin-top:5px;">Can be useful for things like pet names between you and your character, although vector scoring should handle this just fine.</small></div>
                    <div class="ragfordummies-section"><h4>Context Injection Position</h4><label><span>Injection Position:</span><select id="ragfordummies_injection_position"><option value="before_main" ${extensionSettings.injectionPosition === 'before_main' ? 'selected' : ''}>Before Main Prompt</option><option value="after_main" ${extensionSettings.injectionPosition === 'after_main' ? 'selected' : ''}>After Main Prompt</option><option value="after_messages" ${extensionSettings.injectionPosition === 'after_messages' ? 'selected' : ''}>After X Messages</option></select></label><label id="ragfordummies_inject_after_messages_setting" style="${extensionSettings.injectionPosition === 'after_messages' ? '' : 'display:none'}"><span>Messages from End:</span><input type="number" id="ragfordummies_inject_after_messages" value="${extensionSettings.injectAfterMessages}" min="0" max="50" /><small style="opacity:0.7; display:block; margin-top:5px;">0 = at the very end, 3 = after last 3 messages</small></label></div>
                    <div class="ragfordummies-section"><h4>Manual Operations</h4><button id="ragfordummies_index_current" class="menu_button">Index Current Chat</button><button id="ragfordummies_force_reindex" class="menu_button">Force Re-index (Rebuild)</button><button id="ragfordummies_stop_indexing" class="menu_button ragfordummies-stop-btn">Stop Indexing</button><hr style="border-color: var(--SmartThemeBorderColor); margin: 10px 0;" /><label class="checkbox_label" style="margin-bottom: 8px;"><input type="checkbox" id="ragfordummies_merge_uploads" checked /><span>Merge uploads into current chat collection</span></label><button id="ragfordummies_upload_btn" class="menu_button">Upload File (JSONL or txt)</button><input type="file" id="ragfordummies_file_input" accept=".jsonl,.txt" style="display:none" /><div id="ragfordummies_status" class="ragfordummies-status">Ready</div></div>
                </div>
            </div>
        </div>`;
    return html;
}
function attachEventListeners() {
    const settingIds = [
        'enabled', 'qdrant_local_url', 'embedding_provider', 'kobold_url', 'ollama_url', 'ollama_model', 
        'openai_api_key', 'openai_model', 'retrieval_count', 'similarity_threshold', 'auto_index', 
        'inject_context', 'injection_position', 'inject_after_messages', 'exclude_last_messages', 'user_blacklist'
    ];
    settingIds.forEach(id => {
        const element = document.getElementById('ragfordummies_' + id);
        if (element) {
            element.addEventListener('change', () => {
                const key = id.replace(/_([a-z])/g, (m, l) => l.toUpperCase());
                if (element.type === 'checkbox') extensionSettings[key] = element.checked;
                else if (element.type === 'number') extensionSettings[key] = parseFloat(element.value) || 0;
                else extensionSettings[key] = element.value;
                if (id === 'auto_index') {
                    if (element.checked && !eventsRegistered && !pollingInterval) startPolling();
                    else if (!element.checked && pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
                }
                saveSettings();
            });
        }
    });
    
    document.getElementById('ragfordummies_embedding_provider')?.addEventListener('change', function() {
        const provider = this.value;
        document.getElementById('ragfordummies_kobold_settings').style.display = provider === 'kobold' ? '' : 'none';
        document.getElementById('ragfordummies_ollama_settings').style.display = provider === 'ollama' ? '' : 'none';
        document.getElementById('ragfordummies_openai_settings').style.display = provider === 'openai' ? '' : 'none';
    });
    
    document.getElementById('ragfordummies_injection_position')?.addEventListener('change', function() {
        document.getElementById('ragfordummies_inject_after_messages_setting').style.display = this.value === 'after_messages' ? '' : 'none';
    });
    
    document.getElementById('ragfordummies_index_current')?.addEventListener('click', async () => {
        try {
            const chatId = getCurrentChatId();
            if (!chatId) { updateUI('status', '✗ No active chat found'); return; }
            await indexChat(convertChatToJSONL(SillyTavern.getContext()), chatId, isCurrentChatGroupChat());
            currentChatIndexed = true;
        } catch (error) {
            updateUI('status', '✗ Indexing failed: ' + error.message);
        }
    });

    document.getElementById('ragfordummies_force_reindex')?.addEventListener('click', async () => {
        if (!confirm('This will delete and rebuild the index. Continue?')) return;
        try {
            await forceReindexCurrentChat();
            updateUI('status', '✓ Force re-index complete!');
        } catch (error) {
            updateUI('status', '✗ Force re-index failed: ' + error.message);
        }
    });

    document.getElementById('ragfordummies_stop_indexing')?.addEventListener('click', () => {
        shouldStopIndexing = true;
        updateUI('status', 'Stopping...');
    });
    
    const uploadBtn = document.getElementById('ragfordummies_upload_btn');
    const fileInput = document.getElementById('ragfordummies_file_input');
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const content = await file.text();
                const isTxt = /\.txt$/i.test(file.name);
                const isJsonl = /\.jsonl$/i.test(file.name);
                if (!isTxt && !isJsonl) throw new Error('Unsupported file type. Please upload .jsonl or .txt');
                const shouldMerge = document.getElementById('ragfordummies_merge_uploads')?.checked;
                let targetChatId, targetIsGroupChat;
                if (shouldMerge) {
                    targetChatId = getCurrentChatId();
                    targetIsGroupChat = isCurrentChatGroupChat();
                    if (!targetChatId) throw new Error('No active chat to merge into.');
                    updateUI('status', 'Merging into current chat collection...');
                } else {
                    targetChatId = Date.now().toString();
                    targetIsGroupChat = false;
                }
                const jsonlToIndex = isTxt ? convertTextToJSONL(content) : content;
                if (!shouldMerge) {
                    const parsed = parseJSONL(jsonlToIndex);
                    if (parsed.chatMetadata?.chat_id_hash) targetChatId = parsed.chatMetadata.chat_id_hash;
                }
                await indexChat(jsonlToIndex, targetChatId, targetIsGroupChat);
                updateUI('status', shouldMerge ? '✓ Merged into current chat!' : '✓ Uploaded file indexed.');
            } catch (error) {
                updateUI('status', 'Upload failed: ' + error.message);
            }
            fileInput.value = '';
        });
    }
}

function saveSettings() {
    localStorage.setItem(MODULE_NAME + '_settings', JSON.stringify(extensionSettings));
}

function loadSettings() {
    const saved = localStorage.getItem(MODULE_NAME + '_settings');
    if (saved) {
        try {
            extensionSettings = { ...defaultSettings, ...JSON.parse(saved) };
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Failed to load settings:', error);
        }
    }
}

// ===========================
// Extension Initialization
// ===========================

async function init() {
    loadSettings();
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = null;
    
    // Asynchronously load the compromise NLP library from a CDN
    async function loadNlpLibrary() {
        return new Promise((resolve, reject) => {
            if (typeof window.nlp !== 'undefined') {
                console.log('[' + MODULE_NAME + '] compromise NLP library already loaded.');
                return resolve();
            }
            console.log('[' + MODULE_NAME + '] Loading compromise NLP library from CDN...');
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/compromise';
            script.onload = () => {
                console.log('[' + MODULE_NAME + '] compromise NLP library loaded successfully.');
                resolve();
            };
            script.onerror = () => {
                console.error('[' + MODULE_NAME + '] Failed to load compromise NLP library.');
                updateUI('status', 'ERROR: NLP library failed to load. Keyword extraction will be limited.');
                reject(new Error('NLP library failed to load'));
            };
            document.head.appendChild(script);
        });
    }

    try {
        await loadNlpLibrary();
    } catch (error) {
        // If the library fails to load, the extension can still run, but with degraded functionality.
        // `extractKeywords` will see that `window.nlp` is undefined and will simply return an empty array.
    }
    
    const settingsHtml = createSettingsUI();
    $('#extensions_settings').append(settingsHtml);
    
    setTimeout(() => {
        const toggle = $('#ragfordummies_container .inline-drawer-toggle');
        if (toggle.length) {
            toggle.on('click', function(e) {
                e.preventDefault(); e.stopPropagation();
                $(this).find('.inline-drawer-icon').toggleClass('down up');
                $('#ragfordummies_container .inline-drawer-content').slideToggle(200);
            });
        }
    }, 200);
    
    attachEventListeners();
    
    let eventSourceToUse = null;
    if (typeof eventSource !== 'undefined') eventSourceToUse = eventSource;
    else if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext?.().eventSource) eventSourceToUse = SillyTavern.getContext().eventSource;

    if (eventSourceToUse) {
        console.log('[' + MODULE_NAME + '] Registering event listeners on eventSource');
        eventSourceToUse.on('chat_loaded', onChatLoaded);
        eventSourceToUse.on('message_sent', onMessageSent);
        eventSourceToUse.on('message_received', onMessageReceived);
        eventSourceToUse.on('message_swiped', onMessageSwiped);
        eventSourceToUse.on('message_deleted', onMessageDeleted);
        eventSourceToUse.on('message_edited', onMessageEdited);
        if (typeof injectContextWithSetExtensionPrompt === 'function') {
            eventSourceToUse.on('GENERATION_AFTER_COMMANDS', (type) => injectContextWithSetExtensionPrompt(type));
            eventSourceToUse.on('generate_before_combine_prompts', () => injectContextWithSetExtensionPrompt('normal'));
        }
        eventsRegistered = true;
        usePolling = false;
        console.log('[' + MODULE_NAME + '] Event listeners registered successfully');
    } else {
        console.log('[' + MODULE_NAME + '] eventSource not available, using polling fallback');
        eventsRegistered = false;
        usePolling = true;
        if (extensionSettings.autoIndex) await startPolling();
    }

    setTimeout(async () => {
        console.log('[' + MODULE_NAME + '] Running initial index status check...');
        const chatId = getCurrentChatId();
        if (chatId && !currentChatIndexed) {
            const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
            try {
                const pointCount = await countPoints(collectionName);
                if (pointCount > 0) {
                    currentChatIndexed = true;
                    updateUI('status', '✓ Indexed (' + pointCount + ' messages)');
                } else {
                    updateUI('status', 'Ready to index');
                }
            } catch (checkError) {
                console.log('[' + MODULE_NAME + '] Initial check: Could not verify collection -', checkError.message);
            }
        }
    }, 500);
    
    console.log('[' + MODULE_NAME + '] Extension loaded successfully');
    updateUI('status', 'Extension loaded');
}

jQuery(async function() {
    setTimeout(init, 100);
});
