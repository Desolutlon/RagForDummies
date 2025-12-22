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

        // Update core fields directly (case-insensitive lookup)
        const getField = (obj, ...keys) => {
            for (const key of keys) {
                if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
                // Also check lowercase
                const lowerKey = key.toLowerCase();
                for (const k of Object.keys(obj)) {
                    if (k.toLowerCase() === lowerKey && typeof obj[k] === 'string' && obj[k].trim()) {
                        return obj[k].trim();
                    }
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

        // Dynamic: store everything except forbidden keys (AI must not guide time)
        const forbidden = new Set(["time", "date", "datetime", "day", "clock"]);
        for (const [k, v] of Object.entries(data)) {
            if (forbidden.has(k.toLowerCase())) continue;
            // Store with original key AND normalized key for reliable lookup
            this.fields[k] = v;
        }

        console.log(`[${MODULE_NAME}] [FUCKTRACKER] updateFromJSON complete. Fields:`, JSON.stringify(this.fields));
        tracker_updateSettingsDebug();
    },

    getFormattedDate: function() { return this.time; }
};

// Per-message snapshots so old messages don't show latest state
window.FuckTrackerSnapshots = {
    byMesId: Object.create(null),
    pending: [], // fallback if mesid isn't available at processing time
    processing: new Set(), // lock to prevent concurrent processing of same message
    swipesInProgress: new Set(), // track which messages are being swiped
};

function ft_getMesIdFromEventArg(arg) {
    if (arg == null) return null;
    if (typeof arg === 'number' || typeof arg === 'string') return arg;

    if (typeof arg === 'object') {
        if (arg.mesid != null) return arg.mesid;
        if (arg.mesId != null) return arg.mesId;
        if (arg.messageId != null) return arg.messageId;
        if (arg.id != null) return arg.id;
        // Also check nested message object
        if (arg.message && typeof arg.message === 'object') {
            if (arg.message.mesid != null) return arg.message.mesid;
            if (arg.message.id != null) return arg.message.id;
        }
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
    if (v === null || v === undefined || v === '') return 'None';
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

// --- MOVED HELPERS TO GLOBAL SCOPE (Fixed Syntax Error) ---

function ft_getTextAccessor(obj) {
    // Returns { get():string, set(v:string) } for whatever field ST used
    if (!obj || typeof obj !== 'object') return null;

    // Direct text properties
    if (typeof obj.text === 'string') return { get: () => obj.text, set: (v) => { obj.text = v; } };
    if (typeof obj.mes === 'string') return { get: () => obj.mes, set: (v) => { obj.mes = v; } };
    if (typeof obj.message === 'string') return { get: () => obj.message, set: (v) => { obj.message = v; } };
    if (typeof obj.content === 'string') return { get: () => obj.content, set: (v) => { obj.content = v; } };

    // Nested message object
    if (obj.message && typeof obj.message === 'object') {
        if (typeof obj.message.text === 'string') return { get: () => obj.message.text, set: (v) => { obj.message.text = v; } };
        if (typeof obj.message.mes === 'string') return { get: () => obj.message.mes, set: (v) => { obj.message.mes = v; } };
        if (typeof obj.message.content === 'string') return { get: () => obj.message.content, set: (v) => { obj.message.content = v; } };
    }

    // Try data property (some ST versions wrap it)
    if (obj.data && typeof obj.data === 'object') {
        if (typeof obj.data.text === 'string') return { get: () => obj.data.text, set: (v) => { obj.data.text = v; } };
        if (typeof obj.data.mes === 'string') return { get: () => obj.data.mes, set: (v) => { obj.data.mes = v; } };
        if (typeof obj.data.message === 'string') return { get: () => obj.data.message, set: (v) => { obj.data.message = v; } };
    }

    // Log what we received for debugging
    console.log(`[${MODULE_NAME}] [FUCKTRACKER] ft_getTextAccessor could not find text in:`, Object.keys(obj));

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

// -----------------------------------------------------------

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

        // current value comes from state (value is always editable)
        let currentVal = '';
        if (title === 'Location') currentVal = window.RagTrackerState.location ?? '';
        else if (title === 'Topic') currentVal = window.RagTrackerState.topic ?? '';
        else if (title === 'Tone') currentVal = window.RagTrackerState.tone ?? '';
        else currentVal = window.RagTrackerState.fields?.[title] ?? '';

        const row = document.createElement('div');
        row.className = 'ft-field-row';
        row.style.cssText = 'display:grid; grid-template-columns: 1fr 2fr 2fr 1fr auto; gap:6px; margin-bottom:6px; align-items:start;';

        row.innerHTML = `
          <input class="text_pole ft-field-title" data-idx="${idx}" placeholder="Title (e.g., Mood)" value="${ft_escapeHtml(title)}" ${locked ? 'disabled' : ''} />
          <textarea class="text_pole ft-field-prompt" data-idx="${idx}" rows="2" placeholder="Prompt for this field" ${locked ? 'disabled' : ''}>${ft_escapeHtml(prompt)}</textarea>
          <textarea class="text_pole ft-field-examples" data-idx="${idx}" rows="2" placeholder='Examples (e.g., ["Working Out"])' ${locked ? 'disabled' : ''}>${ft_escapeHtml(examples)}</textarea>
          <input class="text_pole ft-field-value" data-idx="${idx}" placeholder="Manual value" value="${ft_escapeHtml(currentVal)}" />
          <button class="menu_button ft-field-remove" data-idx="${idx}" style="padding:4px 8px; font-size:0.85em;" ${locked ? 'disabled' : ''}>X</button>
        `;

        container.appendChild(row);
    });

    // Update time preview
    const prev = document.getElementById('ft_time_preview');
    if (prev) prev.textContent = window.RagTrackerState.time || 'Unknown';
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

function getParticipantNames(messages) {
    const names = new Set();
    for (const msg of messages) {
        if (msg && msg.name) {
            names.add(msg.name.toLowerCase());
        }
    }
    return names;
}

// ===========================
// INDEXING + QDRANT FUNCTIONS
// ===========================

function getCurrentChatId() {
    let ctx = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
    else if (typeof getContext === 'function') ctx = getContext();
    if (!ctx) return null;
    if (ctx.chatId) return ctx.chatId;
    if (ctx.getCurrentChatId) return ctx.getCurrentChatId();
    if (ctx.chat_metadata && ctx.chat_metadata.chat_id_hash) return ctx.chat_metadata.chat_id_hash;
    return null;
}

function isCurrentChatGroupChat() {
    let ctx = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
    else if (typeof getContext === 'function') ctx = getContext();
    return !!ctx?.groupId;
}

function getActiveCharacterName() {
    let ctx = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
    else if (typeof getContext === 'function') ctx = getContext();
    if (!ctx) return null;
    if (ctx.characterId && ctx.characters && ctx.characters[ctx.characterId]) {
        return ctx.characters[ctx.characterId].name;
    }
    return ctx.name2 || null;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function convertChatToJSONL(context) {
    if (!context || !context.chat) return '';
    const lines = [];
    for (const msg of context.chat) {
        if (msg && msg.mes) {
            lines.push(JSON.stringify(msg));
        }
    }
    return lines.join('\n');
}

async function qdrantRequest(endpoint, options = {}) {
    const url = extensionSettings.qdrantLocalUrl + endpoint;
    try {
        const response = await fetch(url, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers }
        });
        if (!response.ok) throw new Error('Qdrant returned ' + response.status);
        return await response.json();
    } catch (error) {
        throw error;
    }
}

async function createCollection(collectionName, vectorSize) {
    try {
        await qdrantRequest('/collections/' + collectionName, {
            method: 'PUT',
            body: JSON.stringify({ vectors: { size: vectorSize, distance: 'Cosine' } })
        });
    } catch (error) {
        if (!error.message.includes('already exists')) throw error;
    }
}

async function countPoints(collectionName) {
    try {
        const result = await qdrantRequest('/collections/' + collectionName);
        return result.result?.points_count || 0;
    } catch (error) {
        return 0;
    }
}

async function upsertVectors(collectionName, points) {
    await qdrantRequest('/collections/' + collectionName + '/points?wait=true', {
        method: 'PUT',
        body: JSON.stringify({ points: points })
    });
}

async function deletePoints(collectionName, filter) {
    await qdrantRequest('/collections/' + collectionName + '/points/delete?wait=true', {
        method: 'POST',
        body: JSON.stringify({ filter: filter })
    });
}

async function deleteMessageByIndex(collectionName, chatIdHash, messageIndex) {
    try {
        await deletePoints(collectionName, {
            must: [
                { key: 'chat_id_hash', match: { value: chatIdHash } },
                { key: 'message_index', match: { value: messageIndex } }
            ]
        });
        console.log('[' + MODULE_NAME + '] Deleted existing point for message index ' + messageIndex);
    } catch (error) {
        console.warn('[' + MODULE_NAME + '] Delete failed (may not exist):', error.message);
    }
}

async function searchVectors(collectionName, vector, limit, filter) {
    const result = await qdrantRequest('/collections/' + collectionName + '/points/search', {
        method: 'POST',
        body: JSON.stringify({ vector: vector, limit: limit, with_payload: true, filter: filter })
    });
    return result.result || [];
}

async function generateEmbedding(textOrArray) {
    const isArray = Array.isArray(textOrArray);
    const texts = isArray ? textOrArray : [textOrArray];
    const provider = extensionSettings.embeddingProvider || 'kobold';
    if (provider === 'ollama') return await generateOllamaEmbedding(texts, isArray);
    if (provider === 'openai') return await generateOpenAIEmbedding(texts, isArray);
    return await generateKoboldEmbedding(texts, isArray);
}

async function generateKoboldEmbedding(texts, isArray) {
    const input = isArray ? texts : [texts];
    const response = await fetch(extensionSettings.koboldUrl + '/api/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: input, model: "text-embedding-ada-002" })
    });
    if (!response.ok) throw new Error('KoboldCpp API error: ' + response.status + ' - ' + await response.text());
    const data = await response.json();
    return isArray ? data.data.map(d => d.embedding) : data.data[0].embedding;
}

