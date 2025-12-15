/**
 * RagForDummies - A RAG extension for SillyTavern that actually works
 * Supports group chats with Qdrant vector storage
 */

const MODULE_NAME = 'RagForDummies';

// Extension settings with defaults
const defaultSettings = {
    enabled: true,
    qdrantMode: 'local', // 'local' or 'cloud'
    qdrantLocalUrl: 'http://localhost:6333',
    qdrantCloudUrl: '',
    qdrantApiKey: '',
    embeddingProvider: 'kobold', // 'kobold', 'ollama', or 'openai'
    koboldUrl: 'http://localhost:5001',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    openaiApiKey: '',
    openaiModel: 'text-embedding-3-small',
    retrievalCount: 5,
    similarityThreshold: 0.7,
    autoIndex: true,
    injectContext: true
};

let extensionSettings = { ...defaultSettings };
let isIndexing = false;
let shouldStopIndexing = false;
let currentChatIndexed = false;
let lastMessageCount = 0;
let lastChatId = null;
let pollingInterval = null;
let indexedMessageIds = new Set(); // Track which messages we've already indexed

// ===========================
// Utility Functions
// ===========================

function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ===========================
// Qdrant Client Functions
// ===========================

async function qdrantRequest(endpoint, method = 'GET', body = null) {
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
        method,
        headers,
        body: body ? JSON.stringify(body) : null
    };
    
    try {
        const response = await fetch(`${baseUrl}${endpoint}`, options);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Qdrant error: ${response.status} - ${error}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`[${MODULE_NAME}] Qdrant request failed:`, error);
        throw error;
    }
}

async function createCollection(collectionName, vectorSize = 1536) {
    try {
        // Check if collection exists
        const collections = await qdrantRequest('/collections');
        const exists = collections.result.collections.some(c => c.name === collectionName);
        
        if (exists) {
            console.log(`[${MODULE_NAME}] Collection ${collectionName} already exists`);
            return true;
        }
        
        // Create collection
        await qdrantRequest('/collections/' + collectionName, 'PUT', {
            vectors: {
                size: vectorSize,
                distance: 'Cosine'
            }
        });
        
        console.log(`[${MODULE_NAME}] Created collection: ${collectionName}`);
        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to create collection:`, error);
        throw error;
    }
}

async function upsertVectors(collectionName, points) {
    try {
        await qdrantRequest(`/collections/${collectionName}/points`, 'PUT', {
            points
        });
        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to upsert vectors:`, error);
        throw error;
    }
}

async function searchVectors(collectionName, vector, limit = 5, scoreThreshold = 0.7) {
    try {
        const result = await qdrantRequest(`/collections/${collectionName}/points/search`, 'POST', {
            vector,
            limit,
            score_threshold: scoreThreshold,
            with_payload: true
        });
        return result.result || [];
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to search vectors:`, error);
        return [];
    }
}

async function getCollectionInfo(collectionName) {
    try {
        const result = await qdrantRequest(`/collections/${collectionName}`);
        return result.result;
    } catch (error) {
        // Collection doesn't exist
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

// ===========================
// Embedding Provider Functions
// ===========================

async function generateEmbedding(text) {
    const provider = extensionSettings.embeddingProvider;
    
    try {
        switch (provider) {
            case 'kobold':
                return await generateKoboldEmbedding(text);
            case 'ollama':
                return await generateOllamaEmbedding(text);
            case 'openai':
                return await generateOpenAIEmbedding(text);
            default:
                throw new Error(`Unknown embedding provider: ${provider}`);
        }
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to generate embedding:`, error);
        throw error;
    }
}

