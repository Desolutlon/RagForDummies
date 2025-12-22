/**
 * RagForDummies + FuckTracker Integration (Final Merged Version with DOM Injection + Dynamic Tracker Fields)
 * A RAG extension for SillyTavern that actually works + Zero Latency State Tracking
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
    'injected successfully' // For the new DOM injection confirmation
];

// Allow detailed confirmations and hybrid search traces
const MODULE_LOG_ALLOW_SUBSTR = [
    'Indexed message',
    'Deleted existing point',
    'Delete:',
    'Swipe:',
    'Edit:',
    'HYBRID',
    'Run 1', 'Run 2',
    'Final', 'Score',
    'Collection:', 'Parameters:', 'Proper nouns',
    'validated results', 'dense', 'filtered',
    'Result', 'query filter', 'retrieved', 'retrieval', 'combined',
    'Query:',
    'Excluding',
    'Summary changed',
    'Qvlink Sync',
    'State Updated',
    'Prompt Injected',
    'Injected tracker header',
    'Snapshot'
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
// 1. GLOBAL TRACKER STATE (FuckTracker Engine V3 - JS clock + dynamic fields)
// =================================================================

/**
 * IMPORTANT:
 * - Time/Date is computed by JS per assistant message (AI output ignored).
 * - Location + Topic are required (AI-provided, used for hybrid search).
 * - Everything else is user-defined fields (titles) returned by the AI JSON.
 */
window.RagTrackerState = {
    // Computed time (NOT AI-guided)
    _clockMs: null, // epoch ms
    time: "Unknown",

    // Required fields (AI)
    location: "Unknown",
    topic: "None",

    // Optional convenience (still used by older UI/debug + potential user field)
    tone: "Neutral",

    // Dynamic fields store (everything else)
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

        // advance based on existing assistant messages (stable on reload)
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
        const suffix = isPm ? "p.m" : "a.m";
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

    // Applies parsed JSON to state (ignores AI time/date)
    updateFromJSON: function(data) {
        if (!data || typeof data !== 'object') return;

        if (typeof data.Location === 'string' && data.Location.trim()) this.location = data.Location.trim();
        if (typeof data.Topic === 'string' && data.Topic.trim()) this.topic = data.Topic.trim();

        if (typeof data.Tone === 'string' && data.Tone.trim()) this.tone = data.Tone.trim();

        // Dynamic: store everything except forbidden keys (AI must not guide time)
        const forbidden = new Set(["Time", "Date", "Datetime", "Day", "Clock"]);
        for (const [k, v] of Object.entries(data)) {
            if (forbidden.has(k)) continue;
            this.fields[k] = v;
        }

        tracker_updateSettingsDebug();
    },

    getFormattedDate: function() { return this.time; }
};

// Per-message snapshots so old messages don't show latest state
window.FuckTrackerSnapshots = {
    byMesId: Object.create(null),
    pending: [], // fallback if mesid isn't available at processing time
};

function ft_getMesIdFromEventArg(arg) {
    if (arg == null) return null;
    if (typeof arg === 'number' || typeof arg === 'string') return arg;

    if (typeof arg === 'object') {
        if (arg.mesid != null) return arg.mesid;
        if (arg.mesId != null) return arg.mesId;
        if (arg.messageId != null) return arg.messageId;
        if (arg.id != null) return arg.id;
    }
    return null;
}

