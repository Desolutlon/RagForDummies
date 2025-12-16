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
        'screams', 'screaming', 'screamed', 'shouts', 'shouting', 'shouted', 'yells', 'yelling', 'yelled',
        'cries', 'crying', 'cried', 'sobs', 'sobbing', 'sobbed', 'weeps', 'weeping', 'wept',
        'continues', 'continuing', 'continued', 'repeats', 'repeating', 'repeated', 'responds', 'responding', 'responded',
        'answers', 'answering', 'answered', 'nods', 'nodding', 'nodded', 'agrees', 'agreeing', 'agreed',
        'disagrees', 'disagreeing', 'disagreed', 'hesitates', 'hesitating', 'hesitated', 'frowns', 'frowning', 'frowned',
        'winces', 'wincing', 'winced', 'grimaces', 'grimacing', 'grimaced', 'squints', 'squinting', 'squinted',
        'furrows', 'furrowing', 'furrowed', 'wrinkles', 'wrinkling', 'wrinkled', 'squeezes', 'squeezing', 'squeezed',
        'tightens', 'tightening', 'tightened', 'loosens', 'loosening', 'loosened', 'relaxes', 'relaxing', 'relaxed',
        'tenses', 'tensing', 'tensed', 'shivers', 'shivering', 'shivered', 'trembles', 'trembling', 'trembled',
        'shudders', 'shuddering', 'shuddered', 'gasps', 'gasping', 'gasped', 'pants', 'panting', 'panted',
        'breathes', 'breathing', 'breathed', 'exhales', 'exhaling', 'exhaled', 'inhales', 'inhaling', 'inhaled',
        'swallows', 'swallowing', 'swallowed', 'licks', 'licking', 'licked', 'bites', 'biting', 'bit',
        'kisses', 'kissing', 'kissed', 'hugs', 'hugging', 'hugged', 'embraces', 'embracing', 'embraced',
        'touches', 'touching', 'touched', 'strokes', 'stroking', 'stroked', 'caresses', 'caressing', 'caressed',
        'grabs', 'grabbing', 'grabbed', 'grips', 'gripping', 'gripped', 'clutches', 'clutching', 'clutched',
        'releases', 'releasing', 'released', 'drops', 'dropping', 'dropped', 'catches', 'catching', 'caught',
        'throws', 'throwing', 'threw', 'tosses', 'tossing', 'tossed', 'slides', 'sliding', 'slid',
        'rolls', 'rolling', 'rolled', 'spins', 'spinning', 'spun', 'twists', 'twisting', 'twisted',
        'bends', 'bending', 'bent', 'stretches', 'stretching', 'stretched', 'kneels', 'kneeling', 'knelt',
        'crouches', 'crouching', 'crouched', 'squats', 'squatting', 'squatted', 'rises', 'rising', 'rose',
        'climbs', 'climbing', 'climbed', 'jumps', 'jumping', 'jumped', 'leaps', 'leaping', 'leaped',
        'hops', 'hopping', 'hopped', 'skips', 'skipping', 'skipped', 'dances', 'dancing', 'danced',
        'sways', 'swaying', 'swayed', 'wobbles', 'wobbling', 'wobbled', 'stumbles', 'stumbling', 'stumbled',
        'trips', 'tripping', 'tripped', 'slips', 'slipping', 'slipped', 'falls', 'falling', 'fell',
        'crashes', 'crashing', 'crashed', 'collapses', 'collapsing', 'collapsed', 'faints', 'fainting', 'fainted',
        'wakes', 'waking', 'woke', 'sleeps', 'sleeping', 'slept', 'dreams', 'dreaming', 'dreamed',
        'rubs', 'rubbing', 'rubbed', 'scratches', 'scratching', 'scratched', 'pats', 'patting', 'patted',
        'taps', 'tapping', 'tapped', 'knocks', 'knocking', 'knocked', 'pounds', 'pounding', 'pounded',
        'bangs', 'banging', 'banged', 'slams', 'slamming', 'slammed', 'shuts', 'shutting', 'shut',
        'closes', 'closing', 'closed', 'locks', 'locking', 'locked', 'unlocks', 'unlocking', 'unlocked',
        'opens', 'opening', 'opened', 'peeks', 'peeking', 'peeked', 'peers', 'peering', 'peered',
        'examines', 'examining', 'examined', 'inspects', 'inspecting', 'inspected', 'studies', 'studying', 'studied',
        'observes', 'observing', 'observed', 'watches', 'watching', 'watched', 'monitors', 'monitoring', 'monitored',
        'tracks', 'tracking', 'tracked', 'follows', 'following', 'followed', 'pursues', 'pursuing', 'pursued',
        'chases', 'chasing', 'chased', 'hunts', 'hunting', 'hunted', 'searches', 'searching', 'searched',
        'seeks', 'seeking', 'sought', 'explores', 'exploring', 'explored', 'investigates', 'investigating', 'investigated',
        'checks', 'checking', 'checked', 'tests', 'testing', 'tested', 'tries', 'trying', 'tried',
        'attempts', 'attempting', 'attempted', 'works', 'working', 'worked', 'labors', 'laboring', 'labored',
        'struggles', 'struggling', 'struggled', 'strives', 'striving', 'strove', 'fights', 'fighting', 'fought',
        'battles', 'battling', 'battled', 'attacks', 'attacking', 'attacked', 'strikes', 'striking', 'struck',
        'hits', 'hitting', 'hit', 'punches', 'punching', 'punched', 'slaps', 'slapping', 'slapped',
        'kicks', 'kicking', 'kicked', 'shoves', 'shoving', 'shoved', 'blocks', 'blocking', 'blocked',
        'dodges', 'dodging', 'dodged', 'ducks', 'ducking', 'ducked', 'evades', 'evading', 'evaded',
        'escapes', 'escaping', 'escaped', 'flees', 'fleeing', 'fled', 'retreats', 'retreating', 'retreated',
        'runs', 'running', 'ran', 'sprints', 'sprinting', 'sprinted', 'dashes', 'dashing', 'dashed',
        'rushes', 'rushing', 'rushed', 'hurries', 'hurrying', 'hurried', 'races', 'racing', 'raced'
    ]);
    
    // Split text into sentences (roughly - by period, exclamation, question mark)
    const sentences = text.split(/[.!?]+/);
    
    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        if (!sentence) continue;
        
        // Split sentence into words
        const words = sentence.split(/\s+/);
        
        for (let j = 0; j < words.length; j++) {
            const word = words[j];
            
            // Clean the word: remove punctuation, quotes, asterisks, etc.
            const cleaned = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
            
            if (!cleaned || cleaned.length < 2) continue;
            
            // Check if word starts with capital letter
            if (cleaned[0] !== cleaned[0].toUpperCase()) continue;
            
            // Skip if it's the first word of the sentence (always capitalized)
            if (j === 0) continue;
            
            const lowerCleaned = cleaned.toLowerCase();
            
            // Skip if it's in common words list
            if (commonWords.has(lowerCleaned)) continue;
            
            // Add to proper nouns set (lowercase for case-insensitive matching)
            properNouns.add(lowerCleaned);
        }
    }
    
    return Array.from(properNouns);
}

// ===========================
// Qdrant API Functions
// ===========================

async function qdrantRequest(endpoint, method, body) {
    const baseUrl = extensionSettings.qdrantMode === 'cloud' ? 
        extensionSettings.qdrantCloudUrl : 
        extensionSettings.qdrantLocalUrl;
    
    const url = baseUrl + endpoint;
    
    const headers = {
        'Content-Type': 'application/json'
    };
    
    // Add API key for cloud mode
    if (extensionSettings.qdrantMode === 'cloud' && extensionSettings.qdrantApiKey) {
        headers['api-key'] = extensionSettings.qdrantApiKey;
    }
    
    const options = {
        method: method,
        headers: headers
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error('Qdrant API error (' + response.status + '): ' + errorText);
    }
    
    return await response.json();
}

