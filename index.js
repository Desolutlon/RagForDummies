/**
 * RagForDummies - A RAG extension for SillyTavern that actually works
 * Supports group chats with Qdrant vector storage
 */

const MODULE_NAME = 'RagForDummies';

// Extension settings with defaults
const defaultSettings = {
    enabled: true,
    qdrantMode: 'local',
    qdrantLocalUrl: 'http://localhost:6333',
    qdrantCloudUrl: '',
    qdrantApiKey: '',
    embeddingProvider: 'kobold',
    koboldUrl: 'http://localhost:5001',
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
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
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
    
    // Split into sentences - include:
    // - Standard punctuation: . ! ?
    // - Quotes: " ' "
    // - Asterisks: * (roleplay action markers)
    const sentences = text.split(/[.!?*]+|["'"]\s*/);
    
    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        if (!sentence) continue;
        
        // Split sentence into words
        const words = sentence.split(/\s+/);
        
        // Skip first word (sentence start), check rest for capitals
        for (let j = 1; j < words.length; j++) {
            const word = words[j];
            
            // Skip if word comes right after an opening quote within the sentence
            if (j > 0) {
                const prevWord = words[j-1];
                // If previous "word" ends with opening quote, this is dialogue start
                if (prevWord && /["'"]$/.test(prevWord)) continue;
            }
            
            // Skip contractions (it's, you're, don't, etc.) and possessives
            // Check for both straight (') and curly (') apostrophes
            if (word.indexOf("'") !== -1 || word.indexOf("'") !== -1 || word.indexOf("'") !== -1) continue;
            
            // Skip words that start with numbers (like "3D-printed", "2nd", "4K")
            // These would get cleaned to "D-printed", "nd", "K" which aren't proper nouns
            if (/^\d/.test(word)) continue;
            
            // Skip words that contain numbers mixed with letters (like "MP3", "H2O")
            if (/\d/.test(word) && /[a-zA-Z]/.test(word)) continue;
            
            // Clean the word - remove punctuation but keep the core
            const cleaned = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
            
            // Must start with capital, be at least 2 chars, and max 20 chars (avoid garbage)
            if (cleaned.length >= 2 && cleaned.length <= 20 && /^[A-Z]/.test(cleaned)) {
                const lower = cleaned.toLowerCase();
                
                // Skip if it's a common word
                if (commonWords.has(lower)) continue;
                
                // Skip if it's ALL CAPS (likely emphasis, not a proper noun)
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
    
    // Same stop words as extractProperNouns
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
    
    // Clean and split the query into words
    const words = text.toLowerCase().split(/\s+/);
    
    for (const word of words) {
        // Clean punctuation from start/end
        const cleaned = word.replace(/^[^a-z]+|[^a-z]+$/g, '');
        
        // Skip short words (less than 3 chars) - too common/meaningless
        if (cleaned.length < 3) continue;
        
        // Skip if longer than 20 chars (garbage)
        if (cleaned.length > 20) continue;
        
        // Skip stop words
        if (stopWords.has(cleaned)) continue;
        
        terms.add(cleaned);
    }
    
    return Array.from(terms);
}

// ===========================
// Qdrant Client Functions
// ===========================

async function qdrantRequest(endpoint, method, body) {
    if (method === undefined) method = 'GET';
    if (body === undefined) body = null;
    
    const baseUrl = extensionSettings.qdrantMode === 'cloud' 
        ? extensionSettings.qdrantCloudUrl 
        : extensionSettings.qdrantLocalUrl;
    
    const headers = {
        'Content-Type': 'application/json'
    };
    
    if (extensionSettings.qdrantMode === 'cloud' && extensionSettings.qdrantApiKey) {
        headers['api-key'] = extensionSettings.qdrantApiKey;
    }
    
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
            // Still try to ensure payload index exists (idempotent)
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
        
        // Create payload index for hybrid search
        await createPayloadIndex(collectionName);
        
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to create collection:', error);
        throw error;
    }
}

/**
 * Create payload index for proper_nouns field to enable fast filtering
 * This enables the hybrid search strategy
 */
async function createPayloadIndex(collectionName) {
    try {
        await qdrantRequest('/collections/' + collectionName + '/index', 'PUT', {
            field_name: 'proper_nouns',
            field_schema: 'keyword'
        });
        console.log('[' + MODULE_NAME + '] Created payload index for proper_nouns on ' + collectionName);
        return true;
    } catch (error) {
        // Index might already exist, which is fine
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

/**
 * Hybrid search: combines filtered (proper noun) search with dense search
 * Strategy:
 *   1. Run 1 (Narrow): Search with proper noun filter
 *   2. Run 2 (Broad): If Run 1 returns < retrievalCount results, run pure dense search
 *   3. Combine and deduplicate results, sorted by score
 */
async function searchVectors(collectionName, vector, limit, scoreThreshold, properNouns) {
    if (limit === undefined) limit = 5;
    if (scoreThreshold === undefined) scoreThreshold = 0.7;
    if (properNouns === undefined) properNouns = [];
    
    try {
        console.log('[' + MODULE_NAME + '] ===== HYBRID SEARCH =====');
        console.log('[' + MODULE_NAME + '] Collection: ' + collectionName);
        console.log('[' + MODULE_NAME + '] Parameters: limit=' + limit + ', threshold=' + scoreThreshold);
        console.log('[' + MODULE_NAME + '] Query vector dimensions: ' + vector.length);
        console.log('[' + MODULE_NAME + '] Proper nouns for filtering: ' + (properNouns.length > 0 ? properNouns.join(', ') : '(none)'));
        
        let filteredResults = [];
        let denseResults = [];
        
        // ===== RUN 1: Filtered Search (if we have proper nouns) =====
        if (properNouns.length > 0) {
            console.log('[' + MODULE_NAME + '] Run 1: Filtered search with ' + properNouns.length + ' proper nouns...');
            
            // Build filter: match ANY of the proper nouns
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
                    limit: limit * 2,  // Request more since we'll filter some out
                    score_threshold: scoreThreshold,
                    with_payload: true,
                    filter: filter
                });
                
                const rawResults = filteredResult.result || [];
                console.log('[' + MODULE_NAME + '] Run 1 raw results: ' + rawResults.length);
                
                // IMPORTANT: Validate that each result actually has matching proper_nouns
                // This catches cases where Qdrant's filter doesn't work as expected
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
                    // Log which nouns matched
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
        
        // ===== RUN 2: Dense Search (if filtered returned fewer than limit) =====
        if (filteredResults.length < limit) {
            console.log('[' + MODULE_NAME + '] Run 2: Dense search (filtered returned ' + filteredResults.length + ' < ' + limit + ')...');
            
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
            console.log('[' + MODULE_NAME + '] Skipping dense: filtered returned sufficient results (' + filteredResults.length + ' >= ' + limit + ')');
        }
        
        // ===== COMBINE AND DEDUPLICATE =====
        const combined = [];
        const seenIds = new Set();
        
        // Add filtered results first (they matched on proper nouns = more relevant)
        filteredResults.forEach(function(r) {
            if (!seenIds.has(r.id)) {
                r._source = 'filtered'; // Mark source for debugging
                combined.push(r);
                seenIds.add(r.id);
            }
        });
        
        // Add dense results that weren't in filtered
        denseResults.forEach(function(r) {
            if (!seenIds.has(r.id)) {
                r._source = 'dense';
                combined.push(r);
                seenIds.add(r.id);
            }
        });
        
        // Sort by score descending
        combined.sort(function(a, b) { return b.score - a.score; });
        
        // Limit to requested count
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

/**
 * Delete a collection from Qdrant
 * Used for force re-indexing
 */
async function deleteCollection(collectionName) {
    try {
        await qdrantRequest('/collections/' + collectionName, 'DELETE');
        console.log('[' + MODULE_NAME + '] Deleted collection: ' + collectionName);
        return true;
    } catch (error) {
        // Collection might not exist, which is fine
        if (error.message && error.message.indexOf('404') !== -1) {
            console.log('[' + MODULE_NAME + '] Collection did not exist: ' + collectionName);
            return true;
        }
        console.error('[' + MODULE_NAME + '] Failed to delete collection:', error);
        throw error;
    }
}

/**
 * Force re-index the current chat
 * Deletes existing collection and rebuilds from scratch with proper_nouns for hybrid search
 */
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
    
    // Delete existing collection
    await deleteCollection(collectionName);
    
    // Reset tracking state
    currentChatIndexed = false;
    lastMessageCount = 0;
    indexedMessageIds.clear();
    
    // Get current chat and re-index
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
    
    // Extract characters present from the message
    let charactersPresent = [];
    if (message.present && Array.isArray(message.present)) {
        // present is an array of avatar filenames like ["character1.png", "character2.png"]
        charactersPresent = message.present.map(function(avatar) {
            // Remove .png extension to get character name
            return avatar.replace(/\.png$/, '');
        });
    } else if (tracker.CharactersPresent && Array.isArray(tracker.CharactersPresent)) {
        charactersPresent = tracker.CharactersPresent;
    }
    
    // Extract proper nouns for hybrid search filtering
    // ONLY from full_message and summary - NOT from character names or other metadata
    // This ensures we match on "messages that MENTION X" not "messages BY X"
    const messageProperNouns = extractProperNouns(message.mes || '');
    
    // Also extract from summary if it exists
    const summary = (message.extra && message.extra.qvink_memory && message.extra.qvink_memory.memory) 
        ? message.extra.qvink_memory.memory 
        : '';
    const summaryProperNouns = summary ? extractProperNouns(summary) : [];
    
    // Combine message and summary proper nouns (NOT character names)
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
        proper_nouns: Array.from(contentNouns) // For hybrid search filtering - content only!
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
        const chatMetadata = parsed.chatMetadata;
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
        const vectorSize = firstEmbedding.length;
        
        await createCollection(collectionName, vectorSize);
        
        const batchSize = 10;
        const points = [];
        
        for (let i = 0; i < messages.length; i++) {
            if (shouldStopIndexing) {
                console.log('[' + MODULE_NAME + '] Indexing stopped by user at message ' + i);
                updateUI('status', 'Stopped at ' + i + '/' + messages.length + ' messages');
                isIndexing = false;
                shouldStopIndexing = false;
                hideStopButton();
                return false;
            }
            
            const message = messages[i];
            updateUI('status', 'Indexing ' + (i + 1) + '/' + messages.length + '...');
            
            const embeddingText = buildEmbeddingText(message, message.tracker);
            const embedding = await generateEmbedding(embeddingText);
            const payload = extractPayload(message, i, chatIdHash);
            
            points.push({
                id: generateUUID(),
                vector: embedding,
                payload: payload
            });
            
            if (points.length >= batchSize) {
                await upsertVectors(collectionName, points);
                points.length = 0;
            }
        }
        
        if (points.length > 0) {
            await upsertVectors(collectionName, points);
        }
        
        updateUI('status', 'Successfully indexed ' + messages.length + ' messages!');
        console.log('[' + MODULE_NAME + '] Successfully indexed ' + messages.length + ' messages');
        
        isIndexing = false;
        shouldStopIndexing = false;
        hideStopButton();
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Indexing failed:', error);
        updateUI('status', 'Indexing failed: ' + error.message);
        isIndexing = false;
        shouldStopIndexing = false;
        hideStopButton();
        throw error;
    }
}

async function indexSingleMessage(message, chatIdHash, messageIndex, isGroupChat) {
    if (isGroupChat === undefined) isGroupChat = false;
    
    try {
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatIdHash;
        
        const embeddingText = buildEmbeddingText(message, message.tracker);
        const embedding = await generateEmbedding(embeddingText);
        const payload = extractPayload(message, messageIndex, chatIdHash);
        
        const point = {
            id: generateUUID(),
            vector: embedding,
            payload: payload
        };
        
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

async function retrieveContext(query, chatIdHash, isGroupChat) {
    if (isGroupChat === undefined) isGroupChat = false;
    
    try {
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatIdHash;
        
        // Extract filter terms from query (more lenient than proper noun extraction)
        // This will match words regardless of capitalization in the query
        const queryFilterTerms = extractQueryFilterTerms(query);
        console.log('[' + MODULE_NAME + '] Query filter terms: ' + 
            (queryFilterTerms.length > 0 ? queryFilterTerms.join(', ') : '(none - pure dense search)'));
        
        const queryEmbedding = await generateEmbedding(query);
        
        // Use hybrid search with filter terms
        const results = await searchVectors(
            collectionName,
            queryEmbedding,
            extensionSettings.retrievalCount,
            extensionSettings.similarityThreshold,
            queryFilterTerms  // Pass filter terms for filtering
        );
        
        if (results.length === 0) {
            console.log('[' + MODULE_NAME + '] No relevant context found');
            return '';
        }
        
        console.log('[' + MODULE_NAME + '] Retrieved ' + results.length + ' messages with scores:', 
            results.map(function(r) { return r.score.toFixed(3); }).join(', '));
        
        const contextParts = results.map(function(result) {
            const p = result.payload;
            const score = result.score;
            const source = result._source || 'unknown';
            
            let text = '\n[Character: ' + p.character_name + ']';
            if (p.timestamp) text += '\n[Time: ' + p.timestamp + ']';
            if (p.topic) text += '\n[Topic: ' + p.topic + ']';
            if (p.emotional_tone) text += '\n[Tone: ' + p.emotional_tone + ']';
            if (p.location) text += '\n[Location: ' + p.location + ']';
            text += '\n[Relevance Score: ' + score.toFixed(3) + ' (' + source + ')]';
            
            if (p.summary) {
                text += '\n\nSummary: ' + p.summary;
            }
            
            text += '\n\nFull Message: ' + p.full_message;
            
            return text;
        });
        
        const context = '\n\n========== RELEVANT PAST CONTEXT FROM RAG ==========\n' + 
                       contextParts.join('\n\n-------------------\n') + 
                       '\n\n========== END RAG CONTEXT ==========\n\n';
        
        console.log('[' + MODULE_NAME + '] Formatted context with full metadata (' + context.length + ' chars)');
        return context;
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
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const context = SillyTavern.getContext();
            if (context.chatMetadata && context.chatMetadata.chat_id_hash) {
                return context.chatMetadata.chat_id_hash;
            }
            if (context.chat_id) {
                return context.chat_id;
            }
        }
        
        if (typeof getContext === 'function') {
            const context = getContext();
            if (context.chatMetadata && context.chatMetadata.chat_id_hash) {
                return context.chatMetadata.chat_id_hash;
            }
            if (context.chat_id) {
                return context.chat_id;
            }
        }
        
        return null;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Error getting chat ID:', error);
        return null;
    }
}

function isCurrentChatGroupChat() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const context = SillyTavern.getContext();
            return context.groupId !== null && context.groupId !== undefined;
        }
        
        if (typeof getContext === 'function') {
            const context = getContext();
            return context.groupId !== null && context.groupId !== undefined;
        }
        
        return false;
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
        let context;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            context = SillyTavern.getContext();
        } else if (typeof getContext === 'function') {
            context = getContext();
        }
        
        if (context && context.chat) {
            lastMessageCount = context.chat.length;
            console.log('[' + MODULE_NAME + '] Initial message count: ' + lastMessageCount);
        }
        
        // Check if collection already exists in Qdrant
        if (chatId) {
            const isGroupChat = isCurrentChatGroupChat();
            const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
            const collectionName = prefix + chatId;
            
            try {
                const pointCount = await countPoints(collectionName);
                if (pointCount > 0) {
                    currentChatIndexed = true;
                    console.log('[' + MODULE_NAME + '] Collection exists with ' + pointCount + ' points - marking as indexed');
                    updateUI('status', 'Indexed (' + pointCount + ' messages)');
                } else {
                    console.log('[' + MODULE_NAME + '] Collection empty or not found - needs indexing');
                    updateUI('status', 'Ready to index');
                }
            } catch (checkError) {
                console.log('[' + MODULE_NAME + '] Collection not found - needs indexing');
                updateUI('status', 'Ready to index');
            }
        }
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Error in onChatLoaded:', error);
    }
}