function ft_escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ft_renderValue(v) {
    if (Array.isArray(v)) return v.join(', ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    if (v === null || v === undefined) return 'None';
    return String(v);
}

function ft_findMesElementByMesId(mesId) {
    const id = String(mesId);
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(id)}"]`)
        || document.querySelector(`.mes[mesid="${CSS.escape(id)}"]`);
}

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
    maxTokenBudget: 1000,
    queryMessageCount: 3,
    autoIndex: true,
    injectContext: true,
    injectionPosition: 'after_main',
    injectAfterMessages: 3,
    excludeLastMessages: 2,
    userBlacklist: '',

    // --- FUCK TRACKER SETTINGS ---
    trackerEnabled: true,
    trackerInline: true,
    trackerTimeStep: 15,
    trackerContextDepth: 10,
    trackerStartDate: new Date().toISOString().split('T')[0] + "T08:00",

    // NEW: user-configurable fields (Location/Topic required + locked)
    trackerFields: [
        {
            title: "Location",
            prompt: "Provide the current specific location in the format: Specific Place, Building, City, State.",
            examples: `["The Green Mill Lounge, Uptown, Chicago, Illinois"]`,
            locked: true,
            required: true,
        },
        {
            title: "Topic",
            prompt: "Provide a one- or two-word description of the main activity/event/subject driving the current scene's focus. Be specific and concise.",
            examples: `["Working Out"]`,
            locked: true,
            required: true,
        },
        {
            title: "Tone",
            prompt: "Describe the emotional tone in 1–3 words.",
            examples: `["Tense", "Playful"]`,
            locked: false,
            required: false,
        },
        {
            title: "CharactersPresent",
            prompt: "Array of active participants' nicknames. Put {{user}} first if present. Only active participants.",
            examples: `["{{user}}", "Al Capone"]`,
            locked: false,
            required: false,
        },
        {
            title: "CurrentAction",
            prompt: "Short description of posture + interaction (e.g., 'Standing at podium').",
            examples: `["Sitting at the desk, smoking a cigar"]`,
            locked: false,
            required: false,
        },
        {
            title: "Weather",
            prompt: "Scientific style (Temp C, wind, clouds). Match environment/time.",
            examples: `["22°C, light wind, overcast"]`,
            locked: false,
            required: false,
        },
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
const INJECTION_DEBOUNCE_MS = 1000;

// ===========================
// TRACKER CSS INJECTOR
// ===========================
function injectTrackerCSS() {
    const styleId = 'rag-tracker-styles';
    if (document.getElementById(styleId)) return;

    const css = `
        .ft-tracker-display {
            display: block;
            margin: 0 0 12px 0;
            width: 100%;
            background-color: rgba(20, 20, 20, 0.6);
            border: 2px solid var(--SmartThemeBorderColor);
            border-radius: 8px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: 0.75em;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0,0,0,0.2);
        }

        .ft-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 1px;
            background-color: rgba(255,255,255,0.1);
        }

        .ft-cell {
            background-color: var(--SmartThemeChatTintColor, #1e1e1e);
            padding: 5px 10px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }

        .ft-cell.full-width {
            grid-column: span 2;
        }

        .ft-label {
            text-transform: uppercase;
            font-weight: 700;
            font-size: 0.85em;
            opacity: 0.6;
            margin-bottom: 2px;
            letter-spacing: 0.5px;
        }

        .ft-val {
            font-weight: 500;
            color: var(--SmartThemeBodyColor);
            line-height: 1.3;
        }
    `;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
}

// ===========================
// TRACKER LOGIC
// ===========================

function tracker_initDate() {
    // Time/Date is now JS-driven via RagTrackerState.initClockFromSettingsAndChat()
}

function tracker_updateSettingsDebug() {
    const s = window.RagTrackerState;
    const el = document.getElementById('ft_debug_time');
    if (!el) return;

    el.innerHTML = `
        <b>Time:</b> ${ft_escapeHtml(s.time)}<br>
        <b>Loc:</b> ${ft_escapeHtml(s.location)}<br>
        <b>Topic:</b> ${ft_escapeHtml(s.topic)}
    `;
}

function ft_ensureRequiredFields() {
    let fields = Array.isArray(extensionSettings.trackerFields) ? extensionSettings.trackerFields : [];
    const hasLocation = fields.some(f => f?.title === "Location");
    const hasTopic = fields.some(f => f?.title === "Topic");

    if (!hasLocation) {
        fields.unshift({
            title: "Location",
            prompt: "Provide the current specific location in the format: Specific Place, Building, City, State.",
            examples: `["The Green Mill Lounge, Uptown, Chicago, Illinois"]`,
            locked: true,
            required: true,
        });
    }
    function ft_getTextAccessor(obj) {
    // Returns { get():string, set(v:string) } for whatever field ST used
    if (!obj || typeof obj !== 'object') return null;

    if (typeof obj.text === 'string') return { get: () => obj.text, set: (v) => { obj.text = v; } };
    if (typeof obj.mes === 'string') return { get: () => obj.mes, set: (v) => { obj.mes = v; } };
    if (typeof obj.message === 'string') return { get: () => obj.message, set: (v) => { obj.message = v; } };

    if (obj.message && typeof obj.message === 'object') {
        if (typeof obj.message.text === 'string') return { get: () => obj.message.text, set: (v) => { obj.message.text = v; } };
        if (typeof obj.message.mes === 'string') return { get: () => obj.message.mes, set: (v) => { obj.message.mes = v; } };
        if (typeof obj.message.content === 'string') return { get: () => obj.message.content, set: (v) => { obj.message.content = v; } };
    }

    if (typeof obj.content === 'string') return { get: () => obj.content, set: (v) => { obj.content = v; } };
    return null;
}

function ft_setClockMs(ms) {
    if (!Number.isFinite(ms)) return;
    window.RagTrackerState._clockMs = ms;
    window.RagTrackerState.time = window.RagTrackerState.formatClock(ms);
    tracker_updateSettingsDebug();
}

function ft_parseDatetimeLocalToMs(v) {
    // datetime-local yields "YYYY-MM-DDTHH:MM"
    if (!v || typeof v !== 'string') return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
}

function ft_setStateValueByTitle(title, value) {
    const t = String(title || '').trim();
    if (!t) return;

    if (t === 'Location') {
        window.RagTrackerState.location = String(value ?? '').trim() || 'Unknown';
    } else if (t === 'Topic') {
        window.RagTrackerState.topic = String(value ?? '').trim() || 'None';
    } else if (t === 'Tone') {
        window.RagTrackerState.tone = String(value ?? '').trim() || 'Neutral';
        window.RagTrackerState.fields['Tone'] = window.RagTrackerState.tone;
    } else if (t === 'Time & Date') {
        // ignore here; time is set via the datetime-local control
    } else {
        window.RagTrackerState.fields[t] = value;
    }

    tracker_updateSettingsDebug();
}
    if (!hasTopic) {
        fields.splice(1, 0, {
            title: "Topic",
            prompt: "Provide a one- or two-word description of the main activity/event/subject driving the current scene's focus. Be specific and concise.",
            examples: `["Working Out"]`,
            locked: true,
            required: true,
        });
    }

    // Ensure required are locked
    fields = fields.map(f => {
        if (f?.title === "Location" || f?.title === "Topic") {
            return { ...f, locked: true, required: true };
        }
        return f;
    });

    extensionSettings.trackerFields = fields;
}

function ft_renderFieldsUI() {
    const container = document.getElementById('ft_fields_container');
    if (!container) return;

    const fields = Array.isArray(extensionSettings.trackerFields) ? extensionSettings.trackerFields : [];
    container.innerHTML = '';

    fields.forEach((f, idx) => {
        const title = f?.title ?? '';
        const prompt = f?.prompt ?? '';
        const examples = f?.examples ?? '';
        const locked = !!f?.locked;

        const row = document.createElement('div');
        row.className = 'ft-field-row';
        row.style.cssText = 'display:grid; grid-template-columns: 1fr 2fr 2fr auto; gap:6px; margin-bottom:6px; align-items:start;';

        row.innerHTML = `
          <input class="text_pole ft-field-title" data-idx="${idx}" placeholder="Title (e.g., Mood)" value="${ft_escapeHtml(title)}" ${locked ? 'disabled' : ''} />
          <textarea class="text_pole ft-field-prompt" data-idx="${idx}" rows="2" placeholder="Prompt for this field" ${locked ? 'disabled' : ''}>${ft_escapeHtml(prompt)}</textarea>
          <textarea class="text_pole ft-field-examples" data-idx="${idx}" rows="2" placeholder='Examples (e.g., ["Working Out"])' ${locked ? 'disabled' : ''}>${ft_escapeHtml(examples)}</textarea>
          <button class="menu_button ft-field-remove" data-idx="${idx}" style="padding:4px 8px; font-size:0.85em;" ${locked ? 'disabled' : ''}>X</button>
        `;

        container.appendChild(row);
    });
}

// ===========================
// Utility and NLP Functions
// ===========================

// --- The One, Master Blacklist to Rule Them All ---
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
    return new Set(
        extensionSettings.userBlacklist
            .toLowerCase()
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0)
    );
}