async function createCollection(collectionName, vectorSize) {
    try {
        await qdrantRequest('/collections/' + collectionName, 'PUT', {
            vectors: {
                size: vectorSize,
                distance: 'Cosine'
            }
        });
        console.log('[' + MODULE_NAME + '] ✓ Collection created: ' + collectionName);
        return true;
    } catch (error) {
        if (error.message.includes('already exists')) {
            console.log('[' + MODULE_NAME + '] Collection already exists: ' + collectionName);
            return true;
        }
        throw error;
    }
}

async function upsertPoints(collectionName, points) {
    await qdrantRequest('/collections/' + collectionName + '/points', 'PUT', {
        points: points
    });
}

async function searchPoints(collectionName, vector, limit, scoreThreshold, filter) {
    const body = {
        vector: vector,
        limit: limit,
        score_threshold: scoreThreshold,
        with_payload: true
    };
    
    if (filter) {
        body.filter = filter;
    }
    
    const result = await qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', body);
    return result.result || [];
}

async function countPoints(collectionName) {
    try {
        const result = await qdrantRequest('/collections/' + collectionName, 'GET');
        return result.result.points_count || 0;
    } catch (error) {
        if (error.message.includes('404') || error.message.includes('Not found')) {
            return 0;
        }
        throw error;
    }
}

async function deleteCollection(collectionName) {
    try {
        await qdrantRequest('/collections/' + collectionName, 'DELETE');
        console.log('[' + MODULE_NAME + '] ✓ Collection deleted: ' + collectionName);
        return true;
    } catch (error) {
        if (error.message.includes('404') || error.message.includes('Not found')) {
            console.log('[' + MODULE_NAME + '] Collection does not exist: ' + collectionName);
            return false;
        }
        throw error;
    }
}

// ===========================
// Embedding Functions
// ===========================

async function generateEmbedding(text) {
    if (!text || text.trim().length === 0) {
        throw new Error('Cannot generate embedding for empty text');
    }
    
    switch (extensionSettings.embeddingProvider) {
        case 'kobold':
            return await generateKoboldEmbedding(text);
        case 'ollama':
            return await generateOllamaEmbedding(text);
        case 'openai':
            return await generateOpenAIEmbedding(text);
        default:
            throw new Error('Unknown embedding provider: ' + extensionSettings.embeddingProvider);
    }
}

async function generateKoboldEmbedding(text) {
    const response = await fetch(extensionSettings.koboldUrl + '/api/extra/generate/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text })
    });
    
    if (!response.ok) {
        throw new Error('KoboldCpp embedding failed: ' + response.statusText);
    }
    
    const data = await response.json();
    
    if (!data.data || !data.data[0] || !data.data[0].embedding) {
        throw new Error('Invalid embedding response from KoboldCpp');
    }
    
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
        throw new Error('Ollama embedding failed: ' + response.statusText);
    }
    
    const data = await response.json();
    
    if (!data.embedding) {
        throw new Error('Invalid embedding response from Ollama');
    }
    
    return data.embedding;
}

async function generateOpenAIEmbedding(text) {
    if (!extensionSettings.openaiApiKey) {
        throw new Error('OpenAI API key not configured');
    }
    
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
        throw new Error('OpenAI embedding failed: ' + response.statusText);
    }
    
    const data = await response.json();
    
    if (!data.data || !data.data[0] || !data.data[0].embedding) {
        throw new Error('Invalid embedding response from OpenAI');
    }
    
    return data.data[0].embedding;
}

// ===========================
// Chat Helpers
// ===========================

function getCurrentChatId() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const context = SillyTavern.getContext();
        if (context && context.chatId) {
            return context.chatId;
        }
        
        if (context && context.groupId) {
            return context.groupId;
        }
    }
    
    if (typeof getContext === 'function') {
        const context = getContext();
        if (context && context.chatId) {
            return context.chatId;
        }
        
        if (context && context.groupId) {
            return context.groupId;
        }
    }
    
    return null;
}

function isCurrentChatGroupChat() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const context = SillyTavern.getContext();
        if (context && context.groupId) {
            return true;
        }
    }
    
    if (typeof getContext === 'function') {
        const context = getContext();
        if (context && context.groupId) {
            return true;
        }
    }
    
    return false;
}

function getCurrentMessages() {
    let context;
    
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        context = SillyTavern.getContext();
    } else if (typeof getContext === 'function') {
        context = getContext();
    }
    
    if (!context || !context.chat) {
        return [];
    }
    
    return context.chat;
}

// ===========================
// Indexing Functions
// ===========================

async function indexChat(chatContent, chatIdParam, isGroupChatParam) {
    if (isIndexing) {
        console.log('[' + MODULE_NAME + '] Already indexing, skipping');
        return;
    }
    
    isIndexing = true;
    shouldStopIndexing = false;
    updateUI('status', 'Indexing...');
    
    try {
        let messages = [];
        let chatId = chatIdParam;
        let isGroupChat = isGroupChatParam;
        
        // Parse the chat content
        if (typeof chatContent === 'string') {
            try {
                const parsed = JSON.parse(chatContent);
                messages = parsed.messages || parsed;
                
                // If chatId/isGroupChat not provided, try to extract from metadata
                if (!chatId) {
                    chatId = (parsed.chat_id_hash) ? parsed.chat_id_hash : Date.now();
                }
                if (isGroupChat === undefined) {
                    isGroupChat = parsed.groupId !== undefined;
                }
            } catch (parseError) {
                throw new Error('Failed to parse chat JSON: ' + parseError.message);
            }
        } else if (Array.isArray(chatContent)) {
            messages = chatContent;
        } else {
            throw new Error('Invalid chat content type');
        }
        
        // Use current chat if not specified
        if (!chatId) {
            chatId = getCurrentChatId();
            isGroupChat = isCurrentChatGroupChat();
        }
        
        if (!chatId) {
            throw new Error('No chat ID available');
        }
        
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new Error('No messages found in chat');
        }
        
        console.log('[' + MODULE_NAME + '] Indexing ' + messages.length + ' messages for chat: ' + chatId + ' (group: ' + isGroupChat + ')');
        
        // Generate first embedding to get vector size
        updateUI('status', 'Generating sample embedding...');
        const sampleText = messages[0].mes || messages[0].content || 'sample';
        const sampleEmbedding = await generateEmbedding(sampleText);
        const vectorSize = sampleEmbedding.length;
        
        console.log('[' + MODULE_NAME + '] Vector size: ' + vectorSize);
        
        // Create collection
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatId;
        
        updateUI('status', 'Creating collection...');
        await createCollection(collectionName, vectorSize);
        
        // Index messages
        let indexed = 0;
        const batchSize = 10;
        
        for (let i = 0; i < messages.length; i += batchSize) {
            if (shouldStopIndexing) {
                console.log('[' + MODULE_NAME + '] Indexing stopped by user');
                updateUI('status', 'Indexing stopped (' + indexed + ' of ' + messages.length + ')');
                return;
            }
            
            const batch = messages.slice(i, i + batchSize);
            const points = [];
            
            for (const msg of batch) {
                const messageText = msg.mes || msg.content || '';
                
                if (!messageText || messageText.trim().length === 0) {
                    continue;
                }
                
                // Extract proper nouns for hybrid search
                const properNouns = extractProperNouns(messageText);
                
                try {
                    const embedding = await generateEmbedding(messageText);
                    
                    // Generate unique ID
                    const pointId = generateUUID();
                    
                    points.push({
                        id: pointId,
                        vector: embedding,
                        payload: {
                            message: messageText,
                            sender: msg.name || msg.user || 'Unknown',
                            is_user: msg.is_user || false,
                            timestamp: msg.send_date || Date.now(),
                            proper_nouns: properNouns,
                            message_index: i + batch.indexOf(msg)
                        }
                    });
                    
                    indexedMessageIds.add(pointId);
                } catch (embeddingError) {
                    console.error('[' + MODULE_NAME + '] Failed to generate embedding for message ' + (i + batch.indexOf(msg)) + ':', embeddingError);
                }
            }
            
            if (points.length > 0) {
                await upsertPoints(collectionName, points);
                indexed += points.length;
                updateUI('status', 'Indexing... ' + indexed + ' / ' + messages.length);
            }
        }
        
        currentChatIndexed = true;
        lastChatId = chatId;
        
        updateUI('status', '✓ Indexed ' + indexed + ' messages!');
        console.log('[' + MODULE_NAME + '] ✓ Indexing complete: ' + indexed + ' messages');
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Indexing failed:', error);
        updateUI('status', '✗ Indexing failed: ' + error.message);
        throw error;
    } finally {
        isIndexing = false;
    }
}