async function onMessageSent(messageData) {
    console.log('[' + MODULE_NAME + '] ===== MESSAGE SENT EVENT FIRED =====');
    console.log('[' + MODULE_NAME + '] Event data:', messageData);
    
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) {
        console.log('[' + MODULE_NAME + '] Auto-index disabled, skipping');
        return;
    }
    
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.log('[' + MODULE_NAME + '] No chat ID, skipping');
        return;
    }
    
    const isGroupChat = isCurrentChatGroupChat();
    
    if (!currentChatIndexed && typeof SillyTavern !== 'undefined') {
        try {
            updateUI('status', 'Auto-indexing chat...');
            const context = SillyTavern.getContext();
            if (context.chat && context.chat.length > 0) {
                const jsonl = convertChatToJSONL(context);
                await indexChat(jsonl, chatId, isGroupChat);
                currentChatIndexed = true;
            }
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Auto-indexing failed:', error);
            updateUI('status', 'Auto-index failed: ' + error.message);
        }
    }
    
    if (messageData && currentChatIndexed) {
        const messageIndex = SillyTavern.getContext().chat.length - 1;
        await indexSingleMessage(messageData, chatId, messageIndex, isGroupChat);
    }
    
    // Note: RAG context retrieval happens during chat_completion_prompt_ready event
    // Query is based on context.chat (actual messages), not data.chat (API format)
    
    console.log('[' + MODULE_NAME + '] ===== MESSAGE SENT HANDLER COMPLETE =====');
}

async function onMessageReceived(messageData) {
    console.log('[' + MODULE_NAME + '] ===== MESSAGE RECEIVED EVENT FIRED =====');
    
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) {
        return;
    }
    
    const chatId = getCurrentChatId();
    if (!chatId) {
        return;
    }
    
    const isGroupChat = isCurrentChatGroupChat();
    
    // Index the newly received message
    if (currentChatIndexed && typeof SillyTavern !== 'undefined') {
        try {
            const context = SillyTavern.getContext();
            if (context.chat && context.chat.length > 0) {
                const messageIndex = context.chat.length - 1;
                const message = context.chat[messageIndex];
                if (!indexedMessageIds.has(messageIndex)) {
                    console.log('[' + MODULE_NAME + '] Indexing received message ' + messageIndex);
                    await indexSingleMessage(message, chatId, messageIndex, isGroupChat);
                    indexedMessageIds.add(messageIndex);
                    lastMessageCount = context.chat.length;
                }
            }
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Failed to index received message:', error);
        }
    }
    
    console.log('[' + MODULE_NAME + '] ===== MESSAGE RECEIVED HANDLER COMPLETE =====');
}

