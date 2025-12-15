# RagForDummies

A RAG (Retrieval-Augmented Generation) extension for SillyTavern that **actually works** with group chats. Uses Qdrant for vector storage and supports multiple embedding providers.

## Why This Extension?

Existing RAG extensions for SillyTavern don't support group chats properly. This extension was built from the ground up to handle:
- ✅ Group chats with multiple characters
- ✅ Individual character chats
- ✅ Complex JSONL metadata from extensions like Tracker and Qvink
- ✅ Automatic summarization integration
- ✅ Real-time indexing as messages are sent
- ✅ Manual upload of historical chats

## Features

- **Group Chat Support**: Properly indexes and retrieves context from group chats
- **Multiple Embedding Providers**: Choose between Kobold, Ollama, or OpenAI
- **Flexible Qdrant Setup**: Use local Docker instance or Qdrant Cloud
- **Smart Context Retrieval**: Combines message summaries with full text for optimal results
- **Auto-Indexing**: Automatically indexes chats on first message
- **Extension Integration**: Works with Tracker, Qvink, and other SillyTavern extensions
- **Manual Upload**: Import historical chats from JSONL files

## Prerequisites

### Qdrant Setup

**Option 1: Local (Recommended for testing)**
```bash
docker run -p 6333:6333 qdrant/qdrant
```

**Option 2: Cloud**
- Sign up at [Qdrant Cloud](https://cloud.qdrant.io/)
- Create a cluster and note your URL and API key

### Embedding Provider Setup

**Option 1: Kobold**
- Run KoboldAI with embedding support
- Default URL: `http://localhost:5001`

**Option 2: Ollama (Recommended)**
```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text
```

**Option 3: OpenAI**
- Get API key from [OpenAI](https://platform.openai.com/)
- Uses `text-embedding-3-small` by default

## Installation

1. Navigate to your SillyTavern installation directory
2. Go to `public/scripts/extensions/third-party/`
3. Clone or download this repository:
```bash
cd public/scripts/extensions/third-party/
git clone https://github.com/yourusername/RagForDummies.git
```

4. Restart SillyTavern
5. Go to Extensions > RagForDummies to configure

## Configuration

### Qdrant Settings
- **Mode**: Choose `Local (Docker)` or `Cloud`
- **Local URL**: Default is `http://localhost:6333`
- **Cloud URL**: Your Qdrant Cloud cluster URL
- **Cloud API Key**: Your Qdrant Cloud API key

### Embedding Provider
- **Provider**: Choose between Kobold, Ollama, or OpenAI
- **Kobold URL**: Your KoboldAI instance URL
- **Ollama URL**: Your Ollama instance URL (default: `http://localhost:11434`)
- **Ollama Model**: Embedding model name (default: `nomic-embed-text`)
- **OpenAI API Key**: Your OpenAI API key
- **OpenAI Model**: Embedding model (default: `text-embedding-3-small`)

### RAG Settings
- **Retrieval Count**: Number of similar messages to retrieve (1-20, default: 5)
- **Similarity Threshold**: Minimum similarity score (0-1, default: 0.7)
- **Auto-index on first message**: Automatically index entire chat when first message is sent
- **Inject context into system prompt**: Automatically add retrieved context to AI responses

## Usage

### Testing Connection

Before using the extension, **test your connections**:

1. **Test Qdrant Connection**: Click "Test Qdrant Connection" button
   - Should show: "✓ Qdrant connected! Found X collections"
   - If it fails, check your Qdrant URL and that Qdrant is running

2. **Test Embedding Provider**: Click "Test Embedding Provider" button
   - Should show: "✓ Embedding provider working! Vector size: X"
   - If it fails, check your provider settings and API keys

### Automatic Indexing

1. Enable "Auto-index on first message" in settings
2. Start or load a chat (group or individual)
3. Send any message - the extension will automatically:
   - Index all previous messages in the chat
   - Index new messages as they're sent
   - Retrieve relevant context for AI responses

### Manual Indexing

If auto-indexing doesn't work or you want to manually trigger it:

1. **Index Current Chat**: Click "Index Current Chat" button
   - Indexes the currently active chat immediately
   - Useful for troubleshooting or when auto-index is disabled

2. **Upload Chat JSONL**: Click "Upload Chat JSONL" button
2. Select a `.jsonl` file exported from SillyTavern
3. The extension will index the entire chat history
4. This is useful for importing old chats or chats from other sessions

### Context Retrieval

When enabled, the extension will:
1. Monitor each message sent in the chat
2. Generate embeddings from recent messages
3. Search for similar messages in the vector database
4. Inject relevant context into the system prompt
5. The AI will have access to past conversations automatically

## How It Works

### Message Processing

Each message is processed with:
- **Character metadata**: Name, timestamp, topic, emotional tone
- **Summary**: If available from Qvink extension
- **Full message text**: Complete message content
- **Tracker data**: Location, character states, etc.

Example embedding text:
```
[Character: test nigga] [Time: 18:50:00; 12/20/2025] [Topic: Greeting] [Tone: Friendly]
Summary: test nigga enthusiastically greeted Tre, stating he was doing fantastic...
Message: *A bright, almost toothy grin spreads across my face...
```

### Collection Organization

- **Group chats**: `st_groupchat_{chat_id_hash}`
- **Individual chats**: `st_chat_{chat_id_hash}`

Each collection is completely isolated to prevent cross-contamination of context.

### Context Injection

Retrieved messages are formatted as:
```
=== Relevant Past Context ===

[Character Name - 12/20/2025 18:50]
Summary: Brief summary of what happened...
Message: Full message text...

---

[Another Character - 12/19/2025 15:30]
Summary: Another relevant moment...
Message: Full message text...

=== End Context ===
```

## Troubleshooting

### "Qdrant error: Connection refused"
- Ensure Qdrant is running (`docker ps` should show qdrant container)
- Check that the URL matches your Qdrant instance

### "Embedding generation failed"
- Verify your embedding provider is running
- Check API keys (for OpenAI/Cloud services)
- Ensure the model name is correct (for Ollama)

### "No relevant context found"
- Lower the similarity threshold in settings
- Increase the retrieval count
- Ensure the chat has been indexed (check status message)

### Messages not being indexed
- Check that "Auto-index on first message" is enabled
- Verify Qdrant connection is working
- Look at browser console for error messages

## Development

### File Structure
```
RagForDummies/
├── index.js          # Main extension logic
├── manifest.json     # Extension metadata
├── style.css         # UI styling
└── README.md         # Documentation
```

### Key Functions
- `indexChat()`: Index entire chat from JSONL
- `indexSingleMessage()`: Index individual message
- `retrieveContext()`: Query Qdrant for similar messages
- `generateEmbedding()`: Create embeddings via selected provider

## Contributing

Issues and pull requests are welcome! Please ensure:
- Code is well-commented
- Changes are tested with both group and individual chats
- Settings are backwards compatible

## License

MIT License - feel free to modify and distribute

## Credits

Created because existing RAG extensions didn't work for group chats. Built with frustration and determination.

## Support

If you encounter issues:
1. Check the browser console for errors
2. Verify all prerequisites are installed
3. Check extension settings are correct
4. Open an issue on GitHub with:
   - SillyTavern version
   - Error messages from console
   - Your configuration (without sensitive keys)