async function indexCurrentChat() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        updateUI('status', '✗ No active chat');
        return;
    }
    
    const messages = getCurrentMessages();
    if (messages.length === 0) {
        updateUI('status', '✗ No messages to index');
        return;
    }
    
    const isGroupChat = isCurrentChatGroupChat();
    await indexChat(messages, chatId, isGroupChat);
}

// ===========================
// Context Retrieval with Hybrid Search
// ===========================

async function retrieveContext(query, chatId, isGroupChat) {
    if (!query || !chatId) {
        console.log('[' + MODULE_NAME + '] No query or chatId for retrieval');
        return null;
    }
    
    const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
    const collectionName = prefix + chatId;
    
    console.log('[' + MODULE_NAME + '] Retrieving context for collection: ' + collectionName);
    
    try {
        // Extract proper nouns from query for filtering
        const properNouns = extractProperNouns(query);
        console.log('[' + MODULE_NAME + '] Extracted proper nouns for hybrid search:', properNouns);
        
        // Generate query embedding
        const queryEmbedding = await generateEmbedding(query);
        
        let results = [];
        
        // HYBRID SEARCH: Combine filtered and dense search
        if (properNouns.length > 0) {
            // Phase 1: Filtered search (proper noun matching)
            console.log('[' + MODULE_NAME + '] Running filtered search with proper nouns...');
            
            const filter = {
                should: properNouns.map(function(noun) {
                    return {
                        key: 'proper_nouns',
                        match: { value: noun }
                    };
                })
            };
            
            const filteredResults = await searchPoints(
                collectionName,
                queryEmbedding,
                extensionSettings.retrievalCount * 2, // Get more candidates
                extensionSettings.similarityThreshold * 0.8, // Lower threshold for filtered
                filter
            );
            
            console.log('[' + MODULE_NAME + '] Filtered search returned ' + filteredResults.length + ' results');
            
            // Phase 2: Dense search (no filter)
            console.log('[' + MODULE_NAME + '] Running dense search...');
            const denseResults = await searchPoints(
                collectionName,
                queryEmbedding,
                extensionSettings.retrievalCount,
                extensionSettings.similarityThreshold,
                null
            );
            
            console.log('[' + MODULE_NAME + '] Dense search returned ' + denseResults.length + ' results');
            
            // Merge results: prefer filtered, then add dense
            const seenIds = new Set();
            
            // Add filtered results first
            for (const result of filteredResults) {
                if (!seenIds.has(result.id)) {
                    results.push(result);
                    seenIds.add(result.id);
                }
            }
            
            // Add dense results that weren't in filtered
            for (const result of denseResults) {
                if (!seenIds.has(result.id)) {
                    results.push(result);
                    seenIds.add(result.id);
                }
            }
            
            // Sort by score and take top N
            results.sort(function(a, b) { return b.score - a.score; });
            results = results.slice(0, extensionSettings.retrievalCount);
            
            console.log('[' + MODULE_NAME + '] Hybrid search combined to ' + results.length + ' final results');
        } else {
            // No proper nouns: pure dense search
            console.log('[' + MODULE_NAME + '] No proper nouns found, using pure dense search');
            results = await searchPoints(
                collectionName,
                queryEmbedding,
                extensionSettings.retrievalCount,
                extensionSettings.similarityThreshold,
                null
            );
        }
        
        if (results.length === 0) {
            console.log('[' + MODULE_NAME + '] No relevant context found (all below threshold)');
            return null;
        }
        
        // Sort by message_index to maintain chronological order
        results.sort(function(a, b) {
            const indexA = (a.payload && a.payload.message_index !== undefined) ? a.payload.message_index : 0;
            const indexB = (b.payload && b.payload.message_index !== undefined) ? b.payload.message_index : 0;
            return indexA - indexB;
        });
        
        // Format context
        let contextText = '=== Relevant Context from Chat History ===\n\n';
        
        for (const result of results) {
            const sender = result.payload.sender || 'Unknown';
            const message = result.payload.message || '';
            const similarity = (result.score * 100).toFixed(1);
            
            contextText += sender + ' (relevance: ' + similarity + '%): ' + message + '\n\n';
        }
        
        console.log('[' + MODULE_NAME + '] ✓ Retrieved ' + results.length + ' relevant messages');
        
        return contextText;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Context retrieval failed:', error);
        return null;
    }
}

// ===========================
// Context Injection
// ===========================

