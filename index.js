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
    'HYBRID',          // any HYBRID SEARCH header/detail
    'Run 1', 'Run 2',
    'Final', 'Score',
    'Collection:', 'Parameters:', 'Proper nouns',
    'validated results', 'dense', 'filtered',
    'Result', 'query filter', 'retrieved', 'retrieval', 'combined'
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

// Extension settings with defaults (Cloud removed)
const defaultSettings = {
    enabled: true,
    qdrantLocalUrl: 'http://localhost:6333',
    embeddingProvider: 'kobold',
    koboldUrl: 'http://localhost:11434', // updated default
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    openaiApiKey: '',
    openaiModel: 'text-embedding-3-small',
    retrievalCount: 5,
    similarityThreshold: 0.7,
    autoIndex: true,
    injectContext: true,
    injectionPosition: 'after_main', // 'before_main', 'after_main', 'after_messages'
    injectAfterMessages: 3 // If injectionPosition is 'after_messages', inject after this many messages from end
};

let extensionSettings = { ...defaultSettings };
let isIndexing = false;
let shouldStopIndexing = false;
let currentChatIndexed = false;
let lastMessageCount = 0;
let lastChatId = null;
let pollingInterval = null;
let indexedMessageIds = new Set();
let usePolling = false; // Flag to control whether polling should be used
let eventsRegistered = false; // Track if events were successfully registered
let lastInjectionTime = 0; // Debounce injection
const INJECTION_DEBOUNCE_MS = 1000; // Minimum time between injections

// ===========================
// Utility Functions
// ===========================

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 8);
        return v.toString(16);
    });
}

/**
 * Extract proper nouns from text for hybrid search filtering
 * Finds capitalized words that aren't at the start of sentences
 * @param {string} text - The text to extract proper nouns from
 * @returns {string[]} - Array of proper nouns (lowercase for case-insensitive matching)
 */
