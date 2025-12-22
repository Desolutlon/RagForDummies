/**
 * RagForDummies + FuckTracker (FINAL FULL RESTORATION)
 * - RAG: Hybrid Search (Vector + Keyword), Token Budgeting, Auto-Optimization, TXT/JSONL Upload
 * - TRACKER: DOM Injection, State State, Dynamic Fields
 */

const MODULE_NAME = 'RagForDummies';

// Whitelist/allowlist logging for this module
const MODULE_LOG_WHITELIST = [
    'Settings loaded',
    'Extension loaded successfully',
    'Container found',
    'Content found',
    'Initial check',
    'Tracker',
    'TRACKER',
    'FUCKTRACKER',
    'JSON Parse',
    'injected successfully',
    'Payload index'
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
    'Excluding',       // participant name exclusion logging
    'Summary changed', // logging for qvlink updates
    'Qvlink Sync',     // Explicit tag for summary updates
    'State Updated',
    'Prompt Injected',
    'Injected tracker header',
    'Snapshot',
    'Token budget'
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

// =================================================================
// 1. GLOBAL TRACKER STATE (FuckTracker Engine V3)
// =================================================================

window.RagTrackerState = {
    _clockMs: null, 
    time: "Unknown",
    location: "Unknown",
    topic: "None",
    tone: "Neutral",
    fields: {},

    initClockFromSettingsAndChat: function() {
        const start = extensionSettings.trackerStartDate;
        const stepMin = extensionSettings.trackerTimeStep || 15;
        let startMs = Date.parse(start);
        if (!Number.isFinite(startMs)) {
            const d = new Date();
            d.setHours(8, 0, 0, 0);
            startMs = d.getTime();
        }
        let ctx = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
        else if (typeof getContext === 'function') ctx = getContext();
        let assistantCount = 0;
        const chat = ctx?.chat || [];
        for (const m of chat) {
            if (!m || m.is_system) continue;
            if (m.is_user) continue;
            assistantCount++;
        }
        this._clockMs = startMs + assistantCount * stepMin * 60_000;
        this.time = this.formatClock(this._clockMs);
    },

    formatClock: function(ms) {
        if (!Number.isFinite(ms)) return "Unknown";
        const d = new Date(ms);
        const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        const dayName = dayNames[d.getDay()];
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yyyy = String(d.getFullYear());
        let hours = d.getHours();
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const isPm = hours >= 12;
        const suffix = isPm ? "p.m." : "a.m.";
        hours = hours % 12;
        if (hours === 0) hours = 12;
        return `${hours}:${minutes} ${suffix}; ${mm}/${dd}/${yyyy} (${dayName})`;
    },

    advanceClock: function() {
        const stepMin = extensionSettings.trackerTimeStep || 15;
        if (!Number.isFinite(this._clockMs)) {
            this.initClockFromSettingsAndChat();
            return;
        }
        this._clockMs += stepMin * 60_000;
        this.time = this.formatClock(this._clockMs);
    },

    updateFromJSON: function(data) {
        if (!data || typeof data !== 'object') return;
        const getField = (obj, ...keys) => {
            for (const key of keys) {
                if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
                const lowerKey = key.toLowerCase();
                for (const k of Object.keys(obj)) {
                    if (k.toLowerCase() === lowerKey && typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
                }
            }
            return null;
        };
        const loc = getField(data, 'Location', 'location');
        if (loc) this.location = loc;
        const top = getField(data, 'Topic', 'topic');
        if (top) this.topic = top;
        const ton = getField(data, 'Tone', 'tone');
        if (ton) this.tone = ton;

        const forbidden = new Set(["time", "date", "datetime", "day", "clock"]);
        for (const [k, v] of Object.entries(data)) {
            if (forbidden.has(k.toLowerCase())) continue;
            this.fields[k] = v;
        }
        tracker_updateSettingsDebug();
    },
    getFormattedDate: function() { return this.time; }
};

window.FuckTrackerSnapshots = {
    byMesId: Object.create(null),
    pending: [],
    processing: new Set(),
    swipesInProgress: new Set(),
};

function ft_getMesIdFromEventArg(arg) {
    if (arg == null) return null;
    if (typeof arg === 'number' || typeof arg === 'string') return arg;
    if (typeof arg === 'object') {
        if (arg.mesid != null) return arg.mesid;
        if (arg.mesId != null) return arg.mesId;
        if (arg.messageId != null) return arg.messageId;
        if (arg.id != null) return arg.id;
        if (arg.message && typeof arg.message === 'object') {
            if (arg.message.mesid != null) return arg.message.mesid;
            if (arg.message.id != null) return arg.message.id;
        }
    }
    return null;
}

function ft_escapeHtml(v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function ft_renderValue(v) {
    if (Array.isArray(v)) return v.join(', ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    if (v === null || v === undefined || v === '') return 'None';
    return String(v);
}

// ===========================
// CONFIG & SETTINGS
// ===========================

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
    maxTokenBudget: 1000, 
    queryMessageCount: 3,
    autoIndex: true,
    injectContext: true,
    injectionPosition: 'after_main',
    injectAfterMessages: 3,
    excludeLastMessages: 2,
    userBlacklist: '',

    // --- FUCK TRACKER ---
    trackerEnabled: true,
    trackerInline: true,
    trackerTimeStep: 15,
    trackerContextDepth: 10,
    trackerStartDate: new Date().toISOString().split('T')[0] + "T08:00",
    trackerFields: [
        { title: "Location", prompt: "Format: Specific Place, Building, City, State.", examples: `["The Green Mill Lounge, Uptown, Chicago, Illinois"]`, locked: true, required: true },
        { title: "Topic", prompt: "One- or two-word description of activity/event.", examples: `["Working Out"]`, locked: true, required: true },
        { title: "Tone", prompt: "Emotional tone (1-3 words).", examples: `["Tense", "Playful"]`, locked: false, required: false },
        { title: "CharactersPresent", prompt: "Array of nicknames.", examples: `["{{user}}", "Al Capone"]`, locked: false, required: false },
        { title: "CurrentAction", prompt: "Posture + interaction.", examples: `["Sitting at the desk, smoking a cigar"]`, locked: false, required: false },
        { title: "Weather", prompt: "Scientific style (Temp, wind).", examples: `["22°C, light wind"]`, locked: false, required: false },
    ],
};

let extensionSettings = { ...defaultSettings };
let isIndexing = false;
let shouldStopIndexing = false;
let currentChatIndexed = false;
let lastMessageCount = 0;
let lastChatId = null;
let pollingInterval = null;
let indexedMessageIds = new Set();
let lastKnownSummaries = new Map();
let usePolling = false;
let eventsRegistered = false;
let lastInjectionTime = 0;

// ===========================
// TRACKER CSS INJECTOR
// ===========================
function injectTrackerCSS() {
    const styleId = 'rag-tracker-styles';
    if (document.getElementById(styleId)) return;
    const css = `.ft-tracker-display{display:block;margin:0 0 12px 0;width:100%;background-color:rgba(20,20,20,0.6);border:2px solid var(--SmartThemeBorderColor);border-radius:8px;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;font-size:0.75em;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.2)}.ft-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background-color:rgba(255,255,255,0.1)}.ft-cell{background-color:var(--SmartThemeChatTintColor,#1e1e1e);padding:5px 10px;display:flex;flex-direction:column;justify-content:center}.ft-cell.full-width{grid-column:span 2}.ft-label{text-transform:uppercase;font-weight:700;font-size:0.85em;opacity:0.6;margin-bottom:2px;letter-spacing:0.5px}.ft-val{font-weight:500;color:var(--SmartThemeBodyColor);line-height:1.3}`;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
}

// ===========================
// UTILITY FUNCTIONS (NLP)
// ===========================

// --- The One, Master Blacklist to Rule Them All (FULL LIST RESTORED) ---
const keywordBlacklist = new Set([
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
    'rough', 'slight', 'slightly', 'brief', 'briefly', 'quick', 'slow', 'sudden', 'careful', 'carefully',
    "we've", "you're", "he's", "she's", "it's", "they're",
    'yourself', 'worry', 'mr', 'mrs', 'sir', 'maam', 'hmph',
    'fuck', 'fucking', 'fucked', 'shit', 'shitty', 'damn', 'damned', 'hell', 'ass', 'crap', 'crappy', 'bitch', 'dumbass',
    'motherfucker', 'fucker', 'cunt', 'shitter', 'bullshit', 'asshat', 'fuckface', 'bastard', 'dick', 'cock', 'pussy', 'slut', 'whore', 'asshole', 'arse', 'prick', 'twat',
    'tonights', 'tomorrows', 'todays', 'tonight', 'goddamn', 'godamn',
    'saturdays', 'sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays',
    'januarys', 'februarys', 'marchs', 'aprils', 'mays', 'junes', 'julys', 'augusts', 'septembers', 'octobers', 'novembers', 'decembers',
    'don', 'wasn', 'weren', 'isn', 'aren', 'didn', 'doesn', 'hasn', 'hadn', 'haven', 'wouldn', 'shouldn', 'couldn', 'mustn', 'shan', 'won', 've', 're', 'll', 's', 'm', 'd', 't',
    'leg', 'legs', 'babe', 'baby', 'darling', 'honey', 'sweetheart', 'dear', 'love', 'oof', 'mmph', 'mmmph'
]);

function getUserBlacklistSet() {
    if (!extensionSettings.userBlacklist) return new Set();
    return new Set(extensionSettings.userBlacklist.toLowerCase().split(',').map(t => t.trim()).filter(t => t.length > 0));
}

function sanitizeTextForKeywords(text, namesSet) {
    let cleanText = text;
    const sortedNames = Array.from(namesSet).sort((a, b) => b.length - a.length);
    if (sortedNames.length > 0) {
        const pattern = '\\b(' + sortedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b';
        const nameRegex = new RegExp(pattern, 'gi');
        cleanText = cleanText.replace(nameRegex, ' ');
    }
    return cleanText.replace(/\s+/g, ' ').trim();
}

function extractKeywords(text, excludeNames = new Set()) {
    if (typeof window.nlp === 'undefined' || !text) return [];
    text = text.replace(/[\u2018\u2019`]/g, "'");
    let doc = window.nlp(text);
    doc.match('#Contraction').remove();
    doc.match('#Expression').remove();
    text = doc.text().replace(/[-–—_*]+/g, ' ');

    const wordsInText = text.split(/\s+/).length;
    if (wordsInText < 100) return [];
    
    const limit = 5 + Math.floor((wordsInText - 100) / 100) * 3;
    const finalKeywords = new Set();

    doc = window.nlp(text);
    doc.match('#Expression').remove();
    doc.match('#Contraction').remove();

    const processTerm = (term) => {
        const cleaned = term.toLowerCase().replace(/[^a-z]/g, "");
        if (cleaned && cleaned.length > 2 && !excludeNames.has(cleaned) && !keywordBlacklist.has(cleaned) &&
            !window.nlp(cleaned).has('#Verb') && !window.nlp(cleaned).has('#Pronoun') && window.nlp(cleaned).has('#Noun')) {
            finalKeywords.add(cleaned);
        }
    };
    const potentialSources = [...doc.topics().out('array'), ...doc.quotations().out('array')];
    for (const source of potentialSources) {
        source.split(/[^a-zA-Z0-9]+/).forEach(processTerm);
    }
    return Array.from(finalKeywords).slice(0, limit);
}

function extractProperNouns(text, excludeNames) {
    if (excludeNames === undefined) excludeNames = new Set();
    if (!text || typeof text !== 'string') return [];
    const properNouns = new Set();
    const sentences = text.split(/[.!?*]+|["'"]\s*/);
    for (let i = 0; i < sentences.length; i++) {
        let sentence = sentences[i].trim().replace(/[-–—_*]+/g, ' ');
        if (!sentence) continue;
        const words = sentence.split(/\s+/);
        for (let j = 0; j < words.length; j++) {
            const word = words[j];
            if (j > 0 && /^[A-Z]/.test(word)) {
                const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
                if (cleaned && cleaned.length > 2 && !excludeNames.has(cleaned) && !keywordBlacklist.has(cleaned)) {
                    properNouns.add(cleaned);
                }
            }
        }
    }
    return Array.from(properNouns);
}

function extractTopicTerms(topic, excludeNames = new Set()) {
    if (!topic || typeof topic !== 'string') return [];
    const userBlacklist = getUserBlacklistSet();
    const tokens = topic.replace(/[\u2018\u2019`]/g, "'").toLowerCase().split(/[^a-z0-9]+/g).map(t => t.trim()).filter(Boolean);
    const out = [];
    for (const t of tokens) {
        if (t.length < 3 || t.length > 30 || excludeNames.has(t) || userBlacklist.has(t) || keywordBlacklist.has(t)) continue;
        out.push(t);
    }
    return Array.from(new Set(out));
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

function getParticipantNames(messages) {
    const names = new Set();
    if (messages && Array.isArray(messages)) {
        messages.forEach(msg => { if (msg?.name) names.add(msg.name.toLowerCase()); });
    }
    let context = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
    else if (typeof getContext === 'function') context = getContext();
    if (context) {
        if (context.name1) names.add(context.name1.toLowerCase());
        if (context.name2) names.add(context.name2.toLowerCase());
        if (context.characterId && typeof characters !== 'undefined' && characters[context.characterId]?.data?.nickname) {
            names.add(characters[context.characterId].data.nickname.toLowerCase());
        }
    }
    return names;
}

// ===========================
// QDRANT & INDEXING
// ===========================

async function qdrantRequest(endpoint, method = 'GET', body = null) {
    const url = extensionSettings.qdrantLocalUrl + endpoint;
    const options = { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null };
    try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error('Qdrant error: ' + response.status + ' - ' + await response.text());
        return await response.json();
    } catch (error) { throw error; }
}

async function createPayloadIndex(collectionName) {
    try {
        await qdrantRequest('/collections/' + collectionName + '/index', 'PUT', { field_name: 'proper_nouns', field_schema: 'keyword' });
        console.log('[' + MODULE_NAME + '] Created payload index for proper_nouns on ' + collectionName);
        return true;
    } catch (error) {
        if (error.message && error.message.indexOf('already exists') !== -1) return true;
        return false;
    }
}

async function createCollection(collectionName, vectorSize) {
    try {
        await qdrantRequest('/collections/' + collectionName, 'PUT', { vectors: { size: vectorSize, distance: 'Cosine' } });
        await createPayloadIndex(collectionName);
    } catch (error) {
        if (!error.message.includes('already exists')) throw error;
        await createPayloadIndex(collectionName);
    }
}

async function deleteCollection(collectionName) {
    try {
        await qdrantRequest('/collections/' + collectionName, 'DELETE');
        return true;
    } catch (error) { return true; } // Ignore 404
}

async function countPoints(collectionName) {
    try { return (await qdrantRequest('/collections/' + collectionName)).result.points_count || 0; } catch (e) { return 0; }
}

async function upsertVectors(collectionName, points) {
    await qdrantRequest('/collections/' + collectionName + '/points?wait=true', 'PUT', { points: points });
}

async function deleteMessageByIndex(collectionName, chatIdHash, messageIndex) {
    try {
        await qdrantRequest('/collections/' + collectionName + '/points/delete?wait=true', 'POST', {
            filter: { must: [{ key: 'chat_id_hash', match: { value: chatIdHash } }, { key: 'message_index', match: { value: messageIndex } }] }
        });
    } catch (err) {}
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
        console.log('[' + MODULE_NAME + '] Keywords: ' + (properNouns.length > 0 ? properNouns.join(', ') : '(none)'));

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
        const denseResults = denseResp?.result || [];
        const rawFiltered = filteredResp?.result || [];
        
        let filteredResults = [];
        if (rawFiltered.length > 0) {
            filteredResults = rawFiltered.filter(r => (r.payload?.proper_nouns || []).some(n => properNouns.includes(n)));
        }

        const seenIds = new Set();
        const finalResults = [];

        // Interleave results
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
        return finalResults;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Hybrid search failed:', error);
        return [];
    }
}

async function retrieveContext(queryText, chatId, isGroupChat = false) {
    try {
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatId;
        const queryVector = await generateEmbedding(queryText);

        let ctx = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
        else if (typeof getContext === 'function') ctx = getContext();

        const chatLength = ctx?.chat?.length || 0;
        const maxIndex = Math.max(0, chatLength - (extensionSettings.excludeLastMessages || 0));
        
        const participantNames = getParticipantNames(null);
        const textForKeywords = sanitizeTextForKeywords(queryText, participantNames);
        const queryFilterTerms = extractQueryFilterTerms(textForKeywords, participantNames);

        const results = await searchVectors(
            collectionName, queryVector, extensionSettings.retrievalCount || 5, 
            extensionSettings.similarityThreshold || 0.7, queryFilterTerms, maxIndex
        );

        if (results.length === 0) return null;

        let currentTotalTokens = 0;
        const contextParts = [];
        const tokenBudget = extensionSettings.maxTokenBudget || 1000;
        let budgetHit = false;

        for (const result of results) {
            const p = result.payload;
            let text = `\n[Character: ${p.character_name}]\n[Time: ${p.timestamp}]`;
            if(p.summary) text += `\n[Summary: ${p.summary}]`;
            text += `\n${p.full_message}`;

            const estimatedTokens = Math.ceil(text.length / 4);
            if (currentTotalTokens + estimatedTokens > tokenBudget) {
                budgetHit = true;
                break;
            }
            contextParts.push(text);
            currentTotalTokens += estimatedTokens;
        }
        
        if (budgetHit) console.log(`[${MODULE_NAME}] Token budget hit (${currentTotalTokens}/${tokenBudget})`);
        return contextParts.join('\n\n');
    } catch (error) { return null; }
}

// ===========================
// EMBEDDINGS
// ===========================

async function generateEmbedding(textOrArray) {
    const isArray = Array.isArray(textOrArray);
    const texts = isArray ? textOrArray : [textOrArray];
    const provider = extensionSettings.embeddingProvider || 'kobold';
    
    if (provider === 'kobold') {
        const response = await fetch(extensionSettings.koboldUrl + '/api/v1/embeddings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: texts, model: "text-embedding-ada-002" })
        });
        if (!response.ok) throw new Error('Kobold error');
        const data = await response.json();
        return isArray ? data.data.map(d => d.embedding) : data.data[0].embedding;
    } else if (provider === 'ollama') {
        const results = [];
        for (const text of texts) {
            const response = await fetch(extensionSettings.ollamaUrl + '/api/embeddings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: extensionSettings.ollamaModel, prompt: text })
            });
            const data = await response.json();
            results.push(data.embedding);
        }
        return isArray ? results : results[0];
    } else if (provider === 'openai') {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + extensionSettings.openaiApiKey },
            body: JSON.stringify({ model: extensionSettings.openaiModel, input: texts })
        });
        const data = await response.json();
        return isArray ? data.data.map(d => d.embedding) : data.data[0].embedding;
    }
}

