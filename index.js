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
            return true;
        }
        
        await qdrantRequest('/collections/' + collectionName, 'PUT', {
            vectors: {
                size: vectorSize,
                distance: 'Cosine'
            }
        });
        
        console.log('[' + MODULE_NAME + '] Created collection: ' + collectionName);
        return true;
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to create collection:', error);
        throw error;
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

async function searchVectors(collectionName, vector, limit, scoreThreshold) {
    if (limit === undefined) limit = 5;
    if (scoreThreshold === undefined) scoreThreshold = 0.7;
    
    try {
        console.log('[' + MODULE_NAME + '] Searching Qdrant collection: ' + collectionName);
        console.log('[' + MODULE_NAME + '] Search parameters: limit=' + limit + ', threshold=' + scoreThreshold);
        console.log('[' + MODULE_NAME + '] Query vector dimensions: ' + vector.length);
        
        const result = await qdrantRequest('/collections/' + collectionName + '/points/search', 'POST', {
            vector: vector,
            limit: limit,
            score_threshold: scoreThreshold,
            with_payload: true
        });
        
        console.log('[' + MODULE_NAME + '] Qdrant returned ' + (result.result ? result.result.length : 0) + ' results');
        if (result.result && result.result.length > 0) {
            console.log('[' + MODULE_NAME + '] Top result score: ' + result.result[0].score.toFixed(3));
            console.log('[' + MODULE_NAME + '] Lowest result score: ' + result.result[result.result.length - 1].score.toFixed(3));
        }
        
        return result.result || [];
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to search vectors:', error);
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
    
    return {
        chat_id_hash: chatIdHash,
        message_index: messageIndex,
        character_name: message.name,
        is_user: message.is_user || false,
        timestamp: message.send_date || '',
        summary: (message.extra && message.extra.qvink_memory && message.extra.qvink_memory.memory) ? message.extra.qvink_memory.memory : '',
        full_message: message.mes,
        topic: (tracker.Topics && tracker.Topics.PrimaryTopic) ? tracker.Topics.PrimaryTopic : '',
        emotional_tone: (tracker.Topics && tracker.Topics.EmotionalTone) ? tracker.Topics.EmotionalTone : '',
        location: (tracker.Characters && tracker.Characters[message.name] && tracker.Characters[message.name].Location) ? tracker.Characters[message.name].Location : ''
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
        
        const queryEmbedding = await generateEmbedding(query);
        
        const results = await searchVectors(
            collectionName,
            queryEmbedding,
            extensionSettings.retrievalCount,
            extensionSettings.similarityThreshold
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
            
            let text = '\n[Character: ' + p.character_name + ']';
            if (p.timestamp) text += '\n[Time: ' + p.timestamp + ']';
            if (p.topic) text += '\n[Topic: ' + p.topic + ']';
            if (p.emotional_tone) text += '\n[Tone: ' + p.emotional_tone + ']';
            if (p.location) text += '\n[Location: ' + p.location + ']';
            text += '\n[Relevance Score: ' + score.toFixed(3) + ']';
            
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
    updateUI('status', 'Chat loaded - ready to index');
    
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
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Error getting initial message count:', error);
    }
}

async function onMessageSent(messageData) {
    console.log('[' + MODULE_NAME + '] Message sent event fired');
    
    if (!extensionSettings.enabled || !extensionSettings.autoIndex) {
        return;
    }
    
    const chatId = getCurrentChatId();
    if (!chatId) {
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
}

async function onMessageReceived(messageData) {
    if (!extensionSettings.enabled || !extensionSettings.injectContext) return;
    
    const chatId = getCurrentChatId();
    if (!chatId || !currentChatIndexed) {
        return;
    }
    
    await injectContextBeforeGeneration();
}

async function injectContextBeforeGeneration(data) {
    if (!extensionSettings.enabled || !extensionSettings.injectContext) {
        console.log('[' + MODULE_NAME + '] Context injection disabled in settings');
        return;
    }
    
    const chatId = getCurrentChatId();
    if (!chatId || !currentChatIndexed) {
        console.log('[' + MODULE_NAME + '] Skipping injection - chatId: ' + chatId + ', indexed: ' + currentChatIndexed);
        return;
    }
    
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
        
        const recentMessages = context.chat.slice(-3);
        const query = recentMessages.map(function(m) { return m.mes; }).join(' ');
        
        console.log('[' + MODULE_NAME + '] ===== CONTEXT INJECTION ATTEMPT =====');
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
            
            console.log('[' + MODULE_NAME + '] Attempting injection with setExtensionPrompt...');
            console.log('[' + MODULE_NAME + '] Parameters: name="' + MODULE_NAME + '", position=' + position + ', depth=' + depth);
            
            // Try injection
            let injected = false;
            
            if (typeof setExtensionPrompt === 'function') {
                try {
                    setExtensionPrompt(MODULE_NAME, retrievedContext, position, depth);
                    injected = true;
                    console.log('[' + MODULE_NAME + '] ✓✓✓ setExtensionPrompt() called successfully');
                } catch (e) {
                    console.error('[' + MODULE_NAME + '] setExtensionPrompt() threw error:', e);
                }
            } else if (typeof window.setExtensionPrompt === 'function') {
                try {
                    window.setExtensionPrompt(MODULE_NAME, retrievedContext, position, depth);
                    injected = true;
                    console.log('[' + MODULE_NAME + '] ✓✓✓ window.setExtensionPrompt() called successfully');
                } catch (e) {
                    console.error('[' + MODULE_NAME + '] window.setExtensionPrompt() threw error:', e);
                }
            } else {
                console.error('[' + MODULE_NAME + '] ✗✗✗ setExtensionPrompt not found!');
                console.error('[' + MODULE_NAME + '] Checking for alternative injection methods...');
                
                // List all globals that might be relevant
                const relevantGlobals = Object.keys(window).filter(function(k) { 
                    return k.toLowerCase().indexOf('prompt') !== -1 || 
                           k.toLowerCase().indexOf('extension') !== -1 ||
                           k.toLowerCase().indexOf('inject') !== -1;
                });
                console.log('[' + MODULE_NAME + '] Relevant window globals:', relevantGlobals);
                
                if (typeof extension_prompts !== 'undefined') {
                    console.log('[' + MODULE_NAME + '] Found extension_prompts object:', typeof extension_prompts);
                }
            }
            
            if (injected) {
                updateUI('status', 'Context injected! (' + retrievedContext.length + ' chars)');
                console.log('[' + MODULE_NAME + '] ===== INJECTION SUCCESSFUL =====');
            } else {
                updateUI('status', 'Retrieved context but injection method not available');
                console.log('[' + MODULE_NAME + '] ===== INJECTION FAILED - NO METHOD =====');
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
            
            if (extensionSettings.injectContext) {
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
                    '</div>' +
                    
                    '<div class="ragfordummies-section">' +
                        '<h4>Manual Operations</h4>' +
                        '<button id="ragfordummies_index_current" class="menu_button">Index Current Chat</button>' +
                        '<button id="ragfordummies_stop_indexing" class="menu_button ragfordummies-stop-btn">Stop Indexing</button>' +
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
                const recentMessages = context.chat.slice(-3);
                const query = recentMessages.map(function(m) { return m.mes; }).join(' ');
                
                console.log('[' + MODULE_NAME + '] Query text length:', query.length);
                console.log('[' + MODULE_NAME + '] Query preview:', query.substring(0, 150) + '...');
                console.log('[' + MODULE_NAME + '] ---');
                console.log('[' + MODULE_NAME + '] Sending search request to Qdrant...');
                
                const retrievedContext = await retrieveContext(query, chatId, isGroupChat);
                
                console.log('[' + MODULE_NAME + '] ---');
                
                if (retrievedContext) {
                    updateUI('status', '✓ Retrieved ' + retrievedContext.length + ' chars of context');
                    console.log('[' + MODULE_NAME + '] ✓✓✓ SUCCESS! Retrieved context:');
                    console.log('[' + MODULE_NAME + '] ========== FULL RETRIEVED CONTEXT ==========');
                    console.log(retrievedContext);
                    console.log('[' + MODULE_NAME + '] ============================================');
                } else {
                    updateUI('status', '✗ No context found - try lowering similarity threshold to 0.5 or 0.4');
                    console.log('[' + MODULE_NAME + '] ✗ No context retrieved - similarity threshold may be too high');
                    console.log('[' + MODULE_NAME + '] Current threshold: ' + extensionSettings.similarityThreshold);
                    console.log('[' + MODULE_NAME + '] Try lowering it in settings');
                }
                
                console.log('[' + MODULE_NAME + '] ========================================');
                console.log('[' + MODULE_NAME + '] TEST COMPLETE');
                console.log('[' + MODULE_NAME + '] ========================================');
            } catch (error) {
                updateUI('status', '✗ Retrieval failed: ' + error.message);
                console.error('[' + MODULE_NAME + '] ✗✗✗ TEST FAILED:', error);
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
                    
                    // Check if there's an extension_prompts array in context
                    if (ctx.extension_prompts) {
                        console.log('[' + MODULE_NAME + '] ✓ ctx.extension_prompts exists:', ctx.extension_prompts);
                    }
                }
                
                if (SillyTavern.extensions) {
                    console.log('[' + MODULE_NAME + '] SillyTavern.extensions:', SillyTavern.extensions);
                    console.log('[' + MODULE_NAME + '] extensions keys:', Object.keys(SillyTavern.extensions));
                }
                
                if (SillyTavern.setExtensionPrompt) {
                    console.log('[' + MODULE_NAME + '] ✓✓✓ SillyTavern.setExtensionPrompt EXISTS!');
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
                const chatId = (chatMetadata && chatMetadata.chat_id_hash) ? chatMetadata.chat_id_hash : Date.now();
                const isGroupChat = file.name.indexOf('group') !== -1 || (chatMetadata && chatMetadata.groupId !== undefined);
                
                await indexChat(content, chatId, isGroupChat);
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
    
    if (typeof eventSource !== 'undefined') {
        console.log('[' + MODULE_NAME + '] Registering eventSource handlers');
        
        eventSource.on('chat_loaded', onChatLoaded);
        eventSource.on('message_sent', onMessageSent);
        eventSource.on('message_received', onMessageReceived);
        eventSource.on('GENERATE_BEFORE_COMBINE_PROMPTS', injectContextBeforeGeneration);
        
        console.log('[' + MODULE_NAME + '] Event listeners registered');
    } else {
        console.log('[' + MODULE_NAME + '] eventSource not available');
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
    
    if (typeof eventSource === 'undefined') {
        console.log('[' + MODULE_NAME + '] eventSource not available, using polling fallback');
        
        if (extensionSettings.autoIndex) {
            await startPolling();
        } else {
            console.log('[' + MODULE_NAME + '] Auto-index disabled, polling not started');
        }
    }
    
    console.log('[' + MODULE_NAME + '] Extension loaded successfully');
    updateUI('status', 'Extension loaded - Test connections');
}

jQuery(async function() {
    setTimeout(async function() {
        await init();
    }, 100);
});