async function injectContextWithSetExtensionPrompt() {
    if (!extensionSettings.enabled || !extensionSettings.injectContext) {
        return;
    }
    
    const chatId = getCurrentChatId();
    if (!chatId) {
        return;
    }
    
    // Check if chat is indexed
    if (!currentChatIndexed) {
        const isGroupChat = isCurrentChatGroupChat();
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatId;
        try {
            const pointCount = await countPoints(collectionName);
            if (pointCount > 0) {
                currentChatIndexed = true;
                console.log('[' + MODULE_NAME + '] Found indexed collection with ' + pointCount + ' points');
            } else {
                console.log('[' + MODULE_NAME + '] Chat not indexed, skipping injection');
                return;
            }
        } catch (e) {
            console.log('[' + MODULE_NAME + '] Could not verify collection, skipping injection');
            return;
        }
    }
    
    const isGroupChat = isCurrentChatGroupChat();
    
    // Get context for both the chat data AND setExtensionPrompt
    let context;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        context = SillyTavern.getContext();
    } else if (typeof getContext === 'function') {
        context = getContext();
    }
    
    if (!context || !context.chat || context.chat.length === 0) {
        console.log('[' + MODULE_NAME + '] No chat context available');
        return;
    }
    
    if (!context.setExtensionPrompt || typeof context.setExtensionPrompt !== 'function') {
        console.log('[' + MODULE_NAME + '] setExtensionPrompt not available');
        return;
    }
    
    // Find the last actual message (user or character) - skip system messages
    let lastMessage = null;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (msg.mes && !msg.is_system && msg.mes.trim().length > 0) {
            lastMessage = msg;
            break;
        }
    }
    
    if (!lastMessage || !lastMessage.mes) {
        console.log('[' + MODULE_NAME + '] No valid last message found');
        return;
    }
    
    let query = lastMessage.mes;
    if (query.length > 1000) {
        query = query.substring(0, 1000);
    }
    
    console.log('[' + MODULE_NAME + '] Query from ' + (lastMessage.is_user ? 'user' : 'character') + ': "' + query.substring(0, 80) + '..."');
    
    // Retrieve context
    console.log('[' + MODULE_NAME + '] Retrieving RAG context...');
    const retrievedContext = await retrieveContext(query, chatId, isGroupChat);
    
    if (!retrievedContext) {
        console.log('[' + MODULE_NAME + '] No relevant context found');
        return;
    }
    
    console.log('[' + MODULE_NAME + '] Retrieved context (' + retrievedContext.length + ' chars)');
    
    // Determine position and depth based on settings
    // Position: 0 = before main prompt, 1 = after main prompt
    // Depth: how many messages from the end to insert (0 = at system prompt level)
    let position = 1; // after main prompt
    let depth = 4; // default depth
    
    if (extensionSettings.injectionPosition === 'before_main') {
        position = 0;
        depth = 0;
    } else if (extensionSettings.injectionPosition === 'after_main') {
        position = 1;
        depth = 0;
    } else if (extensionSettings.injectionPosition === 'after_messages') {
        position = 1;
        depth = extensionSettings.injectAfterMessages || 3;
    }
    
    // Format the context with a wrapper
    const formattedContext = '[Relevant context from earlier in conversation:\n' + retrievedContext + '\n]';
    
    // Use setExtensionPrompt - this is the proper SillyTavern API!
    try {
        context.setExtensionPrompt(MODULE_NAME, formattedContext, position, depth);
        console.log('[' + MODULE_NAME + '] Injected via setExtensionPrompt (position=' + position + ', depth=' + depth + ')');
        console.log('[' + MODULE_NAME + '] ===== INJECTION SUCCESSFUL =====');
        updateUI('status', 'Context injected (' + retrievedContext.length + ' chars)');
    } catch (e) {
        console.error('[' + MODULE_NAME + '] setExtensionPrompt failed:', e);
    }
}

async function injectContextBeforeGeneration(data) {
    // Debounce - prevent multiple injections in quick succession
    const now = Date.now();
    if (now - lastInjectionTime < INJECTION_DEBOUNCE_MS) {
        console.log('[' + MODULE_NAME + '] Skipping injection - debounce');
        return;
    }
    
    // Skip if no data or chat
    if (!data || !data.chat || !Array.isArray(data.chat)) {
        return;
    }
    
    // Skip Tracker and other extension calls - they have small chat arrays
    if (data.chat.length <= 5) {
        return;
    }
    
    if (!extensionSettings.enabled || !extensionSettings.injectContext) {
        return;
    }
    
    const chatId = getCurrentChatId();
    if (!chatId) {
        return;
    }
    
    // Check if chat is indexed
    if (!currentChatIndexed) {
        const isGroupChat = isCurrentChatGroupChat();
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatId;
        try {
            const pointCount = await countPoints(collectionName);
            if (pointCount > 0) {
                currentChatIndexed = true;
                console.log('[' + MODULE_NAME + '] Found indexed collection with ' + pointCount + ' points');
            } else {
                console.log('[' + MODULE_NAME + '] Chat not indexed, skipping injection');
                return;
            }
        } catch (e) {
            console.log('[' + MODULE_NAME + '] Could not verify collection, skipping injection');
            return;
        }
    }
    
    const isGroupChat = isCurrentChatGroupChat();
    
    // Get query from SillyTavern's context.chat (actual messages with .mes format)
    // This gives us the REAL last message, not prompt instructions
    let context;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        context = SillyTavern.getContext();
    } else if (typeof getContext === 'function') {
        context = getContext();
    }
    
    if (!context || !context.chat || context.chat.length === 0) {
        console.log('[' + MODULE_NAME + '] No chat context available');
        return;
    }
    
    // Find the last actual message (user or character) from context.chat - skip system messages
    let lastMessage = null;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (msg.mes && !msg.is_system && msg.mes.trim().length > 0) {
            lastMessage = msg;
            break;
        }
    }
    
    if (!lastMessage || !lastMessage.mes) {
        console.log('[' + MODULE_NAME + '] No valid last message found');
        return;
    }
    
    let query = lastMessage.mes;
    if (query.length > 1000) {
        query = query.substring(0, 1000);
    }
    
    console.log('[' + MODULE_NAME + '] Query from ' + (lastMessage.is_user ? 'user' : 'character') + ': "' + query.substring(0, 80) + '..."');
    
    // Retrieve context based on the message
    console.log('[' + MODULE_NAME + '] Retrieving RAG context...');
    const retrievedContext = await retrieveContext(query, chatId, isGroupChat);
    
    if (!retrievedContext) {
        console.log('[' + MODULE_NAME + '] No relevant context found');
        return;
    }
    
    console.log('[' + MODULE_NAME + '] Retrieved context (' + retrievedContext.length + ' chars)');
    
    // Inject into data.chat (API format copy) - NOT context.chat!
    // data.chat is temporary for this generation only, won't affect Tracker
    const ragMessage = {
        role: 'system',
        content: '[Relevant context from earlier in conversation:\n' + retrievedContext + '\n]'
    };
    
    // Find insertion point based on settings
    let insertIndex = 0;
    
    if (extensionSettings.injectionPosition === 'before_main') {
        // Insert at the beginning
        insertIndex = 0;
    } else if (extensionSettings.injectionPosition === 'after_main') {
        // Insert after system messages but before conversation
        for (let i = 0; i < data.chat.length; i++) {
            if (data.chat[i].role === 'user' || data.chat[i].role === 'assistant') {
                insertIndex = i;
                break;
            }
            insertIndex = i + 1;
        }
    } else if (extensionSettings.injectionPosition === 'after_messages') {
        // Insert at depth from end
        const depth = extensionSettings.injectAfterMessages || 3;
        insertIndex = Math.max(0, data.chat.length - depth);
    }
    
    data.chat.splice(insertIndex, 0, ragMessage);
    
    // Update debounce timestamp
    lastInjectionTime = Date.now();
    
    console.log('[' + MODULE_NAME + '] Injected into data.chat at index ' + insertIndex + ' (total: ' + data.chat.length + ')');
    console.log('[' + MODULE_NAME + '] ===== INJECTION SUCCESSFUL =====');
    updateUI('status', 'Context injected (' + retrievedContext.length + ' chars)');
}

async function pollForNewMessages() {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) {
        return;
    }
    
    if (isIndexing) {
        return;
    }
    
    try {
        let context;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            context = SillyTavern.getContext();
        } else if (typeof getContext === 'function') {
            context = getContext();
        }
        
        if (!context || !context.chat) return;
        
        const chatId = getCurrentChatId();
        if (!chatId) return;
        
        if (lastChatId !== chatId) {
            console.log('[' + MODULE_NAME + '] Chat changed to: ' + chatId);
            lastChatId = chatId;
            currentChatIndexed = false;
            lastMessageCount = 0;
            indexedMessageIds.clear();
            
            const isGroupChat = isCurrentChatGroupChat();
            const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
            const collectionName = prefix + chatId;
            const existingPoints = await countPoints(collectionName);
            
            if (existingPoints > 0) {
                console.log('[' + MODULE_NAME + '] Chat has ' + existingPoints + ' points - marking as indexed');
                currentChatIndexed = true;
                lastMessageCount = context.chat.length;
                for (let i = 0; i < lastMessageCount; i++) {
                    indexedMessageIds.add(i);
                }
                updateUI('status', 'Chat already indexed (' + existingPoints + ' messages)');
            }
        }
        
        const currentMessageCount = context.chat.length;
        
        if (currentMessageCount > lastMessageCount) {
            console.log('[' + MODULE_NAME + '] New message: count ' + lastMessageCount + ' -> ' + currentMessageCount);
            
            const isGroupChat = isCurrentChatGroupChat();
            
            if (!currentChatIndexed) {
                console.log('[' + MODULE_NAME + '] Auto-indexing entire chat (' + currentMessageCount + ' messages)');
                updateUI('status', 'Auto-indexing chat...');
                const jsonl = convertChatToJSONL(context);
                await indexChat(jsonl, chatId, isGroupChat);
                currentChatIndexed = true;
                
                for (let i = 0; i < currentMessageCount; i++) {
                    indexedMessageIds.add(i);
                }
            } else {
                for (let i = lastMessageCount; i < currentMessageCount; i++) {
                    if (!indexedMessageIds.has(i)) {
                        const message = context.chat[i];
                        console.log('[' + MODULE_NAME + '] Indexing new message ' + i + ': ' + message.name);
                        await indexSingleMessage(message, chatId, i, isGroupChat);
                        indexedMessageIds.add(i);
                    }
                }
            }
            
            lastMessageCount = currentMessageCount;
            updateUI('status', 'Ready - ' + currentMessageCount + ' messages indexed');
            
            // Only inject from polling if events aren't registered
            // (events handle injection via GENERATE_BEFORE_COMBINE_PROMPTS etc.)
            if (extensionSettings.injectContext && !eventsRegistered) {
                console.log('[' + MODULE_NAME + '] Polling: injecting context (no events available)');
                await injectContextBeforeGeneration();
            }
        }
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Polling error:', error);
    }
}