// ===========================
// DATA PROCESSING
// ===========================

function convertTextToJSONL(text) {
    const lines = [JSON.stringify({ chat_metadata: { chat_id_hash: Date.now().toString() } })];
    text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length).forEach(row => {
        lines.push(JSON.stringify({ name: 'User', mes: row, is_user: true, tracker: {}, extra: {}, present: [] }));
    });
    return lines.join('\n');
}

function convertChatToJSONL(context) {
    if (!context || !context.chat) return '';
    const chatId = (context.chatMetadata && context.chatMetadata.chat_id_hash) || context.chat_id || Date.now().toString();
    const lines = [JSON.stringify({ chat_metadata: { chat_id_hash: chatId, ...(context.chatMetadata || {}) } })];
    context.chat.forEach(msg => { if(msg?.mes) lines.push(JSON.stringify(msg)); });
    return lines.join('\n');
}

function parseJSONL(jsonlContent) {
    const lines = jsonlContent.trim().split('\n');
    const messages = [];
    let chatMetadata = null;
    lines.forEach(line => {
        if (!line.trim()) return;
        try {
            const parsed = JSON.parse(line);
            if (parsed.chat_metadata) chatMetadata = parsed.chat_metadata;
            else if (parsed.mes) messages.push(parsed);
        } catch (e) {}
    });
    return { chatMetadata, messages };
}

