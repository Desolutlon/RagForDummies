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
let currentChatIndexed = false;

// ===========================
// Utility Functions
// ===========================

function generateUUID() {
    // Generate a proper UUID v4
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
    // KoboldCpp uses OpenAI-compatible endpoint
    const response = await fetch(`${extensionSettings.koboldUrl}/api/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            input: text,
            model: "text-embedding-ada-002" // KoboldCpp ignores this but it's required
        })
    });
    
    if (!response.ok) {
        throw new Error(`KoboldCpp API error: ${response.status} - ${await response.text()}`);
    }
    
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
    
    if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
    }
    
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
    
    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
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
    
    for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
            const parsed = JSON.parse(line);
            
            // First line is chat metadata
            if (parsed.chat_metadata) {
                chatMetadata = parsed.chat_metadata;
            } else if (parsed.mes) {
                // This is a message
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
    
    // Character info
    parts.push(`[Character: ${message.name}]`);
    
    // Tracker metadata if available
    if (tracker) {
        if (tracker.Time) parts.push(`[Time: ${tracker.Time}]`);
        if (tracker.Topics?.PrimaryTopic) parts.push(`[Topic: ${tracker.Topics.PrimaryTopic}]`);
        if (tracker.Topics?.EmotionalTone) parts.push(`[Tone: ${tracker.Topics.EmotionalTone}]`);
    }
    
    // Summary if available (from qvink_memory)
    if (message.extra?.qvink_memory?.memory) {
        parts.push(`\nSummary: ${message.extra.qvink_memory.memory}`);
    }
    
    // Full message
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
        summary: message.extra?.qvink_memory?.memory || '',
        full_message: message.mes,
        topic: tracker.Topics?.PrimaryTopic || '',
        emotional_tone: tracker.Topics?.EmotionalTone || '',
        location: tracker.Characters?.[message.name]?.Location || ''
    };
}

async function indexChat(jsonlContent, chatIdHash, isGroupChat = false) {
    if (isIndexing) {
        console.log(`[${MODULE_NAME}] Already indexing, please wait...`);
        return false;
    }
    
    isIndexing = true;
    updateUI('status', 'Indexing chat...');
    
    try {
        const { chatMetadata, messages } = parseJSONL(jsonlContent);
        
        if (messages.length === 0) {
            throw new Error('No messages found in chat');
        }
        
        // Create collection name
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = `${prefix}${chatIdHash}`;
        
        // Get embedding size from first message
        const firstEmbedding = await generateEmbedding(buildEmbeddingText(messages[0], messages[0].tracker));
        const vectorSize = firstEmbedding.length;
        
        // Create collection
        await createCollection(collectionName, vectorSize);
        
        // Process messages in batches
        const batchSize = 10;
        const points = [];
        
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            updateUI('status', `Indexing message ${i + 1}/${messages.length}...`);
            
            const embeddingText = buildEmbeddingText(message, message.tracker);
            const embedding = await generateEmbedding(embeddingText);
            const payload = extractPayload(message, i, chatIdHash);
            
            points.push({
                id: generateUUID(), // Use proper UUID instead of string
                vector: embedding,
                payload
            });
            
            // Upsert in batches
            if (points.length >= batchSize) {
                await upsertVectors(collectionName, points);
                points.length = 0;
            }
        }
        
        // Upsert remaining points
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
    }
}

async function indexSingleMessage(message, chatIdHash, messageIndex, isGroupChat = false) {
    try {
        const prefix = isGroupChat ? 'st_groupchat_' : 'st_chat_';
        const collectionName = `${prefix}${chatIdHash}`;
        
        const embeddingText = buildEmbeddingText(message, message.tracker);
        const embedding = await generateEmbedding(embeddingText);
        const payload = extractPayload(message, messageIndex, chatIdHash);
        
        const point = {
            id: generateUUID(), // Use proper UUID
            vector: embedding,
            payload
        };
        
        await upsertVectors(collectionName, [point]);
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
        
        // Generate query embedding
        const queryEmbedding = await generateEmbedding(query);
        
        // Search for similar messages
        const results = await searchVectors(
            collectionName,
            queryEmbedding,
            extensionSettings.retrievalCount,
            extensionSettings.similarityThreshold
        );
        
        if (results.length === 0) {
            console.log(`[${MODULE_NAME}] No relevant context found`);
            return '';
        }
        
        // Format context for system prompt
        const contextParts = results.map(result => {
            const p = result.payload;
            const timestamp = p.timestamp ? ` - ${p.timestamp}` : '';
            const summary = p.summary ? `\nSummary: ${p.summary}` : '';
            
            return `[${p.character_name}${timestamp}]${summary}\nMessage: ${p.full_message}`;
        });
        
        const context = `\n\n=== Relevant Past Context ===\n${contextParts.join('\n\n---\n\n')}\n=== End Context ===\n\n`;
        
        console.log(`[${MODULE_NAME}] Retrieved ${results.length} relevant messages`);
        return context;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Context retrieval failed:`, error);
        return '';
    }
}