async function generateKoboldEmbedding(text) {
    const response = await fetch(`${extensionSettings.koboldUrl}/api/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            input: text,
            model: "text-embedding-ada-002"
        })
    });
    
    if (!response.ok) throw new Error(`KoboldCpp API error: ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
}

async function generateOllamaEmbedding(text) {
    const response = await fetch(`${extensionSettings.ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            model: extensionSettings.ollamaModel,
            prompt: text 
        })
    });
    
    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);
    const data = await response.json();
    return data.embedding;
}

async function generateOpenAIEmbedding(text) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${extensionSettings.openaiApiKey}`
        },
        body: JSON.stringify({
            model: extensionSettings.openaiModel,
            input: text
        })
    });
    
    if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
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
    
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed.chat_metadata) {
                chatMetadata = parsed.chat_metadata;
            } else if (parsed.mes) {
                messages.push(parsed);
            }
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to parse JSONL line:`, error);
        }
    }
    return { chatMetadata, messages };
}

function buildEmbeddingText(message, tracker) {
    const parts = [];
    parts.push(`[Character: ${message.name}]`);
    if (tracker) {
        if (tracker.Time) parts.push(`[Time: ${tracker.Time}]`);
        if (tracker.Topics?.PrimaryTopic) parts.push(`[Topic: ${tracker.Topics.PrimaryTopic}]`);
    }
    if (message.extra?.qvink_memory?.memory) {
        parts.push(`\nSummary: ${message.extra.qvink_memory.memory}`);
    }
    parts.push(`\nMessage: ${message.mes}`);
    return parts.join(' ');
}

function extractPayload(message, messageIndex, chatIdHash) {
    const tracker = message.tracker || {};
    return {
        chat_id_hash: chatIdHash,
        message_index: messageIndex,
        character_name: message.name,
        is_user: message.is_user || false,
        timestamp: message.send_date || '',
        full_message: message.mes,
        topic: tracker.Topics?.PrimaryTopic || ''
    };
}

async function indexChat(jsonlContent, chatIdHash, isGroupChat = false) {
    if (isIndexing) {
        console.log(`[${MODULE_NAME}] Already indexing, please wait...`);
        return false;
    }
    
    isIndexing = true;
    shouldStopIndexing = false; // Reset stop flag
    showStopButton();
    updateUI('status', 'Indexing chat...');
    
    try {
        const { messages } = parseJSONL(jsonlContent);
        if (messages.length === 0) throw new Error('No messages found in chat');
        
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = `${prefix}${chatIdHash}`;
        
        // Get embedding size from first message
        const firstEmbedding = await generateEmbedding(buildEmbeddingText(messages[0], messages[0].tracker));
        await createCollection(collectionName, firstEmbedding.length);
        
        const batchSize = 10;
        let points = [];
        
        for (let i = 0; i < messages.length; i++) {
            // CHECK STOP FLAG
            if (shouldStopIndexing) {
                console.log(`[${MODULE_NAME}] Indexing stopped by user.`);
                updateUI('status', 'Indexing stopped by user.');
                return false; // Stop execution
            }

            const message = messages[i];
            updateUI('status', `Indexing message ${i + 1}/${messages.length}...`);
            
            const embeddingText = buildEmbeddingText(message, message.tracker);
            const embedding = await generateEmbedding(embeddingText);
            const payload = extractPayload(message, i, chatIdHash);
            
            points.push({
                id: generateUUID(),
                vector: embedding,
                payload
            });
            
            if (points.length >= batchSize) {
                await upsertVectors(collectionName, points);
                points = [];
            }
        }
        
        if (points.length > 0) {
            await upsertVectors(collectionName, points);
        }
        
        updateUI('status', `Successfully indexed ${messages.length} messages!`);
        console.log(`[${MODULE_NAME}] Indexed ${messages.length} messages to ${collectionName}`);
        return true;

    } catch (error) {
        console.error(`[${MODULE_NAME}] Indexing failed:`, error);
        updateUI('status', `Indexing failed: ${error.message}`);
        throw error;
    } finally {
        isIndexing = false;
        hideStopButton();
    }
}

async function indexSingleMessage(message, chatIdHash, messageIndex, isGroupChat = false) {
    try {
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = `${prefix}${chatIdHash}`;
        
        const embeddingText = buildEmbeddingText(message, message.tracker);
        const embedding = await generateEmbedding(embeddingText);
        const payload = extractPayload(message, messageIndex, chatIdHash);
        
        await upsertVectors(collectionName, [{
            id: generateUUID(),
            vector: embedding,
            payload
        }]);
        console.log(`[${MODULE_NAME}] Indexed message ${messageIndex}`);
        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to index message:`, error);
        return false;
    }
}

// ===========================
// Context Retrieval
// ===========================