function buildEmbeddingText(message, tracker) {
    const parts = ['[Character: ' + message.name + ']'];
    if (tracker) {
        if (tracker.Time) parts.push('[Time: ' + tracker.Time + ']');
        if (tracker.Topics?.PrimaryTopic) parts.push('[Topic: ' + tracker.Topics.PrimaryTopic + ']');
        if (tracker.Topics?.EmotionalTone) parts.push('[Tone: ' + tracker.Topics.EmotionalTone + ']');
    }
    const summary = (message?.extra?.qvink_memory?.memory);
    if (summary) parts.push('\nSummary: ' + summary);
    parts.push('\nMessage: ' + message.mes);
    return parts.join(' ');
}

function extractPayload(message, messageIndex, chatIdHash, participantNames) {
    const tracker = message.tracker || {};
    let charactersPresent = (message.present && Array.isArray(message.present))
        ? message.present.map(avatar => avatar.replace(/\.png$/, ''))
        : (tracker.CharactersPresent || []);

    if (message.name && message.name !== 'User' && !charactersPresent.some(cp => String(cp).toLowerCase() === String(message.name).toLowerCase())) {
        charactersPresent.push(message.name);
    }

    const normalizedMessage = (message.mes || '').replace(/(\w)\*+(\w)/g, '$1 $2');
    const textForKeywords = sanitizeTextForKeywords(normalizedMessage, participantNames);
    const properNounCandidates = extractProperNouns(textForKeywords, participantNames);
    const commonKeywordCandidates = extractKeywords(textForKeywords, participantNames);
    const allKeywords = new Set([...properNounCandidates, ...commonKeywordCandidates]);
    
    const trackerTopic = (tracker.Topics?.PrimaryTopic) || (tracker.Topic) || '';
    extractTopicTerms(trackerTopic, participantNames).forEach(t => allKeywords.add(t));

    return {
        chat_id_hash: chatIdHash,
        message_index: messageIndex,
        character_name: message.name,
        is_user: !!message.is_user,
        timestamp: message.send_date || '',
        summary: (message?.extra?.qvink_memory?.memory) || "",
        full_message: message.mes,
        characters_present: charactersPresent,
        topic: trackerTopic,
        emotional_tone: (tracker.Topics?.EmotionalTone) || '',
        location: (tracker.Characters?.[message.name]?.Location) || '',
        proper_nouns: Array.from(allKeywords)
    };
}