// ===========================
// SillyTavern Integration
// ===========================

function getCurrentChatId() {
    // Try multiple methods to get chat ID
    try {
        // Method 1: SillyTavern context
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const context = SillyTavern.getContext();
            console.log(`[${MODULE_NAME}] SillyTavern context:`, context);
            
            if (context.chatMetadata?.chat_id_hash) {
                console.log(`[${MODULE_NAME}] Found chat_id_hash:`, context.chatMetadata.chat_id_hash);
                return context.chatMetadata.chat_id_hash;
            }
            
            // Try alternative
            if (context.chat_id) {
                console.log(`[${MODULE_NAME}] Found chat_id:`, context.chat_id);
                return context.chat_id;
            }
        }
        
        // Method 2: Global getContext
        if (typeof getContext === 'function') {
            const context = getContext();
            console.log(`[${MODULE_NAME}] Global context:`, context);
            
            if (context.chatMetadata?.chat_id_hash) {
                return context.chatMetadata.chat_id_hash;
            }
            if (context.chat_id) {
                return context.chat_id;
            }
        }
        
        console.log(`[${MODULE_NAME}] No chat ID found via any method`);
        return null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error getting chat ID:`, error);
        return null;
    }
}

function isCurrentChatGroupChat() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const context = SillyTavern.getContext();
            const isGroup = context.groupId !== null && context.groupId !== undefined;
            console.log(`[${MODULE_NAME}] Is group chat:`, isGroup, 'groupId:', context.groupId);
            return isGroup;
        }
        
        if (typeof getContext === 'function') {
            const context = getContext();
            return context.groupId !== null && context.groupId !== undefined;
        }
        
        return false;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error checking group chat:`, error);
        return false;
    }
}

async function onChatLoaded() {
    currentChatIndexed = false;
    const chatId = getCurrentChatId();
    console.log(`[${MODULE_NAME}] Chat loaded event fired. Chat ID:`, chatId);
    updateUI('status', 'Chat loaded - ready to index');
}

async function onMessageSent(messageData) {
    console.log(`[${MODULE_NAME}] Message sent event fired`, messageData);
    
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) {
        console.log(`[${MODULE_NAME}] Auto-index disabled, skipping`);
        return;
    }
    
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.log(`[${MODULE_NAME}] No chat ID found`);
        return;
    }
    
    const isGroupChat = isCurrentChatGroupChat();
    console.log(`[${MODULE_NAME}] Processing message for chat ${chatId}, isGroupChat: ${isGroupChat}`);
    
    // Auto-index entire chat on first message if not already indexed
    if (!currentChatIndexed && typeof SillyTavern !== 'undefined') {
        try {
            updateUI('status', 'Auto-indexing chat...');
            const context = SillyTavern.getContext();
            if (context.chat && context.chat.length > 0) {
                // Convert chat to JSONL format
                const jsonl = convertChatToJSONL(context);
                await indexChat(jsonl, chatId, isGroupChat);
                currentChatIndexed = true;
            }
        } catch (error) {
            console.error(`[${MODULE_NAME}] Auto-indexing failed:`, error);
            updateUI('status', `Auto-index failed: ${error.message}`);
        }
    }
    
    // Index the new message
    if (messageData && currentChatIndexed) {
        const messageIndex = SillyTavern.getContext().chat.length - 1;
        await indexSingleMessage(messageData, chatId, messageIndex, isGroupChat);
    }
}

async function onMessageReceived(messageData) {
    if (!extensionSettings.enabled || !extensionSettings.injectContext) return;
    
    const chatId = getCurrentChatId();
    if (!chatId || !currentChatIndexed) return;
    
    const isGroupChat = isCurrentChatGroupChat();
    
    // Generate query from recent messages
    const context = SillyTavern.getContext();
    const recentMessages = context.chat.slice(-3);
    const query = recentMessages.map(m => m.mes).join(' ');
    
    // Retrieve and inject context
    const retrievedContext = await retrieveContext(query, chatId, isGroupChat);
    
    if (retrievedContext && typeof setExtensionPrompt === 'function') {
        setExtensionPrompt(MODULE_NAME, retrievedContext, 1, 0);
    }
}

