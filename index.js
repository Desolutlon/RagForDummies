/**
 * RagForDummies + FuckTracker Integration
 * A RAG extension for SillyTavern that actually works + Zero Latency State Tracking
 */

const MODULE_NAME = 'RagForDummies';

// Whitelist logging
const MODULE_LOG_WHITELIST = ['Settings loaded', 'Extension loaded', 'Tracker', 'TRACKER DEBUG'];
const MODULE_LOG_ALLOW_SUBSTR = ['Indexed', 'Deleted', 'HYBRID', 'Result', 'Query:', 'State Updated'];

const __origConsoleLog = console.log.bind(console);
console.log = function(...args) {
    if (args.length && typeof args[0] === 'string' && args[0].startsWith('[' + MODULE_NAME + ']')) {
        const msg = args[0];
        const whitelisted = MODULE_LOG_WHITELIST.some(k => msg.indexOf(k) !== -1);
        const allowSubstr = MODULE_LOG_ALLOW_SUBSTR.some(k => msg.indexOf(k) !== -1);
        if (!whitelisted && !allowSubstr) return;
    }
    __origConsoleLog(...args);
};

// =================================================================
// 1. GLOBAL TRACKER STATE (FuckTracker Engine)
// =================================================================
window.RagTrackerState = {
    // These defaults will be overwritten by the Date Logic immediately
    dateObj: new Date(), 
    location: "Unknown",
    clothing: "Casual",
    tone: "Neutral",
    topic: "Greetings",
    action: "Standing",
    
    // Helper to get formatted string: "10:00 PM; 12/17/2025 (Wednesday)"
    getFormattedDate: function() {
        const d = this.dateObj;
        const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const dateStr = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
        return `${timeStr}; ${dateStr} (${dayName})`;
    }
};

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
    trackerHud: true,
    trackerInline: true,
    trackerTimeStep: 15,
    trackerStartDate: new Date().toISOString().split('T')[0] + "T08:00" // Default to today 8am
};