function getQueryMessage(context, idxOverride, generationType) {
    if (idxOverride !== undefined && idxOverride !== null && idxOverride >= 0) return context.chat[idxOverride];
    let lastMsgIdx = -1;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i]?.mes && !context.chat[i].is_system) { lastMsgIdx = i; break; }
    }
    if (lastMsgIdx === -1) return null;
    const isSwipe = generationType === 'swipe' || generationType === 'regenerate';
    if (isSwipe && !context.chat[lastMsgIdx].is_user) {
        // Grab previous if swiping bot
        for (let i = lastMsgIdx - 1; i >= 0; i--) {
            if (context.chat[i]?.mes && !context.chat[i].is_system) return context.chat[i];
        }
    }
    return context.chat[lastMsgIdx];
}

function constructMultiMessageQuery(context, generationType) {
    const anchorMsg = getQueryMessage(context, null, generationType);
    if (!anchorMsg) return "";
    const count = extensionSettings.queryMessageCount || 1;
    const chat = context.chat;
    let currentIdx = chat.lastIndexOf(anchorMsg);
    if (currentIdx === -1) return anchorMsg.mes;

    const activeChar = (typeof characters !== 'undefined' && context.characterId) ? characters[context.characterId].name : context.name2;
    const isGroup = !!context.groupId;
    const collectedText = [];
    let messagesFound = 0;

    while (messagesFound < count && currentIdx >= 0) {
        const msg = chat[currentIdx];
        if (msg.is_system) { currentIdx--; continue; }
        let isVisible = true;
        if (isGroup && activeChar) {
            const present = (msg.present || msg.characters_present || []).map(n => String(n).toLowerCase());
            if (msg.name !== activeChar && present.length > 0 && !present.includes(activeChar.toLowerCase())) isVisible = false;
        }
        if (isVisible && msg.mes) { collectedText.unshift(msg.mes); messagesFound++; }
        currentIdx--;
    }
    let query = collectedText.join('\n');
    if (extensionSettings.trackerEnabled && window.RagTrackerState.topic !== "None") {
        query += `\n[Topic: ${window.RagTrackerState.topic}]`;
    }
    return query;
}