function extractProperNouns(text) {
    if (!text || typeof text !== 'string') return [];
    
    const properNouns = new Set();
    
    // Common words to EXCLUDE (these are not proper nouns even if capitalized)
    const commonWords = new Set([
        // Pronouns and common words
        'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
        'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
        'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
        'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how',
        'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'upon', 'about', 'over', 'under', 'through', 'between', 'among',
        'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
        'just', 'also', 'now', 'here', 'there', 'always', 'never', 'sometimes', 'often', 'usually', 'as', 'up', 'down', 'out', 'off', 'away',
        // Contractions WITHOUT apostrophes (people often drop them)
        'im', 'ive', 'id', 'ill', 'youre', 'youve', 'youd', 'youll', 'hes', 'shes', 'its', 'weve', 'were', 'wed', 'well', 'theyve', 'theyre', 'theyd', 'theyll',
        'isnt', 'arent', 'wasnt', 'werent', 'dont', 'doesnt', 'didnt', 'wont', 'wouldnt', 'couldnt', 'shouldnt', 'cant', 'cannot', 'hadnt', 'hasnt', 'havent',
        'lets', 'thats', 'whats', 'whos', 'hows', 'wheres', 'whens', 'whys',
        // Common verbs
        'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
        'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
        'say', 'said', 'says', 'see', 'saw', 'seen', 'get', 'got', 'go', 'went', 'gone', 'come', 'came',
        'know', 'knew', 'think', 'thought', 'make', 'made', 'take', 'took', 'want', 'wanted',
        'look', 'looked', 'give', 'gave', 'use', 'used', 'find', 'found', 'tell', 'told',
        'let', 'put', 'keep', 'kept', 'leave', 'left', 'begin', 'began', 'seem', 'seemed', 'help', 'helped', 'show', 'showed',
        'hear', 'heard', 'play', 'played', 'run', 'ran', 'live', 'lived', 'believe', 'believed', 'hold', 'held', 'bring', 'brought',
        'write', 'wrote', 'read', 'sit', 'stand', 'lose', 'lost', 'pay', 'paid', 'meet', 'met', 'include', 'included', 'continue', 'continued',
        'set', 'learn', 'learned', 'change', 'changed', 'lead', 'led', 'understand', 'understood', 'watch', 'watched', 'follow', 'followed',
        'stop', 'stopped', 'create', 'created', 'speak', 'spoke', 'allow', 'allowed', 'add', 'added', 'spend', 'spent', 'grow', 'grew',
        'open', 'opened', 'walk', 'walked', 'win', 'won', 'offer', 'offered', 'remember', 'remembered', 'love', 'loved', 'consider', 'considered',
        'appear', 'appeared', 'buy', 'bought', 'wait', 'waited', 'serve', 'served', 'die', 'died', 'send', 'sent', 'expect', 'expected',
        'build', 'built', 'stay', 'stayed', 'fall', 'fell', 'cut', 'reach', 'kill', 'killed', 'remain', 'remained',
        // Common adjectives/adverbs
        'good', 'bad', 'great', 'big', 'small', 'old', 'new', 'first', 'last', 'long', 'little', 'own', 'other', 'right', 'left',
        'really', 'actually', 'probably', 'maybe', 'perhaps', 'definitely', 'certainly', 'high', 'low', 'young', 'early', 'late',
        'important', 'public', 'different', 'possible', 'full', 'special', 'free', 'strong', 'certain', 'real', 'best', 'better', 'true', 'whole',
        // Interjections and fillers
        'oh', 'ah', 'um', 'uh', 'hey', 'hi', 'hello', 'bye', 'yes', 'no', 'yeah', 'yea', 'yep', 'nope', 'okay', 'ok', 'well', 'like', 'huh', 'hmm', 'hm', 'mhm', 'ugh', 'ooh', 'oops', 'wow', 'whoa',
        // Swear words (often capitalized for emphasis but not proper nouns)
        'fuck', 'fucking', 'fucked', 'shit', 'shitty', 'damn', 'damned', 'hell', 'ass', 'crap', 'crappy', 'god', 'omg', 'wtf', 'lol', 'lmao', 'rofl',
        // Time words
        'today', 'tomorrow', 'yesterday', 'morning', 'afternoon', 'evening', 'night', 'week', 'month', 'year', 'day', 'hour', 'minute', 'second', 'time',
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
        'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
        // Common sentence starters (often capitalized after quotes in dialogue)
        'besides', 'however', 'although', 'though', 'because', 'since', 'while', 'after', 'before', 'until', 'unless',
        'anyway', 'anyways', 'meanwhile', 'furthermore', 'moreover', 'therefore', 'otherwise', 'instead', 'still',
        'maybe', 'perhaps', 'apparently', 'obviously', 'clearly', 'honestly', 'seriously', 'basically', 'literally',
        'sure', 'fine', 'thanks', 'thank', 'sorry', 'please', 'wait', 'stop', 'look', 'listen', 'watch',
        'minor', 'major', 'nice', 'cool', 'awesome', 'amazing', 'terrible', 'horrible', 'wonderful', 'beautiful',
        'enough', 'exactly', 'absolutely', 'totally', 'completely', 'perfectly', 'simply',
        // Other common words that get capitalized
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'something', 'nothing', 'everything', 'anything', 'someone', 'anyone', 'everyone', 'nobody', 'somewhere', 'anywhere', 'everywhere', 'nowhere',
        'much', 'many', 'lot', 'lots', 'bit', 'kind', 'sort', 'type', 'way', 'thing', 'things', 'stuff',
        'even', 'ever', 'still', 'already', 'yet', 'soon', 'later', 'again', 'once', 'twice',
        'back', 'away', 'around', 'part', 'place', 'case', 'point', 'fact', 'hand', 'side', 'world', 'life', 'work', 'home', 'end',
        'man', 'men', 'woman', 'women', 'child', 'children', 'people', 'person', 'family', 'friend', 'friends',
        // Roleplay common words (often after asterisks)
        'sealed', 'unsealed', 'suddenly', 'quickly', 'slowly', 'gently', 'softly', 'quietly', 'loudly',
        'smiles', 'smiling', 'smiled', 'laughs', 'laughing', 'laughed', 'sighs', 'sighing', 'sighed',
        'nods', 'nodding', 'nodded', 'shakes', 'shaking', 'shook', 'looks', 'looking', 'walks', 'walking',
        'turns', 'turning', 'turned', 'stands', 'standing', 'stood', 'sits', 'sitting', 'sat',
        'grins', 'grinning', 'grinned', 'chuckles', 'chuckling', 'chuckled', 'giggles', 'giggling', 'giggled',
        'pauses', 'pausing', 'paused', 'thinks', 'thinking', 'feels', 'feeling', 'felt',
        'takes', 'taking', 'gives', 'giving', 'puts', 'putting', 'gets', 'getting',
        'moves', 'moving', 'moved', 'steps', 'stepping', 'stepped', 'reaches', 'reaching', 'reached',
        'pulls', 'pulling', 'pulled', 'pushes', 'pushing', 'pushed', 'holds', 'holding', 'held',
        'starts', 'starting', 'started', 'stops', 'stopping', 'stopped', 'tries', 'trying', 'tried',
        'says', 'saying', 'asks', 'asking', 'asked', 'tells', 'telling', 'replies', 'replying', 'replied',
        'tilts', 'tilting', 'tilted', 'raises', 'raising', 'raised', 'lowers', 'lowering', 'lowered',
        'leans', 'leaning', 'leaned', 'rests', 'resting', 'rested', 'places', 'placing', 'placed',
        'notices', 'noticing', 'noticed', 'realizes', 'realizing', 'realized', 'wonders', 'wondering', 'wondered',
        'blinks', 'blinking', 'blinked', 'stares', 'staring', 'stared', 'glances', 'glancing', 'glanced',
        'whispers', 'whispering', 'whispered', 'murmurs', 'murmuring', 'murmured', 'mutters', 'muttering', 'muttered',
        'continues', 'continuing', 'continued', 'begins', 'beginning', 'began', 'finishes', 'finishing', 'finished',
        'seems', 'seeming', 'seemed', 'appears', 'appearing', 'appeared', 'sounds', 'sounding', 'sounded',
        'tone', 'voice', 'expression', 'face', 'eyes', 'head', 'body', 'arm', 'arms', 'hand', 'hands', 'finger', 'fingers',
        'teasing', 'teased', 'smug', 'smugly', 'playful', 'playfully', 'curious', 'curiously', 'nervous', 'nervously',
        'soft', 'warm', 'cold', 'hot', 'light', 'dark', 'bright', 'quiet', 'loud', 'gentle', 'rough',
        'slight', 'slightly', 'brief', 'briefly', 'quick', 'slow', 'sudden', 'careful', 'carefully'
    ]);
    
    const sentences = text.split(/[.!?*]+|["'"]\s*/);
    
    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        if (!sentence) continue;
        
        const words = sentence.split(/\s+/);
        
        for (let j = 1; j < words.length; j++) {
            const word = words[j];
            
            if (j > 0) {
                const prevWord = words[j-1];
                if (prevWord && /["'"]$/.test(prevWord)) continue;
            }
            
            if (word.indexOf("'") !== -1) continue;
            if (/^\d/.test(word)) continue;
            if (/\d/.test(word) && /[a-zA-Z]/.test(word)) continue;
            
            const cleaned = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
            
            if (cleaned.length >= 2 && cleaned.length <= 20 && /^[A-Z]/.test(cleaned)) {
                const lower = cleaned.toLowerCase();
                if (commonWords.has(lower)) continue;
                if (cleaned === cleaned.toUpperCase() && cleaned.length > 2) continue;
                properNouns.add(lower);
            }
        }
    }
    
    return Array.from(properNouns);
}