async function generateOllamaEmbedding(texts, isArray) {
    const results = [];
    for (const text of texts) {
        const response = await fetch(extensionSettings.ollamaUrl + '/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: extensionSettings.ollamaModel, prompt: text })
        });
        if (!response.ok) throw new Error('Ollama embedding failed: ' + response.status);
        const data = await response.json();
        results.push(data.embedding);
    }
    return isArray ? results : results[0];
}

async function generateOpenAIEmbedding(texts, isArray) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + extensionSettings.openaiApiKey
        },
        body: JSON.stringify({ model: extensionSettings.openaiModel, input: texts })
    });
    if (!response.ok) throw new Error('OpenAI embedding failed: ' + response.status);
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
        isIndexing = false;
        hideStopButton();
        return true;

    } catch (error) {
        console.error('[' + MODULE_NAME + '] Indexing failed:', error);
        updateUI('status', 'Error: ' + error.message);
        isIndexing = false;
        hideStopButton();
        return false;
    }
}

async function indexSingleMessage(message, chatIdHash, messageIndex, isGroupChat = false) {
    try {
        const participantNames = new Set();
        if (message.name) participantNames.add(message.name.toLowerCase());

        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;

        await deleteMessageByIndex(collectionName, chatIdHash, messageIndex);

        const embeddingText = buildEmbeddingText(message, message.tracker);
        const embedding = await generateEmbedding(embeddingText);

        const payload = extractPayload(message, messageIndex, chatIdHash, participantNames);

        await upsertVectors(collectionName, [{
            id: generateUUID(),
            vector: embedding,
            payload: payload
        }]);

        console.log('[' + MODULE_NAME + '] Indexed message ' + messageIndex);
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to index message:', error);
        return false;
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
        const excludeCount = extensionSettings.excludeLastMessages || 0;
        const excludeThreshold = chatLength - excludeCount;

        const filter = {
            must: [{ key: 'chat_id_hash', match: { value: chatId } }]
        };
        if (excludeThreshold > 0) {
            filter.must.push({ key: 'message_index', range: { lt: excludeThreshold } });
        }

        const results = await searchVectors(
            collectionName,
            queryVector,
            extensionSettings.retrievalCount || 5,
            filter
        );

        const threshold = extensionSettings.similarityThreshold || 0.7;
        const filtered = results.filter(r => r.score >= threshold);

        if (filtered.length === 0) return null;

        filtered.sort((a, b) => a.payload.message_index - b.payload.message_index);

        const contextParts = [];
        for (const result of filtered) {
            const p = result.payload;
            let line = '[' + p.character_name + ']: ' + p.full_message;
            if (p.summary) line = '[Summary: ' + p.summary + '] ' + line;
            contextParts.push(line);
        }

        return contextParts.join('\n\n');
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Context retrieval failed:', error);
        return null;
    }
}