// ===========================
// MAIN ACTIONS
// ===========================

function getCurrentChatId() {
    let ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
    return ctx?.chatMetadata?.chat_id_hash || ctx?.chatId || ctx?.chat_id || null;
}
function isCurrentChatGroupChat() {
    let ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
    return !!ctx?.groupId;
}

async function indexChat(jsonlContent, chatIdHash, isGroupChat = false) {
    if (isIndexing) return;
    isIndexing = true;
    shouldStopIndexing = false;
    showStopButton();
    updateUI('status', 'Preparing...');
    try {
        const { messages } = parseJSONL(jsonlContent);
        if (messages.length === 0) throw new Error('No messages');
        
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;
        if (await countPoints(collectionName) >= messages.length) {
            updateUI('status', 'Already indexed');
            isIndexing = false; hideStopButton(); return;
        }
        
        const dim = (await generateEmbedding("test")).length;
        await createCollection(collectionName, dim);
        
        const participantNames = getParticipantNames(messages);
        const BATCH_SIZE = 10;
        let points = [];
        
        for (let i = 0; i < messages.length; i++) {
            if (shouldStopIndexing) break;
            const msg = messages[i];
            const emb = await generateEmbedding(buildEmbeddingText(msg, msg.tracker));
            points.push({ 
                id: generateUUID(), vector: emb, 
                payload: extractPayload(msg, i, chatIdHash, participantNames) 
            });
            lastKnownSummaries.set(i, msg?.extra?.qvink_memory?.memory || "");
            
            if (points.length >= BATCH_SIZE || i === messages.length - 1) {
                await upsertVectors(collectionName, points);
                points = [];
                updateUI('status', `Indexing ${i+1}/${messages.length}`);
            }
        }
        updateUI('status', 'Complete');
    } catch (e) { updateUI('status', 'Error: ' + e.message); }
    isIndexing = false; hideStopButton();
}

async function indexSingleMessage(message, chatIdHash, messageIndex, isGroupChat = false) {
    try {
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;
        await deleteMessageByIndex(collectionName, chatIdHash, messageIndex);
        const emb = await generateEmbedding(buildEmbeddingText(message, message.tracker));
        const participantNames = getParticipantNames(null);
        await upsertVectors(collectionName, [{
            id: generateUUID(), vector: emb,
            payload: extractPayload(message, messageIndex, chatIdHash, participantNames)
        }]);
        lastKnownSummaries.set(messageIndex, message?.extra?.qvink_memory?.memory || "");
        return true;
    } catch (e) { return false; }
}

async function forceReindexCurrentChat() {
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const isGroup = isCurrentChatGroupChat();
    const collectionName = (isGroup ? 'st_groupchat_' : 'st_chat_') + chatId;
    updateUI('status', 'Rebuilding...');
    await deleteCollection(collectionName);
    currentChatIndexed = false;
    indexedMessageIds.clear();
    lastKnownSummaries.clear();
    
    let ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
    await indexChat(convertChatToJSONL(ctx), chatId, isGroup);
    currentChatIndexed = true;
}

// ===========================
// UI & SETUP
// ===========================

function injectTrackerCSS() {
    if (document.getElementById('rag-tracker-styles')) return;
    const css = `.ft-tracker-display{display:block;margin:0 0 12px 0;width:100%;background-color:rgba(20,20,20,0.6);border:2px solid var(--SmartThemeBorderColor);border-radius:8px;font-family:'Segoe UI',sans-serif;font-size:0.75em;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.2)}.ft-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background-color:rgba(255,255,255,0.1)}.ft-cell{background-color:var(--SmartThemeChatTintColor,#1e1e1e);padding:5px 10px;display:flex;flex-direction:column;justify-content:center}.ft-cell.full-width{grid-column:span 2}.ft-label{text-transform:uppercase;font-weight:700;font-size:0.85em;opacity:0.6;margin-bottom:2px}.ft-val{font-weight:500;color:var(--SmartThemeBodyColor);line-height:1.3}`;
    const style = document.createElement('style');
    style.id = 'rag-tracker-styles'; style.textContent = css;
    document.head.appendChild(style);
}

function updateUI(el, val) { const e = document.getElementById('ragfordummies_'+el); if(e) { if(el==='status')e.textContent=val; else e.value=val; } }
function showStopButton() { document.getElementById('ragfordummies_stop_indexing')?.classList.add('active'); }
function hideStopButton() { document.getElementById('ragfordummies_stop_indexing')?.classList.remove('active'); }