function convertChatToJSONL(context) {
    const lines = [];
    
    // Add chat metadata
    if (context.chatMetadata) {
        lines.push(JSON.stringify({ chat_metadata: context.chatMetadata }));
    }
    
    // Add messages
    if (context.chat) {
        context.chat.forEach(message => {
            lines.push(JSON.stringify(message));
        });
    }
    
    return lines.join('\n');
}

// ===========================
// UI Functions
// ===========================

function updateUI(element, value) {
    const el = document.getElementById(`ragfordummies_${element}`);
    if (el) {
        if (element === 'status') {
            el.textContent = value;
        } else {
            el.value = value;
        }
    }
}

function createSettingsUI() {
    const html = `
        <div class="ragfordummies-settings">
            <h3>RagForDummies Settings</h3>
            
            <div class="ragfordummies-section">
                <label class="checkbox_label">
                    <input type="checkbox" id="ragfordummies_enabled" ${extensionSettings.enabled ? 'checked' : ''} />
                    Enable RAG
                </label>
            </div>
            
            <div class="ragfordummies-section">
                <h4>Qdrant Configuration</h4>
                <label>
                    <span>Mode:</span>
                    <select id="ragfordummies_qdrant_mode">
                        <option value="local" ${extensionSettings.qdrantMode === 'local' ? 'selected' : ''}>Local (Docker)</option>
                        <option value="cloud" ${extensionSettings.qdrantMode === 'cloud' ? 'selected' : ''}>Cloud</option>
                    </select>
                </label>
                
                <label>
                    <span>Local URL:</span>
                    <input type="text" id="ragfordummies_qdrant_local_url" value="${extensionSettings.qdrantLocalUrl}" placeholder="http://localhost:6333" />
                </label>
                
                <label>
                    <span>Cloud URL:</span>
                    <input type="text" id="ragfordummies_qdrant_cloud_url" value="${extensionSettings.qdrantCloudUrl}" placeholder="https://your-cluster.qdrant.io" />
                </label>
                
                <label>
                    <span>Cloud API Key:</span>
                    <input type="password" id="ragfordummies_qdrant_api_key" value="${extensionSettings.qdrantApiKey}" placeholder="Your Qdrant API key" />
                </label>
            </div>
            
            <div class="ragfordummies-section">
                <h4>Embedding Provider</h4>
                <label>
                    <span>Provider:</span>
                    <select id="ragfordummies_embedding_provider">
                        <option value="kobold" ${extensionSettings.embeddingProvider === 'kobold' ? 'selected' : ''}>KoboldCpp</option>
                        <option value="ollama" ${extensionSettings.embeddingProvider === 'ollama' ? 'selected' : ''}>Ollama</option>
                        <option value="openai" ${extensionSettings.embeddingProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
                    </select>
                </label>
                
                <label id="ragfordummies_kobold_settings" style="${extensionSettings.embeddingProvider === 'kobold' ? '' : 'display:none'}">
                    <span>KoboldCpp URL:</span>
                    <input type="text" id="ragfordummies_kobold_url" value="${extensionSettings.koboldUrl}" placeholder="http://localhost:5001" />
                </label>
                
                <div id="ragfordummies_ollama_settings" style="${extensionSettings.embeddingProvider === 'ollama' ? '' : 'display:none'}">
                    <label>
                        <span>Ollama URL:</span>
                        <input type="text" id="ragfordummies_ollama_url" value="${extensionSettings.ollamaUrl}" placeholder="http://localhost:11434" />
                    </label>
                    <label>
                        <span>Ollama Model:</span>
                        <input type="text" id="ragfordummies_ollama_model" value="${extensionSettings.ollamaModel}" placeholder="nomic-embed-text" />
                    </label>
                </div>
                
                <div id="ragfordummies_openai_settings" style="${extensionSettings.embeddingProvider === 'openai' ? '' : 'display:none'}">
                    <label>
                        <span>OpenAI API Key:</span>
                        <input type="password" id="ragfordummies_openai_api_key" value="${extensionSettings.openaiApiKey}" placeholder="sk-..." />
                    </label>
                    <label>
                        <span>OpenAI Model:</span>
                        <input type="text" id="ragfordummies_openai_model" value="${extensionSettings.openaiModel}" placeholder="text-embedding-3-small" />
                    </label>
                </div>
            </div>
            
            <div class="ragfordummies-section">
                <h4>RAG Settings</h4>
                <label>
                    <span>Retrieval Count:</span>
                    <input type="number" id="ragfordummies_retrieval_count" value="${extensionSettings.retrievalCount}" min="1" max="20" />
                </label>
                
                <label>
                    <span>Similarity Threshold:</span>
                    <input type="number" id="ragfordummies_similarity_threshold" value="${extensionSettings.similarityThreshold}" min="0" max="1" step="0.1" />
                </label>
                
                <label class="checkbox_label">
                    <input type="checkbox" id="ragfordummies_auto_index" ${extensionSettings.autoIndex ? 'checked' : ''} />
                    Auto-index on first message
                </label>
                
                <label class="checkbox_label">
                    <input type="checkbox" id="ragfordummies_inject_context" ${extensionSettings.injectContext ? 'checked' : ''} />
                    Inject context into system prompt
                </label>
            </div>
            
            <div class="ragfordummies-section">
                <h4>Connection Tests</h4>
                <button id="ragfordummies_test_qdrant" class="menu_button">Test Qdrant Connection</button>
                <button id="ragfordummies_test_embedding" class="menu_button">Test Embedding Provider</button>
            </div>
            
            <div class="ragfordummies-section">
                <h4>Manual Operations</h4>
                <button id="ragfordummies_index_current" class="menu_button">Index Current Chat</button>
                <button id="ragfordummies_upload_btn" class="menu_button">Upload Chat JSONL</button>
                <input type="file" id="ragfordummies_file_input" accept=".jsonl" style="display:none" />
                <div id="ragfordummies_status" class="ragfordummies-status">Ready</div>
            </div>
        </div>
    `;
    
    return html;
}