async function injectContextBeforeGeneration(data) {
    // FIRST THING - log that we were called
    console.log('[' + MODULE_NAME + '] >>> injectContextBeforeGeneration ENTRY POINT <<<');
    console.log('[' + MODULE_NAME + '] Data received:', data ? 'yes' : 'no');
    
    // Skip if dryRun is true (but log it clearly)
    if (data && data.dryRun === true) {
        console.log('[' + MODULE_NAME + '] Skipping - dryRun mode');
        return;
    }
    
    // IMPROVED TRACKER DETECTION
    // Check for specific indicators that this is NOT a real generation:
    // 1. quietPrompt flag (used by many extensions for background calls)
    // 2. Very small chat array with specific metadata suggesting it's an extension call
    // 3. Explicit flags that indicate background processing
    
    if (data) {
        // Check for quiet/background generation flags
        if (data.quiet === true || data.quietPrompt === true || data.isQuiet === true) {
            console.log('[' + MODULE_NAME + '] Skipping - quiet/background generation detected');
            return;
        }
        
        // Check for extension-specific metadata
        if (data.extensionPromptOnly === true || data.skipRag === true) {
            console.log('[' + MODULE_NAME + '] Skipping - extension-specific flag detected');
            return;
        }
        
        // Check chat array characteristics
        if (data.chat && Array.isArray(data.chat)) {
            console.log('[' + MODULE_NAME + '] data.chat length:', data.chat.length);
            
            // Only skip if EMPTY or clearly an extension call (not based on user messages)
            if (data.chat.length === 0) {
                console.log('[' + MODULE_NAME + '] Skipping - empty chat array');
                return;
            }
            
            // If chat is very small (1-2 messages) AND has extension-like metadata, skip
            if (data.chat.length <= 2) {
                // Check if this looks like an extension background call
                const hasExtensionMarkers = data.chat.some(function(m) {
                    // Look for extension-specific message markers
                    return m && (
                        m.extra && (m.extra.fromExtension || m.extra.isTracking || m.extra.isQuiet) ||
                        m.isExtension === true ||
                        m.isBackground === true ||
                        m.skipRag === true
                    );
                });
                
                if (hasExtensionMarkers) {
                    console.log('[' + MODULE_NAME + '] Skipping - detected extension markers in small chat');
                    return;
                }
            }
        }
    }
    
    console.log('[' + MODULE_NAME + '] 🚀 injectContextBeforeGeneration proceeding with injection');
    
    // Debounce: prevent multiple injections in quick succession
    const now = Date.now();
    if (now - lastInjectionTime < INJECTION_DEBOUNCE_MS) {
        console.log('[' + MODULE_NAME + '] Skipping injection - debounced (' + (now - lastInjectionTime) + 'ms since last)');
        return;
    }
    
    console.log('[' + MODULE_NAME + '] Settings check - enabled:', extensionSettings.enabled, ', injectContext:', extensionSettings.injectContext);
    
    if (!extensionSettings.enabled || !extensionSettings.injectContext) {
        console.log('[' + MODULE_NAME + '] Context injection disabled in settings');
        return;
    }
    
    const chatId = getCurrentChatId();
    console.log('[' + MODULE_NAME + '] Chat check - chatId:', chatId, ', currentChatIndexed:', currentChatIndexed);
    
    if (!chatId) {
        console.log('[' + MODULE_NAME + '] Skipping injection - no chatId');
        return;
    }
    
    // If chat not marked as indexed, check Qdrant directly (fixes race condition)
    if (!currentChatIndexed) {
        console.log('[' + MODULE_NAME + '] Chat not marked indexed - checking Qdrant directly...');
        const isGroupChat = isCurrentChatGroupChat();
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatId;
        
        try {
            const pointCount = await countPoints(collectionName);
            if (pointCount > 0) {
                currentChatIndexed = true;
                console.log('[' + MODULE_NAME + '] ✓ Found existing collection with ' + pointCount + ' points - marking as indexed');
                updateUI('status', '✓ Indexed (' + pointCount + ' messages)');
            } else {
                console.log('[' + MODULE_NAME + '] Skipping injection - collection empty or not found');
                return;
            }
        } catch (checkError) {
            console.log('[' + MODULE_NAME + '] Skipping injection - could not verify collection:', checkError.message);
            return;
        }
    }
    
    // Mark injection time BEFORE async work to prevent parallel calls
    lastInjectionTime = now;
    
    const isGroupChat = isCurrentChatGroupChat();
    
    try {
        let context;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            context = SillyTavern.getContext();
        } else if (typeof getContext === 'function') {
            context = getContext();
        }
        
        if (!context || !context.chat || context.chat.length === 0) {
            console.log('[' + MODULE_NAME + '] No chat context available for injection');
            return;
        }
        
        // Get ONLY actual chat messages (filter out any system/injected content)
        const actualMessages = context.chat.filter(function(m) {
            if (!m.mes) return false;
            if (m.is_system) return false;
            if (m.mes.trim().length === 0) return false;
            return true;
        });
        
        // Get ONLY the last message (most recent user or character message)
        const lastMessage = actualMessages[actualMessages.length - 1];
        
        if (!lastMessage) {
            console.log('[' + MODULE_NAME + '] No valid message found for query');
            return;
        }
        
        let query = lastMessage.mes;
        
        console.log('[' + MODULE_NAME + '] Query from last message (' + (lastMessage.is_user ? 'USER' : 'CHAR') + '): "' + query.substring(0, 100) + '..."');
        
        // Truncate query if too long
        if (query.length > 1000) {
            query = query.substring(0, 1000);
            console.log('[' + MODULE_NAME + '] Query truncated to 1000 chars');
        }
        
        console.log('[' + MODULE_NAME + '] ===== CONTEXT INJECTION ATTEMPT =====');
        console.log('[' + MODULE_NAME + '] Query text (' + query.length + ' chars)');
        console.log('[' + MODULE_NAME + '] Retrieving context for injection...');
        
        const retrievedContext = await retrieveContext(query, chatId, isGroupChat);
        
        if (retrievedContext) {
            console.log('[' + MODULE_NAME + '] ✓ Retrieved context (' + retrievedContext.length + ' chars)');
            
            // Determine injection position based on settings
            let position;
            let depth;
            
            if (extensionSettings.injectionPosition === 'before_main') {
                position = 0;
                depth = 0;
                console.log('[' + MODULE_NAME + '] Injection mode: BEFORE main prompt (position=0, depth=0)');
            } else if (extensionSettings.injectionPosition === 'after_main') {
                position = 1;
                depth = 0;
                console.log('[' + MODULE_NAME + '] Injection mode: AFTER main prompt (position=1, depth=0)');
            } else if (extensionSettings.injectionPosition === 'after_messages') {
                position = 2;
                depth = extensionSettings.injectAfterMessages;
                console.log('[' + MODULE_NAME + '] Injection mode: AFTER ' + depth + ' messages (position=2, depth=' + depth + ')');
            }
            
            console.log('[' + MODULE_NAME + '] Attempting injection via context.setExtensionPrompt...');
            console.log('[' + MODULE_NAME + '] Parameters: name="' + MODULE_NAME + '", position=' + position + ', depth=' + depth);
            
            let injected = false;
            
            // Method 1: Try context.setExtensionPrompt
            if (context.setExtensionPrompt && typeof context.setExtensionPrompt === 'function') {
                try {
                    context.setExtensionPrompt(MODULE_NAME, retrievedContext, position, depth);
                    injected = true;
                    console.log('[' + MODULE_NAME + '] ✓ Method 1: context.setExtensionPrompt() called');
                } catch (e) {
                    console.error('[' + MODULE_NAME + '] Method 1 failed:', e);
                }
            }
            
            // Method 2: Try global setExtensionPrompt
            if (!injected && typeof setExtensionPrompt === 'function') {
                try {
                    setExtensionPrompt(MODULE_NAME, retrievedContext, position, depth);
                    injected = true;
                    console.log('[' + MODULE_NAME + '] ✓ Method 2: global setExtensionPrompt() called');
                } catch (e) {
                    console.error('[' + MODULE_NAME + '] Method 2 failed:', e);
                }
            }
            
            // Method 3: Direct manipulation of extension_prompts object
            if (typeof extension_prompts !== 'undefined') {
                try {
                    extension_prompts[MODULE_NAME] = {
                        value: retrievedContext,
                        position: position,
                        depth: depth,
                        role: 0 // system role
                    };
                    injected = true;
                    console.log('[' + MODULE_NAME + '] ✓ Method 3: Direct extension_prompts assignment');
                    console.log('[' + MODULE_NAME + '] extension_prompts[' + MODULE_NAME + '] =', extension_prompts[MODULE_NAME]);
                } catch (e) {
                    console.error('[' + MODULE_NAME + '] Method 3 failed:', e);
                }
            }
            
            if (injected) {
                console.log('[' + MODULE_NAME + '] ===== INJECTION SUCCESSFUL =====');
                updateUI('status', 'Context injected! (' + retrievedContext.length + ' chars)');
                
                // Verify it's in the array
                if (typeof extension_prompts !== 'undefined') {
                    console.log('[' + MODULE_NAME + '] extension_prompts keys:', Object.keys(extension_prompts));
                    if (extension_prompts[MODULE_NAME]) {
                        console.log('[' + MODULE_NAME + '] Our prompt value length:', extension_prompts[MODULE_NAME].value ? extension_prompts[MODULE_NAME].value.length : 'N/A');
                    }
                }
            } else {
                updateUI('status', 'Context retrieved but injection failed');
                console.log('[' + MODULE_NAME + '] ===== INJECTION FAILED - NO METHOD WORKED =====');
            }
        } else {
            console.log('[' + MODULE_NAME + '] No relevant context found (similarity too low)');
            console.log('[' + MODULE_NAME + '] ===== NO CONTEXT TO INJECT =====');
        }
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Context injection failed:', error);
        console.error('[' + MODULE_NAME + '] ===== INJECTION ERROR =====');
    }
}