/**
 * Extract potential filter terms from a QUERY (more lenient than extractProperNouns)
 * This extracts ALL significant words regardless of capitalization
 * Used for hybrid search to find messages that contain these terms in their proper_nouns field
 * @param {string} text - The query text
 * @returns {string[]} - Array of potential filter terms (lowercase)
 */
function extractQueryFilterTerms(text) {
    if (!text || typeof text !== 'string') return [];
    
    const terms = new Set();
    
    const stopWords = new Set([
        'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
        'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
        'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
        'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how',
        'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'upon', 'about',
        'over', 'under', 'through', 'between', 'among', 'all', 'each', 'every', 'both', 'few',
        'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
        'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'always', 'never',
        'sometimes', 'often', 'usually', 'as', 'up', 'down', 'out', 'off', 'away',
        'im', 'ive', 'id', 'ill', 'youre', 'youve', 'youd', 'youll', 'hes', 'shes', 'weve',
        'were', 'wed', 'well', 'theyve', 'theyre', 'theyd', 'theyll', 'isnt', 'arent', 'wasnt',
        'werent', 'dont', 'doesnt', 'didnt', 'wont', 'wouldnt', 'couldnt', 'shouldnt', 'cant',
        'cannot', 'hadnt', 'hasnt', 'havent', 'lets', 'thats', 'whats', 'whos', 'hows',
        'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having',
        'do', 'does', 'did', 'doing', 'will', 'would', 'could', 'should', 'may', 'might',
        'must', 'shall', 'can', 'say', 'said', 'says', 'see', 'saw', 'seen', 'get', 'got',
        'go', 'went', 'gone', 'come', 'came', 'know', 'knew', 'think', 'thought', 'make',
        'made', 'take', 'took', 'want', 'wanted', 'look', 'looked', 'give', 'gave', 'use',
        'used', 'find', 'found', 'tell', 'told', 'let', 'put', 'keep', 'kept', 'leave', 'left',
        'good', 'bad', 'great', 'big', 'small', 'old', 'new', 'first', 'last', 'long', 'little',
        'really', 'actually', 'probably', 'maybe', 'perhaps', 'definitely', 'certainly',
        'oh', 'ah', 'um', 'uh', 'hey', 'hi', 'hello', 'bye', 'yes', 'no', 'yeah', 'yea', 'yep',
        'nope', 'okay', 'ok', 'well', 'like', 'huh', 'hmm', 'wow', 'whoa',
        'today', 'tomorrow', 'yesterday', 'morning', 'afternoon', 'evening', 'night',
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'something', 'nothing', 'everything', 'anything', 'someone', 'anyone', 'everyone',
        'much', 'many', 'lot', 'lots', 'bit', 'kind', 'sort', 'type', 'way', 'thing', 'things'
    ]);
    
    const words = text.toLowerCase().split(/\s+/);
    
    for (const word of words) {
        const cleaned = word.replace(/^[^a-z]+|[^a-z]+$/g, '');
        if (cleaned.length < 3) continue;
        if (cleaned.length > 20) continue;
        if (stopWords.has(cleaned)) continue;
        terms.add(cleaned);
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
    const metadata = {
        chat_metadata: {
            chat_id_hash: chatId,
            ...(context.chatMetadata || {})
        }
    };
    lines.push(JSON.stringify(metadata));
    context.chat.forEach((msg) => {
        if (!msg || typeof msg.mes === 'undefined') return;
        const payload = {
            name: msg.name || msg.character || 'Unknown',
            mes: msg.mes,
            is_user: !!msg.is_user || msg.role === 'user',
            is_system: !!msg.is_system,
            send_date: msg.send_date || msg.date || '',
            tracker: msg.tracker || {},
            extra: msg.extra || {},
            present: msg.present || msg.characters_present || [],
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
    rows.forEach((row, idx) => {
        lines.push(JSON.stringify({
            name: 'User',
            mes: row,
            is_user: true,
            is_system: false,
            send_date: '',
            tracker: {},
            extra: {},
            present: []
        }));
    });
    return lines.join('\n');
}

// ===========================
// Qdrant Client Functions (Cloud removed; only local)
// ===========================

async function qdrantRequest(endpoint, method, body) {
    if (method === undefined) method = 'GET';
    if (body === undefined) body = null;
    
    const baseUrl = extensionSettings.qdrantLocalUrl;
    
    const headers = {
        'Content-Type': 'application/json'
    };
    
    const options = {
        method: method,
        headers: headers,
        body: body ? JSON.stringify(body) : null
    };
    
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

async function createCollection(collectionName, vectorSize) {
    if (vectorSize === undefined) vectorSize = 1536;
    
    try {
        const collections = await qdrantRequest('/collections');
        const exists = collections.result.collections.some(function(c) { return c.name === collectionName; });
        
        if (exists) {
            console.log('[' + MODULE_NAME + '] Collection ' + collectionName + ' already exists');
            await createPayloadIndex(collectionName);
            return true;
        }
        
        await qdrantRequest('/collections/' + collectionName, 'PUT', {
            vectors: {
                size: vectorSize,
                distance: 'Cosine'
            }
        });
        
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
        await qdrantRequest('/collections/' + collectionName + '/index', 'PUT', {
            field_name: 'proper_nouns',
            field_schema: 'keyword'
        });
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
        await qdrantRequest('/collections/' + collectionName + '/points', 'PUT', {
            points: points
        });
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to upsert vectors:', error);
        throw error;
    }
}

async function deleteMessageByIndex(collectionName, chatIdHash, messageIndex) {
    try {
        await qdrantRequest('/collections/' + collectionName + '/points/delete', 'POST', {
            filter: {
                must: [
                    { key: 'chat_id_hash', match: { value: chatIdHash } },
                    { key: 'message_index', match: { value: messageIndex } }
                ]
            },
            wait: true
        });
        console.log('[' + MODULE_NAME + '] Deleted existing point for message_index=' + messageIndex);
    } catch (err) {
        console.warn('[' + MODULE_NAME + '] Delete (by message_index) failed:', err.message);
    }
}

/**
 * Hybrid search: combines filtered (proper noun) search with dense search
 */
async function searchVectors(collectionName, vector, limit, scoreThreshold, properNouns) {
    if (limit === undefined || limit === null) limit = extensionSettings.retrievalCount || 5;
    if (scoreThreshold === undefined) scoreThreshold = extensionSettings.similarityThreshold || 0.7;
    if (properNouns === undefined) properNouns = [];
    const requiredFiltered = extensionSettings.retrievalCount || limit;
    
    try {
        console.log('[' + MODULE_NAME + '] ===== HYBRID SEARCH =====');
        console.log('[' + MODULE_NAME + '] Collection: ' + collectionName);
        console.log('[' + MODULE_NAME + '] Parameters: limit=' + limit + ', threshold=' + scoreThreshold + ', requiredFiltered=' + requiredFiltered);
        console.log('[' + MODULE_NAME + '] Query vector dimensions: ' + vector.length);
        console.log('[' + MODULE_NAME + '] Proper nouns for filtering: ' + (properNouns.length > 0 ? properNouns.join(', ') : '(none)'));
        
        let filteredResults = [];
        let denseResults = [];
        
        if (properNouns.length > 0) {
            console.log('[' + MODULE_NAME + '] Run 1: Filtered search with ' + properNouns.length + ' proper nouns...');
            const filter = {
                should: properNouns.map(function(noun) {
                    return {
                        key: 'proper_nouns',
                        match: { value: noun }
                    };
                })
            };
            
            try {
                const filteredResult = await qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', {
                    vector: vector,
                    limit: limit * 2,
                    score_threshold: scoreThreshold,
                    with_payload: true,
                    filter: filter
                });
                
                const rawResults = filteredResult.result || [];
                console.log('[' + MODULE_NAME + '] Run 1 raw results: ' + rawResults.length);
                
                filteredResults = rawResults.filter(function(r) {
                    const resultNouns = r.payload.proper_nouns || [];
                    const hasMatch = resultNouns.some(function(noun) {
                        return properNouns.indexOf(noun) !== -1;
                    });
                    if (!hasMatch) {
                        console.log('[' + MODULE_NAME + '] Filtered out false positive: "' + (r.payload.full_message || '').substring(0, 50) + '..." (no matching nouns)');
                    }
                    return hasMatch;
                });
                
                console.log('[' + MODULE_NAME + '] Run 1 validated results: ' + filteredResults.length);
                
                if (filteredResults.length > 0) {
                    console.log('[' + MODULE_NAME + '] Filtered top score: ' + filteredResults[0].score.toFixed(3));
                    filteredResults.forEach(function(r, idx) {
                        const matchedNouns = (r.payload.proper_nouns || []).filter(function(n) {
                            return properNouns.indexOf(n) !== -1;
                        });
                        console.log('[' + MODULE_NAME + ']   Result ' + idx + ' matched nouns: ' + matchedNouns.join(', '));
                    });
                }
            } catch (filterError) {
                console.warn('[' + MODULE_NAME + '] Filtered search failed, falling back to dense:', filterError.message);
            }
        }
        
        if (filteredResults.length < requiredFiltered) {
            console.log('[' + MODULE_NAME + '] Run 2: Dense search (filtered returned ' + filteredResults.length + ' < ' + requiredFiltered + ')...');
            
            const denseResult = await qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', {
                vector: vector,
                limit: limit,
                score_threshold: scoreThreshold,
                with_payload: true
            });
            
            denseResults = denseResult.result || [];
            console.log('[' + MODULE_NAME + '] Run 2 returned ' + denseResults.length + ' dense results');
            
            if (denseResults.length > 0) {
                console.log('[' + MODULE_NAME + '] Dense top score: ' + denseResults[0].score.toFixed(3));
            }
        } else {
            console.log('[' + MODULE_NAME + '] Skipping dense: filtered returned sufficient results (' + filteredResults.length + ' >= ' + requiredFiltered + ')');
        }
        
        const combined = [];
        const seenIds = new Set();
        
        filteredResults.forEach(function(r) {
            if (!seenIds.has(r.id)) {
                r._source = 'filtered';
                combined.push(r);
                seenIds.add(r.id);
            }
        });
        
        denseResults.forEach(function(r) {
            if (!seenIds.has(r.id)) {
                r._source = 'dense';
                combined.push(r);
                seenIds.add(r.id);
            }
        });
        
        combined.sort(function(a, b) { return b.score - a.score; });
        const finalResults = combined.slice(0, limit);
        
        console.log('[' + MODULE_NAME + '] ===== HYBRID SEARCH COMPLETE =====');
        console.log('[' + MODULE_NAME + '] Final results: ' + finalResults.length + ' (filtered: ' + 
            finalResults.filter(function(r) { return r._source === 'filtered'; }).length + 
            ', dense: ' + finalResults.filter(function(r) { return r._source === 'dense'; }).length + ')');
        
        if (finalResults.length > 0) {
            console.log('[' + MODULE_NAME + '] Score range: ' + finalResults[0].score.toFixed(3) + ' - ' + 
                finalResults[finalResults.length - 1].score.toFixed(3));
        }
        
        return finalResults;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Hybrid search failed:', error);
        return [];
    }
}

async function getCollectionInfo(collectionName) {
    try {
        const result = await qdrantRequest('/collections/' + collectionName);
        return result.result;
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
    if (!chatId) {
        throw new Error('No active chat found');
    }
    
    const isGroupChat = isCurrentChatGroupChat();
    const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
    const collectionName = prefix + chatId;
    
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
    
    if (!context || !context.chat || context.chat.length === 0) {
        throw new Error('No chat messages to index');
    }
    
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
        if (provider === 'kobold') {
            return await generateKoboldEmbedding(text);
        } else if (provider === 'ollama') {
            return await generateOllamaEmbedding(text);
        } else if (provider === 'openai') {
            return await generateOpenAIEmbedding(text);
        } else {
            throw new Error('Unknown embedding provider: ' + provider);
        }
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to generate embedding:', error);
        throw error;
    }
}

async function generateKoboldEmbedding(text) {
    const response = await fetch(extensionSettings.koboldUrl + '/api/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            input: text,
            model: "text-embedding-ada-002"
        })
    });
    
    if (!response.ok) {
        throw new Error('KoboldCpp API error: ' + response.status + ' - ' + await response.text());
    }
    
    const data = await response.json();
    return data.data[0].embedding;
}