// ===========================
// Event Handlers
// ===========================

async function onChatLoaded() {
    const chatId = getCurrentChatId();
    if (!chatId) return;

    currentChatIndexed = false;
    indexedMessageIds.clear();
    lastKnownSummaries.clear();

    // Reset tracker state for new chat
    window.RagTrackerState.location = "Unknown";
    window.RagTrackerState.topic = "None";
    window.RagTrackerState.tone = "Neutral";
    window.RagTrackerState.fields = {};
    window.RagTrackerState.initClockFromSettingsAndChat();
    window.FuckTrackerSnapshots.byMesId = Object.create(null);
    window.FuckTrackerSnapshots.pending = [];

    const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
    try {
        const pointCount = await countPoints(collectionName);
        if (pointCount > 0) {
            currentChatIndexed = true;
            updateUI('status', '✓ Indexed (' + pointCount + ' messages)');
        } else {
            updateUI('status', 'Ready to index');
        }
    } catch (error) {
        updateUI('status', 'Ready to index');
    }
}

async function onMessageSent(messageIndex) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;

    let ctx = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
    else if (typeof getContext === 'function') ctx = getContext();

    if (ctx && ctx.chat && ctx.chat[messageIndex]) {
        const message = ctx.chat[messageIndex];
        await indexSingleMessage(message, chatId, messageIndex, isCurrentChatGroupChat());
        indexedMessageIds.add(messageIndex);
        lastKnownSummaries.set(messageIndex, getSummaryFromMsg(message));
    }
}

async function onMessageReceived(messageIndex) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;

    let ctx = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
    else if (typeof getContext === 'function') ctx = getContext();

    if (ctx && ctx.chat && ctx.chat[messageIndex]) {
        const message = ctx.chat[messageIndex];
        await indexSingleMessage(message, chatId, messageIndex, isCurrentChatGroupChat());
        indexedMessageIds.add(messageIndex);
        lastKnownSummaries.set(messageIndex, getSummaryFromMsg(message));
    }
}