let extensionSettings = { ...defaultSettings };
let isIndexing = false;
let shouldStopIndexing = false;
let currentChatIndexed = false;
let lastMessageCount = 0;
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
        .tracker-inline-box {
            display: flex; flex-wrap: wrap; gap: 12px;
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 6px; padding: 5px 10px; margin-bottom: 8px;
            font-size: 0.8em; font-family: monospace;
            color: var(--SmartThemeBodyColor); opacity: 0.9;
            width: fit-content; max-width: 100%;
        }
        .tracker-item { display: inline-flex; align-items: center; gap: 5px; }
        .tracker-icon { opacity: 0.7; }
        .tracker-value { font-weight: 600; }

        #rag-tracker-hud {
            display: flex; flex-wrap: wrap; gap: 10px;
            padding: 8px 12px; margin-bottom: 10px;
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 6px; font-size: 0.85em; color: #e0e0e0;
            backdrop-filter: blur(5px); width: 100%; box-sizing: border-box;
            position: relative; z-index: 2000;
        }
        .rt-stat { 
            display: flex; align-items: center; 
            background: rgba(255, 255, 255, 0.08); 
            padding: 3px 8px; border-radius: 4px; border-left: 3px solid #007bff; 
        }
        .rt-label { font-weight: bold; margin-right: 6px; opacity: 0.7; font-size: 0.75em; text-transform: uppercase; }
        .rt-val { font-family: monospace; }
        
        .t-time, .rt-stat[style*="ffcc00"] { color: #ffcc00; }
        .t-loc, .rt-stat[style*="00cc66"] { color: #66ff99; }
        .t-wear, .rt-stat[style*="ff66cc"] { color: #ff99cc; }
        .t-tone, .rt-stat[style*="00ccff"] { color: #66ccff; }
    `;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
}

// ===========================
// TRACKER LOGIC (Date & Parsing)
// ===========================

function tracker_initDate() {
    // Initialize date from settings if not already set, or on load
    if (extensionSettings.trackerStartDate) {
        window.RagTrackerState.dateObj = new Date(extensionSettings.trackerStartDate);
    }
}

function tracker_advanceTime(minutesToAdd) {
    if (!extensionSettings.trackerEnabled) return;

    // Add minutes to the Date Object
    const current = window.RagTrackerState.dateObj.getTime();
    const newTime = current + (minutesToAdd * 60000);
    window.RagTrackerState.dateObj = new Date(newTime);
    
    // Update visuals
    tracker_updateHud();
    tracker_updateSettingsDebug();
}

function tracker_updateHud() {
    if (!extensionSettings.trackerHud) {
        $('#rag-tracker-hud').hide();
        return;
    }
    
    if ($('#rag-tracker-hud').length === 0) {
        const hudHtml = `
        <div id="rag-tracker-hud">
            <div class="rt-stat" style="border-color:#ffcc00"><span class="rt-label">TIME</span><span class="rt-val" id="rt-val-time">--</span></div>
            <div class="rt-stat" style="border-color:#00cc66"><span class="rt-label">LOC</span><span class="rt-val" id="rt-val-loc">---</span></div>
            <div class="rt-stat" style="border-color:#ff66cc"><span class="rt-label">WEAR</span><span class="rt-val" id="rt-val-wear">---</span></div>
            <div class="rt-stat" style="border-color:#00ccff"><span class="rt-label">TONE</span><span class="rt-val" id="rt-val-tone">---</span></div>
            <div class="rt-stat" style="border-color:#cc33ff"><span class="rt-label">TOPIC</span><span class="rt-val" id="rt-val-topic">---</span></div>
        </div>`;
        
        if ($('#chat_header_wrapper').length) $('#chat_header_wrapper').after(hudHtml);
        else $('#top-bar').after(hudHtml);
    }

    $('#rag-tracker-hud').show();
    const s = window.RagTrackerState;
    const dateStr = s.getFormattedDate();
    
    $('#rt-val-time').text(dateStr);
    $('#rt-val-loc').text(s.location);
    $('#rt-val-wear').text(s.clothing);
    $('#rt-val-tone').text(s.tone);
    $('#rt-val-topic').text(s.topic);
}

function tracker_updateSettingsDebug() {
    // Updates the inputs in the settings menu to match reality
    $('#ft_manual_loc').val(window.RagTrackerState.location);
    $('#ft_manual_wear').val(window.RagTrackerState.clothing);
    $('#ft_manual_tone').val(window.RagTrackerState.tone);
    $('#ft_debug_time').text(window.RagTrackerState.getFormattedDate());
}

function tracker_parseStateString(str) {
    console.log(`[${MODULE_NAME}] [TRACKER DEBUG] Raw AI String: "${str}"`);
    
    const parts = str.split('|');
    parts.forEach(part => {
        let [key, val] = part.split(':').map(x => x.trim());
        if (!key || !val) return;
        key = key.toLowerCase();
        
        if (key.includes('loc')) window.RagTrackerState.location = val;
        if (key.includes('wear')) window.RagTrackerState.clothing = val;
        if (key.includes('tone')) window.RagTrackerState.tone = val;
        if (key.includes('topic')) window.RagTrackerState.topic = val;
        if (key.includes('act')) window.RagTrackerState.action = val;
    });

    tracker_updateHud();
    tracker_updateSettingsDebug();
}

// ===========================
// UTILITY & NLP (Standard)
// ===========================

// ... (Keyword lists and extraction logic kept identical to preserve RAG function) ...
const keywordBlacklist = new Set(['i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','its','our','their','mine','yours','hers','ours','theirs','this','that','these','those','what','which','who','whom','whose','the','a','an','and','or','but','if','then','else','when','where','why','how','to','of','in','on','at','by','for','with','from','into','onto','upon','about','over','under','through','between','among','all','each','every','both','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','also','now','here','there','always','never','sometimes','often','usually','as','up','down','out','off','away','im','ive','id','ill','youre','youve','youd','youll','hes','shes','weve','were','wed','well','theyve','theyre','theyd','theyll','isnt','arent','wasnt','werent','dont','doesnt','didnt','wont','wouldnt','couldnt','shouldnt','cant','cannot','hadnt','hasnt','havent','lets','thats','whats','whos','hows','wheres','whens','whys','is','are','was','be','been','being','have','has','had','having','do','does','did','doing','will','would','could','should','may','might','must','shall','can','say','said','says','see','saw','seen','get','got','go','went','gone','come','came','know','knew','think','thought','make','made','take','took','want','wanted','look','looked','give','gave','use','used','find','found','tell','told','let','put','keep','kept','leave','left','begin','began','seem','seemed','help','helped','show','showed','hear','heard','play','played','run','ran','live','lived','believe','believed','hold','held','bring','brought','write','wrote','read','sit','stand','lose','lost','pay','paid','meet','met','include','included','continue','continued','set','learn','learned','change','changed','lead','led','understand','understood','watch','watched','follow','followed','stop','stopped','create','created','speak','spoke','allow','allowed','add','added','spend','spent','grow','grew','open','opened','walk','walked','win','won','offer','offered','remember','remembered','love','loved','consider','considered','appear','appeared','buy','bought','wait','waited','serve','served','die','died','send','sent','expect','expected','build','built','stay','stayed','fall','fell','cut','reach','kill','killed','remain','remained','good','bad','great','big','small','old','new','first','last','long','little','own','other','right','left','really','actually','probably','maybe','perhaps','definitely','certainly','high','low','young','early','late','important','public','different','possible','full','special','free','strong','certain','real','best','better','true','whole','oh','ah','um','uh','hey','hi','hello','bye','yes','no','yeah','yea','yep','nope','okay','ok','well','like','huh','hmm','hm','mhm','ugh','ooh','oops','wow','whoa','god','omg','wtf','lol','lmao','rofl','today','tomorrow','yesterday','morning','afternoon','evening','night','week','month','year','day','hour','minute','second','time','monday','tuesday','wednesday','thursday','friday','saturday','sunday','january','february','march','april','may','june','july','august','september','october','november','december','besides','however','although','though','because','since','while','after','before','until','unless','anyway','anyways','meanwhile','furthermore','moreover','therefore','otherwise','instead','still','maybe','perhaps','apparently','obviously','clearly','honestly','seriously','basically','literally','sure','fine','thanks','thank','sorry','please','wait','stop','look','listen','watch','minor','major','nice','cool','awesome','amazing','terrible','horrible','wonderful','beautiful','enough','exactly','absolutely','totally','completely','perfectly','simply','one','two','three','four','five','six','seven','eight','nine','ten','something','nothing','everything','anything','someone','anyone','everyone','nobody','somewhere','anywhere','everywhere','nowhere','much','many','lot','lots','bit','kind','sort','type','way','thing','things','stuff','even','ever','still','already','yet','soon','later','again','once','twice','back','away','around','part','place','case','point','fact','hand','side','world','life','work','home','end','man','men','woman','women','child','children','people','person','family','friend','friends','sealed','unsealed','suddenly','quickly','slowly','gently','softly','quietly','loudly','smiles','smiling','smiled','laughs','laughing','laughed','sighs','sighing','sighed','nods','nodding','nodded','shakes','shaking','shook','looks','looking','walks','walking','turns','turning','turned','stands','standing','stood','sits','sitting','sat','grins','grinning','grinned','chuckles','chuckling','chuckled','giggles','giggling','giggled','pauses','pausing','paused','thinks','thinking','feels','feeling','felt','takes','taking','gives','giving','puts','putting','gets','getting','moves','moving','moved','steps','stepping','stepped','reaches','reaching','reached','pulls','pulling','pulled','pushes','pushing','pushed','holds','holding','held','starts','starting','started','stops','stopping','stopped','tries','trying','tried','says','saying','asks','asking','asked','tells','telling','replies','replying','replied','tilts','tilting','tilted','raises','raising','raised','lowers','lowering','lowered','leans','leaning','leaned','rests','resting','rested','places','placing','placed','notices','noticing','noticed','realizes','realizing','realized','wonders','wondering','wondered','blinks','blinking','blinked','stares','staring','stared','glances','glancing','glanced','whispers','whispering','whispered','murmurs','murmuring','murmured','mutters','muttering','muttered','continues','continuing','continued','begins','beginning','began','finishes','finishing','finished','seems','seeming','seemed','appears','appearing','appeared','sounds','sounding','sounded','tone','voice','expression','face','eyes','head','body','arm','arms','hand','hands','finger','fingers','teasing','teased','smug','smugly','playful','playfully','curious','curiously','nervous','nervously','soft','warm','cold','hot','light','dark','bright','quiet','loud','gentle','rough','slight','slightly','brief','briefly','quick','slow','sudden','careful','carefully',"we've","you're","he's","she's","it's","they're",'yourself','worry','mr','mrs','sir','maam','hmph','fuck','fucking','fucked','shit','shitty','damn','damned','hell','ass','crap','crappy','bitch','dumbass','motherfucker','fucker','cunt','shitter','bullshit','asshat','fuckface','bastard','dick','cock','pussy','slut','whore','asshole','arse','prick','twat','tonights','tomorrows','todays','tonight','goddamn','godamn','saturdays','sundays','mondays','tuesdays','wednesdays','thursdays','fridays','januarys','februarys','marchs','aprils','mays','junes','julys','augusts','septembers','octobers','novembers','decembers','don','wasn','weren','isn','aren','didn','doesn','hasn','hadn','haven','wouldn','shouldn','couldn','mustn','shan','won','ve','re','ll','s','m','d','t','leg','legs','babe','baby','darling','honey','sweetheart','dear','love','oof','mmph','mmmph']);
function getUserBlacklistSet() { if (!extensionSettings.userBlacklist) return new Set(); return new Set(extensionSettings.userBlacklist.toLowerCase().split(',').map(t => t.trim()).filter(t => t.length > 0)); }
function sanitizeTextForKeywords(text, namesSet) { let cleanText = text; const sortedNames = Array.from(namesSet).sort((a, b) => b.length - a.length); if (sortedNames.length > 0) { const pattern = '\\b(' + sortedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b'; const nameRegex = new RegExp(pattern, 'gi'); cleanText = cleanText.replace(nameRegex, ' '); } return cleanText.replace(/\s+/g, ' ').trim(); }
function extractKeywords(text, excludeNames = new Set()) { if (typeof window.nlp === 'undefined' || !text) return []; text = text.replace(/[\u2018\u2019`]/g, "'"); let doc = window.nlp(text); doc.match('#Contraction').remove(); doc.match('#Expression').remove(); text = doc.text(); text = text.replace(/[-–—_*]+/g, ' '); const wordsInText = text.split(/\s+/).length; if (wordsInText < 100) return []; const baseKeywords = 5; const scalingFactor = 3; const additionalKeywords = Math.floor((wordsInText - 100) / 100) * scalingFactor; const limit = baseKeywords + additionalKeywords; const finalKeywords = new Set(); doc = window.nlp(text); doc.match('#Expression').remove(); doc.match('#Contraction').remove(); const processTerm = (term) => { const cleaned = term.toLowerCase().replace(/[^a-z]/g, ""); if (cleaned && cleaned.length > 2 && !excludeNames.has(cleaned) && !keywordBlacklist.has(cleaned) && !window.nlp(cleaned).has('#Verb') && !window.nlp(cleaned).has('#Pronoun') && window.nlp(cleaned).has('#Noun')) { finalKeywords.add(cleaned); } }; const topics = doc.topics().out('array'); const quotes = doc.quotations().out('array'); const potentialSources = [...topics, ...quotes]; for (const source of potentialSources) { const words = source.split(/[^a-zA-Z0-9]+/); for (const word of words) processTerm(word); } return Array.from(finalKeywords).slice(0, limit); }
function extractProperNouns(text, excludeNames) { if (excludeNames === undefined) excludeNames = new Set(); if (!text || typeof text !== 'string') return []; const properNouns = new Set(); const sentences = text.split(/[.!?*]+|["'"]\s*/); for (let i = 0; i < sentences.length; i++) { let sentence = sentences[i].trim(); if (!sentence) continue; sentence = sentence.replace(/[-–—_*]+/g, ' '); const words = sentence.split(/\s+/); for (let j = 0; j < words.length; j++) { const word = words[j]; if (j > 0 && /^[A-Z]/.test(word)) { const cleaned = word.toLowerCase().replace(/[^a-z]/g, ""); if (cleaned && cleaned.length > 2 && !excludeNames.has(cleaned) && !keywordBlacklist.has(cleaned)) { properNouns.add(cleaned); } } } } return Array.from(properNouns); }
function generateUUID() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 8); return v.toString(16); }); }
function getParticipantNames(contextOrChat) { const names = new Set(); let context = contextOrChat; if (!context) { if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext(); else if (typeof getContext === 'function') context = getContext(); } else if (Array.isArray(contextOrChat)) { if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext(); } if (context) { if (context.name1) names.add(context.name1.toLowerCase()); if (context.name2) names.add(context.name2.toLowerCase()); if (typeof SillyTavern !== 'undefined' && SillyTavern.user_name) names.add(SillyTavern.user_name.toLowerCase()); if (context.characterId && typeof characters !== 'undefined' && characters[context.characterId]) { const charData = characters[context.characterId].data; if (charData && charData.nickname) names.add(charData.nickname.toLowerCase()); } if (context.groups && context.groupId) { const group = context.groups.find(g => g.id === context.groupId); if (group && group.members) { group.members.forEach(member => { if (member && member.name) names.add(member.name.toLowerCase()); }); } } const chatLog = Array.isArray(contextOrChat) ? contextOrChat : (context.chat || []); chatLog.forEach(msg => { if (msg.name && typeof msg.name === 'string') names.add(msg.name.toLowerCase()); }); } const nameParts = []; names.forEach(n => { const parts = n.split(/\s+/); if (parts.length > 1) { parts.forEach(p => { if (p.length >= 2) nameParts.push(p); }); } }); nameParts.forEach(p => names.add(p)); return names; }
function extractQueryFilterTerms(text, excludeNames) { if (excludeNames === undefined) excludeNames = new Set(); if (!text || typeof text !== 'string') return []; const terms = new Set(); let cleaned = text.replace(/\*+/g, ' ').replace(/\.{2,}/g, ' ').replace(/["']/g, ' '); const words = cleaned.toLowerCase().split(/[^a-z0-9]+/); const userBlacklist = getUserBlacklistSet(); for (const word of words) { if (word.length < 2 || word.length > 30) continue; if (excludeNames.has(word)) continue; if (userBlacklist.has(word)) continue; terms.add(word); } return Array.from(terms); }

// ===========================
// Conversion Helpers (JSONL)
// ===========================

function convertChatToJSONL(context) { if (!context || !Array.isArray(context.chat)) throw new Error('Invalid context: chat array missing'); const lines = []; const chatId = (context.chatMetadata && context.chatMetadata.chat_id_hash) || context.chat_id || Date.now().toString(); const metadata = { chat_metadata: { chat_id_hash: chatId, ...(context.chatMetadata || {}) } }; lines.push(JSON.stringify(metadata)); context.chat.forEach((msg) => { if (!msg || typeof msg.mes === 'undefined') return; const payload = { name: msg.name || msg.character || 'Unknown', mes: msg.mes, is_user: !!msg.is_user || msg.role === 'user', is_system: !!msg.is_system, send_date: msg.send_date || msg.date || '', tracker: msg.tracker || {}, extra: msg.extra || {}, present: msg.present || msg.characters_present || [] }; lines.push(JSON.stringify(payload)); }); return lines.join('\n'); }
function convertTextToJSONL(text) { const lines = []; const chatId = Date.now().toString(); lines.push(JSON.stringify({ chat_metadata: { chat_id_hash: chatId } })); const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0); rows.forEach((row) => { lines.push(JSON.stringify({ name: 'User', mes: row, is_user: true, is_system: false, send_date: '', tracker: {}, extra: {}, present: [] })); }); return lines.join('\n'); }

// ===========================
// Qdrant Client Functions
// ===========================

async function qdrantRequest(endpoint, method = 'GET', body = null) { const baseUrl = extensionSettings.qdrantLocalUrl; const headers = { 'Content-Type': 'application/json' }; const options = { method: method, headers: headers, body: body ? JSON.stringify(body) : null }; try { const response = await fetch(baseUrl + endpoint, options); if (!response.ok) { const error = await response.text(); throw new Error('Qdrant error: ' + response.status + ' - ' + error); } return await response.json(); } catch (error) { console.error('[' + MODULE_NAME + '] Qdrant request failed:', error); throw error; } }
async function createCollection(collectionName, vectorSize = 1536) { try { const collections = await qdrantRequest('/collections'); if (collections.result.collections.some(c => c.name === collectionName)) { await createPayloadIndex(collectionName); return true; } await qdrantRequest('/collections/' + collectionName, 'PUT', { vectors: { size: vectorSize, distance: 'Cosine' } }); await createPayloadIndex(collectionName); return true; } catch (error) { console.error('[' + MODULE_NAME + '] Failed to create collection:', error); throw error; } }
async function createPayloadIndex(collectionName) { try { await qdrantRequest('/collections/' + collectionName + '/index', 'PUT', { field_name: 'proper_nouns', field_schema: 'keyword' }); return true; } catch (error) { if (error.message && error.message.indexOf('already exists') !== -1) return true; return false; } }
async function upsertVectors(collectionName, points) { await qdrantRequest('/collections/' + collectionName + '/points', 'PUT', { points: points }); return true; }
async function deleteMessageByIndex(collectionName, chatIdHash, messageIndex) { try { await qdrantRequest('/collections/' + collectionName + '/points/delete', 'POST', { filter: { must: [{ key: 'chat_id_hash', match: { value: chatIdHash } }, { key: 'message_index', match: { value: messageIndex } }] }, wait: true }); } catch (err) { console.warn('[' + MODULE_NAME + '] Delete (by message_index) failed:', err.message); } }

async function searchVectors(collectionName, vector, limit, scoreThreshold, properNouns, maxIndex) { if (limit === undefined || limit === null) limit = extensionSettings.retrievalCount || 5; if (scoreThreshold === undefined) scoreThreshold = extensionSettings.similarityThreshold || 0.7; if (properNouns === undefined) properNouns = []; if (maxIndex === undefined || maxIndex === null) maxIndex = 999999999; const denseTarget = Math.max(1, Math.ceil(limit / 2)); const filteredTarget = limit - denseTarget; const denseFetch = Math.max(limit * 2, denseTarget * 4); const filteredFetch = Math.max(limit * 2, filteredTarget * 4); try { console.log('[' + MODULE_NAME + '] ===== HYBRID SEARCH ====='); console.log('[' + MODULE_NAME + '] Proper nouns: ' + (properNouns.length > 0 ? properNouns.join(', ') : '(none)')); const rangeFilter = { key: 'message_index', range: { lt: maxIndex } }; const denseFilter = { must: [ rangeFilter ] }; const densePromise = qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', { vector: vector, limit: denseFetch, score_threshold: scoreThreshold, with_payload: true, filter: denseFilter }); let filteredPromise = Promise.resolve({ result: [] }); if (properNouns.length > 0 && filteredTarget > 0) { const keywordFilter = { must: [ rangeFilter, { key: 'proper_nouns', match: { any: properNouns } } ] }; filteredPromise = qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', { vector: vector, limit: filteredFetch, score_threshold: scoreThreshold, with_payload: true, filter: keywordFilter }); } const [denseResp, filteredResp] = await Promise.all([densePromise, filteredPromise]); const denseResults = (denseResp && denseResp.result) ? denseResp.result : []; const rawFiltered = (filteredResp && filteredResp.result) ? filteredResp.result : []; let filteredResults = []; if (rawFiltered.length > 0) { filteredResults = rawFiltered.filter(r => (r.payload && r.payload.proper_nouns || []).some(noun => properNouns.indexOf(noun) !== -1)); } const seenIds = new Set(); const finalResults = []; for (const r of filteredResults) { if (finalResults.length >= filteredTarget) break; if (seenIds.has(r.id)) continue; r._source = 'filtered'; finalResults.push(r); seenIds.add(r.id); } for (const r of denseResults) { if (finalResults.length >= limit) break; if (seenIds.has(r.id)) continue; r._source = 'dense'; finalResults.push(r); seenIds.add(r.id); } if (finalResults.length < limit) { for (const r of filteredResults) { if (finalResults.length >= limit) break; if (seenIds.has(r.id)) continue; r._source = 'filtered'; finalResults.push(r); seenIds.add(r.id); } } finalResults.sort((a, b) => b.score - a.score); return finalResults; } catch (error) { console.error('[' + MODULE_NAME + '] Hybrid search failed:', error); return []; } }
async function getCollectionInfo(collectionName) { try { return (await qdrantRequest('/collections/' + collectionName)).result; } catch (error) { return null; } }
async function countPoints(collectionName) { try { const info = await getCollectionInfo(collectionName); return info ? info.points_count : 0; } catch (error) { return 0; } }
async function deleteCollection(collectionName) { try { await qdrantRequest('/collections/' + collectionName, 'DELETE'); return true; } catch (error) { return true; } }
async function forceReindexCurrentChat() { const chatId = getCurrentChatId(); if (!chatId) throw new Error('No active chat found'); const isGroupChat = isCurrentChatGroupChat(); const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatId; updateUI('status', 'Deleting old collection...'); await deleteCollection(collectionName); currentChatIndexed = false; lastMessageCount = 0; indexedMessageIds.clear(); lastKnownSummaries.clear(); let context; if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext(); else if (typeof getContext === 'function') context = getContext(); if (!context || !context.chat || context.chat.length === 0) throw new Error('No chat messages to index'); const jsonl = convertChatToJSONL(context); await indexChat(jsonl, chatId, isGroupChat); currentChatIndexed = true; }