async function startPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    
    console.log('[' + MODULE_NAME + '] Starting message polling (every 5 seconds)');
    pollingInterval = setInterval(pollForNewMessages, 5000);
    
    await pollForNewMessages();
}

function convertChatToJSONL(context) {
    const lines = [];
    
    if (context.chatMetadata) {
        lines.push(JSON.stringify({ chat_metadata: context.chatMetadata }));
    }
    
    if (context.chat) {
        context.chat.forEach(function(message) {
            lines.push(JSON.stringify(message));
        });
    }
    
    return lines.join('\n');
}

// ===========================
// UI Functions
// ===========================

function showStopButton() {
    const btn = document.getElementById('ragfordummies_stop_indexing');
    if (btn) {
        btn.classList.add('active');
        console.log('[' + MODULE_NAME + '] Stop button shown');
    }
}

function hideStopButton() {
    const btn = document.getElementById('ragfordummies_stop_indexing');
    if (btn) {
        btn.classList.remove('active');
    }
}

function updateUI(element, value) {
    const el = document.getElementById('ragfordummies_' + element);
    if (el) {
        if (element === 'status') {
            el.textContent = value;
        } else {
            el.value = value;
        }
    }
}

function createSettingsUI() {
    const html = 
        '<div id="ragfordummies_container" class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header">' +
                '<b>RagForDummies</b>' +
                '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
            '</div>' +
            '<div class="inline-drawer-content">' +
                '<div class="ragfordummies-settings">' +
                    '<div class="ragfordummies-section">' +
                        '<label class="checkbox_label">' +
                            '<input type="checkbox" id="ragfordummies_enabled" ' + (extensionSettings.enabled ? 'checked' : '') + ' />' +
                            'Enable RAG' +
                        '</label>' +
                    '</div>' +
                    
                    '<div class="ragfordummies-section">' +
                        '<h4>Qdrant Configuration</h4>' +
                        '<label>' +
                            '<span>Mode:</span>' +
                            '<select id="ragfordummies_qdrant_mode">' +
                                '<option value="local" ' + (extensionSettings.qdrantMode === 'local' ? 'selected' : '') + '>Local (Docker)</option>' +
                                '<option value="cloud" ' + (extensionSettings.qdrantMode === 'cloud' ? 'selected' : '') + '>Cloud</option>' +
                            '</select>' +
                        '</label>' +
                        
                        '<label>' +
                            '<span>Local URL:</span>' +
                            '<input type="text" id="ragfordummies_qdrant_local_url" value="' + extensionSettings.qdrantLocalUrl + '" placeholder="http://localhost:6333" />' +
                        '</label>' +
                        
                        '<label>' +
                            '<span>Cloud URL:</span>' +
                            '<input type="text" id="ragfordummies_qdrant_cloud_url" value="' + extensionSettings.qdrantCloudUrl + '" placeholder="https://your-cluster.qdrant.io" />' +
                        '</label>' +
                        
                        '<label>' +
                            '<span>Cloud API Key:</span>' +
                            '<input type="password" id="ragfordummies_qdrant_api_key" value="' + extensionSettings.qdrantApiKey + '" placeholder="Your Qdrant API key" />' +
                        '</label>' +
                    '</div>' +
                    
                    '<div class="ragfordummies-section">' +
                        '<h4>Embedding Provider</h4>' +
                        '<label>' +
                            '<span>Provider:</span>' +
                            '<select id="ragfordummies_embedding_provider">' +
                                '<option value="kobold" ' + (extensionSettings.embeddingProvider === 'kobold' ? 'selected' : '') + '>KoboldCpp</option>' +
                                '<option value="ollama" ' + (extensionSettings.embeddingProvider === 'ollama' ? 'selected' : '') + '>Ollama</option>' +
                                '<option value="openai" ' + (extensionSettings.embeddingProvider === 'openai' ? 'selected' : '') + '>OpenAI</option>' +
                            '</select>' +
                        '</label>' +
                        
                        '<label id="ragfordummies_kobold_settings" style="' + (extensionSettings.embeddingProvider === 'kobold' ? '' : 'display:none') + '">' +
                            '<span>KoboldCpp URL:</span>' +
                            '<input type="text" id="ragfordummies_kobold_url" value="' + extensionSettings.koboldUrl + '" placeholder="http://localhost:5001" />' +
                        '</label>' +
                        
                        '<div id="ragfordummies_ollama_settings" style="' + (extensionSettings.embeddingProvider === 'ollama' ? '' : 'display:none') + '">' +
                            '<label>' +
                                '<span>Ollama URL:</span>' +
                                '<input type="text" id="ragfordummies_ollama_url" value="' + extensionSettings.ollamaUrl + '" placeholder="http://localhost:11434" />' +
                            '</label>' +
                            '<label>' +
                                '<span>Ollama Model:</span>' +
                                '<input type="text" id="ragfordummies_ollama_model" value="' + extensionSettings.ollamaModel + '" placeholder="nomic-embed-text" />' +
                            '</label>' +
                        '</div>' +
                        
                        '<div id="ragfordummies_openai_settings" style="' + (extensionSettings.embeddingProvider === 'openai' ? '' : 'display:none') + '">' +
                            '<label>' +
                                '<span>OpenAI API Key:</span>' +
                                '<input type="password" id="ragfordummies_openai_api_key" value="' + extensionSettings.openaiApiKey + '" placeholder="sk-..." />' +
                            '</label>' +
                            '<label>' +
                                '<span>OpenAI Model:</span>' +
                                '<input type="text" id="ragfordummies_openai_model" value="' + extensionSettings.openaiModel + '" placeholder="text-embedding-3-small" />' +
                            '</label>' +
                        '</div>' +
                    '</div>' +
                    
                    '<div class="ragfordummies-section">' +
                        '<h4>RAG Settings</h4>' +
                        '<label>' +
                            '<span>Retrieval Count:</span>' +
                            '<input type="number" id="ragfordummies_retrieval_count" value="' + extensionSettings.retrievalCount + '" min="1" max="20" />' +
                        '</label>' +
                        
                        '<label>' +
                            '<span>Similarity Threshold:</span>' +
                            '<input type="number" id="ragfordummies_similarity_threshold" value="' + extensionSettings.similarityThreshold + '" min="0" max="1" step="0.1" />' +
                        '</label>' +
                        
                        '<label class="checkbox_label">' +
                            '<input type="checkbox" id="ragfordummies_auto_index" ' + (extensionSettings.autoIndex ? 'checked' : '') + ' />' +
                            'Auto-index on first message' +
                        '</label>' +
                        
                        '<label class="checkbox_label">' +
                            '<input type="checkbox" id="ragfordummies_inject_context" ' + (extensionSettings.injectContext ? 'checked' : '') + ' />' +
                            'Inject context into prompt' +
                        '</label>' +
                    '</div>' +
                    
                    '<div class="ragfordummies-section">' +
                        '<h4>Context Injection Position</h4>' +
                        '<label>' +
                            '<span>Injection Position:</span>' +
                            '<select id="ragfordummies_injection_position">' +
                                '<option value="before_main" ' + (extensionSettings.injectionPosition === 'before_main' ? 'selected' : '') + '>Before Main Prompt</option>' +
                                '<option value="after_main" ' + (extensionSettings.injectionPosition === 'after_main' ? 'selected' : '') + '>After Main Prompt</option>' +
                                '<option value="after_messages" ' + (extensionSettings.injectionPosition === 'after_messages' ? 'selected' : '') + '>After X Messages</option>' +
                            '</select>' +
                        '</label>' +
                        
                        '<label id="ragfordummies_inject_after_messages_setting" style="' + (extensionSettings.injectionPosition === 'after_messages' ? '' : 'display:none') + '">' +
                            '<span>Messages from End:</span>' +
                            '<input type="number" id="ragfordummies_inject_after_messages" value="' + extensionSettings.injectAfterMessages + '" min="0" max="50" />' +
                            '<small style="opacity:0.7; display:block; margin-top:5px;">0 = at the very end, 3 = after last 3 messages</small>' +
                        '</label>' +
                    '</div>' +
                    
                    '<div class="ragfordummies-section">' +
                        '<h4>Connection Tests</h4>' +
                        '<button id="ragfordummies_test_qdrant" class="menu_button">Test Qdrant Connection</button>' +
                        '<button id="ragfordummies_test_embedding" class="menu_button">Test Embedding Provider</button>' +
                        '<button id="ragfordummies_test_retrieval" class="menu_button">Test Context Retrieval</button>' +
                        '<button id="ragfordummies_test_injection" class="menu_button">Test Context Injection</button>' +
                        '<hr style="border-color: var(--SmartThemeBorderColor); margin: 10px 0;" />' +
                        '<label>' +
                            '<span>Hybrid Search Test Query:</span>' +
                            '<input type="text" id="ragfordummies_hybrid_test_query" placeholder="e.g. What did Alice say about the garden?" style="width: 100%;" />' +
                        '</label>' +
                        '<button id="ragfordummies_test_hybrid" class="menu_button">Test Hybrid Search</button>' +
                        '<pre id="ragfordummies_hybrid_results" style="background: var(--black70a); padding: 10px; border-radius: 5px; font-size: 0.8em; max-height: 300px; overflow-y: auto; white-space: pre-wrap; display: none;"></pre>' +
                    '</div>' +
                    
                    '<div class="ragfordummies-section">' +
                        '<h4>Manual Operations</h4>' +
                        '<button id="ragfordummies_index_current" class="menu_button">Index Current Chat</button>' +
                        '<button id="ragfordummies_force_reindex" class="menu_button">Force Re-index (Rebuild)</button>' +
                        '<button id="ragfordummies_stop_indexing" class="menu_button ragfordummies-stop-btn">Stop Indexing</button>' +
                        '<hr style="border-color: var(--SmartThemeBorderColor); margin: 10px 0;" />' +
                        '<label class="checkbox_label" style="margin-bottom: 8px;">' +
                            '<input type="checkbox" id="ragfordummies_merge_uploads" checked />' +
                            '<span>Merge uploads into current chat collection</span>' +
                        '</label>' +
                        '<button id="ragfordummies_upload_btn" class="menu_button">Upload Chat JSONL</button>' +
                        '<input type="file" id="ragfordummies_file_input" accept=".jsonl" style="display:none" />' +
                        '<div id="ragfordummies_status" class="ragfordummies-status">Ready</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    
    return html;
}