async function retrieveContext(query, chatIdHash, isGroupChat = false) {
    try {
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = `${prefix}${chatIdHash}`;
        
        const queryEmbedding = await generateEmbedding(query);
        const results = await searchVectors(
            collectionName,
            queryEmbedding,
            extensionSettings.retrievalCount,
            extensionSettings.similarityThreshold
        );
        
        if (results.length === 0) return '';
        
        const contextParts = results.map(result => {
            const p = result.payload;
            const summary = p.summary ? `\nSummary: ${p.summary}` : '';
            return `[${p.character_name}]${summary}\nMessage: ${p.full_message}`;
        });
        
        return `\n\n=== Relevant Past Context ===\n${contextParts.join('\n\n---\n\n')}\n=== End Context ===\n\n`;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Context retrieval failed:`, error);
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
            if (context.chatMetadata?.chat_id_hash) return context.chatMetadata.chat_id_hash;
            if (context.chat_id) return context.chat_id;
        }
        if (typeof getContext === 'function') {
            const context = getContext();
            if (context.chatMetadata?.chat_id_hash) return context.chatMetadata.chat_id_hash;
            if (context.chat_id) return context.chat_id;
        }
        // Removed console.log here to prevent loop spam
        return null;
    } catch (error) {
        return null;
    }
}

function isCurrentChatGroupChat() {
    try {
        let context = null;
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) context = SillyTavern.getContext();
        else if (typeof getContext === 'function') context = getContext();
        
        return context ? (context.groupId !== null && context.groupId !== undefined) : false;
    } catch (error) {
        return false;
    }
}

async function onChatLoaded() {
    currentChatIndexed = false;
    lastMessageCount = 0;
    indexedMessageIds.clear();
    
    const chatId = getCurrentChatId();
    lastChatId = chatId;
    
    console.log('[' + MODULE_NAME + '] Chat loaded. ID:', chatId);
    updateUI('status', 'Chat loaded - ready');
    
    try {
        let context = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
        if (context && context.chat) {
            lastMessageCount = context.chat.length;
        }
    } catch (e) {}
}

async function onMessageSent(messageData) {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) return;
    
    const chatId = getCurrentChatId();
    if (!chatId) return;
    
    const isGroupChat = isCurrentChatGroupChat();
    
    // Auto-index entire chat on first message if not already indexed
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
    
    // Index the new message
    if (currentChatIndexed) {
        const context = SillyTavern.getContext();
        const messageIndex = context.chat.length - 1;
        // The messageData from hook might be partial, safe to fetch from context
        const fullMessage = context.chat[messageIndex];
        await indexSingleMessage(fullMessage, chatId, messageIndex, isGroupChat);
    }
}

async function injectContextBeforeGeneration(data) {
    if (!extensionSettings.enabled || !extensionSettings.injectContext) return;
    
    const chatId = getCurrentChatId();
    if (!chatId || !currentChatIndexed) return;
    
    const isGroupChat = isCurrentChatGroupChat();
    
    try {
        const context = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
        if (!context || !context.chat || context.chat.length === 0) return;
        
        const recentMessages = context.chat.slice(-3);
        const query = recentMessages.map(m => m.mes).join(' ');
        
        updateUI('status', 'Retrieving context...');
        const retrievedContext = await retrieveContext(query, chatId, isGroupChat);
        
        if (retrievedContext) {
            if (typeof setExtensionPrompt === 'function') {
                setExtensionPrompt(MODULE_NAME, retrievedContext, 1, 0);
                updateUI('status', 'Context injected');
            } else if (typeof window.setExtensionPrompt === 'function') {
                window.setExtensionPrompt(MODULE_NAME, retrievedContext, 1, 0);
                updateUI('status', 'Context injected');
            }
        } else {
            updateUI('status', 'No relevant context found');
        }
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Context injection error:', error);
    }
}

// Polling mechanism to detect new messages (Fallback)
async function pollForNewMessages() {
    if (!extensionSettings.enabled || !extensionSettings.autoIndex || isIndexing) return;
    
    try {
        const context = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : getContext();
        if (!context || !context.chat) return;
        
        const chatId = getCurrentChatId();
        if (!chatId) return;
        
        // Handle Chat Change
        if (lastChatId !== chatId) {
            lastChatId = chatId;
            currentChatIndexed = false;
            lastMessageCount = 0;
            indexedMessageIds.clear();
            
            const isGroupChat = isCurrentChatGroupChat();
            const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
            const existingPoints = await countPoints(prefix + chatId);
            
            if (existingPoints > 0) {
                currentChatIndexed = true;
                lastMessageCount = context.chat.length;
                updateUI('status', 'Chat already indexed');
            }
        }
        
        // Handle New Messages
        const currentMessageCount = context.chat.length;
        if (currentMessageCount > lastMessageCount) {
            const isGroupChat = isCurrentChatGroupChat();
            
            if (!currentChatIndexed) {
                // Try to auto-index
                const jsonl = convertChatToJSONL(context);
                // If this fails, we catch it so we don't loop forever crashing
                try {
                    await indexChat(jsonl, chatId, isGroupChat);
                    currentChatIndexed = true;
                } catch (idxErr) {
                    console.error("Auto-index failed during polling", idxErr);
                    // Update count so we don't retry immediately
                    lastMessageCount = currentMessageCount; 
                    return; 
                }
            } else {
                // Index incremental
                for (let i = lastMessageCount; i < currentMessageCount; i++) {
                    if (!indexedMessageIds.has(i)) {
                        await indexSingleMessage(context.chat[i], chatId, i, isGroupChat);
                        indexedMessageIds.add(i);
                    }
                }
            }
            lastMessageCount = currentMessageCount;
            updateUI('status', 'Indexed new messages');
        }
    } catch (error) {
        // Silent fail to avoid console loop
    }
}

async function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(pollForNewMessages, 5000);
}

function convertChatToJSONL(context) {
    const lines = [];
    if (context.chatMetadata) lines.push(JSON.stringify({ chat_metadata: context.chatMetadata }));
    if (context.chat) context.chat.forEach(message => lines.push(JSON.stringify(message)));
    return lines.join('\n');
}

// ===========================
// UI Functions
// ===========================

function showStopButton() {
    const btn = document.getElementById('ragfordummies_stop_indexing');
    if (btn) btn.style.display = 'block';
}

function hideStopButton() {
    const btn = document.getElementById('ragfordummies_stop_indexing');
    if (btn) btn.style.display = 'none';
}

function updateUI(element, value) {
    const el = document.getElementById(`ragfordummies_${element}`);
    if (el) {
        if (element === 'status') el.textContent = value;
        else el.value = value;
    }
}

function createSettingsUI() {
    // Note: Added the Stop Indexing button with specific red styling
    const html = `
        <div id="ragfordummies_container" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>RagForDummies</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="ragfordummies-settings">
                    <div class="ragfordummies-section">
                        <label class="checkbox_label">
                            <input type="checkbox" id="ragfordummies_enabled" ${extensionSettings.enabled ? 'checked' : ''} />
                            Enable RAG
                        </label>
                    </div>
            
            <div class="ragfordummies-section">
                <h4>Qdrant Configuration</h4>
                <label>Mode: <select id="ragfordummies_qdrant_mode"><option value="local">Local</option><option value="cloud">Cloud</option></select></label>
                <label>Local URL: <input type="text" id="ragfordummies_qdrant_local_url" value="${extensionSettings.qdrantLocalUrl}" /></label>
                <label>Cloud URL: <input type="text" id="ragfordummies_qdrant_cloud_url" value="${extensionSettings.qdrantCloudUrl}" /></label>
                <label>API Key: <input type="password" id="ragfordummies_qdrant_api_key" value="${extensionSettings.qdrantApiKey}" /></label>
            </div>
            
            <div class="ragfordummies-section">
                <h4>Embedding Provider</h4>
                <label>Provider: <select id="ragfordummies_embedding_provider">
                    <option value="kobold">KoboldCpp</option><option value="ollama">Ollama</option><option value="openai">OpenAI</option>
                </select></label>
                
                <div id="ragfordummies_kobold_settings">
                    <label>Kobold URL: <input type="text" id="ragfordummies_kobold_url" value="${extensionSettings.koboldUrl}" /></label>
                </div>
                <div id="ragfordummies_ollama_settings" style="display:none">
                    <label>Ollama URL: <input type="text" id="ragfordummies_ollama_url" value="${extensionSettings.ollamaUrl}" /></label>
                    <label>Model: <input type="text" id="ragfordummies_ollama_model" value="${extensionSettings.ollamaModel}" /></label>
                </div>
                <div id="ragfordummies_openai_settings" style="display:none">
                    <label>API Key: <input type="password" id="ragfordummies_openai_api_key" value="${extensionSettings.openaiApiKey}" /></label>
                </div>
            </div>
            
            <div class="ragfordummies-section">
                <h4>RAG Settings</h4>
                <label>Retrieval Count: <input type="number" id="ragfordummies_retrieval_count" value="${extensionSettings.retrievalCount}" /></label>
                <label>Threshold: <input type="number" id="ragfordummies_similarity_threshold" value="${extensionSettings.similarityThreshold}" step="0.1" /></label>
                <label class="checkbox_label"><input type="checkbox" id="ragfordummies_inject_context" ${extensionSettings.injectContext ? 'checked' : ''} /> Inject Context</label>
            </div>
            
            <div class="ragfordummies-section">
                <button id="ragfordummies_test_qdrant" class="menu_button">Test Connection</button>
                <hr>
                <button id="ragfordummies_index_current" class="menu_button">Index Current Chat</button>
                <button id="ragfordummies_stop_indexing" class="menu_button" style="display:none; background-color: #a00; color: white; font-weight: bold;">STOP INDEXING</button>
                <div id="ragfordummies_status" class="ragfordummies-status" style="margin-top:5px; font-style:italic;">Ready</div>
            </div>
                </div>
            </div>
        </div>
    `;
    return html;
}

function attachEventListeners() {
    // Settings change handlers
    const inputs = ['enabled', 'qdrant_mode', 'qdrant_local_url', 'qdrant_cloud_url', 'qdrant_api_key', 'embedding_provider', 'kobold_url', 'ollama_url', 'ollama_model', 'openai_api_key', 'retrieval_count', 'similarity_threshold', 'inject_context'];
    
    inputs.forEach(id => {
        const el = document.getElementById(`ragfordummies_${id}`);
        if(el) el.addEventListener('change', () => {
            const key = id.replace(/_([a-z])/g, (m, l) => l.toUpperCase());
            extensionSettings[key] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? parseFloat(el.value) : el.value);
            saveSettings();
            
            // Handle UI toggles
            if(id === 'embedding_provider') {
                document.getElementById('ragfordummies_kobold_settings').style.display = el.value === 'kobold' ? '' : 'none';
                document.getElementById('ragfordummies_ollama_settings').style.display = el.value === 'ollama' ? '' : 'none';
                document.getElementById('ragfordummies_openai_settings').style.display = el.value === 'openai' ? '' : 'none';
            }
        });
    });

    // Test Buttons
    document.getElementById('ragfordummies_test_qdrant')?.addEventListener('click', async () => {
        try {
            updateUI('status', 'Testing...');
            const res = await qdrantRequest('/collections');
            updateUI('status', `Success! Found ${res.result.collections.length} collections.`);
        } catch(e) { updateUI('status', 'Connection Failed'); }
    });

    // Manual Index
    document.getElementById('ragfordummies_index_current')?.addEventListener('click', async () => {
        const chatId = getCurrentChatId();
        if(!chatId) return updateUI('status', 'No chat loaded');
        const context = SillyTavern.getContext();
        const jsonl = convertChatToJSONL(context);
        await indexChat(jsonl, chatId, isCurrentChatGroupChat());
    });

    // STOP BUTTON HANDLER
    document.getElementById('ragfordummies_stop_indexing')?.addEventListener('click', () => {
        shouldStopIndexing = true;
        updateUI('status', 'Stopping...');
    });
}

function saveSettings() {
    localStorage.setItem(`${MODULE_NAME}_settings`, JSON.stringify(extensionSettings));
}

function loadSettings() {
    const saved = localStorage.getItem(`${MODULE_NAME}_settings`);
    if (saved) extensionSettings = { ...defaultSettings, ...JSON.parse(saved) };
}

// ===========================
// Extension Initialization
// ===========================

async function init() {
    loadSettings();
    $('#extensions_settings').append(createSettingsUI());
    
    // UI Drawer Logic
    setTimeout(() => {
        const toggle = $('#ragfordummies_container .inline-drawer-toggle');
        const content = $('#ragfordummies_container .inline-drawer-content');
        content.hide();
        toggle.on('click', () => {
            toggle.find('.inline-drawer-icon').toggleClass('down up');
            content.slideToggle(200);
        });
        
        // Refresh provider UI state
        const provider = document.getElementById('ragfordummies_embedding_provider');
        if(provider) provider.dispatchEvent(new Event('change'));
    }, 500);
    
    attachEventListeners();
    
    // Event Registration
    if (typeof eventSource !== 'undefined') {
        console.log(`[${MODULE_NAME}] Registering Events...`);
        
        eventSource.on('chat_loaded', onChatLoaded);
        eventSource.on('message_sent', onMessageSent);
        // We do NOT use message_received for indexing, only for injection context prep if needed
        eventSource.on('GENERATE_BEFORE_COMBINE_PROMPTS', injectContextBeforeGeneration);
        eventSource.on('EXTENSION_PROMPT_REQUESTED', injectContextBeforeGeneration);
    } else {
        console.warn(`[${MODULE_NAME}] eventSource missing, falling back to polling.`);
        await startPolling();
    }
    
    console.log(`[${MODULE_NAME}] Loaded.`);
}

jQuery(async () => {
    setTimeout(init, 100);
});