async function pollForNewMessages() {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) {
        return;
    }
    
    const currentMessages = getCurrentMessages();
    const currentChatId = getCurrentChatId();
    
    // Check for chat change
    if (currentChatId !== lastChatId) {
        console.log('[' + MODULE_NAME + '] Chat changed, resetting state');
        lastChatId = currentChatId;
        lastMessageCount = 0;
        currentChatIndexed = false;
        indexedMessageIds.clear();
    }
    
    // Check for new messages
    if (currentMessages.length > lastMessageCount) {
        console.log('[' + MODULE_NAME + '] New messages detected: ' + currentMessages.length + ' (was ' + lastMessageCount + ')');
        
        const newMessages = currentMessages.slice(lastMessageCount);
        
        // Index new messages incrementally
        if (currentChatIndexed && newMessages.length > 0) {
            try {
                await indexChat(newMessages, currentChatId, isCurrentChatGroupChat());
            } catch (error) {
                console.error('[' + MODULE_NAME + '] Failed to index new messages:', error);
            }
        }
        
        lastMessageCount = currentMessages.length;
    }
}

async function startPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    
    console.log('[' + MODULE_NAME + '] Starting polling for new messages');
    pollingInterval = setInterval(pollForNewMessages, 5000);
    
    // Run immediately
    await pollForNewMessages();
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        console.log('[' + MODULE_NAME + '] Polling stopped');
    }
}

// ===========================
// Event Handlers
// ===========================

async function onChatLoaded() {
    console.log('[' + MODULE_NAME + '] Event: chat_loaded');
    
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.log('[' + MODULE_NAME + '] No chat ID available');
        return;
    }
    
    // Reset state
    if (chatId !== lastChatId) {
        console.log('[' + MODULE_NAME + '] New chat loaded: ' + chatId);
        lastChatId = chatId;
        currentChatIndexed = false;
        lastMessageCount = 0;
        indexedMessageIds.clear();
        
        // Check if this chat is already indexed
        const isGroupChat = isCurrentChatGroupChat();
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = prefix + chatId;
        
        try {
            const pointCount = await countPoints(collectionName);
            if (pointCount > 0) {
                currentChatIndexed = true;
                console.log('[' + MODULE_NAME + '] ✓ Chat already indexed (' + pointCount + ' messages)');
                updateUI('status', '✓ Indexed (' + pointCount + ' messages)');
            } else {
                console.log('[' + MODULE_NAME + '] Chat not indexed yet');
                updateUI('status', 'Ready to index');
            }
        } catch (error) {
            console.log('[' + MODULE_NAME + '] Could not check collection:', error.message);
            updateUI('status', 'Ready to index');
        }
        
        // Update message count
        const messages = getCurrentMessages();
        lastMessageCount = messages.length;
    }
}

async function onMessageSent(data) {
    console.log('[' + MODULE_NAME + '] Event: message_sent', data);
    
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) {
        return;
    }
    
    // Auto-index if not already indexed
    if (!currentChatIndexed) {
        console.log('[' + MODULE_NAME + '] Auto-indexing triggered by message_sent');
        await indexCurrentChat();
    } else {
        // Update message count for polling
        const messages = getCurrentMessages();
        lastMessageCount = messages.length;
    }
}

async function onMessageReceived(data) {
    console.log('[' + MODULE_NAME + '] Event: message_received', data);
    
    // Same as message_sent
    await onMessageSent(data);
}

// ===========================
// UI Functions
// ===========================