function attachEventListeners() {
    const settingIds = [
        'enabled', 'qdrant_mode', 'qdrant_local_url', 'qdrant_cloud_url', 'qdrant_api_key',
        'embedding_provider', 'kobold_url', 'ollama_url', 'ollama_model', 
        'openai_api_key', 'openai_model', 'retrieval_count', 'similarity_threshold',
        'auto_index', 'inject_context', 'injection_position', 'inject_after_messages'
    ];
    
    settingIds.forEach(function(id) {
        const element = document.getElementById('ragfordummies_' + id);
        if (element) {
            element.addEventListener('change', function() {
                const key = id.replace(/_([a-z])/g, function(m, l) { return l.toUpperCase(); });
                
                if (element.type === 'checkbox') {
                    extensionSettings[key] = element.checked;
                    
                    if (id === 'auto_index') {
                        if (element.checked && typeof eventSource === 'undefined' && !pollingInterval) {
                            console.log('[' + MODULE_NAME + '] Auto-index enabled, starting polling');
                            startPolling();
                        } else if (!element.checked && pollingInterval) {
                            console.log('[' + MODULE_NAME + '] Auto-index disabled, stopping polling');
                            clearInterval(pollingInterval);
                            pollingInterval = null;
                        }
                    }
                } else if (element.type === 'number') {
                    extensionSettings[key] = parseFloat(element.value);
                } else {
                    extensionSettings[key] = element.value;
                }
                
                saveSettings();
            });
        }
    });
    
    const providerSelect = document.getElementById('ragfordummies_embedding_provider');
    if (providerSelect) {
        providerSelect.addEventListener('change', function() {
            const provider = providerSelect.value;
            document.getElementById('ragfordummies_kobold_settings').style.display = provider === 'kobold' ? '' : 'none';
            document.getElementById('ragfordummies_ollama_settings').style.display = provider === 'ollama' ? '' : 'none';
            document.getElementById('ragfordummies_openai_settings').style.display = provider === 'openai' ? '' : 'none';
        });
    }
    
    // Injection position toggle
    const injectionPositionSelect = document.getElementById('ragfordummies_injection_position');
    if (injectionPositionSelect) {
        injectionPositionSelect.addEventListener('change', function() {
            const position = injectionPositionSelect.value;
            const messagesField = document.getElementById('ragfordummies_inject_after_messages_setting');
            if (messagesField) {
                messagesField.style.display = position === 'after_messages' ? '' : 'none';
            }
        });
    }
    
    const testQdrantBtn = document.getElementById('ragfordummies_test_qdrant');
    if (testQdrantBtn) {
        testQdrantBtn.addEventListener('click', async function() {
            updateUI('status', 'Testing Qdrant connection...');
            try {
                const result = await qdrantRequest('/collections');
                updateUI('status', '✓ Qdrant connected! Found ' + result.result.collections.length + ' collections');
                console.log('[' + MODULE_NAME + '] Qdrant test successful:', result);
            } catch (error) {
                updateUI('status', '✗ Qdrant connection failed: ' + error.message);
                console.error('[' + MODULE_NAME + '] Qdrant test failed:', error);
            }
        });
    }
    
    const testEmbeddingBtn = document.getElementById('ragfordummies_test_embedding');
    if (testEmbeddingBtn) {
        testEmbeddingBtn.addEventListener('click', async function() {
            updateUI('status', 'Testing embedding provider...');
            try {
                const embedding = await generateEmbedding('This is a test message');
                updateUI('status', '✓ Embedding provider working! Vector size: ' + embedding.length);
                console.log('[' + MODULE_NAME + '] Embedding test successful, dimension:', embedding.length);
            } catch (error) {
                updateUI('status', '✗ Embedding failed: ' + error.message);
                console.error('[' + MODULE_NAME + '] Embedding test failed:', error);
            }
        });
    }
    
    const testRetrievalBtn = document.getElementById('ragfordummies_test_retrieval');
    console.log('[' + MODULE_NAME + '] Test retrieval button found:', testRetrievalBtn !== null);
    
    if (testRetrievalBtn) {
        testRetrievalBtn.addEventListener('click', async function() {
            console.log('[' + MODULE_NAME + '] ========================================');
            console.log('[' + MODULE_NAME + '] TEST CONTEXT RETRIEVAL STARTED');
            console.log('[' + MODULE_NAME + '] ========================================');
            
            updateUI('status', 'Testing context retrieval...');
            try {
                const chatId = getCurrentChatId();
                console.log('[' + MODULE_NAME + '] Chat ID:', chatId);
                
                if (!chatId) {
                    updateUI('status', '✗ No active chat found');
                    console.log('[' + MODULE_NAME + '] FAILED: No chat ID');
                    return;
                }
                
                console.log('[' + MODULE_NAME + '] Chat indexed:', currentChatIndexed);
                
                if (!currentChatIndexed) {
                    updateUI('status', '✗ Chat not indexed yet. Click "Index Current Chat" first.');
                    console.log('[' + MODULE_NAME + '] FAILED: Chat not indexed');
                    return;
                }
                
                const isGroupChat = isCurrentChatGroupChat();
                const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
                const collectionName = prefix + chatId;
                
                console.log('[' + MODULE_NAME + '] Is group chat:', isGroupChat);
                console.log('[' + MODULE_NAME + '] Collection name:', collectionName);
                
                // Check collection exists
                const pointCount = await countPoints(collectionName);
                console.log('[' + MODULE_NAME + '] Collection has ' + pointCount + ' indexed points');
                
                if (pointCount === 0) {
                    updateUI('status', '✗ Collection is empty! Re-index the chat.');
                    console.log('[' + MODULE_NAME + '] FAILED: Collection empty');
                    return;
                }
                
                const context = SillyTavern.getContext();
                
                // Get ONLY actual chat messages (same logic as injection)
                const actualMessages = context.chat.filter(function(m) {
                    if (!m.mes) return false;
                    if (m.is_system) return false;
                    if (m.mes.trim().length === 0) return false;
                    return true;
                });
                
                // Get ONLY the last message
                const lastMessage = actualMessages[actualMessages.length - 1];
                
                if (!lastMessage) {
                    updateUI('status', '✗ No valid message found');
                    return;
                }
                
                let query = lastMessage.mes;
                
                console.log('[' + MODULE_NAME + '] Query from last message (' + (lastMessage.is_user ? 'USER' : 'CHAR') + '): "' + query.substring(0, 100) + '..."');
                
                if (query.length > 1000) {
                    query = query.substring(0, 1000);
                }
                
                console.log('[' + MODULE_NAME + '] Query text length:', query.length);
                console.log('[' + MODULE_NAME + '] ---');
                console.log('[' + MODULE_NAME + '] Sending search request to Qdrant...');
                
                const retrievedContext = await retrieveContext(query, chatId, isGroupChat);
                
                console.log('[' + MODULE_NAME + '] ---');
                
                if (retrievedContext) {
                    updateUI('status', '✓ Retrieved ' + retrievedContext.length + ' chars of context');
                    console.log('[' + MODULE_NAME + '] SUCCESS - Retrieved context:');
                    console.log('[' + MODULE_NAME + '] ========== FULL RETRIEVED CONTEXT ==========');
                    console.log(retrievedContext);
                    console.log('[' + MODULE_NAME + '] ============================================');
                } else {
                    updateUI('status', '✗ No context found - try lowering similarity threshold to 0.5 or 0.4');
                    console.log('[' + MODULE_NAME + '] No context retrieved - similarity threshold may be too high');
                    console.log('[' + MODULE_NAME + '] Current threshold: ' + extensionSettings.similarityThreshold);
                    console.log('[' + MODULE_NAME + '] Try lowering it in settings');
                }
                
                console.log('[' + MODULE_NAME + '] ========================================');
                console.log('[' + MODULE_NAME + '] TEST COMPLETE');
                console.log('[' + MODULE_NAME + '] ========================================');
            } catch (error) {
                updateUI('status', '✗ Retrieval failed: ' + error.message);
                console.error('[' + MODULE_NAME + '] TEST FAILED -', error);
                console.error('[' + MODULE_NAME + '] Error stack:', error.stack);
            }
        });
        console.log('[' + MODULE_NAME + '] Test retrieval button handler attached');
    } else {
        console.error('[' + MODULE_NAME + '] Test retrieval button NOT FOUND in DOM!');
    }
    
    // Test context injection
    const testInjectionBtn = document.getElementById('ragfordummies_test_injection');
    if (testInjectionBtn) {
        testInjectionBtn.addEventListener('click', async function() {
            console.log('[' + MODULE_NAME + '] ========================================');
            console.log('[' + MODULE_NAME + '] TEST CONTEXT INJECTION');
            console.log('[' + MODULE_NAME + '] ========================================');
            
            updateUI('status', 'Testing context injection...');
            
            if (!currentChatIndexed) {
                updateUI('status', '✗ Chat not indexed. Index first.');
                console.log('[' + MODULE_NAME + '] FAILED: Chat not indexed');
                return;
            }
            
            console.log('[' + MODULE_NAME + '] Searching for SillyTavern extension API...');
            console.log('[' + MODULE_NAME + '] typeof setExtensionPrompt:', typeof setExtensionPrompt);
            console.log('[' + MODULE_NAME + '] typeof window.setExtensionPrompt:', typeof window.setExtensionPrompt);
            console.log('[' + MODULE_NAME + '] typeof extension_prompts:', typeof extension_prompts);
            console.log('[' + MODULE_NAME + '] typeof window.extension_prompts:', typeof window.extension_prompts);
            console.log('[' + MODULE_NAME + '] typeof eventSource:', typeof eventSource);
            console.log('[' + MODULE_NAME + '] typeof SillyTavern:', typeof SillyTavern);
            
            if (typeof SillyTavern !== 'undefined') {
                console.log('[' + MODULE_NAME + '] SillyTavern EXISTS! Exploring...');
                console.log('[' + MODULE_NAME + '] SillyTavern keys:', Object.keys(SillyTavern));
                
                // Explore libs
                if (SillyTavern.libs) {
                    console.log('[' + MODULE_NAME + '] SillyTavern.libs exists!');
                    console.log('[' + MODULE_NAME + '] libs keys:', Object.keys(SillyTavern.libs));
                    console.log('[' + MODULE_NAME + '] libs content:', SillyTavern.libs);
                }
                
                // Check context
                if (SillyTavern.getContext) {
                    const ctx = SillyTavern.getContext();
                    console.log('[' + MODULE_NAME + '] Context keys:', Object.keys(ctx));
                    
                    // Look for prompt-related properties
                    const promptProps = Object.keys(ctx).filter(function(k) {
                        return k.toLowerCase().indexOf('prompt') !== -1 ||
                               k.toLowerCase().indexOf('extension') !== -1;
                    });
                    console.log('[' + MODULE_NAME + '] Prompt-related context properties:', promptProps);
                    
                    // Check if setExtensionPrompt is on context
                if (ctx.setExtensionPrompt) {
                    console.log('[' + MODULE_NAME + '] context.setExtensionPrompt EXISTS');
                    console.log('[' + MODULE_NAME + '] This is the correct injection method!');
                    console.log('[' + MODULE_NAME + '] Triggering test injection...');
                    await injectContextBeforeGeneration();
                } else {
                    console.log('[' + MODULE_NAME + '] context.setExtensionPrompt NOT FOUND');
                }
                
                // Check if there's an extension_prompts array in context
                if (ctx.extensionPrompts) {
                    console.log('[' + MODULE_NAME + '] ctx.extensionPrompts exists:', ctx.extensionPrompts);
                }
            }
            
            if (SillyTavern.extensions) {
                console.log('[' + MODULE_NAME + '] SillyTavern.extensions:', SillyTavern.extensions);
                console.log('[' + MODULE_NAME + '] extensions keys:', Object.keys(SillyTavern.extensions));
            }
            
            if (SillyTavern.setExtensionPrompt) {
                console.log('[' + MODULE_NAME + '] SillyTavern.setExtensionPrompt EXISTS');
            }
                
                // Search for prompt-related properties
                const stKeys = Object.keys(SillyTavern);
                const promptKeys = stKeys.filter(function(k) {
                    return k.toLowerCase().indexOf('prompt') !== -1 ||
                           k.toLowerCase().indexOf('inject') !== -1 ||
                           k.toLowerCase().indexOf('extension') !== -1;
                });
                console.log('[' + MODULE_NAME + '] Prompt-related SillyTavern properties:', promptKeys);
                
                // Show all SillyTavern functions
                const stFunctions = stKeys.filter(function(k) {
                    return typeof SillyTavern[k] === 'function';
                });
                console.log('[' + MODULE_NAME + '] SillyTavern functions:', stFunctions);
            }
            
            if (typeof extension_prompts !== 'undefined') {
                console.log('[' + MODULE_NAME + '] extension_prompts object:', extension_prompts);
            } else {
                console.log('[' + MODULE_NAME + '] extension_prompts does NOT exist');
            }
            
            // Search for any prompt-related functions
            const allGlobals = Object.keys(window);
            const promptFunctions = allGlobals.filter(function(k) {
                const val = window[k];
                return typeof val === 'function' && (
                    k.toLowerCase().indexOf('prompt') !== -1 ||
                    k.toLowerCase().indexOf('inject') !== -1 ||
                    k.toLowerCase().indexOf('extension') !== -1
                );
            });
            console.log('[' + MODULE_NAME + '] Prompt-related functions:', promptFunctions);
            
            // Search for any prompt-related arrays/objects
            const promptObjects = allGlobals.filter(function(k) {
                const val = window[k];
                return (typeof val === 'object' || Array.isArray(val)) && (
                    k.toLowerCase().indexOf('prompt') !== -1 ||
                    k.toLowerCase().indexOf('extension') !== -1
                );
            });
            console.log('[' + MODULE_NAME + '] Prompt-related objects/arrays:', promptObjects);
            
            // Check each one
            promptObjects.forEach(function(k) {
                console.log('[' + MODULE_NAME + '] window.' + k + ':', window[k]);
            });
            
            // Check eventSource events
            if (typeof eventSource !== 'undefined') {
                if (eventSource._events) {
                    console.log('[' + MODULE_NAME + '] Available eventSource events:', Object.keys(eventSource._events));
                }
            } else {
                console.log('[' + MODULE_NAME + '] eventSource does NOT exist globally');
                
                // Check if it's inside SillyTavern
                if (typeof SillyTavern !== 'undefined' && SillyTavern.eventSource) {
                    console.log('[' + MODULE_NAME + '] Found SillyTavern.eventSource!');
                    if (SillyTavern.eventSource._events) {
                        console.log('[' + MODULE_NAME + '] Events:', Object.keys(SillyTavern.eventSource._events));
                    }
                }
            }
            
            console.log('[' + MODULE_NAME + '] ---');
            console.log('[' + MODULE_NAME + '] RECOMMENDATION: Copy this console output and send to developer');
            
            updateUI('status', 'Check console for detailed API information');
            console.log('[' + MODULE_NAME + '] ========================================');
        });
        console.log('[' + MODULE_NAME + '] Test injection button handler attached');
    }
    
    // Test Hybrid Search
    const testHybridBtn = document.getElementById('ragfordummies_test_hybrid');
    if (testHybridBtn) {
        testHybridBtn.addEventListener('click', async function() {
            const resultsDiv = document.getElementById('ragfordummies_hybrid_results');
            const queryInput = document.getElementById('ragfordummies_hybrid_test_query');
            
            let output = '';
            function log(msg) {
                output += msg + '\n';
                if (resultsDiv) {
                    resultsDiv.textContent = output;
                    resultsDiv.style.display = 'block';
                }
                console.log('[' + MODULE_NAME + '] ' + msg);
            }
            
            try {
                log('===== HYBRID SEARCH TEST =====');
                
                const chatId = getCurrentChatId();
                if (!chatId) {
                    log('✗ ERROR: No active chat found');
                    updateUI('status', '✗ No active chat');
                    return;
                }
                log('Chat ID: ' + chatId);
                
                const isGroupChat = isCurrentChatGroupChat();
                const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
                const collectionName = prefix + chatId;
                log('Collection: ' + collectionName);
                
                // Check collection
                const pointCount = await countPoints(collectionName);
                log('Indexed messages: ' + pointCount);
                
                if (pointCount === 0) {
                    log('✗ ERROR: Collection is empty! Index the chat first.');
                    updateUI('status', '✗ Collection empty');
                    return;
                }
                
                // Get query
                let query = queryInput ? queryInput.value.trim() : '';
                if (!query) {
                    // Use last 3 messages as default
                    const context = SillyTavern.getContext();
                    const recentMessages = context.chat.slice(-3);
                    query = recentMessages.map(function(m) { return m.mes; }).join(' ');
                    log('Using last 3 messages as query (no custom query entered)');
                }
                log('');
                log('Query: "' + query.substring(0, 100) + (query.length > 100 ? '...' : '') + '"');
                log('');
                
                // Extract filter terms (all significant words, not just capitalized)
                const filterTerms = extractQueryFilterTerms(query);
                log('===== FILTER TERM EXTRACTION =====');
                if (filterTerms.length > 0) {
                    log('Found ' + filterTerms.length + ' filter terms: ' + filterTerms.join(', '));
                } else {
                    log('No filter terms found in query');
                    log('(Will use pure dense search)');
                }
                log('');
                
                // Generate embedding
                log('Generating query embedding...');
                updateUI('status', 'Generating embedding...');
                const queryEmbedding = await generateEmbedding(query);
                log('Embedding dimensions: ' + queryEmbedding.length);
                log('');
                
                // Run hybrid search manually to show detailed output
                log('===== RUNNING HYBRID SEARCH =====');
                updateUI('status', 'Running hybrid search...');
                
                let filteredResults = [];
                let denseResults = [];
                
                // Run 1: Filtered search
                if (filterTerms.length > 0) {
                    log('RUN 1: Filtered search (term matching)...');
                    
                    const filter = {
                        should: filterTerms.map(function(term) {
                            return {
                                key: 'proper_nouns',
                                match: { value: term }
                            };
                        })
                    };
                    
                    try {
                        const filteredResult = await qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', {
                            vector: queryEmbedding,
                            limit: extensionSettings.retrievalCount * 2,  // Get more to filter
                            score_threshold: extensionSettings.similarityThreshold,
                            with_payload: true,
                            filter: filter
                        });
                        
                        const rawResults = filteredResult.result || [];
                        log('Run 1 raw results from Qdrant: ' + rawResults.length);
                        
                        // Validate that each result actually has matching proper_nouns
                        filteredResults = rawResults.filter(function(r) {
                            const resultNouns = r.payload.proper_nouns || [];
                            const hasMatch = resultNouns.some(function(noun) {
                                return filterTerms.indexOf(noun) !== -1;
                            });
                            return hasMatch;
                        });
                        
                        const falsePositives = rawResults.length - filteredResults.length;
                        if (falsePositives > 0) {
                            log('Warning: Filtered out ' + falsePositives + ' false positives (Qdrant filter issue)');
                        }
                        log('Run 1 validated results: ' + filteredResults.length);
                        
                        if (filteredResults.length > 0) {
                            filteredResults.forEach(function(r, idx) {
                                const matchedTerms = (r.payload.proper_nouns || []).filter(function(n) {
                                    return filterTerms.indexOf(n) !== -1;
                                });
                                log('  [' + idx + '] Score: ' + r.score.toFixed(3) + ' | Character: ' + r.payload.character_name + ' | Matched: ' + matchedTerms.join(', '));
                            });
                        }
                    } catch (filterError) {
                        log('Run 1 FAILED: ' + filterError.message);
                        log('(This may mean proper_nouns index doesnt exist - try Force Re-index)');
                    }
                } else {
                    log('RUN 1: Skipped (no filter terms to match)');
                }
                log('');
                
                // Run 2: Dense search (if needed)
                if (filteredResults.length < 2) {
                    log('RUN 2: Dense search (filtered returned ' + filteredResults.length + ' < 2)...');
                    
                    const denseResult = await qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', {
                        vector: queryEmbedding,
                        limit: extensionSettings.retrievalCount,
                        score_threshold: extensionSettings.similarityThreshold,
                        with_payload: true
                    });
                    
                    denseResults = denseResult.result || [];
                    log('Run 2 returned: ' + denseResults.length + ' results');
                    
                    if (denseResults.length > 0) {
                        denseResults.forEach(function(r, idx) {
                            log('  [' + idx + '] Score: ' + r.score.toFixed(3) + ' | Character: ' + r.payload.character_name);
                        });
                    }
                } else {
                    log('RUN 2: Skipped (filtered search returned enough results)');
                }
                log('');
                
                // Combine results
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
                const finalResults = combined.slice(0, extensionSettings.retrievalCount);
                
                log('===== FINAL RESULTS =====');
                log('Total: ' + finalResults.length + ' results');
                log('From filtered: ' + finalResults.filter(function(r) { return r._source === 'filtered'; }).length);
                log('From dense: ' + finalResults.filter(function(r) { return r._source === 'dense'; }).length);
                log('');
                
                if (finalResults.length > 0) {
                    finalResults.forEach(function(r, idx) {
                        log('--- Result ' + (idx + 1) + ' [' + r._source.toUpperCase() + '] ---');
                        log('Score: ' + r.score.toFixed(3));
                        log('Character: ' + r.payload.character_name);
                        log('Proper nouns in message: ' + (r.payload.proper_nouns && r.payload.proper_nouns.length > 0 ? r.payload.proper_nouns.join(', ') : '(none)'));
                        log('Message preview: ' + (r.payload.full_message || '').substring(0, 100) + '...');
                        log('');
                    });
                    
                    updateUI('status', '✓ Hybrid search complete! ' + finalResults.length + ' results');
                } else {
                    log('No results found. Try:');
                    log('- Lowering similarity threshold (currently ' + extensionSettings.similarityThreshold + ')');
                    log('- Using different search terms');
                    log('- Force re-indexing the chat');
                    updateUI('status', '✗ No results found');
                }
                
                log('===== TEST COMPLETE =====');
                
            } catch (error) {
                log('');
                log('✗ ERROR: ' + error.message);
                console.error('[' + MODULE_NAME + '] Hybrid test failed:', error);
                updateUI('status', '✗ Test failed: ' + error.message);
            }
        });
        console.log('[' + MODULE_NAME + '] Test hybrid search button handler attached');
    }
    
    const indexCurrentBtn = document.getElementById('ragfordummies_index_current');
    if (indexCurrentBtn) {
        indexCurrentBtn.addEventListener('click', async function() {
            try {
                const chatId = getCurrentChatId();
                if (!chatId) {
                    updateUI('status', '✗ No active chat found');
                    return;
                }
                
                const isGroupChat = isCurrentChatGroupChat();
                const context = SillyTavern.getContext();
                const jsonl = convertChatToJSONL(context);
                
                await indexChat(jsonl, chatId, isGroupChat);
                currentChatIndexed = true;
            } catch (error) {
                updateUI('status', '✗ Indexing failed: ' + error.message);
                console.error('[' + MODULE_NAME + '] Manual indexing failed:', error);
            }
        });
    }
    
    const forceReindexBtn = document.getElementById('ragfordummies_force_reindex');
    if (forceReindexBtn) {
        forceReindexBtn.addEventListener('click', async function() {
            if (!confirm('This will delete the existing index and rebuild it from scratch.\n\nThis is useful after updating the extension to enable hybrid search on older collections.\n\nContinue?')) {
                return;
            }
            
            try {
                await forceReindexCurrentChat();
                updateUI('status', '✓ Force re-index complete!');
            } catch (error) {
                updateUI('status', '✗ Force re-index failed: ' + error.message);
                console.error('[' + MODULE_NAME + '] Force re-index failed:', error);
            }
        });
    }
    
    const stopIndexingBtn = document.getElementById('ragfordummies_stop_indexing');
    if (stopIndexingBtn) {
        stopIndexingBtn.addEventListener('click', function() {
            console.log('[' + MODULE_NAME + '] User requested to stop indexing');
            shouldStopIndexing = true;
            updateUI('status', 'Stopping... (will stop at next message)');
        });
    }
    
    const uploadBtn = document.getElementById('ragfordummies_upload_btn');
    const fileInput = document.getElementById('ragfordummies_file_input');
    
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', function() { fileInput.click(); });
        
        fileInput.addEventListener('change', async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                const content = await file.text();
                const parsed = parseJSONL(content);
                const chatMetadata = parsed.chatMetadata;
                
                // Check if we should merge into current chat
                const mergeCheckbox = document.getElementById('ragfordummies_merge_uploads');
                const shouldMerge = mergeCheckbox && mergeCheckbox.checked;
                
                let targetChatId;
                let targetIsGroupChat;
                
                if (shouldMerge) {
                    // Use CURRENT chat's collection
                    targetChatId = getCurrentChatId();
                    targetIsGroupChat = isCurrentChatGroupChat();
                    
                    if (!targetChatId) {
                        throw new Error('No active chat to merge into. Open a chat first or uncheck "Merge uploads".');
                    }
                    
                    console.log('[' + MODULE_NAME + '] Merging uploaded chat into current collection: ' + targetChatId);
                    updateUI('status', 'Merging into current chat collection...');
                } else {
                    // Use the uploaded file's chat ID (creates separate collection)
                    targetChatId = (chatMetadata && chatMetadata.chat_id_hash) ? chatMetadata.chat_id_hash : Date.now();
                    targetIsGroupChat = file.name.indexOf('group') !== -1 || (chatMetadata && chatMetadata.groupId !== undefined);
                    
                    console.log('[' + MODULE_NAME + '] Creating separate collection for uploaded chat: ' + targetChatId);
                }
                
                await indexChat(content, targetChatId, targetIsGroupChat);
                
                if (shouldMerge) {
                    updateUI('status', '✓ Merged ' + parsed.messages.length + ' messages into current chat!');
                }
            } catch (error) {
                console.error('[' + MODULE_NAME + '] Upload failed:', error);
                updateUI('status', 'Upload failed: ' + error.message);
            }
            
            fileInput.value = '';
        });
    }
}