// Helper: topic tokens (used for keyword matching in hybrid search)
function extractTopicTerms(topic, excludeNames = new Set()) {
    if (!topic || typeof topic !== 'string') return [];
    const userBlacklist = getUserBlacklistSet();
    const tokens = topic
        .replace(/[\u2018\u2019`]/g, "'")
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map(t => t.trim())
        .filter(Boolean);

    const out = [];
    for (const t of tokens) {
        if (t.length < 3 || t.length > 30) continue;
        if (excludeNames.has(t)) continue;
        if (userBlacklist.has(t)) continue;
        if (keywordBlacklist.has(t)) continue;
        out.push(t);
    }
    return Array.from(new Set(out));
}

// HELPER: Aggressively strips names (and possessives) from text
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
    if (typeof window.nlp === 'undefined' || !text) {
        return [];
    }

    text = text.replace(/[\u2018\u2019`]/g, "'");

    let doc = window.nlp(text);
    doc.match('#Contraction').remove();
    doc.match('#Expression').remove();
    text = doc.text();

    text = text.replace(/[-–—_*]+/g, ' ');

    const wordsInText = text.split(/\s+/).length;
    if (wordsInText < 100) {
        return [];
    }

    const baseKeywords = 5;
    const scalingFactor = 3;
    const additionalKeywords = Math.floor((wordsInText - 100) / 100) * scalingFactor;
    const limit = baseKeywords + additionalKeywords;

    const finalKeywords = new Set();

    doc = window.nlp(text);
    doc.match('#Expression').remove();
    doc.match('#Contraction').remove();

    const processTerm = (term) => {
        const cleaned = term.toLowerCase().replace(/[^a-z]/g, "");

        if (
            cleaned && cleaned.length > 2 &&
            !excludeNames.has(cleaned) &&
            !keywordBlacklist.has(cleaned) &&
            !window.nlp(cleaned).has('#Verb') &&
            !window.nlp(cleaned).has('#Pronoun') &&
            window.nlp(cleaned).has('#Noun')
        ) {
            finalKeywords.add(cleaned);
        }
    };

    const topics = doc.topics().out('array');
    const quotes = doc.quotations().out('array');
    const potentialSources = [...topics, ...quotes];

    for (const source of potentialSources) {
        const words = source.split(/[^a-zA-Z0-9]+/);
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
        let sentence = sentences[i].trim();
        if (!sentence) continue;

        sentence = sentence.replace(/[-–—_*]+/g, ' ');

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

    if (!context) {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            context = SillyTavern.getContext();
        } else if (typeof getContext === 'function') {
            context = getContext();
        }
    } else if (Array.isArray(contextOrChat)) {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            context = SillyTavern.getContext();
        }
    }

    if (context) {
        if (context.name1) names.add(context.name1.toLowerCase());
        if (context.name2) names.add(context.name2.toLowerCase());

        if (typeof SillyTavern !== 'undefined' && SillyTavern.user_name) names.add(SillyTavern.user_name.toLowerCase());

        if (context.characterId && typeof characters !== 'undefined' && characters[context.characterId]) {
            const charData = characters[context.characterId].data;
            if (charData && charData.nickname) {
                names.add(charData.nickname.toLowerCase());
            }
        }

        if (context.groups && context.groupId) {
            const group = context.groups.find(g => g.id === context.groupId);
            if (group && group.members) {
                group.members.forEach(member => {
                    if (member && member.name) {
                        names.add(member.name.toLowerCase());
                    }
                });
            }
        }

        const chatLog = Array.isArray(contextOrChat) ? contextOrChat : (context.chat || []);
        chatLog.forEach(msg => {
            if (msg.name && typeof msg.name === 'string') {
                names.add(msg.name.toLowerCase());
            }
        });
    }

    const nameParts = [];
    names.forEach(n => {
        const parts = n.split(/\s+/);
        if (parts.length > 1) {
            parts.forEach(p => {
                if (p.length >= 2) nameParts.push(p);
            });
        }
    });
    nameParts.forEach(p => names.add(p));

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
            name: msg.name || msg.character || 'Unknown',
            mes: msg.mes,
            is_user: !!msg.is_user || msg.role === 'user',
            is_system: !!msg.is_system,
            send_date: msg.send_date || msg.date || '',
            tracker: msg.tracker || {},
            extra: msg.extra || {},
            present: msg.present || msg.characters_present || []
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
    lastKnownSummaries.clear();
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