function createSettingsUI() {
    return `
    <div id="ragfordummies_container" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>RagForDummies</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <div class="ragfordummies-settings">
                <div class="ragfordummies-section"><label class="checkbox_label"><input type="checkbox" id="ragfordummies_enabled" ${extensionSettings.enabled ? 'checked' : ''} />Enable RAG</label></div>
                <!-- FUCK TRACKER -->
                <div class="ragfordummies-section">
                    <div id="rag_tracker_drawer" class="inline-drawer">
                        <div class="inline-drawer-toggle inline-drawer-header"><b>Fuck Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div></div>
                        <div class="inline-drawer-content">
                            <label class="checkbox_label"><input type="checkbox" id="ragfordummies_tracker_enabled" ${extensionSettings.trackerEnabled ? 'checked' : ''} />Enable Tracking</label>
                            <label class="checkbox_label"><input type="checkbox" id="ragfordummies_tracker_inline" ${extensionSettings.trackerInline ? 'checked' : ''} />Show Header</label>
                            <div class="flex-container"><label>Context Depth</label><input type="number" id="ragfordummies_tracker_context_depth" class="text_pole" value="${extensionSettings.trackerContextDepth}"></div>
                            <div style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;">
                                <div style="font-weight:700;margin-bottom:6px;">Fields</div><div id="ft_fields_container"></div><button class="menu_button" id="ft_add_field_btn">+ Add</button>
                            </div>
                            <div style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;">
                                <div style="font-weight:700;">Time</div>
                                <div class="flex-container"><label>Start</label><input type="datetime-local" id="ragfordummies_tracker_start_date" class="text_pole" value="${extensionSettings.trackerStartDate}"></div>
                                <div class="flex-container"><label>Step (min)</label><input type="number" id="ragfordummies_tracker_time_step" class="text_pole" value="${extensionSettings.trackerTimeStep}"></div>
                                <div class="flex-container"><label>Manual</label><input type="datetime-local" id="ft_manual_time" class="text_pole"><button class="menu_button" id="ft_manual_time_apply">Set</button></div>
                                <div><small>Current: <span id="ft_time_preview">${window.RagTrackerState.time}</span></small></div>
                            </div>
                            <div id="ft_debug_time" style="margin-top:8px;font-size:0.85em;opacity:0.7;"></div>
                        </div>
                    </div>
                </div>
                <!-- RAG SETTINGS -->
                <div class="ragfordummies-section"><label>Qdrant URL</label><input type="text" id="ragfordummies_qdrant_url" class="text_pole" value="${extensionSettings.qdrantLocalUrl}"></div>
                <div class="ragfordummies-section"><label>Provider</label><select id="ragfordummies_embedding_provider" class="text_pole"><option value="kobold" ${extensionSettings.embeddingProvider==='kobold'?'selected':''}>Kobold</option><option value="ollama" ${extensionSettings.embeddingProvider==='ollama'?'selected':''}>Ollama</option><option value="openai" ${extensionSettings.embeddingProvider==='openai'?'selected':''}>OpenAI</option></select></div>
                <div id="kobold_settings" style="${extensionSettings.embeddingProvider==='kobold'?'':'display:none'}"><label>Kobold URL</label><input type="text" id="ragfordummies_kobold_url" class="text_pole" value="${extensionSettings.koboldUrl}"></div>
                <div id="ollama_settings" style="${extensionSettings.embeddingProvider==='ollama'?'':'display:none'}"><label>Ollama URL</label><input type="text" id="ragfordummies_ollama_url" class="text_pole" value="${extensionSettings.ollamaUrl}"><label>Model</label><input type="text" id="ragfordummies_ollama_model" class="text_pole" value="${extensionSettings.ollamaModel}"></div>
                <div id="openai_settings" style="${extensionSettings.embeddingProvider==='openai'?'':'display:none'}"><label>API Key</label><input type="password" id="ragfordummies_openai_key" class="text_pole" value="${extensionSettings.openaiApiKey}"><label>Model</label><input type="text" id="ragfordummies_openai_model" class="text_pole" value="${extensionSettings.openaiModel}"></div>
                <div class="ragfordummies-section"><label>Retrieval Count</label><input type="number" id="ragfordummies_retrieval_count" class="text_pole" value="${extensionSettings.retrievalCount}"></div>
                <div class="ragfordummies-section"><label>Similarity</label><input type="number" id="ragfordummies_similarity" class="text_pole" value="${extensionSettings.similarityThreshold}" step="0.05"></div>
                <div class="ragfordummies-section"><label>Token Budget</label><input type="number" id="ragfordummies_max_token_budget" class="text_pole" value="${extensionSettings.maxTokenBudget}"></div>
                <div class="ragfordummies-section"><label class="checkbox_label"><input type="checkbox" id="ragfordummies_auto_index" ${extensionSettings.autoIndex?'checked':''} /> Auto-index</label></div>
                <div class="ragfordummies-section"><label class="checkbox_label"><input type="checkbox" id="ragfordummies_inject" ${extensionSettings.injectContext?'checked':''} /> Inject Context</label></div>
                <div class="ragfordummies-section">
                    <button class="menu_button" id="ragfordummies_index_btn">Index Chat</button>
                    <button class="menu_button" id="ragfordummies_force_reindex">Force Re-index</button>
                    <button class="menu_button" id="ragfordummies_stop_indexing" style="display:none">Stop</button>
                </div>
                <div class="ragfordummies-section">
                    <hr style="margin:10px 0;border-color:var(--SmartThemeBorderColor)">
                    <label class="checkbox_label"><input type="checkbox" id="ragfordummies_merge_upload" checked> Merge Uploads</label>
                    <button class="menu_button" id="ragfordummies_upload_btn">Upload File</button>
                    <input type="file" id="ragfordummies_file_input" style="display:none">
                </div>
                <div class="ragfordummies-section"><span id="ragfordummies_status">Ready</span></div>
            </div>
        </div>
    </div>`;
}