function attachEventListeners() {
    // Save settings on change
    const settingIds = [
        'enabled', 'qdrant_mode', 'qdrant_local_url', 'qdrant_cloud_url', 'qdrant_api_key',
        'embedding_provider', 'kobold_url', 'ollama_url', 'ollama_model', 
        'openai_api_key', 'openai_model', 'retrieval_count', 'similarity_threshold',
        'auto_index', 'inject_context'
    ];
    
    settingIds.forEach(id => {
        const element = document.getElementById(`ragfordummies_${id}`);
        if (element) {
            element.addEventListener('change', () => {
                const key = id.replace(/_([a-z])/g, (m, l) => l.toUpperCase());
                
                if (element.type === 'checkbox') {
                    extensionSettings[key] = element.checked;
                } else if (element.type === 'number') {
                    extensionSettings[key] = parseFloat(element.value);
                } else {
                    extensionSettings[key] = element.value;
                }
                
                saveSettings();
            });
        }
    });
    
    // Provider selection toggles
    const providerSelect = document.getElementById('ragfordummies_embedding_provider');
    if (providerSelect) {
        providerSelect.addEventListener('change', () => {
            const provider = providerSelect.value;
            document.getElementById('ragfordummies_kobold_settings').style.display = provider === 'kobold' ? '' : 'none';
            document.getElementById('ragfordummies_ollama_settings').style.display = provider === 'ollama' ? '' : 'none';
            document.getElementById('ragfordummies_openai_settings').style.display = provider === 'openai' ? '' : 'none';
        });
    }
    
    // Test Qdrant connection
    const testQdrantBtn = document.getElementById('ragfordummies_test_qdrant');
    if (testQdrantBtn) {
        testQdrantBtn.addEventListener('click', async () => {
            updateUI('status', 'Testing Qdrant connection...');
            try {
                const result = await qdrantRequest('/collections');
                updateUI('status', `✓ Qdrant connected! Found ${result.result.collections.length} collections`);
                console.log(`[${MODULE_NAME}] Qdrant test successful:`, result);
            } catch (error) {
                updateUI('status', `✗ Qdrant connection failed: ${error.message}`);
                console.error(`[${MODULE_NAME}] Qdrant test failed:`, error);
            }
        });
    }
    
    // Test embedding provider
    const testEmbeddingBtn = document.getElementById('ragfordummies_test_embedding');
    if (testEmbeddingBtn) {
        testEmbeddingBtn.addEventListener('click', async () => {
            updateUI('status', 'Testing embedding provider...');
            try {
                const embedding = await generateEmbedding('This is a test message');
                updateUI('status', `✓ Embedding provider working! Vector size: ${embedding.length}`);
                console.log(`[${MODULE_NAME}] Embedding test successful, dimension:`, embedding.length);
            } catch (error) {
                updateUI('status', `✗ Embedding failed: ${error.message}`);
                console.error(`[${MODULE_NAME}] Embedding test failed:`, error);
            }
        });
    }
    
    // Index current chat
    const indexCurrentBtn = document.getElementById('ragfordummies_index_current');
    if (indexCurrentBtn) {
        indexCurrentBtn.addEventListener('click', async () => {
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
                updateUI('status', `✗ Indexing failed: ${error.message}`);
                console.error(`[${MODULE_NAME}] Manual indexing failed:`, error);
            }
        });
    }
    
    // File upload
    const uploadBtn = document.getElementById('ragfordummies_upload_btn');
    const fileInput = document.getElementById('ragfordummies_file_input');
    
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
        
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                const content = await file.text();
                const { chatMetadata } = parseJSONL(content);
                const chatId = chatMetadata?.chat_id_hash || Date.now();
                const isGroupChat = file.name.includes('group') || chatMetadata?.groupId !== undefined;
                
                await indexChat(content, chatId, isGroupChat);
            } catch (error) {
                console.error(`[${MODULE_NAME}] Upload failed:`, error);
                updateUI('status', `Upload failed: ${error.message}`);
            }
            
            fileInput.value = '';
        });
    }
}