async function onMessageSwiped(data) {
    const chatId = getCurrentChatId();
    if (!chatId) return;

    const messageIndex = typeof data === 'number' ? data : data?.message_id;
    if (messageIndex === undefined) return;

    console.log('[' + MODULE_NAME + '] Swipe: message ' + messageIndex);

    // TRACKER FIX: Handle tracker update for swipe
    // This runs regardless of autoIndex setting
    if (extensionSettings.trackerEnabled && extensionSettings.trackerInline) {
        const key = String(messageIndex);
        
        // Mark this message as having a swipe in progress
        window.FuckTrackerSnapshots.swipesInProgress.add(key);
        
        // Remove stale snapshot and clear any processing lock
        delete window.FuckTrackerSnapshots.byMesId[key];
        window.FuckTrackerSnapshots.processing.delete(key);
        
        // Remove old tracker DOM element immediately
        const mesEl = ft_findMesElementByMesId(messageIndex);
        if (mesEl) {
            const oldTracker = mesEl.querySelector('.ft-tracker-display');
            if (oldTracker) {
                oldTracker.remove();
                console.log(`[${MODULE_NAME}] [FUCKTRACKER] Removed old tracker for swipe on mesId: ${messageIndex}`);
            }
        }
        
        // Wait for message content AND DOM to stabilize, then rebuild tracker ourselves
        (async () => {
            try {
                const maxWaitMs = 3000;
                const start = Date.now();
                
                // Wait for chat context to update
                const readMes = () => {
                    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : (typeof getContext === 'function' ? getContext() : null);
                    return ctx?.chat?.[messageIndex]?.mes || null;
                };
                const initial = readMes();
                let lastSeen = initial, stableCount = 0;
                
                while (Date.now() - start < maxWaitMs) {
                    await new Promise(res => setTimeout(res, 100));
                    const mes = readMes();
                    if (!mes || mes === initial) continue;
                    if (mes === lastSeen) stableCount++; 
                    else { stableCount = 1; lastSeen = mes; }
                    if (stableCount >= 3) break; // Wait for 3 stable reads
                }
                
                // Extra wait for DOM render
                await new Promise(res => setTimeout(res, 200));
                
                // Now find the message element again (DOM may have changed)
                const mesElNew = ft_findMesElementByMesId(messageIndex);
                if (!mesElNew) {
                    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Could not find message element after swipe wait`);
                    return;
                }
                
                const mesTextEl = mesElNew.querySelector('.mes_text');
                if (!mesTextEl) {
                    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Could not find mes_text after swipe wait`);
                    return;
                }
                
                // Remove any tracker that might have been added by the event handler
                const existingTracker = mesElNew.querySelector('.ft-tracker-display');
                if (existingTracker) {
                    existingTracker.remove();
                }
                
                // Clear snapshot again and processing lock
                delete window.FuckTrackerSnapshots.byMesId[key];
                window.FuckTrackerSnapshots.processing.delete(key);
                
                // Now process: strip JSON and build tracker
                const regex = /⦗([\s\S]*?)⦘/;
                const html = mesTextEl.innerHTML;
                const match = html.match(regex);
                
                let snapshot = null;
                
                if (match) {
                    let jsonStr = match[1];
                    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Swipe: Found JSON in DOM`);

                    // Convert HTML to plain text for parsing
                    jsonStr = jsonStr.replace(/<br\s*\/?>/gi, '\n');
                    jsonStr = jsonStr.replace(/&quot;/g, '"');
                    jsonStr = jsonStr.replace(/&amp;/g, '&');
                    jsonStr = jsonStr.replace(/&lt;/g, '<');
                    jsonStr = jsonStr.replace(/&gt;/g, '>');
                    jsonStr = jsonStr.replace(/&#39;/g, "'");
                    jsonStr = jsonStr.replace(/&nbsp;/g, ' ');
                    jsonStr = jsonStr.replace(/<[^>]*>/g, '');
                    jsonStr = jsonStr.trim();

                    if (!Number.isFinite(window.RagTrackerState._clockMs)) {
                        window.RagTrackerState.initClockFromSettingsAndChat();
                    }
                    const messageTime = window.RagTrackerState.formatClock(window.RagTrackerState._clockMs);

                    try {
                        const parsedData = JSON.parse(jsonStr);
                        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Swipe: Parsed JSON successfully`);
                        
                        window.RagTrackerState.updateFromJSON(parsedData);

                        snapshot = {
                            time: messageTime,
                            location: window.RagTrackerState.location,
                            topic: window.RagTrackerState.topic,
                            tone: window.RagTrackerState.tone,
                            fields: { ...window.RagTrackerState.fields },
                            rawData: { ...parsedData },
                        };

                        window.FuckTrackerSnapshots.byMesId[key] = snapshot;
                    } catch (e) {
                        console.error(`[${MODULE_NAME}] [FUCKTRACKER] Swipe: JSON parse failed:`, e);
                    }
                    
                    // ALWAYS strip JSON from DOM
                    mesTextEl.innerHTML = html.replace(regex, '').trim();
                    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Swipe: Stripped JSON from DOM`);
                }
                
                // Build and inject tracker
                const trackerHtml = ft_buildTrackerHtmlFromSnapshot(snapshot);
                mesTextEl.insertAdjacentHTML('beforebegin', trackerHtml);
                console.log(`[${MODULE_NAME}] [FUCKTRACKER] Swipe: Injected new tracker for mesId: ${messageIndex}`);
            } finally {
                // Always clear swipe in progress flag
                window.FuckTrackerSnapshots.swipesInProgress.delete(key);
            }
        })();
    }

    // RAG re-indexing only if enabled
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;

    console.log('[' + MODULE_NAME + '] Swipe: re-indexing message ' + messageIndex);

    let ctx = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
    else if (typeof getContext === 'function') ctx = getContext();

    if (ctx && ctx.chat && ctx.chat[messageIndex]) {
        const message = ctx.chat[messageIndex];
        await indexSingleMessage(message, chatId, messageIndex, isCurrentChatGroupChat());
        lastKnownSummaries.set(messageIndex, getSummaryFromMsg(message));
    }
}

async function onMessageDeleted(data) {
    if (!extensionSettings.enabled) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;

    const messageIndex = typeof data === 'number' ? data : data?.message_id;
    if (messageIndex === undefined) return;

    console.log('[' + MODULE_NAME + '] Delete: removing message ' + messageIndex + ' from index');

    const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
    await deleteMessageByIndex(collectionName, chatId, messageIndex);
    indexedMessageIds.delete(messageIndex);
    lastKnownSummaries.delete(messageIndex);
}

async function onMessageEdited(data) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;

    const messageIndex = typeof data === 'number' ? data : data?.message_id;
    if (messageIndex === undefined) return;

    console.log('[' + MODULE_NAME + '] Edit: re-indexing message ' + messageIndex);

    let ctx = null;
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
    else if (typeof getContext === 'function') ctx = getContext();

    if (ctx && ctx.chat && ctx.chat[messageIndex]) {
        const message = ctx.chat[messageIndex];
        await indexSingleMessage(message, chatId, messageIndex, isCurrentChatGroupChat());
        lastKnownSummaries.set(messageIndex, getSummaryFromMsg(message));
    }
}

async function startPolling() {
    if (pollingInterval) return;

    pollingInterval = setInterval(async () => {
        try {
            const chatId = getCurrentChatId();
            if (!chatId) return;

            if (chatId !== lastChatId) {
                lastChatId = chatId;
                currentChatIndexed = false;
                indexedMessageIds.clear();
                lastKnownSummaries.clear();
                lastMessageCount = 0;
            }

            let context = null;
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
            else if (typeof getContext === 'function') context = getContext();
            if (!context || !context.chat) return;

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

    console.log(`[${MODULE_NAME}] [FUCKTRACKER] tracker_onReplyProcessed called with:`, typeof data, data ? Object.keys(data) : 'null');

    const acc = ft_getTextAccessor(data);
    if (!acc) {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] No text accessor found, skipping processing`);
        return data;
    }

    const rawMsg = acc.get();
    if (typeof rawMsg !== 'string') {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] rawMsg is not a string:`, typeof rawMsg);
        return data;
    }

    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Processing message (first 200 chars):`, rawMsg.substring(0, 200));

    const regex = /⦗([\s\S]*?)⦘/;
    const match = rawMsg.match(regex);

    // Ensure clock initialized
    if (!Number.isFinite(window.RagTrackerState._clockMs)) {
        window.RagTrackerState.initClockFromSettingsAndChat();
    }
    const messageTime = window.RagTrackerState.formatClock(window.RagTrackerState._clockMs);

    if (match) {
        const jsonStr = match[1];
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Found JSON block:`, jsonStr.substring(0, 200));
        
        try {
            const parsedData = JSON.parse(jsonStr);
            console.log(`[${MODULE_NAME}] [FUCKTRACKER] Parsed JSON successfully:`, JSON.stringify(parsedData));

            // Update global state (ignores AI time/date)
            window.RagTrackerState.updateFromJSON(parsedData);

            // Create snapshot with ALL data
            const snapshot = {
                time: messageTime,
                location: window.RagTrackerState.location,
                topic: window.RagTrackerState.topic,
                tone: window.RagTrackerState.tone,
                // Include both the fields object AND copy the parsed data directly
                fields: { ...window.RagTrackerState.fields },
                // Also store the raw parsed data for any fields we might have missed
                rawData: { ...parsedData },
            };

            console.log(`[${MODULE_NAME}] [FUCKTRACKER] Created snapshot:`, JSON.stringify(snapshot));

            const mesId = ft_getMesIdFromEventArg(data);
            if (mesId != null) {
                window.FuckTrackerSnapshots.byMesId[String(mesId)] = snapshot;
                console.log(`[${MODULE_NAME}] [FUCKTRACKER] Stored snapshot for mesId: ${mesId}`);
            } else {
                window.FuckTrackerSnapshots.pending.push(snapshot);
                console.log(`[${MODULE_NAME}] [FUCKTRACKER] Stored snapshot in pending queue`);
            }

            // Strip JSON from the visible assistant message
            const stripped = rawMsg.replace(regex, "").trim();
            acc.set(stripped.length ? stripped : "(AI failed to generate dialogue. Please regenerate.)");

            console.log(`[${MODULE_NAME}] [FUCKTRACKER] State Updated + Snapshot stored (processed hook)`);
        } catch (e) {
            console.error(`[${MODULE_NAME}] [FUCKTRACKER] Failed to parse JSON (processed hook):`, e);
            console.error(`[${MODULE_NAME}] [FUCKTRACKER] JSON string was:`, jsonStr);
            // still strip to avoid leaking JSON
            acc.set(rawMsg.replace(regex, "").trim());
        }

        // advance clock per assistant message
        window.RagTrackerState.advanceClock();
        tracker_updateSettingsDebug();
    } else {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] No JSON block found in message`);
    }

    return data;
};