function getSummaryFromMsg(msg) {
    if (msg && msg.extra && msg.extra.qvink_memory && typeof msg.extra.qvink_memory.memory === 'string') {
        return msg.extra.qvink_memory.memory;
    }
    return "";
}

function buildEmbeddingText(message, tracker) {
    const parts = ['[Character: ' + message.name + ']'];
    if (tracker) {
        if (tracker.Time) parts.push('[Time: ' + tracker.Time + ']');
        if (tracker.Topics && tracker.Topics.PrimaryTopic) parts.push('[Topic: ' + tracker.Topics.PrimaryTopic + ']');
        if (tracker.Topics && tracker.Topics.EmotionalTone) parts.push('[Tone: ' + tracker.Topics.EmotionalTone + ']');
    }

    const summary = getSummaryFromMsg(message);
    if (summary) {
        parts.push('\nSummary: ' + summary);
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

    const normalizedMessage = (message.mes || '').replace(/(\w)\*+(\w)/g, '$1 $2');

    const textForKeywords = sanitizeTextForKeywords(normalizedMessage, participantNames);

    const properNounCandidates = extractProperNouns(textForKeywords, participantNames);
    const commonKeywordCandidates = extractKeywords(textForKeywords, participantNames);

    const allKeywords = new Set([...properNounCandidates, ...commonKeywordCandidates]);

    // 
    const trackerTopic =
        (tracker.Topics && tracker.Topics.PrimaryTopic) ||
        (tracker.Topic) ||
        '';
    const topicTerms = extractTopicTerms(trackerTopic, participantNames);
    topicTerms.forEach(t => allKeywords.add(t));

    const summary = getSummaryFromMsg(message);

    return {
        chat_id_hash: chatIdHash,
        message_index: messageIndex,
        character_name: message.name,
        is_user: !!message.is_user,
        timestamp: message.send_date || '',
        summary: summary,
        full_message: message.mes,
        characters_present: charactersPresent,
        topic: (tracker.Topics && tracker.Topics.PrimaryTopic) || '',
        emotional_tone: (tracker.Topics && tracker.Topics.EmotionalTone) || '',
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

/**
 * Constructs a query string from multiple messages.
 * Respects group chat presence logic.
 * NEW: Injects ONLY Topic (Location removed as requested).
 */
function constructMultiMessageQuery(context, generationType) {
    const anchorMsg = getQueryMessage(context, null, generationType);
    if (!anchorMsg) return "";

    const count = extensionSettings.queryMessageCount || 1;
    const chat = context.chat;
    const anchorIdx = chat.lastIndexOf(anchorMsg);
    if (anchorIdx === -1) return anchorMsg.mes;

    const activeChar = getActiveCharacterName();
    const isGroup = isCurrentChatGroupChat();
    const collectedText = [];

    let messagesFound = 0;
    let currentIdx = anchorIdx;
    while (messagesFound < count && currentIdx >= 0) {
        const msg = chat[currentIdx];
        if (msg.is_system) { currentIdx--; continue; }

        let isVisible = true;
        if (isGroup && activeChar) {
            const isSender = (msg.name === activeChar);
            const presentList = (msg.present || msg.characters_present || []).map(n => String(n).toLowerCase());
            const isPresent = presentList.includes(activeChar.toLowerCase());
            if (!isSender && presentList.length > 0 && !isPresent) isVisible = false;
        }

        if (isVisible && msg.mes) {
            collectedText.unshift(msg.mes);
            messagesFound++;
        }
        currentIdx--;
    }

    let query = collectedText.join('\n');

    // 
    if (extensionSettings.trackerEnabled) {
        const t = window.RagTrackerState;
        if (t && typeof t.topic === 'string' && t.topic.trim()) {
            query += `\n[Topic: ${t.topic.trim()}]`;
            console.log(`[${MODULE_NAME}] Enhanced Query with FuckTracker Topic: ${t.topic.trim()}`);
        }
    }

    return query;
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
            messages.forEach((msg, idx) => {
                lastKnownSummaries.set(idx, getSummaryFromMsg(msg));
            });
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

                lastKnownSummaries.set(messageIndex, getSummaryFromMsg(message));

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

        lastKnownSummaries.set(messageIndex, getSummaryFromMsg(message));

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

        // Dense vector keeps names
        const queryEmbedding = await generateEmbedding(query);

        // Keyword filter strips names
        const textForKeywords = sanitizeTextForKeywords(query, participantNames);
        const queryFilterTerms = extractQueryFilterTerms(textForKeywords, participantNames);

        // 
        // This preserves your existing query behavior but guarantees Topic participates in hybrid filtering.
        const topicTerms = extractTopicTerms(window.RagTrackerState?.topic, participantNames);
        const merged = new Set(queryFilterTerms);
        topicTerms.forEach(t => merged.add(t));
        const finalFilterTerms = Array.from(merged);

        if (finalFilterTerms.length > 0) {
            console.log('[' + MODULE_NAME + '] Query Keywords (Names Removed + Topic):', finalFilterTerms);
        }

        const results = await searchVectors(
            collectionName,
            queryEmbedding,
            extensionSettings.retrievalCount,
            extensionSettings.similarityThreshold,
            finalFilterTerms,
            maxIndex
        );

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

        let currentTotalTokens = 0;
        const contextParts = [];
        const tokenBudget = extensionSettings.maxTokenBudget || 1000;
        let budgetHit = false;

        for (const result of filteredByPresence) {
            const p = result.payload;
            const score = result.score;
            let text = `\n[Character: ${p.character_name}]\n[Time: ${p.timestamp}]\n[Relevance Score: ${score.toFixed(3)} (${result._source || 'unknown'})]`;
            if (p.summary) text += `\n\nSummary: ${p.summary}`;
            text += `\n\nFull Message: ${p.full_message}`;

            const estimatedTokens = Math.ceil(text.length / 4);

            if (currentTotalTokens + estimatedTokens > tokenBudget) {
                budgetHit = true;
                console.log('[' + MODULE_NAME + '] Token budget hit! Stopping addition of lower-scoring results.');
                break;
            }

            contextParts.push(text);
            currentTotalTokens += estimatedTokens;
        }

        if (budgetHit) {
            const warningMsg = `(RAG Budget reached! Only injecting ${contextParts.length} entries!)`;
            updateUI('status', '⚠️ ' + warningMsg);
            if (typeof toastr !== 'undefined') {
                toastr.warning(warningMsg, 'RagForDummies');
            }
        }

        const contextString = '\n\n========== RELEVANT PAST CONTEXT FROM RAG ==========\n' + contextParts.join('\n\n-------------------\n') + '\n\n========== END RAG CONTEXT ==========\n\n';
        console.log('[' + MODULE_NAME + '] Formatted context with full metadata (' + contextString.length + ' chars, approx ' + Math.ceil(contextString.length/4) + ' tokens)');
        return contextString;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Context retrieval failed:', error);
        return '';
    }
}
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
    lastKnownSummaries.clear();
    const chatId = getCurrentChatId();
    lastChatId = chatId;

    // Reset snapshots per chat
    window.FuckTrackerSnapshots.byMesId = Object.create(null);
    window.FuckTrackerSnapshots.pending = [];

    // Init tracker clock for this chat
    window.RagTrackerState.initClockFromSettingsAndChat();
    tracker_updateSettingsDebug();

    console.log('[' + MODULE_NAME + '] Chat loaded. Chat ID:', chatId);
    updateUI('status', 'Chat loaded - checking index...');
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        if (context && context.chat) {
            lastMessageCount = context.chat.length;
            context.chat.forEach((msg, idx) => {
                lastKnownSummaries.set(idx, getSummaryFromMsg(msg));
            });
        }
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
    lastKnownSummaries.delete(messageIndex);
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
            if (isIndexing) return;
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

            if (!eventsRegistered) {
                if (context.chat.length > lastMessageCount) {
                    for (let i = lastMessageCount; i < context.chat.length; i++) {
                        await indexSingleMessage(context.chat[i], chatId, i, isGroupChat);
                        indexedMessageIds.add(i);
                    }
                    lastMessageCount = context.chat.length;
                }
            } else {
                lastMessageCount = context.chat.length;
            }

            for (let i = 0; i < context.chat.length; i++) {
                const msg = context.chat[i];
                const currentSum = getSummaryFromMsg(msg);
                const knownSum = lastKnownSummaries.get(i);

                if (lastKnownSummaries.has(i) && currentSum !== knownSum) {
                    console.log('[' + MODULE_NAME + '] [Qvlink Sync] Summary changed for message ' + i + '. Re-indexing...');
                    updateUI('status', '↻ Syncing summary for msg #' + i);
                    lastKnownSummaries.set(i, currentSum);
                    const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatId;
                    await deleteMessageByIndex(collectionName, chatId, i);
                    await indexSingleMessage(msg, chatId, i, isGroupChat);

                    setTimeout(() => {
                        const statusEl = document.getElementById('ragfordummies_status');
                        if (statusEl && statusEl.textContent.indexOf('Syncing summary') !== -1) {
                            statusEl.textContent = 'Ready';
                        }
                    }, 2000);
                }
                else if (!lastKnownSummaries.has(i)) {
                    lastKnownSummaries.set(i, currentSum);
                }
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

    const queryText = constructMultiMessageQuery(context, generationType);
    if (!queryText) return;

    console.log('[' + MODULE_NAME + '] Generating query embedding for text: "' + queryText.substring(0, 100).replace(/\n/g, ' ') + '..."');

    const retrievedContext = await retrieveContext(queryText.substring(0, 2000), chatId, isCurrentChatGroupChat());
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

// ===========================
// LISTENERS (Tracker + RAG)
// ===========================

function buildFuckTrackerInstruction() {
    const contextDepth = extensionSettings.trackerContextDepth || 10;
    const fields = Array.isArray(extensionSettings.trackerFields) ? extensionSettings.trackerFields : [];

    const normalized = [...fields];
    const hasLocation = normalized.some(f => f?.title === "Location");
    const hasTopic = normalized.some(f => f?.title === "Topic");

    if (!hasLocation) normalized.unshift({
        title: "Location",
        prompt: "Provide the current specific location in the format: Specific Place, Building, City, State.",
        examples: `["The Green Mill Lounge, Uptown, Chicago, Illinois"]`,
        locked: true,
        required: true,
    });
    if (!hasTopic) normalized.splice(1, 0, {
        title: "Topic",
        prompt: "Provide a one- or two-word description of the main activity/event/subject driving the current scene's focus. Be specific and concise.",
        examples: `["Working Out"]`,
        locked: true,
        required: true,
    });

    const jsonKeys = normalized.map(f => `  "${f.title}": ""`).join(',\n');

    const fieldGuidance = normalized.map(f => {
        const title = f.title;
        const prompt = (f.prompt || "").trim();
        const examples = (f.examples || "").trim();

        return [
            `- ${title}:`,
            prompt ? `  Prompt: ${prompt}` : `  Prompt: (none)`,
            examples ? `  Examples: ${examples}` : `  Examples: (none)`,
        ].join('\n');
    }).join('\n');

    return `
\n[SYSTEM INSTRUCTION: FUCKTRACKER]
Analyze the last ${contextDepth} messages and the current scenario.

CRITICAL RULES:
- DO NOT output Time/Date fields. Time/Date are computed by the application and must not be invented.
- You MUST output a hidden JSON block between ⦗ and ⦘ at the very start of your response.
- After the JSON block, you MUST output the character's normal dialogue/response.
- Output ONLY the fields listed below. Do not add extra keys.

Output Format:
⦗
{
${jsonKeys}
}
⦘
(then the character dialogue)

Field Guidance:
${fieldGuidance}
`;
}

const tracker_injectInstruction = () => {
    if (!extensionSettings.trackerEnabled) return;

    let context = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
    else if (typeof getContext === 'function') context = getContext();

    if (!context || !context.setExtensionPrompt) return;

    const instruction = buildFuckTrackerInstruction();
    context.setExtensionPrompt('RagTracker', instruction, 1, 0, true);
    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Prompt Injected (dynamic fields).`);
};

const tracker_onReplyProcessed = (data) => {
    if (!extensionSettings.trackerEnabled) return data;
    if (!data || typeof data.text !== 'string') return data;

    const rawMsg = data.text;
    const regex = /⦗([\s\S]*?)⦘/;
    const match = rawMsg.match(regex);

    // Snapshot time for THIS assistant message before we advance clock
    if (!Number.isFinite(window.RagTrackerState._clockMs)) {
        window.RagTrackerState.initClockFromSettingsAndChat();
    }
    const messageTime = window.RagTrackerState.formatClock(window.RagTrackerState._clockMs);

    if (match) {
        const jsonStr = match[1];
        try {
            const parsedData = JSON.parse(jsonStr);

            window.RagTrackerState.updateFromJSON(parsedData);

            // snapshot for this message
            const snapshot = {
                time: messageTime,
                location: window.RagTrackerState.location,
                topic: window.RagTrackerState.topic,
                fields: { ...(window.RagTrackerState.fields || {}) },
            };

            const mesId = ft_getMesIdFromEventArg(data);
            if (mesId != null) {
                window.FuckTrackerSnapshots.byMesId[String(mesId)] = snapshot;
            } else {
                window.FuckTrackerSnapshots.pending.push(snapshot);
            }

            console.log(`[${MODULE_NAME}] [FUCKTRACKER] State Updated + Snapshot stored`);

            data.text = rawMsg.replace(regex, "").trim();
            if (data.text.length === 0) {
                data.text = "(AI failed to generate dialogue. Please regenerate.)";
            }
        } catch (e) {
            console.error(`[${MODULE_NAME}] [FUCKTRACKER] Failed to parse JSON:`, e);
            console.error(`[${MODULE_NAME}] [FUCKTRACKER] Raw JSON string:`, jsonStr);
            data.text = rawMsg.replace(regex, "").trim();
        }
    }

    // advance clock per assistant message (as requested)
    window.RagTrackerState.advanceClock();
    tracker_updateSettingsDebug();

    return data;
};

function ft_buildTrackerHtmlFromSnapshot(snapshot) {
    const time = snapshot?.time ?? window.RagTrackerState.time;
    const location = snapshot?.location ?? window.RagTrackerState.location;
    const topic = snapshot?.topic ?? window.RagTrackerState.topic;
    const fields = snapshot?.fields ?? window.RagTrackerState.fields ?? {};

    const settingsFields = Array.isArray(extensionSettings.trackerFields) ? extensionSettings.trackerFields : [];
    const orderedTitles = settingsFields.map(f => f?.title).filter(Boolean);

    const titles = [];
    const seen = new Set();
    for (const t of ["Time & Date", "Location", "Topic", ...orderedTitles]) {
        if (seen.has(t)) continue;
        seen.add(t);
        titles.push(t);
    }

    const getValForTitle = (title) => {
        if (title === "Time & Date") return time;
        if (title === "Location") return location;
        if (title === "Topic") return topic;
        return ft_renderValue(fields[title]);
    };

    // mix: first three full width; rest can be half width if you want later
    const cells = titles.map((title, idx) => {
        const full = (idx < 3) ? 'full-width' : 'full-width'; // keep full-width for readability
        return `
        <div class="ft-cell ${full}">
            <div class="ft-label">${ft_escapeHtml(title)}</div>
            <div class="ft-val">${ft_escapeHtml(getValForTitle(title))}</div>
        </div>`;
    }).join('\n');

    return `
<div class="ft-tracker-display" data-tracker="true">
  <div class="ft-grid">
    ${cells}
  </div>
</div>`;
}

// DOM injection hook
async function onCharacterMessageRendered(eventArg) {
    if (!extensionSettings.trackerEnabled || !extensionSettings.trackerInline) return;

    const mesId = ft_getMesIdFromEventArg(eventArg);
    if (mesId == null) return;

    const maxWaitMs = 2500;
    const start = Date.now();

    let mesEl = null;
    let mesTextEl = null;

    while (Date.now() - start < maxWaitMs) {
        mesEl = ft_findMesElementByMesId(mesId);
        if (mesEl) {
            if (mesEl.classList.contains('user_mes')) return;
            mesTextEl = mesEl.querySelector('.mes_text');
            if (mesTextEl) break;
        }
        await new Promise(r => setTimeout(r, 50));
    }

    if (!mesEl || !mesTextEl) {
        console.warn(`[${MODULE_NAME}] [FUCKTRACKER] Could not resolve DOM for mesid=${mesId}`, { eventArg });
        return;
    }

    if (mesEl.querySelector('.ft-tracker-display')) return;

    const key = String(mesId);
    let snapshot = window.FuckTrackerSnapshots.byMesId[key];
    if (!snapshot && window.FuckTrackerSnapshots.pending.length) {
        snapshot = window.FuckTrackerSnapshots.pending.shift();
        window.FuckTrackerSnapshots.byMesId[key] = snapshot;
    }

    const trackerHtml = ft_buildTrackerHtmlFromSnapshot(snapshot);

    // ✅ insert ABOVE dialogue (.mes_text) as separate block
    mesTextEl.insertAdjacentHTML('beforebegin', trackerHtml);

    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Injected tracker header for mesid=${mesId}`);
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

                    <!-- FUCK TRACKER SECTION -->
                    <div class="ragfordummies-section">
                        <div id="rag_tracker_drawer" class="inline-drawer">
                            <div class="inline-drawer-toggle inline-drawer-header"><b>Fuck Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div></div>
                            <div class="inline-drawer-content">
                                <label class="checkbox_label"><input type="checkbox" id="ragfordummies_tracker_enabled" ${extensionSettings.trackerEnabled ? 'checked' : ''} />Enable State Tracking</label>
                                <label class="checkbox_label"><input type="checkbox" id="ragfordummies_tracker_inline" ${extensionSettings.trackerInline ? 'checked' : ''} />Show Tracker Header</label>

                                <div class="flex-container">
                                    <label>Context Depth</label>
                                    <input type="number" id="ragfordummies_tracker_context_depth" class="text_pole" value="${extensionSettings.trackerContextDepth}" min="1" max="50">
                                    <small>How many recent messages the AI should analyze to infer changes.</small>
                                </div>

                                <div style="margin-top:10px; padding:8px; background:rgba(0,0,0,0.2); border-radius:6px;">
                                  <div style="font-weight:700; margin-bottom:6px;">Tracked Fields</div>

                                  <div id="ft_fields_container"></div>

                                  <button id="ft_add_field_btn" class="menu_button" style="margin-top:6px; padding:4px 8px; font-size:0.85em;">
                                    Add new field
                                  </button>

                                  <div style="margin-top:10px; padding:5px; background:rgba(0,0,0,0.25); border-radius:4px; font-family:monospace; font-size:0.8em;">
                                    <strong>Current State:</strong><br>
                                    <span id="ft_debug_time">Loading...</span>
                                  </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- END TRACKER -->

                    <div class="ragfordummies-section"><h4>Qdrant Configuration</h4><label><span>Local URL:</span><input type="text" id="ragfordummies_qdrant_local_url" value="${extensionSettings.qdrantLocalUrl}" placeholder="http://localhost:6333" /></label></div>
                    <div class="ragfordummies-section"><h4>Embedding Provider</h4><label><span>Provider:</span><select id="ragfordummies_embedding_provider"><option value="kobold" ${extensionSettings.embeddingProvider === 'kobold' ? 'selected' : ''}>KoboldCpp</option><option value="ollama" ${extensionSettings.embeddingProvider === 'ollama' ? 'selected' : ''}>Ollama</option><option value="openai" ${extensionSettings.embeddingProvider === 'openai' ? 'selected' : ''}>OpenAI</option></select></label><label id="ragfordummies_kobold_settings" style="${extensionSettings.embeddingProvider === 'kobold' ? '' : 'display:none'}"><span>KoboldCpp URL:</span><input type="text" id="ragfordummies_kobold_url" value="${extensionSettings.koboldUrl}" placeholder="http://localhost:11434" /></label><div id="ragfordummies_ollama_settings" style="${extensionSettings.embeddingProvider === 'ollama' ? '' : 'display:none'}"><label><span>Ollama URL:</span><input type="text" id="ragfordummies_ollama_url" value="${extensionSettings.ollamaUrl}" placeholder="http://localhost:11434" /></label><label><span>Ollama Model:</span><input type="text" id="ragfordummies_ollama_model" value="${extensionSettings.ollamaModel}" placeholder="nomic-embed-text" /></label></div><div id="ragfordummies_openai_settings" style="${extensionSettings.embeddingProvider === 'openai' ? '' : 'display:none'}"><label><span>OpenAI API Key:</span><input type="password" id="ragfordummies_openai_api_key" value="${extensionSettings.openaiApiKey}" placeholder="sk-..." /></label><label><span>OpenAI Model:</span><input type="text" id="ragfordummies_openai_model" value="${extensionSettings.openaiModel}" placeholder="text-embedding-3-small" /></label></div></div>
                    <div class="ragfordummies-section"><h4>RAG Settings</h4><label><span>Retrieval Count:</span><input type="number" id="ragfordummies_retrieval_count" value="${extensionSettings.retrievalCount}" min="1" max="20" /></label><label><span>Similarity Threshold:</span><input type="number" id="ragfordummies_similarity_threshold" value="${extensionSettings.similarityThreshold}" min="0" max="1" step="0.1" /></label><label><span>Query Context Messages:</span><input type="number" id="ragfordummies_query_message_count" value="${extensionSettings.queryMessageCount}" min="1" max="10" /><small style="opacity:0.7; display:block; margin-top:5px;">How many recent messages to combine for the search query. Higher = better topic understanding.</small></label><label><span>Context Budget (Tokens):</span><input type="number" id="ragfordummies_max_token_budget" value="${extensionSettings.maxTokenBudget || 1000}" min="100" max="5000" /><small style="opacity:0.7; display:block; margin-top:5px;">Budget for injected context. Lower budget = less context injected (least relevant information will be thrown away)</small></label><label><span>Exclude Recent Messages:</span><input type="number" id="ragfordummies_exclude_last_messages" value="${extensionSettings.excludeLastMessages}" min="0" max="10" /><small style="opacity:0.7; display:block; margin-top:5px;">Prevent RAG from fetching the messages currently in context (usually 2)</small></label><label class="checkbox_label"><input type="checkbox" id="ragfordummies_auto_index" ${extensionSettings.autoIndex ? 'checked' : ''} />Auto-index on first message</label><label class="checkbox_label"><input type="checkbox" id="ragfordummies_inject_context" ${extensionSettings.injectContext ? 'checked' : ''} />Inject context into prompt</label></div>
                    <div class="ragfordummies-section"><h4>Custom Keyword Blacklist</h4><label><span>Blacklisted Terms (comma-separated):</span><input type="text" id="ragfordummies_user_blacklist" value="${extensionSettings.userBlacklist || ''}" placeholder="baka, sweetheart, darling" /></label><small style="opacity:0.7; display:block; margin-top:5px;">Can be useful for things like pet names between you and your character appearing in the hybrid search. (Most likely not needed, as vector scoring takes care of this.) Do not touch unless you know what you're doing.</small></div>
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
        'openai_api_key', 'openai_model', 'retrieval_count', 'similarity_threshold', 'query_message_count', 'auto_index',
        'inject_context', 'injection_position', 'inject_after_messages', 'exclude_last_messages', 'user_blacklist',
        'max_token_budget',
        // Tracker settings
        'tracker_enabled', 'tracker_time_step', 'tracker_inline', 'tracker_start_date', 'tracker_context_depth'
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
                    if (element.checked && !pollingInterval) startPolling();
                    else if (!element.checked && pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
                }
                if (id === 'tracker_start_date') tracker_initDate();
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

    // Tracker fields UI wiring
    ft_ensureRequiredFields();
    ft_renderFieldsUI();

    document.getElementById('ft_add_field_btn')?.addEventListener('click', () => {
        ft_ensureRequiredFields();
        extensionSettings.trackerFields.push({
            title: "",
            prompt: "",
            examples: "",
            locked: false,
            required: false,
        });
        saveSettings();
        ft_renderFieldsUI();
    });

    document.getElementById('ft_fields_container')?.addEventListener('input', (e) => {
        const t = e.target;
        if (!t) return;

        const idx = Number(t.getAttribute('data-idx'));
        if (!Number.isFinite(idx)) return;

        const fields = extensionSettings.trackerFields;
        if (!Array.isArray(fields) || !fields[idx]) return;
        if (fields[idx].locked) return;

        if (t.classList.contains('ft-field-title')) fields[idx].title = t.value;
        if (t.classList.contains('ft-field-prompt')) fields[idx].prompt = t.value;
        if (t.classList.contains('ft-field-examples')) fields[idx].examples = t.value;

        saveSettings();
    });

    document.getElementById('ft_fields_container')?.addEventListener('click', (e) => {
        const btn = e.target;
        if (!btn?.classList?.contains('ft-field-remove')) return;

        const idx = Number(btn.getAttribute('data-idx'));
        const fields = extensionSettings.trackerFields;
        if (!Array.isArray(fields) || !fields[idx]) return;
        if (fields[idx].locked) return;

        fields.splice(idx, 1);
        ft_ensureRequiredFields();
        saveSettings();
        ft_renderFieldsUI();
    });
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
    ft_ensureRequiredFields();

    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = null;

    injectTrackerCSS();
    tracker_initDate();

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
        // degrade gracefully
    }

    const settingsHtml = createSettingsUI();
    $('#extensions_settings').append(settingsHtml);

    $('#ragfordummies_container > .inline-drawer-toggle').on('click', function(e) {
        e.preventDefault(); e.stopPropagation();
        $(this).find('.inline-drawer-icon').toggleClass('down up');
        $('#ragfordummies_container .inline-drawer-content').first().slideToggle(200);
    });
    $('#rag_tracker_drawer > .inline-drawer-toggle').on('click', function(e) {
        e.preventDefault(); e.stopPropagation();
        $(this).find('.inline-drawer-icon').toggleClass('down up');
        $(this).next('.inline-drawer-content').slideToggle(200);
    });

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
            const injectionHandler = (type) => {
                injectContextWithSetExtensionPrompt(type || 'normal'); // RAG
                tracker_injectInstruction();                           // TRACKER
            };
            eventSourceToUse.on('GENERATION_AFTER_COMMANDS', injectionHandler);
            eventSourceToUse.on('generate_before_combine_prompts', () => injectionHandler('normal'));
        }

        eventSourceToUse.on('chat_completion_processed', tracker_onReplyProcessed);

        eventSourceToUse.on('character_message_rendered', (arg) => {
            console.log(`[${MODULE_NAME}] [FUCKTRACKER] character_message_rendered payload:`, arg);
            onCharacterMessageRendered(arg);
        });

        eventsRegistered = true;
        console.log('[' + MODULE_NAME + '] Event listeners registered successfully');
    } else {
        console.log('[' + MODULE_NAME + '] eventSource not available, using polling fallback');
        eventsRegistered = false;
        usePolling = true;
    }

    if (extensionSettings.autoIndex) {
        await startPolling();
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

    tracker_updateSettingsDebug();

    console.log('[' + MODULE_NAME + '] Extension loaded successfully');
    updateUI('status', 'Extension loaded');
}

jQuery(async function() {
    setTimeout(init, 100);
});