function createSettingsUI() {
    return `
        <div id="ragfordummies_container" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>RagForDummies</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display: none;">
                <div class="ragfordummies_settings">
                    <!-- Status -->
                    <div class="ragfordummies_status_row">
                        <label>Status:</label>
                        <span id="ragfordummies_status" style="color: #888;">Initializing...</span>
                    </div>
                    
                    <hr>
                    
                    <!-- Main Controls -->
                    <div class="flex-container flexFlowColumn">
                        <label class="checkbox_label" for="ragfordummies_enabled">
                            <input type="checkbox" id="ragfordummies_enabled" />
                            <span>Enable RAG Extension</span>
                        </label>
                        
                        <label class="checkbox_label" for="ragfordummies_auto_index">
                            <input type="checkbox" id="ragfordummies_auto_index" />
                            <span>Auto-index new messages</span>
                        </label>
                        
                        <label class="checkbox_label" for="ragfordummies_inject_context">
                            <input type="checkbox" id="ragfordummies_inject_context" />
                            <span>Auto-inject retrieved context</span>
                        </label>
                    </div>
                    
                    <!-- Index Controls -->
                    <div class="ragfordummies_button_row">
                        <div class="menu_button" id="ragfordummies_index_current">
                            <i class="fa-solid fa-database"></i>
                            <span>Index Current Chat</span>
                        </div>
                        
                        <div class="menu_button" id="ragfordummies_stop_index">
                            <i class="fa-solid fa-stop"></i>
                            <span>Stop Indexing</span>
                        </div>
                    </div>
                    
                    <div class="ragfordummies_button_row">
                        <div class="menu_button" id="ragfordummies_clear_index">
                            <i class="fa-solid fa-trash"></i>
                            <span>Clear Current Index</span>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Qdrant Settings -->
                    <h4>Qdrant Settings</h4>
                    
                    <label for="ragfordummies_qdrant_mode">
                        <small>Qdrant Mode</small>
                    </label>
                    <select id="ragfordummies_qdrant_mode" class="text_pole">
                        <option value="local">Local (self-hosted)</option>
                        <option value="cloud">Cloud (Qdrant Cloud)</option>
                    </select>
                    
                    <label for="ragfordummies_qdrant_local_url">
                        <small>Local Qdrant URL</small>
                    </label>
                    <input type="text" id="ragfordummies_qdrant_local_url" class="text_pole" placeholder="http://localhost:6333" />
                    
                    <label for="ragfordummies_qdrant_cloud_url">
                        <small>Cloud Qdrant URL</small>
                    </label>
                    <input type="text" id="ragfordummies_qdrant_cloud_url" class="text_pole" placeholder="https://xxx.qdrant.io" />
                    
                    <label for="ragfordummies_qdrant_api_key">
                        <small>Cloud API Key</small>
                    </label>
                    <input type="password" id="ragfordummies_qdrant_api_key" class="text_pole" placeholder="Optional for local" />
                    
                    <div class="ragfordummies_button_row">
                        <div class="menu_button" id="ragfordummies_test_qdrant">
                            <i class="fa-solid fa-vial"></i>
                            <span>Test Qdrant Connection</span>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Embedding Settings -->
                    <h4>Embedding Provider</h4>
                    
                    <label for="ragfordummies_embedding_provider">
                        <small>Provider</small>
                    </label>
                    <select id="ragfordummies_embedding_provider" class="text_pole">
                        <option value="kobold">KoboldCpp</option>
                        <option value="ollama">Ollama</option>
                        <option value="openai">OpenAI</option>
                    </select>
                    
                    <div id="ragfordummies_kobold_settings">
                        <label for="ragfordummies_kobold_url">
                            <small>KoboldCpp URL</small>
                        </label>
                        <input type="text" id="ragfordummies_kobold_url" class="text_pole" placeholder="http://localhost:5001" />
                    </div>
                    
                    <div id="ragfordummies_ollama_settings" style="display: none;">
                        <label for="ragfordummies_ollama_url">
                            <small>Ollama URL</small>
                        </label>
                        <input type="text" id="ragfordummies_ollama_url" class="text_pole" placeholder="http://localhost:11434" />
                        
                        <label for="ragfordummies_ollama_model">
                            <small>Embedding Model</small>
                        </label>
                        <input type="text" id="ragfordummies_ollama_model" class="text_pole" placeholder="nomic-embed-text" />
                    </div>
                    
                    <div id="ragfordummies_openai_settings" style="display: none;">
                        <label for="ragfordummies_openai_api_key">
                            <small>OpenAI API Key</small>
                        </label>
                        <input type="password" id="ragfordummies_openai_api_key" class="text_pole" />
                        
                        <label for="ragfordummies_openai_model">
                            <small>Model</small>
                        </label>
                        <select id="ragfordummies_openai_model" class="text_pole">
                            <option value="text-embedding-3-small">text-embedding-3-small (cheap)</option>
                            <option value="text-embedding-3-large">text-embedding-3-large (best)</option>
                        </select>
                    </div>
                    
                    <div class="ragfordummies_button_row">
                        <div class="menu_button" id="ragfordummies_test_embedding">
                            <i class="fa-solid fa-vial"></i>
                            <span>Test Embedding</span>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Retrieval Settings -->
                    <h4>Retrieval Settings</h4>
                    
                    <label for="ragfordummies_retrieval_count">
                        <small>Number of messages to retrieve</small>
                    </label>
                    <input type="number" id="ragfordummies_retrieval_count" class="text_pole" min="1" max="20" />
                    
                    <label for="ragfordummies_similarity_threshold">
                        <small>Similarity threshold (0.0 - 1.0)</small>
                    </label>
                    <input type="number" id="ragfordummies_similarity_threshold" class="text_pole" min="0" max="1" step="0.05" />
                    
                    <hr>
                    
                    <!-- Injection Settings -->
                    <h4>Injection Settings</h4>
                    
                    <label for="ragfordummies_injection_position">
                        <small>Injection Position</small>
                    </label>
                    <select id="ragfordummies_injection_position" class="text_pole">
                        <option value="before_main">Before Main Prompt</option>
                        <option value="after_main">After Main Prompt</option>
                        <option value="after_messages">After N Recent Messages</option>
                    </select>
                    
                    <div id="ragfordummies_inject_depth_container">
                        <label for="ragfordummies_inject_after_messages">
                            <small>Inject after N messages from end</small>
                        </label>
                        <input type="number" id="ragfordummies_inject_after_messages" class="text_pole" min="0" max="20" />
                    </div>
                    
                    <hr>
                    
                    <!-- Upload Chat -->
                    <h4>Upload & Index Chat File</h4>
                    <small>Upload a SillyTavern .jsonl chat export to index it separately or merge it into your current chat's collection.</small>
                    
                    <label class="checkbox_label" for="ragfordummies_merge_uploads">
                        <input type="checkbox" id="ragfordummies_merge_uploads" />
                        <span>Merge uploads into current chat collection</span>
                    </label>
                    <small style="color: #888;">When checked, uploaded chats will be added to your currently open chat's vector database instead of creating a separate collection. Useful for adding context from other conversations.</small>
                    
                    <div class="ragfordummies_button_row" style="margin-top: 10px;">
                        <input type="file" id="ragfordummies_upload_chat" accept=".jsonl" style="display: none;" />
                        <div class="menu_button" id="ragfordummies_upload_chat_btn">
                            <i class="fa-solid fa-upload"></i>
                            <span>Upload Chat File</span>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <!-- Testing & Debugging -->
                    <h4>Testing & Debugging</h4>
                    
                    <div class="ragfordummies_button_row">
                        <div class="menu_button" id="ragfordummies_test_injection">
                            <i class="fa-solid fa-flask"></i>
                            <span>Test Injection APIs</span>
                        </div>
                    </div>
                    
                    <div style="margin-top: 10px;">
                        <label for="ragfordummies_hybrid_test_query">
                            <small>Hybrid Search Test Query (optional)</small>
                        </label>
                        <input type="text" id="ragfordummies_hybrid_test_query" class="text_pole" placeholder="Leave empty to use last 3 messages" />
                        
                        <div class="ragfordummies_button_row">
                            <div class="menu_button" id="ragfordummies_test_hybrid">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <span>Test Hybrid Search</span>
                            </div>
                        </div>
                        
                        <div id="ragfordummies_hybrid_results" style="
                            display: none;
                            margin-top: 10px;
                            padding: 10px;
                            background: #1a1a1a;
                            border: 1px solid #333;
                            border-radius: 5px;
                            font-family: monospace;
                            font-size: 12px;
                            white-space: pre-wrap;
                            max-height: 400px;
                            overflow-y: auto;
                        "></div>
                    </div>
                </div>
            </div>
        </div>
        
        <style>
            .ragfordummies_settings {
                padding: 10px;
            }
            
            .ragfordummies_status_row {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 10px;
            }
            
            .ragfordummies_status_row label {
                font-weight: bold;
                min-width: 60px;
            }
            
            .ragfordummies_button_row {
                display: flex;
                gap: 10px;
                margin: 10px 0;
                flex-wrap: wrap;
            }
            
            .ragfordummies_button_row .menu_button {
                flex: 1;
                min-width: 150px;
            }
            
            #ragfordummies_inject_depth_container {
                display: none;
            }
        </style>
    `;
}

function updateUI(element, value) {
    if (element === 'status') {
        const statusEl = document.getElementById('ragfordummies_status');
        if (statusEl) {
            statusEl.textContent = value;
        }
    }
}

function updateProviderSettings() {
    const provider = extensionSettings.embeddingProvider;
    
    document.getElementById('ragfordummies_kobold_settings').style.display = 
        provider === 'kobold' ? 'block' : 'none';
    document.getElementById('ragfordummies_ollama_settings').style.display = 
        provider === 'ollama' ? 'block' : 'none';
    document.getElementById('ragfordummies_openai_settings').style.display = 
        provider === 'openai' ? 'block' : 'none';
}

function updateInjectionSettings() {
    const position = extensionSettings.injectionPosition;
    const depthContainer = document.getElementById('ragfordummies_inject_depth_container');
    
    if (depthContainer) {
        depthContainer.style.display = position === 'after_messages' ? 'block' : 'none';
    }
}

function loadUIFromSettings() {
    document.getElementById('ragfordummies_enabled').checked = extensionSettings.enabled;
    document.getElementById('ragfordummies_qdrant_mode').value = extensionSettings.qdrantMode;
    document.getElementById('ragfordummies_qdrant_local_url').value = extensionSettings.qdrantLocalUrl;
    document.getElementById('ragfordummies_qdrant_cloud_url').value = extensionSettings.qdrantCloudUrl;
    document.getElementById('ragfordummies_qdrant_api_key').value = extensionSettings.qdrantApiKey;
    document.getElementById('ragfordummies_embedding_provider').value = extensionSettings.embeddingProvider;
    document.getElementById('ragfordummies_kobold_url').value = extensionSettings.koboldUrl;
    document.getElementById('ragfordummies_ollama_url').value = extensionSettings.ollamaUrl;
    document.getElementById('ragfordummies_ollama_model').value = extensionSettings.ollamaModel;
    document.getElementById('ragfordummies_openai_api_key').value = extensionSettings.openaiApiKey;
    document.getElementById('ragfordummies_openai_model').value = extensionSettings.openaiModel;
    document.getElementById('ragfordummies_retrieval_count').value = extensionSettings.retrievalCount;
    document.getElementById('ragfordummies_similarity_threshold').value = extensionSettings.similarityThreshold;
    document.getElementById('ragfordummies_auto_index').checked = extensionSettings.autoIndex;
    document.getElementById('ragfordummies_inject_context').checked = extensionSettings.injectContext;
    document.getElementById('ragfordummies_injection_position').value = extensionSettings.injectionPosition;
    document.getElementById('ragfordummies_inject_after_messages').value = extensionSettings.injectAfterMessages;
    
    updateProviderSettings();
    updateInjectionSettings();
}