function ft_buildTrackerHtmlFromSnapshot(snapshot) {
    // Get values from snapshot, falling back to current state
    const time = snapshot?.time ?? window.RagTrackerState.time;
    const location = snapshot?.location ?? window.RagTrackerState.location;
    const topic = snapshot?.topic ?? window.RagTrackerState.topic;
    
    // Merge fields from multiple sources to ensure we have all data
    const snapshotFields = snapshot?.fields ?? {};
    const snapshotRawData = snapshot?.rawData ?? {};
    const currentFields = window.RagTrackerState.fields ?? {};
    
    // Combine all field sources (snapshot fields take priority)
    const fields = { ...currentFields, ...snapshotRawData, ...snapshotFields };

    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Building HTML with:`, {
        time, location, topic,
        fieldsKeys: Object.keys(fields),
        fieldsValues: fields
    });

    const settingsFields = Array.isArray(extensionSettings.trackerFields) ? extensionSettings.trackerFields : [];
    const orderedTitles = settingsFields.map(f => f?.title).filter(Boolean);

    // Build ordered list of titles, avoiding duplicates
    const titles = [];
    const seen = new Set();
    for (const t of ["Time & Date", "Location", "Topic", ...orderedTitles]) {
        if (seen.has(t)) continue;
        seen.add(t);
        titles.push(t);
    }

    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Titles to render:`, titles);

    // Helper function to get value for a title - with case-insensitive fallback
    const getValForTitle = (title) => {
        if (title === "Time & Date") return time;
        if (title === "Location") return location;
        if (title === "Topic") return topic;
        
        // Try exact match first
        if (fields[title] !== undefined) {
            return ft_renderValue(fields[title]);
        }
        
        // Try case-insensitive match
        const lowerTitle = title.toLowerCase();
        for (const [key, value] of Object.entries(fields)) {
            if (key.toLowerCase() === lowerTitle) {
                return ft_renderValue(value);
            }
        }
        
        // Check special fields on RagTrackerState
        if (title === "Tone" || title.toLowerCase() === "tone") {
            return snapshot?.tone ?? window.RagTrackerState.tone ?? "Neutral";
        }
        
        return "None";
    };

    // Generate cells for all titles
    const cells = titles.map((title, idx) => {
        const value = getValForTitle(title);
        const full = 'full-width'; // All cells full width for readability
        return `
        <div class="ft-cell ${full}">
            <div class="ft-label">${ft_escapeHtml(title)}</div>
            <div class="ft-val">${ft_escapeHtml(value)}</div>
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

    console.log(`[${MODULE_NAME}] [FUCKTRACKER] onCharacterMessageRendered called with:`, eventArg);

    const mesId = ft_getMesIdFromEventArg(eventArg);
    if (mesId == null) {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Could not get mesId from event arg`);
        return;
    }

    const key = String(mesId);
    
    // If a swipe is in progress for this message, let the swipe handler handle it
    if (window.FuckTrackerSnapshots.swipesInProgress.has(key)) {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Swipe in progress for mesId ${key}, letting swipe handler handle it`);
        return;
    }
    
    // Prevent concurrent processing of the same message (race condition during swipes)
    if (window.FuckTrackerSnapshots.processing.has(key)) {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Already processing mesId ${key}, skipping`);
        return;
    }
    window.FuckTrackerSnapshots.processing.add(key);

    try {
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
            console.log(`[${MODULE_NAME}] [FUCKTRACKER] Could not find message element for mesId: ${mesId}`);
            return;
        }

        // Don't duplicate header - check parent for existing tracker
        const existingTracker = mesEl.querySelector('.ft-tracker-display');
        if (existingTracker) {
            console.log(`[${MODULE_NAME}] [FUCKTRACKER] Tracker already exists for mesId ${mesId}`);
            return;
        }

    // 1) Prefer snapshot created by processed hook
    let snapshot = window.FuckTrackerSnapshots.byMesId[key];
    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Looking for snapshot with key "${key}":`, snapshot ? 'found' : 'not found');

    // 2) If no snapshot, try the pending queue (rare)
    if (!snapshot && window.FuckTrackerSnapshots.pending.length) {
        snapshot = window.FuckTrackerSnapshots.pending.shift();
        window.FuckTrackerSnapshots.byMesId[key] = snapshot;
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Got snapshot from pending queue`);
    }

    // ALWAYS check for and strip JSON from DOM (even if we have a snapshot)
    const regex = /⦗([\s\S]*?)⦘/;
    const html = mesTextEl.innerHTML;
    const match = html.match(regex);
    
    if (match) {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Found JSON block in DOM, will strip it`);
        
        // If we don't have a snapshot yet, try to parse it
        if (!snapshot) {
            let jsonStr = match[1];
            console.log(`[${MODULE_NAME}] [FUCKTRACKER] No snapshot, attempting DOM fallback parse`);

            // Convert HTML back to plain text for JSON parsing
            jsonStr = jsonStr.replace(/<br\s*\/?>/gi, '\n');
            jsonStr = jsonStr.replace(/&quot;/g, '"');
            jsonStr = jsonStr.replace(/&amp;/g, '&');
            jsonStr = jsonStr.replace(/&lt;/g, '<');
            jsonStr = jsonStr.replace(/&gt;/g, '>');
            jsonStr = jsonStr.replace(/&#39;/g, "'");
            jsonStr = jsonStr.replace(/&nbsp;/g, ' ');
            jsonStr = jsonStr.replace(/<[^>]*>/g, '');
            jsonStr = jsonStr.trim();

            console.log(`[${MODULE_NAME}] [FUCKTRACKER] Cleaned JSON string:`, jsonStr.substring(0, 200));

            // Ensure clock initialized
            if (!Number.isFinite(window.RagTrackerState._clockMs)) {
                window.RagTrackerState.initClockFromSettingsAndChat();
            }
            const messageTime = window.RagTrackerState.formatClock(window.RagTrackerState._clockMs);

            try {
                const parsedData = JSON.parse(jsonStr);
                console.log(`[${MODULE_NAME}] [FUCKTRACKER] DOM fallback parsed:`, JSON.stringify(parsedData));

                window.RagTrackerState.updateFromJSON(parsedData);

                snapshot = {
                    time: messageTime,
                    location: window.RagTrackerState.location,
                    topic: window.RagTrackerState.topic,
                    tone: window.RagTrackerState.tone,
                    fields: { ...window.RagTrackerState.fields },
                    rawData: { ...parsedData },
                };

                window.FuckTrackerSnapshots.byMesId[key] = snapshot;
                console.log(`[${MODULE_NAME}] [FUCKTRACKER] Snapshot stored (DOM fallback) for mesid=${key}`);
                
                // Advance clock per assistant message (DOM fallback path)
                window.RagTrackerState.advanceClock();
                tracker_updateSettingsDebug();
            } catch (e) {
                console.error(`[${MODULE_NAME}] [FUCKTRACKER] DOM fallback JSON parse failed:`, e);
            }
        }
        
        // ALWAYS strip JSON block from rendered message, even if parse failed
        mesTextEl.innerHTML = html.replace(regex, '').trim();
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] Stripped JSON block from DOM`);
    } else {
        console.log(`[${MODULE_NAME}] [FUCKTRACKER] No JSON block found in DOM`);
    }

    // 4) Build header from snapshot if we have it; else from current state
    const trackerHtml = ft_buildTrackerHtmlFromSnapshot(snapshot);

    // Insert ABOVE dialogue as separate block
    mesTextEl.insertAdjacentHTML('beforebegin', trackerHtml);

    console.log(`[${MODULE_NAME}] [FUCKTRACKER] Injected tracker header for mesid=${mesId}`);
    } finally {
        // Always release the processing lock
        window.FuckTrackerSnapshots.processing.delete(key);
    }
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
                                  <div style="font-weight:700; margin-bottom:6px;">Tracked Fields (Title / Prompt / Examples / Manual Value)</div>

                                  <div id="ft_fields_container"></div>

                                  <button class="menu_button" id="ft_add_field_btn" style="margin-top:8px;">+ Add Field</button>
                                </div>

                                <div style="margin-top:10px; padding:8px; background:rgba(0,0,0,0.2); border-radius:6px;">
                                  <div style="font-weight:700; margin-bottom:6px;">Time Settings</div>
                                  <div class="flex-container" style="gap:8px; align-items:center;">
                                    <label>Start Date/Time:</label>
                                    <input type="datetime-local" id="ragfordummies_tracker_start_date" class="text_pole" value="${extensionSettings.trackerStartDate}">
                                  </div>
                                  <div class="flex-container" style="gap:8px; align-items:center; margin-top:6px;">
                                    <label>Time Step (minutes):</label>
                                    <input type="number" id="ragfordummies_tracker_time_step" class="text_pole" value="${extensionSettings.trackerTimeStep}" min="1" max="1440" style="width:80px;">
                                  </div>
                                  <div class="flex-container" style="gap:8px; align-items:center; margin-top:6px;">
                                    <label>Manual Time Override:</label>
                                    <input type="datetime-local" id="ft_manual_time" class="text_pole">
                                    <button class="menu_button" id="ft_manual_time_apply">Set</button>
                                  </div>
                                  <div style="margin-top:6px;">
                                    <small>Current Time: <span id="ft_time_preview">${window.RagTrackerState.time || 'Unknown'}</span></small>
                                  </div>
                                </div>

                                <div id="ft_debug_time" style="margin-top:8px; font-size:0.85em; opacity:0.7;"></div>
                            </div>
                        </div>
                    </div>
                    <!-- END FUCK TRACKER -->

                    <div class="ragfordummies-section">
                        <label>Qdrant URL</label>
                        <input type="text" id="ragfordummies_qdrant_url" class="text_pole" value="${extensionSettings.qdrantLocalUrl}" placeholder="http://localhost:6333">
                    </div>
                    <div class="ragfordummies-section">
                        <label>Embedding Provider</label>
                        <select id="ragfordummies_embedding_provider" class="text_pole">
                            <option value="kobold" ${extensionSettings.embeddingProvider === 'kobold' ? 'selected' : ''}>KoboldCpp</option>
                            <option value="ollama" ${extensionSettings.embeddingProvider === 'ollama' ? 'selected' : ''}>Ollama</option>
                            <option value="openai" ${extensionSettings.embeddingProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
                        </select>
                    </div>
                    <div class="ragfordummies-section" id="kobold_settings" style="${extensionSettings.embeddingProvider === 'kobold' ? '' : 'display:none;'}">
                        <label>KoboldCpp URL</label>
                        <input type="text" id="ragfordummies_kobold_url" class="text_pole" value="${extensionSettings.koboldUrl}">
                    </div>
                    <div class="ragfordummies-section" id="ollama_settings" style="${extensionSettings.embeddingProvider === 'ollama' ? '' : 'display:none;'}">
                        <label>Ollama URL</label>
                        <input type="text" id="ragfordummies_ollama_url" class="text_pole" value="${extensionSettings.ollamaUrl}">
                        <label>Ollama Model</label>
                        <input type="text" id="ragfordummies_ollama_model" class="text_pole" value="${extensionSettings.ollamaModel}">
                    </div>
                    <div class="ragfordummies-section" id="openai_settings" style="${extensionSettings.embeddingProvider === 'openai' ? '' : 'display:none;'}">
                        <label>OpenAI API Key</label>
                        <input type="password" id="ragfordummies_openai_key" class="text_pole" value="${extensionSettings.openaiApiKey}">
                        <label>OpenAI Model</label>
                        <input type="text" id="ragfordummies_openai_model" class="text_pole" value="${extensionSettings.openaiModel}">
                    </div>
                    <div class="ragfordummies-section">
                        <label>Retrieval Count</label>
                        <input type="number" id="ragfordummies_retrieval_count" class="text_pole" value="${extensionSettings.retrievalCount}" min="1" max="20">
                    </div>
                    <div class="ragfordummies-section">
                        <label>Similarity Threshold</label>
                        <input type="number" id="ragfordummies_similarity" class="text_pole" value="${extensionSettings.similarityThreshold}" min="0" max="1" step="0.05">
                    </div>
                    <div class="ragfordummies-section">
                        <label>Query Message Count</label>
                        <input type="number" id="ragfordummies_query_count" class="text_pole" value="${extensionSettings.queryMessageCount}" min="1" max="10">
                    </div>
                    <div class="ragfordummies-section">
                        <label>Exclude Last N Messages</label>
                        <input type="number" id="ragfordummies_exclude_last" class="text_pole" value="${extensionSettings.excludeLastMessages}" min="0" max="20">
                    </div>
                    <div class="ragfordummies-section">
                        <label>User Keyword Blacklist (comma-separated)</label>
                        <textarea id="ragfordummies_user_blacklist" class="text_pole" rows="2" placeholder="e.g., foo, bar, baz">${extensionSettings.userBlacklist || ''}</textarea>
                    </div>
                    <div class="ragfordummies-section">
                        <label class="checkbox_label"><input type="checkbox" id="ragfordummies_auto_index" ${extensionSettings.autoIndex ? 'checked' : ''} />Auto-index new messages</label>
                    </div>
                    <div class="ragfordummies-section">
                        <label class="checkbox_label"><input type="checkbox" id="ragfordummies_inject" ${extensionSettings.injectContext ? 'checked' : ''} />Inject context into prompts</label>
                    </div>
                    <div class="ragfordummies-section">
                        <label>Injection Position</label>
                        <select id="ragfordummies_position" class="text_pole">
                            <option value="before_main" ${extensionSettings.injectionPosition === 'before_main' ? 'selected' : ''}>Before Main Prompt</option>
                            <option value="after_main" ${extensionSettings.injectionPosition === 'after_main' ? 'selected' : ''}>After Main Prompt</option>
                            <option value="after_messages" ${extensionSettings.injectionPosition === 'after_messages' ? 'selected' : ''}>After N Messages</option>
                        </select>
                    </div>
                    <div class="ragfordummies-section" id="inject_after_section" style="${extensionSettings.injectionPosition === 'after_messages' ? '' : 'display:none;'}">
                        <label>Inject After N Messages</label>
                        <input type="number" id="ragfordummies_inject_after" class="text_pole" value="${extensionSettings.injectAfterMessages}" min="1" max="50">
                    </div>
                    <div class="ragfordummies-section">
                        <button class="menu_button" id="ragfordummies_index_btn">Index Current Chat</button>
                        <button class="menu_button" id="ragfordummies_stop_indexing" style="display:none;">Stop Indexing</button>
                    </div>
                    <div class="ragfordummies-section">
                        <label>Upload JSONL</label>
                        <input type="file" id="ragfordummies_upload" accept=".jsonl">
                        <label class="checkbox_label"><input type="checkbox" id="ragfordummies_merge_upload" />Merge into current chat collection</label>
                    </div>
                    <div class="ragfordummies-section">
                        <span id="ragfordummies_status">Ready</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    return html;
}