function attachListeners() {
    const bind = (id, key, type='val') => {
        const el = document.getElementById('ragfordummies_'+id);
        if(!el) return;
        el.addEventListener('change', (e) => {
            if(type==='chk') extensionSettings[key] = e.target.checked;
            else if(type==='int') extensionSettings[key] = parseInt(e.target.value);
            else if(type==='float') extensionSettings[key] = parseFloat(e.target.value);
            else extensionSettings[key] = e.target.value;
            localStorage.setItem(MODULE_NAME+'_settings', JSON.stringify(extensionSettings));
            if(key.includes('tracker')) window.RagTrackerState.initClockFromSettingsAndChat();
        });
    };
    bind('enabled', 'enabled', 'chk');
    bind('tracker_enabled', 'trackerEnabled', 'chk');
    bind('tracker_inline', 'trackerInline', 'chk');
    bind('tracker_context_depth', 'trackerContextDepth', 'int');
    bind('tracker_start_date', 'trackerStartDate');
    bind('tracker_time_step', 'trackerTimeStep', 'int');
    bind('qdrant_url', 'qdrantLocalUrl');
    bind('embedding_provider', 'embeddingProvider');
    bind('kobold_url', 'koboldUrl');
    bind('ollama_url', 'ollamaUrl'); bind('ollama_model', 'ollamaModel');
    bind('openai_key', 'openaiApiKey'); bind('openai_model', 'openaiModel');
    bind('retrieval_count', 'retrievalCount', 'int');
    bind('similarity', 'similarityThreshold', 'float');
    bind('max_token_budget', 'maxTokenBudget', 'int');
    bind('auto_index', 'autoIndex', 'chk');
    bind('inject', 'injectContext', 'chk');

    document.getElementById('ragfordummies_embedding_provider').addEventListener('change', (e) => {
        ['kobold','ollama','openai'].forEach(p => document.getElementById(p+'_settings').style.display = e.target.value===p?'':'none');
    });

    document.getElementById('ragfordummies_index_btn').addEventListener('click', async () => {
        const ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
        if(ctx?.chat?.length) await indexChat(convertChatToJSONL(ctx), getCurrentChatId(), isCurrentChatGroupChat());
    });
    document.getElementById('ragfordummies_force_reindex').addEventListener('click', () => {
        if(confirm("Rebuild index?")) forceReindexCurrentChat();
    });
    document.getElementById('ragfordummies_stop_indexing').addEventListener('click', () => shouldStopIndexing = true);

    const upBtn = document.getElementById('ragfordummies_upload_btn');
    const fileIn = document.getElementById('ragfordummies_file_input');
    if(upBtn && fileIn) {
        upBtn.addEventListener('click', () => fileIn.click());
        fileIn.addEventListener('change', async (e) => {
            const f = e.target.files[0];
            if(!f) return;
            updateUI('status', 'Reading...');
            const txt = await f.text();
            const merge = document.getElementById('ragfordummies_merge_upload').checked;
            let id = merge ? getCurrentChatId() : 'upload_'+Date.now();
            if(!id && merge) { updateUI('status', 'No chat'); return; }
            const jsonl = f.name.endsWith('.txt') ? convertTextToJSONL(txt) : txt;
            await indexChat(jsonl, id, merge ? isCurrentChatGroupChat() : false);
            fileIn.value = '';
        });
    }

    // Tracker Field UI
    const refreshFields = () => {
        const c = document.getElementById('ft_fields_container');
        c.innerHTML = '';
        extensionSettings.trackerFields.forEach((f,i) => {
            const div = document.createElement('div');
            div.style.cssText = "display:grid;grid-template-columns:1fr 2fr 2fr 1fr auto;gap:4px;margin-bottom:4px;";
            div.innerHTML = `
                <input class="text_pole t-title" data-i="${i}" value="${f.title}" ${f.locked?'disabled':''}>
                <input class="text_pole t-p" data-i="${i}" value="${f.prompt}" ${f.locked?'disabled':''}>
                <input class="text_pole t-ex" data-i="${i}" value="${f.examples}" ${f.locked?'disabled':''}>
                <input class="text_pole t-val" data-i="${i}" value="${window.RagTrackerState.fields[f.title]||(f.title==='Location'?window.RagTrackerState.location:(f.title==='Topic'?window.RagTrackerState.topic:''))}">
                <button class="menu_button t-del" data-i="${i}" ${f.locked?'disabled':''}>X</button>`;
            c.appendChild(div);
        });
        document.getElementById('ft_time_preview').textContent = window.RagTrackerState.time;
    };
    refreshFields();
    
    document.getElementById('ft_add_field_btn').addEventListener('click', () => {
        extensionSettings.trackerFields.push({title:"",prompt:"",examples:"",locked:false});
        localStorage.setItem(MODULE_NAME+'_settings', JSON.stringify(extensionSettings));
        refreshFields();
    });
    document.getElementById('ft_fields_container').addEventListener('change', (e) => {
        if(e.target.classList.contains('text_pole')) {
            const i = e.target.getAttribute('data-i');
            const f = extensionSettings.trackerFields[i];
            if(e.target.classList.contains('t-title')) f.title=e.target.value;
            if(e.target.classList.contains('t-p')) f.prompt=e.target.value;
            if(e.target.classList.contains('t-ex')) f.examples=e.target.value;
            if(e.target.classList.contains('t-val')) {
                if(f.title==='Location') window.RagTrackerState.location=e.target.value;
                else if(f.title==='Topic') window.RagTrackerState.topic=e.target.value;
                else window.RagTrackerState.fields[f.title]=e.target.value;
                tracker_updateSettingsDebug();
            }
            localStorage.setItem(MODULE_NAME+'_settings', JSON.stringify(extensionSettings));
        }
    });
    document.getElementById('ft_fields_container').addEventListener('click', (e) => {
        if(e.target.classList.contains('t-del')) {
            extensionSettings.trackerFields.splice(e.target.getAttribute('data-i'), 1);
            localStorage.setItem(MODULE_NAME+'_settings', JSON.stringify(extensionSettings));
            refreshFields();
        }
    });
    document.getElementById('ft_manual_time_apply').addEventListener('click', () => {
        const v = document.getElementById('ft_manual_time').value;
        if(v) {
            window.RagTrackerState._clockMs = Date.parse(v);
            window.RagTrackerState.time = window.RagTrackerState.formatClock(window.RagTrackerState._clockMs);
            refreshFields();
        }
    });
}

function ft_getTextAccessor(obj) {
    if(!obj || typeof obj!=='object') return null;
    if(typeof obj.text==='string') return {get:()=>obj.text, set:(v)=>obj.text=v};
    if(typeof obj.mes==='string') return {get:()=>obj.mes, set:(v)=>obj.mes=v};
    if(obj.message?.text) return {get:()=>obj.message.text, set:(v)=>obj.message.text=v};
    if(obj.message?.mes) return {get:()=>obj.message.mes, set:(v)=>obj.message.mes=v};
    return null;
}

// ===========================
// INITIALIZATION
// ===========================