// ===========================
// Embedding Provider Functions
// ===========================

async function generateEmbedding(text) { const provider = extensionSettings.embeddingProvider; if (provider === 'kobold') return await generateKoboldEmbedding(text); if (provider === 'ollama') return await generateOllamaEmbedding(text); if (provider === 'openai') return await generateOpenAIEmbedding(text); throw new Error('Unknown embedding provider: ' + provider); }
async function generateKoboldEmbedding(text) { const isArray = Array.isArray(text); const input = isArray ? text : [text]; const response = await fetch(extensionSettings.koboldUrl + '/api/v1/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: input, model: "text-embedding-ada-002" }) }); if (!response.ok) throw new Error('KoboldCpp API error'); const data = await response.json(); return isArray ? data.data.map(d => d.embedding) : data.data[0].embedding; }
async function generateOllamaEmbedding(text) { const isArray = Array.isArray(text); if (isArray) return Promise.all(text.map(t => generateOllamaEmbedding(t))); const response = await fetch(extensionSettings.ollamaUrl + '/api/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: extensionSettings.ollamaModel, prompt: text }) }); if (!response.ok) throw new Error('Ollama API error'); const data = await response.json(); return data.embedding; }
async function generateOpenAIEmbedding(text) { const isArray = Array.isArray(text); const input = isArray ? text : [text]; const response = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + extensionSettings.openaiApiKey }, body: JSON.stringify({ model: extensionSettings.openaiModel, input: input }) }); if (!response.ok) throw new Error('OpenAI API error'); const data = await response.json(); const embeddings = data.data.map(d => d.embedding); return isArray ? embeddings : embeddings[0]; }

// ===========================
// JSONL Parsing and Indexing
// ===========================

function parseJSONL(jsonlContent) { const lines = jsonlContent.trim().split('\n'); const messages = []; let chatMetadata = null; for (const line of lines) { if (!line.trim()) continue; try { const parsed = JSON.parse(line); if (parsed.chat_metadata) chatMetadata = parsed.chat_metadata; else if (parsed.mes) messages.push(parsed); } catch (error) {} } return { chatMetadata, messages }; }
function getSummaryFromMsg(msg) { if (msg && msg.extra && msg.extra.qvink_memory && typeof msg.extra.qvink_memory.memory === 'string') return msg.extra.qvink_memory.memory; return ""; }
function buildEmbeddingText(message, tracker) { const parts = ['[Character: ' + message.name + ']']; if (tracker) { if (tracker.Time) parts.push('[Time: ' + tracker.Time + ']'); if (tracker.Topics && tracker.Topics.PrimaryTopic) parts.push('[Topic: ' + tracker.Topics.PrimaryTopic + ']'); if (tracker.Topics && tracker.Topics.EmotionalTone) parts.push('[Tone: ' + tracker.Topics.EmotionalTone + ']'); } const summary = getSummaryFromMsg(message); if (summary) parts.push('\nSummary: ' + summary); parts.push('\nMessage: ' + message.mes); return parts.join(' '); }
function extractPayload(message, messageIndex, chatIdHash, participantNames) { const tracker = message.tracker || {}; let charactersPresent = (message.present && Array.isArray(message.present)) ? message.present.map(avatar => avatar.replace(/\.png$/, '')) : (tracker.CharactersPresent && Array.isArray(tracker.CharactersPresent) ? tracker.CharactersPresent : []); if (message.name && message.name !== 'User' && !charactersPresent.some(cp => String(cp).toLowerCase() === String(message.name).toLowerCase())) { charactersPresent.push(message.name); } const normalizedMessage = (message.mes || '').replace(/(\w)\*+(\w)/g, '$1 $2'); const textForKeywords = sanitizeTextForKeywords(normalizedMessage, participantNames); const properNounCandidates = extractProperNouns(textForKeywords, participantNames); const commonKeywordCandidates = extractKeywords(textForKeywords, participantNames); const allKeywords = new Set([...properNounCandidates, ...commonKeywordCandidates]); const summary = getSummaryFromMsg(message); return { chat_id_hash: chatIdHash, message_index: messageIndex, character_name: message.name, is_user: !!message.is_user, timestamp: message.send_date || '', summary: summary, full_message: message.mes, characters_present: charactersPresent, topic: (tracker.Topics && tracker.Topics.PrimaryTopic) || '', emotional_tone: (tracker.Topics && tracker.Topics.EmotionalTone) || '', location: (tracker.Characters && tracker.Characters[message.name] && tracker.Characters[message.name].Location) || '', proper_nouns: Array.from(allKeywords) }; }
function getQueryMessage(context, idxOverride, generationType) { if (idxOverride === undefined) idxOverride = null; if (generationType === undefined) generationType = 'normal'; if (!context || !context.chat || !Array.isArray(context.chat) || context.chat.length === 0) return null; if (idxOverride !== null && idxOverride >= 0 && idxOverride < context.chat.length) { const m = context.chat[idxOverride]; if (m && m.mes && m.mes.trim() && !m.is_system) return m; } let lastMsgIdx = -1; for (let i = context.chat.length - 1; i >= 0; i--) { const msg = context.chat[i]; if (!msg || !msg.mes || !msg.mes.trim() || msg.is_system) continue; lastMsgIdx = i; break; } if (lastMsgIdx === -1) return null; const lastMsg = context.chat[lastMsgIdx]; const isSwipeOrRegen = generationType === 'swipe' || generationType === 'regenerate' || generationType === 'continue'; if (isSwipeOrRegen && !lastMsg.is_user && lastMsgIdx > 0) { for (let i = lastMsgIdx - 1; i >= 0; i--) { const prevMsg = context.chat[i]; if (!prevMsg || !prevMsg.mes || !prevMsg.mes.trim() || prevMsg.is_system) continue; console.log('[' + MODULE_NAME + '] Query: ' + generationType + ' detected - using PREVIOUS message (idx ' + i + ')'); return prevMsg; } } return lastMsg; }

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
    
    // SYNERGY: Inject State into Query
    if (extensionSettings.trackerEnabled) {
        const t = window.RagTrackerState;
        const dateStr = t.getFormattedDate();
        query += `\n[Context: Location is ${t.location}, Mood is ${t.tone}, Current Date is ${dateStr}]`;
        console.log(`[${MODULE_NAME}] Enhanced Query with FuckTracker: ${t.location}, ${t.tone}`);
    }
    return query;
}