async function generateOllamaEmbedding(text) {
    const response = await fetch(extensionSettings.ollamaUrl + '/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            model: extensionSettings.ollamaModel,
            prompt: text 
        })
    });
    
    if (!response.ok) {
        throw new Error('Ollama API error: ' + response.status);
    }
    
    const data = await response.json();
    return data.embedding;
}

async function generateOpenAIEmbedding(text) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + extensionSettings.openaiApiKey
        },
        body: JSON.stringify({
            model: extensionSettings.openaiModel,
            input: text
        })
    });
    
    if (!response.ok) {
        throw new Error('OpenAI API error: ' + response.status);
    }
    
    const data = await response.json();
    return data.data[0].embedding;
}

// ===========================
// JSONL Parsing and Indexing
// ===========================

function parseJSONL(jsonlContent) {
    const lines = jsonlContent.trim().split('\n');
    const messages = [];
    let chatMetadata = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        
        try {
            const parsed = JSON.parse(line);
            
            if (parsed.chat_metadata) {
                chatMetadata = parsed.chat_metadata;
            } else if (parsed.mes) {
                messages.push(parsed);
            }
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Failed to parse JSONL line:', error);
        }
    }
    
    return { chatMetadata: chatMetadata, messages: messages };
}

function buildEmbeddingText(message, tracker) {
    const parts = [];
    
    parts.push('[Character: ' + message.name + ']');
    
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

function extractPayload(message, messageIndex, chatIdHash) {
    const tracker = message.tracker || {};
    
    let charactersPresent = [];
    if (message.present && Array.isArray(message.present)) {
        charactersPresent = message.present.map(function(avatar) {
            return avatar.replace(/\.png$/, '');
        });
    } else if (tracker.CharactersPresent && Array.isArray(tracker.CharactersPresent)) {
        charactersPresent = tracker.CharactersPresent;
    }
    
    const messageProperNouns = extractProperNouns(message.mes || '');
    
    const summary = (message.extra && message.extra.qvink_memory && message.extra.qvink_memory.memory) 
        ? message.extra.qvink_memory.memory 
        : '';
    const summaryProperNouns = summary ? extractProperNouns(summary) : [];
    
    const contentNouns = new Set(messageProperNouns.concat(summaryProperNouns));
    
    return {
        chat_id_hash: chatIdHash,
        message_index: messageIndex,
        character_name: message.name,
        is_user: message.is_user || false,
        timestamp: message.send_date || '',
        summary: summary,
        full_message: message.mes,
        characters_present: charactersPresent,
        topic: (tracker.Topics && tracker.Topics.PrimaryTopic) ? tracker.Topics.PrimaryTopic : '',
        emotional_tone: (tracker.Topics && tracker.Topics.EmotionalTone) ? tracker.Topics.EmotionalTone : '',
        location: (tracker.Characters && tracker.Characters[message.name] && tracker.Characters[message.name].Location) ? tracker.Characters[message.name].Location : '',
        proper_nouns: Array.from(contentNouns)
    };
}

async function indexChat(jsonlContent, chatIdHash, isGroupChat) {
    if (isGroupChat === undefined) isGroupChat = false;
    
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
        const parsed = parseJSONL(jsonlContent);
        const messages = parsed.messages;
        
        if (messages.length === 0) {
            throw new Error('No messages found in chat');
        }
        
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatIdHash;
        
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
        const firstEmbedding = await generateEmbedding(buildEmbeddingText(messages[0], messages[0].tracker));