function saveSettings() {
    localStorage.setItem(`${MODULE_NAME}_settings`, JSON.stringify(extensionSettings));
    console.log(`[${MODULE_NAME}] Settings saved`);
}

function loadSettings() {
    const saved = localStorage.getItem(`${MODULE_NAME}_settings`);
    if (saved) {
        try {
            extensionSettings = { ...defaultSettings, ...JSON.parse(saved) };
            console.log(`[${MODULE_NAME}] Settings loaded`);
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to load settings:`, error);
        }
    }
}

// ===========================
// Extension Initialization
// ===========================

async function init() {
    loadSettings();
    
    // Add settings to UI
    const settingsHtml = createSettingsUI();
    const container = $('<div id="ragfordummies_container"></div>');
    container.html(settingsHtml);
    
    // Find and append to extensions settings
    const extensionsSettings = $('#extensions_settings');
    if (extensionsSettings.length === 0) {
        console.error(`[${MODULE_NAME}] Extensions settings panel not found`);
        // Try alternative
        $('#extensions_settings2').append(container);
    } else {
        extensionsSettings.append(container);
    }
    
    attachEventListeners();
    
    // Register event handlers - try multiple methods
    console.log(`[${MODULE_NAME}] Registering event handlers...`);
    
    // Method 1: Standard eventSource
    if (typeof eventSource !== 'undefined') {
        console.log(`[${MODULE_NAME}] Attempting to register eventSource handlers`);
        
        // Try various event names
        const eventNames = [
            'chat_loaded',
            'message_sent', 
            'message_received',
            'CHARACTER_MESSAGE_RENDERED',
            'CHAT_CHANGED',
            'MESSAGE_SENT',
            'MESSAGE_RECEIVED',
            'USER_MESSAGE_RENDERED'
        ];
        
        eventNames.forEach(eventName => {
            eventSource.on(eventName, (data) => {
                console.log(`[${MODULE_NAME}] Event fired: ${eventName}`, data);
                
                if (eventName.toLowerCase().includes('chat') || eventName.toLowerCase().includes('loaded')) {
                    onChatLoaded();
                } else if (eventName.toLowerCase().includes('sent')) {
                    onMessageSent(data);
                } else if (eventName.toLowerCase().includes('received') || eventName.toLowerCase().includes('rendered')) {
                    onMessageReceived(data);
                }
            });
        });
        
        console.log(`[${MODULE_NAME}] Registered listeners for events: ${eventNames.join(', ')}`);
    } else {
        console.warn(`[${MODULE_NAME}] eventSource not available`);
    }
    
    // Method 2: Hook into generation
    if (typeof window.generateQuietPrompt !== 'undefined') {
        console.log(`[${MODULE_NAME}] Found generateQuietPrompt, attempting to hook`);
        const originalGenerate = window.generateQuietPrompt;
        window.generateQuietPrompt = function(...args) {
            console.log(`[${MODULE_NAME}] generateQuietPrompt called`);
            onMessageSent({ fromHook: true });
            return originalGenerate.apply(this, args);
        };
    }
    
    // Log available global objects for debugging
    console.log(`[${MODULE_NAME}] Available globals:`, {
        eventSource: typeof eventSource !== 'undefined',
        SillyTavern: typeof SillyTavern !== 'undefined',
        getContext: typeof getContext !== 'undefined',
        generateQuietPrompt: typeof window.generateQuietPrompt !== 'undefined'
    });
    
    console.log(`[${MODULE_NAME}] Extension loaded successfully`);
    updateUI('status', 'Extension loaded - Test connections to get started');
}

// Register the extension with SillyTavern
jQuery(async () => {
    // Small delay to ensure SillyTavern is ready
    setTimeout(async () => {
        await init();
    }, 100);
});