async function indexChat(jsonlContent, chatIdHash, isGroupChat = false) {
    if (isIndexing) return false;
    isIndexing = true;
    shouldStopIndexing = false;
    updateUI('status', 'Preparing to index...');
    showStopButton();
    try {
        const { messages } = parseJSONL(jsonlContent);
        if (messages.length === 0) throw new Error('No messages found');
        const participantNames = getParticipantNames(messages);
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;
        const existingPoints = await countPoints(collectionName);
        if (existingPoints >= messages.length) {
            updateUI('status', 'Chat already indexed');
            isIndexing = false;
            hideStopButton();
            messages.forEach((msg, idx) => { lastKnownSummaries.set(idx, getSummaryFromMsg(msg)); });
            return true;
        }
        updateUI('status', 'Getting embedding dimensions...');
        const vectorSize = (await generateEmbedding(buildEmbeddingText(messages[0], messages[0].tracker))).length;
        await createCollection(collectionName, vectorSize);
        const EMBEDDING_BATCH_SIZE = 1024;
        const upsertBatchSize = 10;
        for (let batchStart = 0; batchStart < messages.length; batchStart += EMBEDDING_BATCH_SIZE) {
            if (shouldStopIndexing) {
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
            if (points.length > 0) await upsertVectors(collectionName, points);
        }
        updateUI('status', 'Successfully indexed ' + messages.length + ' messages!');
    } catch (error) {
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
        return true;
    } catch (error) { return false; }
}

async function retrieveContext(query, chatIdHash, isGroupChat = false) {
    try {
        const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatIdHash;
        let context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const excludeCount = extensionSettings.excludeLastMessages || 2;
        const maxIndex = (context && context.chat) ? Math.max(0, context.chat.length - excludeCount) : 999999999;
        const participantNames = getParticipantNames(null);
        const queryEmbedding = await generateEmbedding(query);
        const textForKeywords = sanitizeTextForKeywords(query, participantNames);
        const queryFilterTerms = extractQueryFilterTerms(textForKeywords, participantNames);
        const results = await searchVectors(collectionName, queryEmbedding, extensionSettings.retrievalCount, extensionSettings.similarityThreshold, queryFilterTerms, maxIndex);
        if (results.length === 0) return '';
        const activeChar = getActiveCharacterName();
        let filteredByPresence = results;
        if (activeChar) {
            const target = activeChar.toLowerCase();
            filteredByPresence = results.filter(r => (r.payload.characters_present || []).some(name => String(name).toLowerCase() === target));
        }
        if (filteredByPresence.length === 0) return '';
        
        let currentTotalTokens = 0;
        const contextParts = [];
        const tokenBudget = extensionSettings.maxTokenBudget || 1000;
        for (const result of filteredByPresence) {
            const p = result.payload;
            const score = result.score;
            let text = `\n[Character: ${p.character_name}]\n[Time: ${p.timestamp}]\n[Relevance Score: ${score.toFixed(3)}]`;
            if (p.summary) text += `\n\nSummary: ${p.summary}`;
            text += `\n\nFull Message: ${p.full_message}`;
            const estimatedTokens = Math.ceil(text.length / 4);
            if (currentTotalTokens + estimatedTokens > tokenBudget) break;
            contextParts.push(text);
            currentTotalTokens += estimatedTokens;
        }
        return '\n\n========== RELEVANT PAST CONTEXT ==========\n' + contextParts.join('\n\n-------------------\n') + '\n\n========== END CONTEXT ==========\n\n';
    } catch (error) { return ''; }
}

// ===========================
// SillyTavern Integration
// ===========================

function getCurrentChatId() {
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        return (context && context.chatMetadata && context.chatMetadata.chat_id_hash) || (context && context.chat_id) || null;
    } catch (error) { return null; }
}
function getActiveCharacterName() {
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        if (!context) return null;
        return context.character?.name || context.chatMetadata?.character_name || context.main?.name || null;
    } catch (e) { return null; }
}
function isCurrentChatGroupChat() {
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        return context && context.groupId !== null && context.groupId !== undefined;
    } catch (error) { return false; }
}
async function onChatLoaded() {
    currentChatIndexed = false;
    lastMessageCount = 0;
    indexedMessageIds.clear();
    lastKnownSummaries.clear();
    const chatId = getCurrentChatId();
    lastChatId = chatId;
    tracker_updateHud(); // Tracker HUD init
    updateUI('status', 'Chat loaded - checking index...');
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        if (context && context.chat) {
            lastMessageCount = context.chat.length;
            context.chat.forEach((msg, idx) => { lastKnownSummaries.set(idx, getSummaryFromMsg(msg)); });
        }
        if (chatId) {
            const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
            const pointCount = await countPoints(collectionName);
            if (pointCount > 0) {
                currentChatIndexed = true;
                updateUI('status', 'Indexed (' + pointCount + ' messages)');
            } else { updateUI('status', 'Ready to index'); }
        }
    } catch (error) {}
}
async function onMessageSent(messageData) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const isGroupChat = isCurrentChatGroupChat();
    if (!currentChatIndexed && typeof SillyTavern !== 'undefined') {
        const context = SillyTavern.getContext();
        if (context.chat && context.chat.length > 0) {
            await indexChat(convertChatToJSONL(context), chatId, isGroupChat);
            currentChatIndexed = true;
        }
    }
    if (messageData && currentChatIndexed) await indexSingleMessage(messageData, chatId, SillyTavern.getContext().chat.length - 1, isGroupChat);
}
async function onMessageReceived(messageData) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    if (currentChatIndexed && typeof SillyTavern !== 'undefined') {
        const context = SillyTavern.getContext();
        if (context.chat && context.chat.length > 0) {
            const messageIndex = context.chat.length - 1;
            if (!indexedMessageIds.has(messageIndex)) {
                await indexSingleMessage(context.chat[messageIndex], chatId, messageIndex, isCurrentChatGroupChat());
                indexedMessageIds.add(messageIndex);
                lastMessageCount = context.chat.length;
            }
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
            const context = await (async (idx) => {
                const readCtx = () => SillyTavern.getContext();
                const { mes: initial } = readCtx().chat[idx] || {};
                let lastSeen = initial, stableCount = 0;
                while (stableCount < 2) {
                    await new Promise(res => setTimeout(res, 100));
                    const mes = (readCtx().chat[idx] || {}).mes;
                    if (mes === lastSeen) stableCount++; else { stableCount = 0; lastSeen = mes; }
                }
                return readCtx();
            })(targetIndex !== null ? targetIndex : (SillyTavern.getContext()?.chat.length - 1 || 0));
            if (!context?.chat?.length) return;
            if (targetIndex === null || targetIndex < 0) targetIndex = context.chat.length - 1;
            const message = context.chat[targetIndex];
            await deleteMessageByIndex(collectionName, chatId, targetIndex);
            await indexSingleMessage(message, chatId, targetIndex, isCurrentChatGroupChat());
        } catch (err) {}
    })();
}
async function onMessageDeleted(data) {
    if (!extensionSettings.enabled) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
    const messageIndex = typeof data === 'number' ? data : null;
    if (messageIndex === null) return;
    await deleteMessageByIndex(collectionName, chatId, messageIndex);
}
async function onMessageEdited(data) {
    if (!extensionSettings.enabled) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
    const messageIndex = typeof data === 'number' ? data : (data && typeof data.index === 'number' ? data.index : null);
    if (messageIndex === null) return;
    const context = SillyTavern.getContext();
    if (!context?.chat?.[messageIndex]) return;
    const message = context.chat[messageIndex];
    await deleteMessageByIndex(collectionName, chatId, messageIndex);
    await indexSingleMessage(message, chatId, messageIndex, isCurrentChatGroupChat());
}
async function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(async () => {
        try {
            if (isIndexing) return;
            if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
            const chatId = getCurrentChatId();
            if (!chatId) return;
            let context = SillyTavern.getContext();
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
            } else lastMessageCount = context.chat.length; 
            for (let i = 0; i < context.chat.length; i++) {
                const msg = context.chat[i];
                const currentSum = getSummaryFromMsg(msg);
                const knownSum = lastKnownSummaries.get(i);
                if (lastKnownSummaries.has(i) && currentSum !== knownSum) {
                    lastKnownSummaries.set(i, currentSum); 
                    const collectionName = (isGroupChat ? 'st_groupchat_' : 'st_chat_') + chatId;
                    await deleteMessageByIndex(collectionName, chatId, i);
                    await indexSingleMessage(msg, chatId, i, isGroupChat);
                } else if (!lastKnownSummaries.has(i)) lastKnownSummaries.set(i, currentSum);
            }
        } catch (e) {}
    }, 3000);
}
async function injectContextWithSetExtensionPrompt(generationType) {
    if (!extensionSettings.enabled || !extensionSettings.injectContext) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    if (!currentChatIndexed) {
        const collectionName = (isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId;
        try { if (await countPoints(collectionName) > 0) currentChatIndexed = true; else return; } catch (e) { return; }
    }
    let context = SillyTavern.getContext();
    if (!context?.chat?.length || !context.setExtensionPrompt) return;
    const queryText = constructMultiMessageQuery(context, generationType);
    if (!queryText) return;
    const retrievedContext = await retrieveContext(queryText.substring(0, 2000), chatId, isCurrentChatGroupChat());
    if (!retrievedContext) return;
    let position = 1, depth = 4;
    if (extensionSettings.injectionPosition === 'before_main') { position = 0; depth = 0; }
    else if (extensionSettings.injectionPosition === 'after_main') { position = 1; depth = 0; }
    else if (extensionSettings.injectionPosition === 'after_messages') { position = 1; depth = extensionSettings.injectAfterMessages || 3; }
    const formattedContext = '[Relevant context from earlier in conversation:\n' + retrievedContext + '\n]';
    context.setExtensionPrompt(MODULE_NAME, formattedContext, position, depth);
    updateUI('status', 'Context injected');
}

// ===========================
// LISTENERS (Tracker + RAG)
// ===========================

const tracker_onPromptGeneration = (data) => {
    if (!extensionSettings.trackerEnabled) return data;
    const s = window.RagTrackerState;
    const dateStr = s.getFormattedDate(); // "10:00 PM; 12/17/2025 (Wednesday)"
    const instruction = `\n[SYSTEM INSTRUCTION: STATE TRACKING]
Current Simulation Date: ${dateStr}.
Location Context: ${s.location}.
START every response with a hidden state block exactly like this:
\`⦗ Loc: <Current Location> | Wear: <Outfit Condition> | Tone: <Emotional Tone> | Topic: <Main Subject> | Act: <Physical Action> ⦘\`
Ensure the response that follows strictly adheres to this state.`;
    if (data && data.prompt) data.prompt += instruction;
    return data;
};

const tracker_onReplyProcessed = (data) => {
    if (!extensionSettings.trackerEnabled) return data;
    const rawMsg = data.text;
    const regex = /⦗(.*?)⦘/s;
    const match = rawMsg.match(regex);
    if (match) {
        const content = match[1];
        tracker_parseStateString(content);
        tracker_advanceTime(extensionSettings.trackerTimeStep);
        const s = window.RagTrackerState;
        
        let inlineHtml = '';
        if (extensionSettings.trackerInline) {
            inlineHtml = `
            <div class="tracker-inline-box">
                <span class="tracker-item t-time" title="Time"><span class="tracker-icon">🕒</span><span class="tracker-value">${s.getFormattedDate()}</span></span>
                <span class="tracker-item t-loc" title="Location"><span class="tracker-icon">📍</span><span class="tracker-value">${s.location}</span></span>
                <span class="tracker-item t-wear" title="Outfit"><span class="tracker-icon">👕</span><span class="tracker-value">${s.clothing}</span></span>
                <span class="tracker-item t-tone" title="Tone"><span class="tracker-icon">💭</span><span class="tracker-value">${s.tone}</span></span>
            </div>\n`;
        }
        data.text = inlineHtml + rawMsg.replace(regex, "").trim();
    }
    return data;
};

function showStopButton() { const btn = document.getElementById('ragfordummies_stop_indexing'); if (btn) btn.classList.add('active'); }
function hideStopButton() { const btn = document.getElementById('ragfordummies_stop_indexing'); if (btn) btn.classList.remove('active'); }
function updateUI(element, value) {
    const el = document.getElementById('ragfordummies_' + element);
    if (el) {
        if (element === 'status') el.textContent = value;
        else el.value = value;
    }
}
function createSettingsUI() {
    // Note: We use type="datetime-local" for the start date
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
                                <label class="checkbox_label"><input type="checkbox" id="ragfordummies_tracker_enabled" ${extensionSettings.trackerEnabled ? 'checked' : ''} />Enable Zero-Latency Tracking</label>
                                <label class="checkbox_label"><input type="checkbox" id="ragfordummies_tracker_hud" ${extensionSettings.trackerHud ? 'checked' : ''} />Show HUD on Chat</label>
                                <label class="checkbox_label"><input type="checkbox" id="ragfordummies_tracker_inline" ${extensionSettings.trackerInline ? 'checked' : ''} />Show Inline Chat Status</label>
                                
                                <div class="flex-container"><label>Minutes per Turn</label><input type="number" id="ragfordummies_tracker_time_step" class="text_pole" value="${extensionSettings.trackerTimeStep}" min="1" max="1440"></div>
                                <div class="flex-container"><label>Simulation Start Date</label><input type="datetime-local" id="ragfordummies_tracker_start_date" class="text_pole" value="${extensionSettings.trackerStartDate}"></div>
                                
                                <hr><small>Manual Overrides (Correction):</small>
                                <div class="flex-container"><label>Location</label><input type="text" id="ft_manual_loc" class="text_pole" placeholder="e.g. Tavern"></div>
                                <div class="flex-container"><label>Outfit</label><input type="text" id="ft_manual_wear" class="text_pole" placeholder="e.g. Naked"></div>
                                <div class="flex-container"><label>Tone</label><input type="text" id="ft_manual_tone" class="text_pole" placeholder="e.g. Angry"></div>
                                
                                <div style="margin-top:10px; padding:5px; background:rgba(0,0,0,0.2); border-radius:4px; font-family:monospace; font-size:0.8em;"><strong>Current Time:</strong><br><span id="ft_debug_time">Loading...</span></div>
                            </div>
                        </div>
                    </div>
                    <!-- END TRACKER -->

                    <div class="ragfordummies-section"><h4>Qdrant Configuration</h4><label><span>Local URL:</span><input type="text" id="ragfordummies_qdrant_local_url" value="${extensionSettings.qdrantLocalUrl}" placeholder="http://localhost:6333" /></label></div>
                    <div class="ragfordummies-section"><h4>Embedding Provider</h4><label><span>Provider:</span><select id="ragfordummies_embedding_provider"><option value="kobold" ${extensionSettings.embeddingProvider === 'kobold' ? 'selected' : ''}>KoboldCpp</option><option value="ollama" ${extensionSettings.embeddingProvider === 'ollama' ? 'selected' : ''}>Ollama</option><option value="openai" ${extensionSettings.embeddingProvider === 'openai' ? 'selected' : ''}>OpenAI</option></select></label><label id="ragfordummies_kobold_settings" style="${extensionSettings.embeddingProvider === 'kobold' ? '' : 'display:none'}"><span>KoboldCpp URL:</span><input type="text" id="ragfordummies_kobold_url" value="${extensionSettings.koboldUrl}" placeholder="http://localhost:11434" /></label><div id="ragfordummies_ollama_settings" style="${extensionSettings.embeddingProvider === 'ollama' ? '' : 'display:none'}"><label><span>Ollama URL:</span><input type="text" id="ragfordummies_ollama_url" value="${extensionSettings.ollamaUrl}" placeholder="http://localhost:11434" /></label><label><span>Ollama Model:</span><input type="text" id="ragfordummies_ollama_model" value="${extensionSettings.ollamaModel}" placeholder="nomic-embed-text" /></label></div><div id="ragfordummies_openai_settings" style="${extensionSettings.embeddingProvider === 'openai' ? '' : 'display:none'}"><label><span>OpenAI API Key:</span><input type="password" id="ragfordummies_openai_api_key" value="${extensionSettings.openaiApiKey}" placeholder="sk-..." /></label><label><span>OpenAI Model:</span><input type="text" id="ragfordummies_openai_model" value="${extensionSettings.openaiModel}" placeholder="text-embedding-3-small" /></label></div></div>
                    <div class="ragfordummies-section"><h4>RAG Settings</h4><label><span>Retrieval Count:</span><input type="number" id="ragfordummies_retrieval_count" value="${extensionSettings.retrievalCount}" min="1" max="20" /></label><label><span>Similarity Threshold:</span><input type="number" id="ragfordummies_similarity_threshold" value="${extensionSettings.similarityThreshold}" min="0" max="1" step="0.1" /></label><label><span>Query Context Messages:</span><input type="number" id="ragfordummies_query_message_count" value="${extensionSettings.queryMessageCount}" min="1" max="10" /></label><label><span>Context Budget (Tokens):</span><input type="number" id="ragfordummies_max_token_budget" value="${extensionSettings.maxTokenBudget || 1000}" min="100" max="5000" /></label><label><span>Exclude Recent Messages:</span><input type="number" id="ragfordummies_exclude_last_messages" value="${extensionSettings.excludeLastMessages}" min="0" max="10" /></label><label class="checkbox_label"><input type="checkbox" id="ragfordummies_auto_index" ${extensionSettings.autoIndex ? 'checked' : ''} />Auto-index on first message</label><label class="checkbox_label"><input type="checkbox" id="ragfordummies_inject_context" ${extensionSettings.injectContext ? 'checked' : ''} />Inject context into prompt</label></div>
                    <div class="ragfordummies-section"><h4>Custom Keyword Blacklist</h4><label><span>Blacklisted Terms (comma-separated):</span><input type="text" id="ragfordummies_user_blacklist" value="${extensionSettings.userBlacklist || ''}" placeholder="baka, sweetheart, darling" /></label></div>
                    <div class="ragfordummies-section"><h4>Manual Operations</h4><button id="ragfordummies_index_current" class="menu_button">Index Current Chat</button><button id="ragfordummies_force_reindex" class="menu_button">Force Re-index (Rebuild)</button><button id="ragfordummies_stop_indexing" class="menu_button ragfordummies-stop-btn">Stop Indexing</button><hr style="border-color: var(--SmartThemeBorderColor); margin: 10px 0;" /><label class="checkbox_label" style="margin-bottom: 8px;"><input type="checkbox" id="ragfordummies_merge_uploads" checked /><span>Merge uploads into current chat collection</span></label><button id="ragfordummies_upload_btn" class="menu_button">Upload File (JSONL or txt)</button><input type="file" id="ragfordummies_file_input" accept=".jsonl,.txt" style="display:none" /><div id="ragfordummies_status" class="ragfordummies-status">Ready</div></div>
                </div>
            </div>
        </div>`;
    return html;
}

function attachEventListeners() {
    const settingIds = ['enabled', 'qdrant_local_url', 'embedding_provider', 'kobold_url', 'ollama_url', 'ollama_model', 'openai_api_key', 'openai_model', 'retrieval_count', 'similarity_threshold', 'query_message_count', 'auto_index', 'inject_context', 'injection_position', 'inject_after_messages', 'exclude_last_messages', 'user_blacklist', 'max_token_budget', 'tracker_enabled', 'tracker_hud', 'tracker_time_step', 'tracker_inline', 'tracker_start_date'];
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
                if (id === 'tracker_hud') tracker_updateHud();
                if (id === 'tracker_start_date') tracker_initDate(); // Reset date logic on change
                saveSettings();
            });
        }
    });
    
    // Manual Overrides listeners
    ['loc', 'wear', 'tone'].forEach(field => {
        document.getElementById('ft_manual_' + field)?.addEventListener('change', function() {
            const val = this.value;
            if (field === 'loc') window.RagTrackerState.location = val;
            if (field === 'wear') window.RagTrackerState.clothing = val;
            if (field === 'tone') window.RagTrackerState.tone = val;
            tracker_updateHud();
        });
    });

    document.getElementById('ragfordummies_embedding_provider')?.addEventListener('change', function() {
        const provider = this.value;
        document.getElementById('ragfordummies_kobold_settings').style.display = provider === 'kobold' ? '' : 'none';
        document.getElementById('ragfordummies_ollama_settings').style.display = provider === 'ollama' ? '' : 'none';
        document.getElementById('ragfordummies_openai_settings').style.display = provider === 'openai' ? '' : 'none';
    });
    document.getElementById('ragfordummies_index_current')?.addEventListener('click', async () => {
        try {
            const chatId = getCurrentChatId();
            if (!chatId) { updateUI('status', '✗ No active chat found'); return; }
            await indexChat(convertChatToJSONL(SillyTavern.getContext()), chatId, isCurrentChatGroupChat());
            currentChatIndexed = true;
        } catch (error) { updateUI('status', '✗ Indexing failed: ' + error.message); }
    });
    document.getElementById('ragfordummies_force_reindex')?.addEventListener('click', async () => {
        if (!confirm('This will delete and rebuild the index. Continue?')) return;
        try { await forceReindexCurrentChat(); updateUI('status', '✓ Force re-index complete!'); } catch (error) { updateUI('status', '✗ Force re-index failed: ' + error.message); }
    });
    document.getElementById('ragfordummies_stop_indexing')?.addEventListener('click', () => { shouldStopIndexing = true; updateUI('status', 'Stopping...'); });
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
                if (!isTxt && !isJsonl) throw new Error('Unsupported file type');
                const shouldMerge = document.getElementById('ragfordummies_merge_uploads')?.checked;
                let targetChatId = shouldMerge ? getCurrentChatId() : Date.now().toString();
                const jsonlToIndex = isTxt ? convertTextToJSONL(content) : content;
                if (!shouldMerge) { const parsed = parseJSONL(jsonlToIndex); if (parsed.chatMetadata?.chat_id_hash) targetChatId = parsed.chatMetadata.chat_id_hash; }
                await indexChat(jsonlToIndex, targetChatId, shouldMerge ? isCurrentChatGroupChat() : false);
                updateUI('status', shouldMerge ? '✓ Merged into current chat!' : '✓ Uploaded file indexed.');
            } catch (error) { updateUI('status', 'Upload failed: ' + error.message); }
            fileInput.value = '';
        });
    }
}

function saveSettings() { localStorage.setItem(MODULE_NAME + '_settings', JSON.stringify(extensionSettings)); }
function loadSettings() {
    const saved = localStorage.getItem(MODULE_NAME + '_settings');
    if (saved) { try { extensionSettings = { ...defaultSettings, ...JSON.parse(saved) }; } catch (error) {} }
}

async function init() {
    loadSettings();
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = null;
    injectTrackerCSS();
    tracker_initDate(); // Init the date logic
    
    // Load NLP
    async function loadNlpLibrary() {
        return new Promise((resolve) => {
            if (typeof window.nlp !== 'undefined') return resolve();
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/compromise';
            script.onload = resolve;
            script.onerror = resolve; // degrade gracefully
            document.head.appendChild(script);
        });
    }
    await loadNlpLibrary();
    
    const settingsHtml = createSettingsUI();
    $('#extensions_settings').append(settingsHtml);
    
    // FIX UI BUBBLING - USING HARDCODED IDs TO BE SAFE
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
    let eventSourceToUse = typeof eventSource !== 'undefined' ? eventSource : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.().eventSource : null);

    if (eventSourceToUse) {
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
        // Tracker Hooks - Using String Literals to avoid 'undefined' error
        eventSourceToUse.on('text_generation_prompt_preparation', tracker_onPromptGeneration);
        eventSourceToUse.on('chat_completion_processed', tracker_onReplyProcessed);
        eventsRegistered = true;
    } else {
        usePolling = true;
    }
    if (extensionSettings.autoIndex) await startPolling();
    setTimeout(async () => {
        const chatId = getCurrentChatId();
        if (chatId && !currentChatIndexed) {
            try { if (await countPoints((isCurrentChatGroupChat() ? 'st_groupchat_' : 'st_chat_') + chatId) > 0) currentChatIndexed = true; } catch (e) {}
        }
    }, 500);
    tracker_updateSettingsDebug(); // Update settings view on load
    updateUI('status', 'Extension loaded');
}

jQuery(async function() { setTimeout(init, 100); });