function attachEventListeners() {
    document.getElementById('ragfordummies_enabled')?.addEventListener('change', (e) => {
        extensionSettings.enabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('ragfordummies_tracker_enabled')?.addEventListener('change', (e) => {
        extensionSettings.trackerEnabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('ragfordummies_tracker_inline')?.addEventListener('change', (e) => {
        extensionSettings.trackerInline = e.target.checked;
        saveSettings();
    });

    document.getElementById('ragfordummies_tracker_context_depth')?.addEventListener('change', (e) => {
        extensionSettings.trackerContextDepth = parseInt(e.target.value, 10) || 10;
        saveSettings();
    });

    document.getElementById('ragfordummies_tracker_start_date')?.addEventListener('change', (e) => {
        extensionSettings.trackerStartDate = e.target.value;
        window.RagTrackerState.initClockFromSettingsAndChat();
        saveSettings();
        const prev = document.getElementById('ft_time_preview');
        if (prev) prev.textContent = window.RagTrackerState.time || 'Unknown';
    });

    document.getElementById('ragfordummies_tracker_time_step')?.addEventListener('change', (e) => {
        extensionSettings.trackerTimeStep = parseInt(e.target.value, 10) || 15;
        window.RagTrackerState.initClockFromSettingsAndChat();
        saveSettings();
        const prev = document.getElementById('ft_time_preview');
        if (prev) prev.textContent = window.RagTrackerState.time || 'Unknown';
    });

    document.getElementById('ragfordummies_qdrant_url')?.addEventListener('change', (e) => {
        extensionSettings.qdrantLocalUrl = e.target.value;
        saveSettings();
    });

    document.getElementById('ragfordummies_embedding_provider')?.addEventListener('change', (e) => {
        extensionSettings.embeddingProvider = e.target.value;
        document.getElementById('kobold_settings').style.display = e.target.value === 'kobold' ? '' : 'none';
        document.getElementById('ollama_settings').style.display = e.target.value === 'ollama' ? '' : 'none';
        document.getElementById('openai_settings').style.display = e.target.value === 'openai' ? '' : 'none';
        saveSettings();
    });

    document.getElementById('ragfordummies_kobold_url')?.addEventListener('change', (e) => {
        extensionSettings.koboldUrl = e.target.value;
        saveSettings();
    });

    document.getElementById('ragfordummies_ollama_url')?.addEventListener('change', (e) => {
        extensionSettings.ollamaUrl = e.target.value;
        saveSettings();
    });

    document.getElementById('ragfordummies_ollama_model')?.addEventListener('change', (e) => {
        extensionSettings.ollamaModel = e.target.value;
        saveSettings();
    });

    document.getElementById('ragfordummies_openai_key')?.addEventListener('change', (e) => {
        extensionSettings.openaiApiKey = e.target.value;
        saveSettings();
    });

    document.getElementById('ragfordummies_openai_model')?.addEventListener('change', (e) => {
        extensionSettings.openaiModel = e.target.value;
        saveSettings();
    });

    document.getElementById('ragfordummies_retrieval_count')?.addEventListener('change', (e) => {
        extensionSettings.retrievalCount = parseInt(e.target.value, 10);
        saveSettings();
    });

    document.getElementById('ragfordummies_similarity')?.addEventListener('change', (e) => {
        extensionSettings.similarityThreshold = parseFloat(e.target.value);
        saveSettings();
    });

    document.getElementById('ragfordummies_query_count')?.addEventListener('change', (e) => {
        extensionSettings.queryMessageCount = parseInt(e.target.value, 10);
        saveSettings();
    });

    document.getElementById('ragfordummies_exclude_last')?.addEventListener('change', (e) => {
        extensionSettings.excludeLastMessages = parseInt(e.target.value, 10);
        saveSettings();
    });

    document.getElementById('ragfordummies_user_blacklist')?.addEventListener('change', (e) => {
        extensionSettings.userBlacklist = e.target.value;
        saveSettings();
    });

    document.getElementById('ragfordummies_auto_index')?.addEventListener('change', (e) => {
        extensionSettings.autoIndex = e.target.checked;
        saveSettings();
    });

    document.getElementById('ragfordummies_inject')?.addEventListener('change', (e) => {
        extensionSettings.injectContext = e.target.checked;
        saveSettings();
    });

    document.getElementById('ragfordummies_position')?.addEventListener('change', (e) => {
        extensionSettings.injectionPosition = e.target.value;
        document.getElementById('inject_after_section').style.display = e.target.value === 'after_messages' ? '' : 'none';
        saveSettings();
    });

    document.getElementById('ragfordummies_inject_after')?.addEventListener('change', (e) => {
        extensionSettings.injectAfterMessages = parseInt(e.target.value, 10);
        saveSettings();
    });

    document.getElementById('ragfordummies_index_btn')?.addEventListener('click', async () => {
        const chatId = getCurrentChatId();
        if (!chatId) {
            updateUI('status', 'No active chat');
            return;
        }
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        if (!context?.chat?.length) {
            updateUI('status', 'Chat is empty');
            return;
        }
        await indexChat(convertChatToJSONL(context), chatId, isCurrentChatGroupChat());
        currentChatIndexed = true;
    });

    document.getElementById('ragfordummies_stop_indexing')?.addEventListener('click', () => {
        shouldStopIndexing = true;
        updateUI('status', 'Stopping...');
    });

    const fileInput = document.getElementById('ragfordummies_upload');
    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            updateUI('status', 'Reading file...');
            try {
                const content = await file.text();
                const shouldMerge = document.getElementById('ragfordummies_merge_upload')?.checked;
                let chatIdHash;
                if (shouldMerge) {
                    chatIdHash = getCurrentChatId();
                    if (!chatIdHash) {
                        updateUI('status', 'No active chat to merge into');
                        return;
                    }
                } else {
                    chatIdHash = 'upload_' + Date.now();
                }
                await indexChat(content, chatIdHash, false);
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

        // existing title/prompt/examples logic you already have...
        if (!fields[idx].locked) {
            if (t.classList.contains('ft-field-title')) fields[idx].title = t.value;
            if (t.classList.contains('ft-field-prompt')) fields[idx].prompt = t.value;
            if (t.classList.contains('ft-field-examples')) fields[idx].examples = t.value;
            saveSettings();
        }

        // NEW: value edits (allowed even if locked)
        if (t.classList.contains('ft-field-value')) {
            const title = fields[idx].title;
            ft_setStateValueByTitle(title, t.value);
        }

        // Keep time preview fresh
        const prev = document.getElementById('ft_time_preview');
        if (prev) prev.textContent = window.RagTrackerState.time || 'Unknown';
    });

    // Manual time set button
    document.getElementById('ft_manual_time_apply')?.addEventListener('click', () => {
        const inp = document.getElementById('ft_manual_time');
        if (!inp) return;

        const ms = ft_parseDatetimeLocalToMs(inp.value);
        if (ms == null) return;

        ft_setClockMs(ms);

        const prev = document.getElementById('ft_time_preview');
        if (prev) prev.textContent = window.RagTrackerState.time || 'Unknown';
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