function saveSettings() {
    localStorage.setItem(MODULE_NAME + '_settings', JSON.stringify(extensionSettings));
    console.log('[' + MODULE_NAME + '] Settings saved');
}

function loadSettings() {
    const saved = localStorage.getItem(MODULE_NAME + '_settings');
    if (saved) {
        try {
            extensionSettings = Object.assign({}, defaultSettings, JSON.parse(saved));
            console.log('[' + MODULE_NAME + '] Settings loaded');
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
    
    // CRITICAL: Stop any existing polling from previous loads
    if (pollingInterval) {
        console.log('[' + MODULE_NAME + '] Clearing existing polling interval from previous load');
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    usePolling = false; // Start with polling disabled
    
    const settingsHtml = createSettingsUI();
    $('#extensions_settings').append(settingsHtml);
    
    setTimeout(function() {
        const container = $('#ragfordummies_container');
        const toggle = $('#ragfordummies_container .inline-drawer-toggle');
        const content = $('#ragfordummies_container .inline-drawer-content');
        
        console.log('[' + MODULE_NAME + '] Container found:', container.length);
        console.log('[' + MODULE_NAME + '] Toggle found:', toggle.length);
        console.log('[' + MODULE_NAME + '] Content found:', content.length);
        
        if (toggle.length === 0) {
            console.error('[' + MODULE_NAME + '] Toggle not found!');
            return;
        }
        
        content.hide();
        
        toggle.off('click').on('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            const icon = $(this).find('.inline-drawer-icon');
            const targetContent = $('#ragfordummies_container .inline-drawer-content');
            
            icon.toggleClass('down up');
            targetContent.slideToggle(200);
        });
        
        console.log('[' + MODULE_NAME + '] Dropdown handler attached');
    }, 200);
    
    attachEventListeners();
    
    console.log('[' + MODULE_NAME + '] Registering event handlers...');
    
    // Get eventSource from context if not global
    let eventSourceToUse = null;
    
    if (typeof eventSource !== 'undefined') {
        console.log('[' + MODULE_NAME + '] Using global eventSource');
        eventSourceToUse = eventSource;
    } else if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const context = SillyTavern.getContext();
        if (context.eventSource) {
            console.log('[' + MODULE_NAME + '] Using context.eventSource');
            eventSourceToUse = context.eventSource;
        }
    }
    
    if (eventSourceToUse) {
        console.log('[' + MODULE_NAME + '] Registering event listeners on eventSource');
        
        eventSourceToUse.on('chat_loaded', onChatLoaded);
        eventSourceToUse.on('message_sent', onMessageSent);
        eventSourceToUse.on('message_received', onMessageReceived);
        
        // CRITICAL: Use GENERATION_AFTER_COMMANDS for injection
        // This fires BEFORE prompt assembly, so setExtensionPrompt will work!
        // (chat_completion_prompt_ready fires AFTER assembly - too late)
        eventSourceToUse.on('GENERATION_AFTER_COMMANDS', async function(data) {
            console.log('[' + MODULE_NAME + '] Event: GENERATION_AFTER_COMMANDS');
            await injectContextWithSetExtensionPrompt();
        });
        
        // Fallback: Also try generate_before_combine_prompts 
        eventSourceToUse.on('generate_before_combine_prompts', async function(data) {
            console.log('[' + MODULE_NAME + '] Event: generate_before_combine_prompts');
            await injectContextWithSetExtensionPrompt();
        });
        
        // Keep chat_completion_prompt_ready for logging only
        eventSourceToUse.on('chat_completion_prompt_ready', async function(data) {
            console.log('[' + MODULE_NAME + '] Event: chat_completion_prompt_ready (chat length: ' + (data && data.chat ? data.chat.length : 'N/A') + ')');
            // Don't inject here - too late! Just log for debugging
        });
        
        console.log('[' + MODULE_NAME + '] Registered listeners for: GENERATION_AFTER_COMMANDS, generate_before_combine_prompts');
        
        eventsRegistered = true; // Mark that events are working
        usePolling = false; // Disable polling since events work
        
        console.log('[' + MODULE_NAME + '] Event listeners registered successfully');
        
        // List all available events for debugging
        if (eventSourceToUse._events) {
            console.log('[' + MODULE_NAME + '] All registered events on eventSource:', Object.keys(eventSourceToUse._events));
        }
    } else {
        console.log('[' + MODULE_NAME + '] eventSource not available');
        eventsRegistered = false;
        usePolling = true; // Need polling as fallback
    }
    
    if (typeof window.generateQuietPrompt !== 'undefined') {
        console.log('[' + MODULE_NAME + '] Hooking generateQuietPrompt');
        const originalGenerate = window.generateQuietPrompt;
        window.generateQuietPrompt = function() {
            onMessageSent({ fromHook: true });
            return originalGenerate.apply(this, arguments);
        };
    }
    
    console.log('[' + MODULE_NAME + '] Available globals:', {
        eventSource: typeof eventSource !== 'undefined',
        SillyTavern: typeof SillyTavern !== 'undefined',
        getContext: typeof getContext !== 'undefined',
        setExtensionPrompt: typeof setExtensionPrompt !== 'undefined',
        extension_prompts: typeof extension_prompts !== 'undefined',
        generateQuietPrompt: typeof window.generateQuietPrompt !== 'undefined'
    });
    
    // Check for context.eventSource
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const context = SillyTavern.getContext();
        console.log('[' + MODULE_NAME + '] context.eventSource exists:', !!context.eventSource);
        console.log('[' + MODULE_NAME + '] context.setExtensionPrompt exists:', !!context.setExtensionPrompt);
    }
    
    // Detailed API discovery
    console.log('[' + MODULE_NAME + '] ===== SillyTavern API Discovery =====');
    
    if (typeof extension_prompts !== 'undefined') {
        console.log('[' + MODULE_NAME + '] extension_prompts exists:', extension_prompts);
    }
    
    if (typeof SillyTavern !== 'undefined') {
        console.log('[' + MODULE_NAME + '] SillyTavern object keys:', Object.keys(SillyTavern));
        if (SillyTavern.extensions) {
            console.log('[' + MODULE_NAME + '] SillyTavern.extensions:', SillyTavern.extensions);
        }
        if (SillyTavern.setExtensionPrompt) {
            console.log('[' + MODULE_NAME + '] SillyTavern.setExtensionPrompt EXISTS!');
        }
        if (SillyTavern.eventSource) {
            console.log('[' + MODULE_NAME + '] SillyTavern.eventSource EXISTS!');
        }
    }
    
    if (typeof eventSource !== 'undefined' && eventSource._events) {
        const events = Object.keys(eventSource._events);
        console.log('[' + MODULE_NAME + '] EventSource has ' + events.length + ' events registered');
        console.log('[' + MODULE_NAME + '] Event names:', events);
    } else {
        console.log('[' + MODULE_NAME + '] eventSource not available as global');
        if (typeof SillyTavern !== 'undefined' && SillyTavern.eventSource && SillyTavern.eventSource._events) {
            const events = Object.keys(SillyTavern.eventSource._events);
            console.log('[' + MODULE_NAME + '] But SillyTavern.eventSource exists with ' + events.length + ' events');
            console.log('[' + MODULE_NAME + '] Event names:', events);
        }
    }
    
    console.log('[' + MODULE_NAME + '] =========================================');
    
    // Only start polling if events weren't registered
    if (!eventsRegistered && usePolling) {
        console.log('[' + MODULE_NAME + '] Events not available, using polling fallback');
        
        if (extensionSettings.autoIndex) {
            await startPolling();
        } else {
            console.log('[' + MODULE_NAME + '] Auto-index disabled, polling not started');
        }
    } else if (eventsRegistered) {
        console.log('[' + MODULE_NAME + '] Events registered, polling NOT started (not needed)');
    }
    
    // IMPORTANT: Check if current chat is already indexed on load
    // This handles the case where chat_loaded event doesn't fire (chat already open)
    setTimeout(async function() {
        console.log('[' + MODULE_NAME + '] Running initial index status check...');
        const chatId = getCurrentChatId();
        if (chatId && !currentChatIndexed) {
            const isGroupChat = isCurrentChatGroupChat();
            const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
            const collectionName = prefix + chatId;
            
            try {
                const pointCount = await countPoints(collectionName);
                if (pointCount > 0) {
                    currentChatIndexed = true;
                    console.log('[' + MODULE_NAME + '] Initial check: Collection exists with ' + pointCount + ' points - marking as indexed');
                    updateUI('status', '✓ Indexed (' + pointCount + ' messages)');
                } else {
                    console.log('[' + MODULE_NAME + '] Initial check: Collection empty or not found');
                    updateUI('status', 'Ready to index');
                }
            } catch (checkError) {
                console.log('[' + MODULE_NAME + '] Initial check: Could not verify collection -', checkError.message);
            }
        } else if (currentChatIndexed) {
            console.log('[' + MODULE_NAME + '] Initial check: Already marked as indexed');
        } else {
            console.log('[' + MODULE_NAME + '] Initial check: No chat ID available yet');
        }
    }, 500);
    
    console.log('[' + MODULE_NAME + '] Extension loaded successfully');
    console.log('[' + MODULE_NAME + '] eventsRegistered=' + eventsRegistered + ', usePolling=' + usePolling);
    updateUI('status', 'Extension loaded - Test connections');
}

jQuery(async function() {
    setTimeout(async function() {
        await init();
    }, 100);
});
