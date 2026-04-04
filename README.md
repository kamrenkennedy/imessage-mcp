# imessage-mcp

An MCP server that connects Claude Desktop to iMessage on macOS — read conversations, search messages, send texts, and access attachments.

## Prerequisites

- macOS
- [Node.js](https://nodejs.org) 18+
- [Claude Desktop](https://claude.ai/download)
- **Full Disk Access** granted to Claude Desktop (required to read `~/Library/Messages/chat.db`)

### Granting Full Disk Access

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Add **Claude** to the list and enable it
3. Restart Claude Desktop

## Installation

**1. Add to Claude Desktop config**

Open `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "@kamstudios/imessage-mcp"]
    }
  }
}
```

**2. Restart Claude Desktop**

---

### Manual install (alternative)

If you prefer to run from source:

```bash
git clone https://github.com/kamrenkennedy/imessage-mcp.git
cd imessage-mcp
npm install
```

Then use this config instead:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "node",
      "args": ["/absolute/path/to/imessage-mcp/index.js"]
    }
  }
}
```

---

## Tools

### `get_conversations`
List recent iMessage conversations.

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Max conversations to return (default: 20) |

### `get_messages`
Get messages from a specific conversation.

| Parameter | Type | Description |
|---|---|---|
| `chat_id` | string | **Required.** Chat ID from `get_conversations` |
| `limit` | number | Max messages to return (default: 50) |

### `search_messages`
Search across all messages by text.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | **Required.** Text to search for |
| `limit` | number | Max results to return (default: 20) |

### `get_chat_participants`
Get the participants in a conversation.

| Parameter | Type | Description |
|---|---|---|
| `chat_id` | string | **Required.** Chat ID from `get_conversations` |

### `send_message`
Send an iMessage or SMS.

| Parameter | Type | Description |
|---|---|---|
| `recipient` | string | **Required.** Phone number, email, or contact name |
| `message` | string | **Required.** Text to send |

### `get_attachments`
List attachments from a conversation.

| Parameter | Type | Description |
|---|---|---|
| `chat_id` | string | **Required.** Chat ID from `get_conversations` |
| `limit` | number | Max attachments to return (default: 20) |

### `save_attachment`
Save an attachment from a message to disk.

| Parameter | Type | Description |
|---|---|---|
| `attachment_id` | string | **Required.** Attachment ID from `get_attachments` |
| `destination` | string | **Required.** Full path where the file should be saved |

---

## Notes

- Messages are read directly from `~/Library/Messages/chat.db` using SQLite — no AppleScript required for reads
- Sending uses AppleScript via `osascript`
- Contact names are resolved from AddressBook automatically
- US phone numbers are normalized (leading 1 stripped from 11-digit numbers)