function attachEventListeners() {
    // Enable/Disable
    document.getElementById('ragfordummies_enabled').addEventListener('change', function(e) {
        extensionSettings.enabled = e.target.checked;
        saveSettings();
        
        if (extensionSettings.enabled && extensionSettings.autoIndex && !eventsRegistered) {
            startPolling();
        } else if (!extensionSettings.enabled) {
            stopPolling();
        }
    });
    
    // Qdrant settings
    document.getElementById('ragfordummies_qdrant_mode').addEventListener('change', function(e) {
        extensionSettings.qdrantMode = e.target.value;
        saveSettings();
    });
    
    document.getElementById('ragfordummies_qdrant_local_url').addEventListener('change', function(e) {
        extensionSettings.qdrantLocalUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('ragfordummies_qdrant_cloud_url').addEventListener('change', function(e) {
        extensionSettings.qdrantCloudUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('ragfordummies_qdrant_api_key').addEventListener('change', function(e) {
        extensionSettings.qdrantApiKey = e.target.value;
        saveSettings();
    });
    
    // Embedding provider
    document.getElementById('ragfordummies_embedding_provider').addEventListener('change', function(e) {
        extensionSettings.embeddingProvider = e.target.value;
        updateProviderSettings();
        saveSettings();
    });
    
    document.getElementById('ragfordummies_kobold_url').addEventListener('change', function(e) {
        extensionSettings.koboldUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('ragfordummies_ollama_url').addEventListener('change', function(e) {
        extensionSettings.ollamaUrl = e.target.value;
        saveSettings();
    });
    
    document.getElementById('ragfordummies_ollama_model').addEventListener('change', function(e) {
        extensionSettings.ollamaModel = e.target.value;
        saveSettings();
    });
    
    document.getElementById('ragfordummies_openai_api_key').addEventListener('change', function(e) {
        extensionSettings.openaiApiKey = e.target.value;
        saveSettings();
    });
    
    document.getElementById('ragfordummies_openai_model').addEventListener('change', function(e) {
        extensionSettings.openaiModel = e.target.value;
        saveSettings();
    });
    
    // Retrieval settings
    document.getElementById('ragfordummies_retrieval_count').addEventListener('change', function(e) {
        extensionSettings.retrievalCount = parseInt(e.target.value);
        saveSettings();
    });
    
    document.getElementById('ragfordummies_similarity_threshold').addEventListener('change', function(e) {
        extensionSettings.similarityThreshold = parseFloat(e.target.value);
        saveSettings();
    });
    
    // Auto-index
    document.getElementById('ragfordummies_auto_index').addEventListener('change', function(e) {
        extensionSettings.autoIndex = e.target.checked;
        saveSettings();
        
        if (extensionSettings.enabled && extensionSettings.autoIndex && !eventsRegistered) {
            startPolling();
        } else if (!extensionSettings.autoIndex) {
            stopPolling();
        }
    });
    
    // Inject context
    document.getElementById('ragfordummies_inject_context').addEventListener('change', function(e) {
        extensionSettings.injectContext = e.target.checked;
        saveSettings();
    });
    
    // Injection settings
    document.getElementById('ragfordummies_injection_position').addEventListener('change', function(e) {
        extensionSettings.injectionPosition = e.target.value;
        updateInjectionSettings();
        saveSettings();
    });
    
    document.getElementById('ragfordummies_inject_after_messages').addEventListener('change', function(e) {
        extensionSettings.injectAfterMessages = parseInt(e.target.value);
        saveSettings();
    });
    
    // Index current chat
    document.getElementById('ragfordummies_index_current').addEventListener('click', async function() {
        try {
            await indexCurrentChat();
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Index failed:', error);
        }
    });
    
    // Stop indexing
    document.getElementById('ragfordummies_stop_index').addEventListener('click', function() {
        shouldStopIndexing = true;
        updateUI('status', 'Stopping...');
    });
    
    // Clear index
    document.getElementById('ragfordummies_clear_index').addEventListener('click', async function() {
        if (!confirm('Are you sure you want to delete the index for the current chat?')) {
            return;
        }
        
        const chatId = getCurrentChatId();
        if (!chatId) {
            updateUI('status', '✗ No active chat');
            return;
        }
        
        try {
            const isGroupChat = isCurrentChatGroupChat();
            const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
            const collectionName = prefix + chatId;
            
            updateUI('status', 'Deleting collection...');
            const deleted = await deleteCollection(collectionName);
            
            if (deleted) {
                currentChatIndexed = false;
                indexedMessageIds.clear();
                updateUI('status', '✓ Index cleared');
            } else {
                updateUI('status', 'Collection did not exist');
            }
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Clear index failed:', error);
            updateUI('status', '✗ Clear failed: ' + error.message);
        }
    });
    
    // Test Qdrant connection
    document.getElementById('ragfordummies_test_qdrant').addEventListener('click', async function() {
        try {
            updateUI('status', 'Testing Qdrant...');
            
            const baseUrl = extensionSettings.qdrantMode === 'cloud' ? 
                extensionSettings.qdrantCloudUrl : 
                extensionSettings.qdrantLocalUrl;
            
            const response = await fetch(baseUrl + '/collections');
            
            if (response.ok) {
                const data = await response.json();
                const count = data.result ? data.result.collections.length : 0;
                updateUI('status', '✓ Qdrant OK (' + count + ' collections)');
                console.log('[' + MODULE_NAME + '] Qdrant test successful:', data);
            } else {
                updateUI('status', '✗ Qdrant connection failed');
            }
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Qdrant test failed:', error);
            updateUI('status', '✗ Qdrant error: ' + error.message);
        }
    });
    
    // Test embedding
    document.getElementById('ragfordummies_test_embedding').addEventListener('click', async function() {
        try {
            updateUI('status', 'Testing embedding...');
            const testText = 'This is a test message for embedding generation.';
            
            const embedding = await generateEmbedding(testText);
            
            updateUI('status', '✓ Embedding OK (dim: ' + embedding.length + ')');
            console.log('[' + MODULE_NAME + '] Embedding test successful. Vector size:', embedding.length);
        } catch (error) {
            console.error('[' + MODULE_NAME + '] Embedding test failed:', error);
            updateUI('status', '✗ Embedding error: ' + error.message);
        }
    });
    
    // Upload chat button
    const uploadBtn = document.getElementById('ragfordummies_upload_chat_btn');
    const fileInput = document.getElementById('ragfordummies_upload_chat');
    
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', function() {
            fileInput.click();
        });
        
        fileInput.addEventListener('change', async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                updateUI('status', 'Reading file...');
                
                const text = await file.text();
                const lines = text.trim().split('\n');
                const parsed = {
                    messages: [],
                    chat_id_hash: null,
                    groupId: undefined
                };
                
                // Parse JSONL format
                for (const line of lines) {
                    if (!line.trim()) continue;
                    
                    try {
                        const obj = JSON.parse(line);
                        
                        // If it's chat metadata
                        if (obj.chat_id_hash) {
                            parsed.chat_id_hash = obj.chat_id_hash;
                        }
                        if (obj.groupId !== undefined) {
                            parsed.groupId = obj.groupId;
                        }
                        
                        // If it's a message
                        if (obj.mes || obj.content) {
                            parsed.messages.push(obj);
                        }
                    } catch (lineError) {
                        console.warn('[' + MODULE_NAME + '] Failed to parse line:', lineError);
                    }
                }
                
                if (parsed.messages.length === 0) {
                    throw new Error('No messages found in file');
                }
                
                console.log('[' + MODULE_NAME + '] Parsed ' + parsed.messages.length + ' messages from upload');
                
                // Prepare content for indexing
                const content = JSON.stringify(parsed);
                const chatMetadata = {
                    chat_id_hash: parsed.chat_id_hash,
                    groupId: parsed.groupId
                };
                
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
    
    loadUIFromSettings();
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
        
        // Register generation event for context injection
        eventSourceToUse.on('chat_completion_prompt_ready', function(data) {
            console.log('[' + MODULE_NAME + '] 🎯 EVENT FIRED: chat_completion_prompt_ready');
            injectContextBeforeGeneration(data);
        });
        
        console.log('[' + MODULE_NAME + '] Registered listener for: chat_completion_prompt_ready');
        
        eventsRegistered = true; // Mark that events are working
        usePolling = false; // Disable polling since events work
        
        console.log('[' + MODULE_NAME + '] ✓ Event listeners registered successfully');
        
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
        console.log('[' + MODULE_NAME + '] ✓ extension_prompts exists:', extension_prompts);
    }
    
    if (typeof SillyTavern !== 'undefined') {
        console.log('[' + MODULE_NAME + '] SillyTavern object keys:', Object.keys(SillyTavern));
        if (SillyTavern.extensions) {
            console.log('[' + MODULE_NAME + '] SillyTavern.extensions:', SillyTavern.extensions);
        }
        if (SillyTavern.setExtensionPrompt) {
            console.log('[' + MODULE_NAME + '] ✓ SillyTavern.setExtensionPrompt EXISTS!');
        }
        if (SillyTavern.eventSource) {
            console.log('[' + MODULE_NAME + '] ✓ SillyTavern.eventSource EXISTS!');
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
                    console.log('[' + MODULE_NAME + '] ✓ Initial check: Collection exists with ' + pointCount + ' points - marking as indexed');
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
    
    // Add test injection button handler
    const testInjectionBtn = document.getElementById('ragfordummies_test_injection');
    if (testInjectionBtn) {
        testInjectionBtn.addEventListener('click', function() {
            console.log('[' + MODULE_NAME + '] ======================================');
            console.log('[' + MODULE_NAME + '] INJECTION API TEST');
            console.log('[' + MODULE_NAME + '] ======================================');
            
            // Test setExtensionPrompt availability
            console.log('[' + MODULE_NAME + '] --- setExtensionPrompt Tests ---');
            
            if (typeof setExtensionPrompt !== 'undefined') {
                console.log('[' + MODULE_NAME + '] ✓ global setExtensionPrompt exists');
                console.log('[' + MODULE_NAME + '] Type:', typeof setExtensionPrompt);
            } else {
                console.log('[' + MODULE_NAME + '] ✗ global setExtensionPrompt does NOT exist');
            }
            
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const context = SillyTavern.getContext();
                if (context.setExtensionPrompt) {
                    console.log('[' + MODULE_NAME + '] ✓ context.setExtensionPrompt exists');
                    console.log('[' + MODULE_NAME + '] Type:', typeof context.setExtensionPrompt);
                } else {
                    console.log('[' + MODULE_NAME + '] ✗ context.setExtensionPrompt does NOT exist');
                }
            }
            
            // Test extension_prompts object
            console.log('[' + MODULE_NAME + '] ---');
            console.log('[' + MODULE_NAME + '] --- extension_prompts Object Test ---');
            
            if (typeof extension_prompts !== 'undefined') {
                console.log('[' + MODULE_NAME + '] ✓ extension_prompts exists');
                console.log('[' + MODULE_NAME + '] Type:', typeof extension_prompts);
                console.log('[' + MODULE_NAME + '] Keys:', Object.keys(extension_prompts));
                console.log('[' + MODULE_NAME + '] Full object:', extension_prompts);
            } else {
                console.log('[' + MODULE_NAME + '] ✗ extension_prompts does NOT exist');
            }
            
            // Test eventSource
            console.log('[' + MODULE_NAME + '] ---');
            console.log('[' + MODULE_NAME + '] --- eventSource Test ---');
            
            if (typeof eventSource !== 'undefined') {
                console.log('[' + MODULE_NAME + '] ✓ eventSource exists globally');
                if (eventSource._events) {
                    console.log('[' + MODULE_NAME + '] Events:', Object.keys(eventSource._events));
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
                
                // Extract proper nouns
                const properNouns = extractProperNouns(query);
                log('===== PROPER NOUN EXTRACTION =====');
                if (properNouns.length > 0) {
                    log('Found ' + properNouns.length + ' proper nouns: ' + properNouns.join(', '));
                } else {
                    log('No proper nouns found in query');
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
                if (properNouns.length > 0) {
                    log('RUN 1: Filtered search (proper noun matching)...');
                    
                    const filter = {
                        should: properNouns.map(function(noun) {
                            return {
                                key: 'proper_nouns',
                                match: { value: noun }
                            };
                        })
                    };
                    
                    try {
                        filteredResults = await searchPoints(
                            collectionName,
                            queryEmbedding,
                            extensionSettings.retrievalCount * 2,
                            extensionSettings.similarityThreshold * 0.8,
                            filter
                        );
                        log('Filtered results: ' + filteredResults.length);
                        
                        if (filteredResults.length > 0) {
                            log('Top filtered result:');
                            const top = filteredResults[0];
                            log('  Score: ' + (top.score * 100).toFixed(1) + '%');
                            log('  Sender: ' + top.payload.sender);
                            log('  Message: "' + top.payload.message.substring(0, 80) + '..."');
                            log('  Proper nouns: ' + (top.payload.proper_nouns || []).join(', '));
                        }
                    } catch (e) {
                        log('Filtered search error: ' + e.message);
                    }
                    log('');
                }
                
                // Run 2: Dense search
                log('RUN 2: Dense search (semantic similarity)...');
                try {
                    denseResults = await searchPoints(
                        collectionName,
                        queryEmbedding,
                        extensionSettings.retrievalCount,
                        extensionSettings.similarityThreshold,
                        null
                    );
                    log('Dense results: ' + denseResults.length);
                    
                    if (denseResults.length > 0) {
                        log('Top dense result:');
                        const top = denseResults[0];
                        log('  Score: ' + (top.score * 100).toFixed(1) + '%');
                        log('  Sender: ' + top.payload.sender);
                        log('  Message: "' + top.payload.message.substring(0, 80) + '..."');
                    }
                } catch (e) {
                    log('Dense search error: ' + e.message);
                }
                log('');
                
                // Merge results
                log('===== MERGING RESULTS =====');
                const seenIds = new Set();
                let finalResults = [];
                
                // Add filtered first
                for (const r of filteredResults) {
                    if (!seenIds.has(r.id)) {
                        finalResults.push(r);
                        seenIds.add(r.id);
                    }
                }
                
                // Add dense
                for (const r of denseResults) {
                    if (!seenIds.has(r.id)) {
                        finalResults.push(r);
                        seenIds.add(r.id);
                    }
                }
                
                // Sort by score
                finalResults.sort(function(a, b) { return b.score - a.score; });
                finalResults = finalResults.slice(0, extensionSettings.retrievalCount);
                
                log('Final merged results: ' + finalResults.length);
                log('');
                
                // Show final results
                log('===== FINAL RESULTS =====');
                for (let i = 0; i < finalResults.length; i++) {
                    const r = finalResults[i];
                    log((i + 1) + '. [' + (r.score * 100).toFixed(1) + '%] ' + r.payload.sender + ': "' + r.payload.message.substring(0, 60) + '..."');
                }
                
                updateUI('status', '✓ Hybrid search test complete (' + finalResults.length + ' results)');
                log('');
                log('===== TEST COMPLETE =====');
            } catch (error) {
                log('');
                log('✗ ERROR: ' + error.message);
                log('Stack: ' + error.stack);
                updateUI('status', '✗ Test failed');
            }
        });
    }
}

jQuery(async function() {
    setTimeout(async function() {
        await init();
    }, 100);
});