async function init() {
    const saved = localStorage.getItem(MODULE_NAME+'_settings');
    if(saved) extensionSettings = {...defaultSettings, ...JSON.parse(saved)};
    
    injectTrackerCSS();
    window.RagTrackerState.initClockFromSettingsAndChat();
    
    // Load NLP
    if(!window.nlp) {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/compromise';
        document.head.appendChild(s);
    }
    
    $('#extensions_settings').append(createSettingsUI());
    $('.inline-drawer-toggle').on('click', function(e){
        e.stopPropagation();
        $(this).find('.inline-drawer-icon').toggleClass('down up');
        $(this).next('.inline-drawer-content').slideToggle(200);
    });
    
    attachListeners();
    
    // Event Hooking
    const es = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext().eventSource : (typeof eventSource !== 'undefined' ? eventSource : null);
    if(es) {
        es.on('chat_loaded', onChatLoaded);
        es.on('message_sent', onMessageSent);
        es.on('message_received', onMessageReceived);
        es.on('message_swiped', onMessageSwiped);
        es.on('message_deleted', onMessageDeleted);
        es.on('message_edited', onMessageEdited);
        es.on('chat_completion_processed', tracker_onReplyProcessed);
        es.on('character_message_rendered', onCharacterMessageRendered);
        const promptHook = (t) => {
            if(extensionSettings.injectContext) injectContextWithSetExtensionPrompt(t||'normal');
            if(extensionSettings.trackerEnabled) tracker_injectInstruction();
        };
        es.on('GENERATION_AFTER_COMMANDS', promptHook);
        es.on('generate_before_combine_prompts', () => promptHook('normal'));
        eventsRegistered = true;
    } else {
        usePolling = true;
    }

    if(extensionSettings.autoIndex) {
        if(pollingInterval) clearInterval(pollingInterval);
        pollingInterval = setInterval(async () => {
            if(isIndexing) return;
            const ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
            if(!ctx?.chat) return;
            const cid = getCurrentChatId();
            if(cid && cid!==lastChatId) { lastChatId=cid; currentChatIndexed=false; }
            if(!currentChatIndexed && cid) {
                await indexChat(convertChatToJSONL(ctx), cid, isCurrentChatGroupChat());
                currentChatIndexed=true;
            }
            // Auto-sync summaries
            ctx.chat.forEach((msg, i) => {
                const s = msg?.extra?.qvink_memory?.memory || "";
                if(lastKnownSummaries.has(i) && lastKnownSummaries.get(i)!==s) {
                    indexSingleMessage(msg, cid, i, isCurrentChatGroupChat());
                }
                lastKnownSummaries.set(i, s);
            });
        }, 3000);
    }
    
    updateUI('status', 'Loaded');
    console.log(`[${MODULE_NAME}] Ready.`);
}

function tracker_updateSettingsDebug() {
    const el = document.getElementById('ft_debug_time');
    if(el) el.innerHTML = `<b>Time:</b> ${window.RagTrackerState.time}<br><b>Loc:</b> ${window.RagTrackerState.location}`;
}

function ft_findMesElementByMesId(id) {
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(String(id))}"]`) || document.querySelector(`.mes[mesid="${CSS.escape(String(id))}"]`);
}

function tracker_injectInstruction() {
    if(!extensionSettings.trackerEnabled) return;
    const ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
    if(!ctx?.setExtensionPrompt) return;
    const depth = extensionSettings.trackerContextDepth || 10;
    const fields = extensionSettings.trackerFields.map(f=>`"${f.title}":"..."`).join(',\n');
    const guide = extensionSettings.trackerFields.map(f=>`- ${f.title}: ${f.prompt}`).join('\n');
    const prompt = `\n[SYSTEM INSTRUCTION: TRACKER]\nAnalyze last ${depth} messages. DO NOT output Time/Date.\nOutput hidden JSON block ⦗...⦘ at start.\nFormat:\n⦗\n{\n${fields}\n}\n⦘\nRules:\n${guide}`;
    ctx.setExtensionPrompt('RagTracker', prompt, 1, 0, true);
}

function ft_buildTrackerHtmlFromSnapshot(snap) {
    const s = snap || {};
    const st = window.RagTrackerState;
    const fields = {...st.fields, ...(s.rawData||{}), ...(s.fields||{})};
    const getV = (t) => {
        if(t==='Time & Date') return s.time || st.time;
        if(t==='Location') return s.location || st.location;
        if(t==='Topic') return s.topic || st.topic;
        const k = Object.keys(fields).find(k=>k.toLowerCase()===t.toLowerCase());
        return k ? fields[k] : "None";
    };
    const titles = ["Time & Date", "Location", "Topic", ...extensionSettings.trackerFields.map(f=>f.title)];
    const unique = [...new Set(titles)];
    const cells = unique.map(t => `<div class="ft-cell full-width"><div class="ft-label">${t}</div><div class="ft-val">${getV(t)}</div></div>`).join('');
    return `<div class="ft-tracker-display"><div class="ft-grid">${cells}</div></div>`;
}

async function onCharacterMessageRendered(arg) {
    if(!extensionSettings.trackerEnabled || !extensionSettings.trackerInline) return;
    const id = arg?.mesId ?? arg?.messageId;
    if(id==null || window.FuckTrackerSnapshots.swipesInProgress.has(String(id))) return;
    
    await new Promise(r=>setTimeout(r,100)); // wait for DOM
    const el = ft_findMesElementByMesId(id);
    if(!el || el.querySelector('.ft-tracker-display')) return;
    const txtEl = el.querySelector('.mes_text');
    if(!txtEl) return;

    let snap = window.FuckTrackerSnapshots.byMesId[String(id)];
    // Fallback: Check DOM for JSON if not in snapshot
    const match = txtEl.innerHTML.match(/⦗([\s\S]*?)⦘/);
    if(match) {
        try {
            const json = JSON.parse(match[1].replace(/<[^>]*>/g,'').replace(/&quot;/g,'"'));
            window.RagTrackerState.updateFromJSON(json);
            window.RagTrackerState.advanceClock();
            snap = { time: window.RagTrackerState.time, location: window.RagTrackerState.location, topic: window.RagTrackerState.topic, fields: {...window.RagTrackerState.fields}, rawData: json };
            window.FuckTrackerSnapshots.byMesId[String(id)] = snap;
        } catch(e) {}
        txtEl.innerHTML = txtEl.innerHTML.replace(match[0], '').trim();
    }
    txtEl.insertAdjacentHTML('beforebegin', ft_buildTrackerHtmlFromSnapshot(snap));
}

jQuery(() => setTimeout(init, 100));
