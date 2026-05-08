#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { readdirSync, existsSync, copyFileSync, statSync } from "fs";

const DB_PATH = join(homedir(), "Library/Messages/chat.db");
const AB_SOURCES_DIR = join(homedir(), "Library/Application Support/AddressBook/Sources");
const APPLE_EPOCH_OFFSET = 978307200000; // ms between Unix epoch and Apple epoch (Jan 1 2001)

// ─── Utility functions ───────────────────────────────────────────────────────

function appleTimeToDate(appleTime) {
  if (!appleTime || appleTime === "NULL") return "unknown";
  const t = Number(appleTime);
  const ms = t > 1e12 ? t / 1e6 : t * 1000;
  return new Date(ms + APPLE_EPOCH_OFFSET).toLocaleString();
}

function querySqliteDb(dbPath, sql) {
  const result = spawnSync("/usr/bin/sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "sqlite3 query failed");
  }
  const out = result.stdout?.trim();
  if (!out) return [];
  return JSON.parse(out);
}

function querySqlite(sql) {
  return querySqliteDb(DB_PATH, sql);
}

// iOS 16+ stores message text in `attributedBody` (typedstream-encoded NSAttributedString)
// while leaving the plain `text` column NULL. This extracts the readable text from that blob.
// Format ref: streamtyped header → class metadata → NSString block. After NSString, the inline
// string payload starts at the 0x2b ("+") tag. Length is variable-width per typedstream:
//   value < 0x80              → length is the byte itself (direct, 0..127)
//   0x81 + u8                 → 128..255
//   0x82 + u16le              → 256..65535
//   0x83 + u24le              → 65536..16M
function decodeAttributedBody(hex) {
  if (!hex) return "";
  try {
    const buf = Buffer.from(hex, "hex");
    const nss = buf.indexOf("NSString");
    if (nss < 0) return "";
    // Skip class metadata until the '+' tag marking the inline string payload.
    let i = nss + "NSString".length;
    while (i < buf.length && buf[i] !== 0x2b) i++;
    if (i >= buf.length) return "";
    i++;
    let len;
    const b = buf[i++];
    if (b === 0x81) {
      if (i >= buf.length) return "";
      len = buf[i]; i += 1;
    } else if (b === 0x82) {
      if (i + 1 >= buf.length) return "";
      len = buf.readUInt16LE(i); i += 2;
    } else if (b === 0x83) {
      if (i + 2 >= buf.length) return "";
      len = buf.readUIntLE(i, 3); i += 3;
    } else {
      len = b;
    }
    if (len <= 0 || i + len > buf.length) return "";
    return buf.toString("utf8", i, i + len);
  } catch {
    return "";
  }
}

function runAppleScript(script) {
  const result = spawnSync("osascript", ["-"], {
    input: script,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "AppleScript execution failed");
  }
  return result.stdout?.trim();
}

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  // US numbers: strip leading 1 from 11-digit numbers
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// ─── Contact cache ───────────────────────────────────────────────────────────

const identifierToName = new Map(); // normalized phone or lowercase email -> contact name
const nameToIdentifiers = new Map(); // lowercase name -> Set of raw identifiers

function buildContactCache() {
  try {
    if (!existsSync(AB_SOURCES_DIR)) return;
    const sources = readdirSync(AB_SOURCES_DIR);

    for (const src of sources) {
      const dbPath = join(AB_SOURCES_DIR, src, "AddressBook-v22.abcddb");
      if (!existsSync(dbPath)) continue;

      // Load phone numbers
      try {
        const phoneRows = querySqliteDb(dbPath, `
          SELECT
            COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'') as full_name,
            r.ZNICKNAME as nickname,
            r.ZORGANIZATION as org,
            p.ZFULLNUMBER as phone
          FROM ZABCDRECORD r
          JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
        `);
        for (const row of phoneRows) {
          const name = (row.full_name?.trim() || row.nickname || row.org || "").trim();
          if (!name || !row.phone) continue;
          const normalized = normalizePhone(row.phone);
          if (!normalized) continue;
          if (!identifierToName.has(normalized)) {
            identifierToName.set(normalized, name);
          }
          const lowerName = name.toLowerCase();
          if (!nameToIdentifiers.has(lowerName)) nameToIdentifiers.set(lowerName, new Set());
          nameToIdentifiers.get(lowerName).add(row.phone);
          // Also index nickname as a separate search key
          if (row.nickname) {
            const lowerNick = row.nickname.toLowerCase().trim();
            if (lowerNick && lowerNick !== lowerName) {
              if (!nameToIdentifiers.has(lowerNick)) nameToIdentifiers.set(lowerNick, new Set());
              nameToIdentifiers.get(lowerNick).add(row.phone);
            }
          }
        }
      } catch { /* skip this source for phones */ }

      // Load emails
      try {
        const emailRows = querySqliteDb(dbPath, `
          SELECT
            COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'') as full_name,
            r.ZNICKNAME as nickname,
            r.ZORGANIZATION as org,
            e.ZADDRESS as email
          FROM ZABCDRECORD r
          JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
        `);
        for (const row of emailRows) {
          const name = (row.full_name?.trim() || row.nickname || row.org || "").trim();
          if (!name || !row.email) continue;
          const lowerEmail = row.email.toLowerCase();
          if (!identifierToName.has(lowerEmail)) {
            identifierToName.set(lowerEmail, name);
          }
          const lowerName = name.toLowerCase();
          if (!nameToIdentifiers.has(lowerName)) nameToIdentifiers.set(lowerName, new Set());
          nameToIdentifiers.get(lowerName).add(row.email);
          // Also index nickname as a separate search key
          if (row.nickname) {
            const lowerNick = row.nickname.toLowerCase().trim();
            if (lowerNick && lowerNick !== lowerName) {
              if (!nameToIdentifiers.has(lowerNick)) nameToIdentifiers.set(lowerNick, new Set());
              nameToIdentifiers.get(lowerNick).add(row.email);
            }
          }
        }
      } catch { /* skip this source for emails */ }
    }
  } catch {
    // AddressBook access denied or not available - proceed with empty cache
  }
}

// Build cache on startup
buildContactCache();

function resolveIdentifier(handleId) {
  if (!handleId) return "Unknown";
  // Try email match
  const byEmail = identifierToName.get(handleId.toLowerCase());
  if (byEmail) return byEmail;
  // Try phone match
  const byPhone = identifierToName.get(normalizePhone(handleId));
  if (byPhone) return byPhone;
  return handleId; // fallback to raw identifier
}

function resolveContactToIdentifiers(query) {
  const lower = query.toLowerCase().trim();
  const matches = [];
  for (const [name, ids] of nameToIdentifiers) {
    if (name.includes(lower)) {
      for (const id of ids) matches.push(id);
    }
  }
  return [...new Set(matches)];
}

// ─── Chat ID resolution ─────────────────────────────────────────────────────

function findChatGuidForRecipient(identifier) {
  const safe = identifier.replace(/'/g, "''");
  // Try exact match on chat_identifier
  const rows = querySqlite(`
    SELECT c.ROWID as chat_id, c.guid, c.chat_identifier, c.service_name
    FROM chat c
    WHERE c.chat_identifier LIKE '%${safe}%'
    ORDER BY c.ROWID DESC
    LIMIT 1
  `);
  return rows.length > 0 ? rows[0].guid : null;
}

function findGroupChatByName(name) {
  const safe = name.replace(/'/g, "''");
  const rows = querySqlite(`
    SELECT c.ROWID as chat_id, c.guid, c.display_name
    FROM chat c
    WHERE c.style = 43
    AND LOWER(c.display_name) LIKE LOWER('%${safe}%')
    ORDER BY c.ROWID DESC
    LIMIT 1
  `);
  return rows.length > 0 ? rows[0] : null;
}

// ─── Attachment helpers ──────────────────────────────────────────────────────

function getAttachmentsForMessage(messageRowId) {
  try {
    const rows = querySqlite(`
      SELECT a.filename, a.mime_type, a.transfer_name, a.total_bytes
      FROM attachment a
      JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
      WHERE maj.message_id = ${Number(messageRowId)}
    `);
    return rows
      .filter(a => a.filename)
      .map(a => ({
        filename: a.transfer_name || a.filename?.split("/").pop() || "unknown",
        path: a.filename?.replace(/^~/, homedir()),
        mime_type: a.mime_type || "unknown",
        size_bytes: a.total_bytes || 0,
      }));
  } catch {
    return [];
  }
}

// ─── Tool implementations ────────────────────────────────────────────────────

function getConversations({ limit = 20 } = {}) {
  const rows = querySqlite(`
    SELECT
      c.ROWID as chat_id,
      c.guid as chat_guid,
      c.display_name,
      c.chat_identifier,
      c.style,
      m.text as last_message,
      hex(m.attributedBody) as last_attributed_body_hex,
      m.is_from_me,
      m.date as last_date,
      m.cache_has_attachments as has_attachments,
      (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) as participant_count
    FROM chat c
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    LEFT JOIN message m ON m.ROWID = cmj.message_id
    WHERE m.ROWID = (
      SELECT MAX(m2.ROWID) FROM message m2
      JOIN chat_message_join cmj2 ON cmj2.message_id = m2.ROWID
      WHERE cmj2.chat_id = c.ROWID
    )
    ORDER BY m.date DESC
    LIMIT ${Number(limit)}
  `);

  return rows.map(r => {
    const isGroup = r.style === 43;
    const resolvedName = r.display_name || resolveIdentifier(r.chat_identifier) || r.chat_identifier;
    const decodedLast = r.last_message || decodeAttributedBody(r.last_attributed_body_hex);
    const result = {
      chat_id: r.chat_id,
      chat_guid: r.chat_guid,
      name: resolvedName,
      identifier: r.chat_identifier,
      is_group: isGroup,
      last_message: decodedLast || (r.has_attachments ? "(attachment)" : "(no text)"),
      from_me: r.is_from_me === 1,
      time: appleTimeToDate(r.last_date),
    };
    if (isGroup) {
      result.participant_count = r.participant_count;
    }
    return result;
  });
}

function getMessages({ contact, limit = 50 } = {}) {
  // Resolve contact name to identifiers for broader search
  const contactIdentifiers = resolveContactToIdentifiers(contact);
  const safe = contact.replace(/'/g, "''");

  // Build WHERE clauses - original matching plus resolved identifiers
  let whereParts = [
    `LOWER(c.display_name) LIKE LOWER('%${safe}%')`,
    `LOWER(c.chat_identifier) LIKE LOWER('%${safe}%')`,
    `LOWER(h.id) LIKE LOWER('%${safe}%')`,
  ];
  for (const id of contactIdentifiers) {
    const safeId = id.replace(/'/g, "''");
    whereParts.push(`LOWER(c.chat_identifier) LIKE LOWER('%${safeId}%')`);
    whereParts.push(`LOWER(h.id) LIKE LOWER('%${safeId}%')`);
  }

  const rows = querySqlite(`
    SELECT
      m.ROWID as message_rowid,
      m.text,
      hex(m.attributedBody) as attributed_body_hex,
      m.is_from_me,
      m.date,
      m.cache_has_attachments,
      h.id as handle_id,
      c.ROWID as chat_rowid,
      c.display_name,
      c.chat_identifier,
      c.style,
      c.guid as chat_guid
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE (${whereParts.join(" OR ")})
    AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
    ORDER BY m.date DESC
    LIMIT ${Number(limit)}
  `);

  if (rows.length === 0) {
    return { error: `No messages found for: ${contact}` };
  }

  const isGroup = rows[0].style === 43;
  const conversation = rows[0].display_name || resolveIdentifier(rows[0].chat_identifier) || rows[0].chat_identifier;
  const chatGuid = rows[0].chat_guid;

  // Get participants for group chats
  let participants;
  if (isGroup) {
    try {
      const partRows = querySqlite(`
        SELECT h.id as handle_id FROM handle h
        JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
        WHERE chj.chat_id = ${rows[0].chat_rowid}
      `);
      participants = partRows.map(p => ({
        identifier: p.handle_id,
        name: resolveIdentifier(p.handle_id),
      }));
    } catch { participants = []; }
  }

  const messages = rows.reverse().map(r => {
    const msg = {
      from: r.is_from_me === 1 ? "Me" : resolveIdentifier(r.handle_id),
      text: r.text || decodeAttributedBody(r.attributed_body_hex) || "",
      time: appleTimeToDate(r.date),
    };
    if (r.cache_has_attachments) {
      const atts = getAttachmentsForMessage(r.message_rowid);
      if (atts.length > 0) msg.attachments = atts;
    }
    return msg;
  });

  const result = { conversation, chat_guid: chatGuid, is_group: isGroup, messages };
  if (participants) result.participants = participants;
  return result;
}

function searchMessages({ query, limit = 30 } = {}) {
  const safe = query.replace(/'/g, "''");
  // Encode query as UTF-8 bytes → uppercase hex to match SQLite's hex(attributedBody) output.
  // This is a coarse pre-filter — the JS post-filter below verifies the decoded text actually contains the query.
  const queryHex = Buffer.from(query, "utf8").toString("hex").toUpperCase();
  const queryLower = query.toLowerCase();
  // Fetch a wider pool than `limit` so the post-filter has room after dropping false positives.
  const sqlLimit = Math.max(Number(limit) * 4, 100);
  const rows = querySqlite(`
    SELECT
      m.ROWID as message_rowid,
      m.text,
      hex(m.attributedBody) as attributed_body_hex,
      m.is_from_me,
      m.date,
      m.cache_has_attachments,
      h.id as handle_id,
      c.display_name,
      c.chat_identifier,
      c.guid as chat_guid
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.text LIKE '%${safe}%'
       OR (m.text IS NULL AND m.attributedBody IS NOT NULL AND hex(m.attributedBody) LIKE '%${queryHex}%')
    ORDER BY m.date DESC
    LIMIT ${sqlLimit}
  `);

  const matched = [];
  for (const r of rows) {
    const text = r.text || decodeAttributedBody(r.attributed_body_hex) || "";
    if (!text.toLowerCase().includes(queryLower)) continue;
    const msg = {
      conversation: r.display_name || resolveIdentifier(r.chat_identifier) || r.chat_identifier,
      chat_guid: r.chat_guid,
      from: r.is_from_me === 1 ? "Me" : resolveIdentifier(r.handle_id),
      text,
      time: appleTimeToDate(r.date),
    };
    if (r.cache_has_attachments) {
      const atts = getAttachmentsForMessage(r.message_rowid);
      if (atts.length > 0) msg.attachments = atts;
    }
    matched.push(msg);
    if (matched.length >= Number(limit)) break;
  }
  return matched;
}

function sendMessage({ recipient, message, files } = {}) {
  let chatGuid = null;

  // Path A: Direct chat GUID provided (for group chats or explicit chat IDs)
  if (recipient.includes(";+;") || recipient.includes(";-;")) {
    chatGuid = recipient;
  }

  // Path B: Try to resolve name -> identifiers -> chat GUID
  if (!chatGuid) {
    // Check if it's a group name
    const group = findGroupChatByName(recipient);
    if (group) chatGuid = group.guid;
  }

  if (!chatGuid) {
    // Resolve contact name to phone/email identifiers
    const identifiers = resolveContactToIdentifiers(recipient);
    for (const id of identifiers) {
      chatGuid = findChatGuidForRecipient(id);
      if (chatGuid) break;
    }
  }

  if (!chatGuid) {
    // Try direct lookup (recipient is a phone number or email)
    chatGuid = findChatGuidForRecipient(recipient);
  }

  // Send text message
  let sendResult;
  if (chatGuid) {
    // Chat-ID-based sending - works for iMessage, SMS, RCS, and groups
    const script = `
      on run argv
        tell application "Messages"
          send (item 1 of argv) to chat id (item 2 of argv)
        end tell
      end run
    `;
    const result = spawnSync("osascript", ["-", message, chatGuid], {
      input: script,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "Failed to send message");
    }
    sendResult = { success: true, recipient, message, via: "chat_id", chat_guid: chatGuid };
  } else {
    // Path C: Fallback - buddy-based approach for new conversations
    const safeRecipient = recipient.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const safeMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `
      tell application "Messages"
        try
          set targetService to 1st service whose service type = iMessage
          set targetBuddy to buddy "${safeRecipient}" of targetService
          send "${safeMessage}" to targetBuddy
          return "sent:iMessage"
        on error
          try
            set targetService to 1st service whose service type = SMS
            set targetBuddy to buddy "${safeRecipient}" of targetService
            send "${safeMessage}" to targetBuddy
            return "sent:SMS"
          on error errMsg
            error errMsg
          end try
        end try
      end tell
    `;
    const result = runAppleScript(script);
    sendResult = {
      success: true,
      recipient,
      message,
      via: result.includes("SMS") ? "SMS" : "iMessage",
    };
  }

  // Send file attachments if provided
  if (files && Array.isArray(files) && files.length > 0 && chatGuid) {
    const fileResults = [];
    for (const filePath of files) {
      try {
        if (!existsSync(filePath)) {
          fileResults.push({ file: filePath, error: "File not found" });
          continue;
        }
        const script = `
          on run argv
            tell application "Messages"
              send (POSIX file (item 1 of argv)) to chat id (item 2 of argv)
            end tell
          end run
        `;
        const result = spawnSync("osascript", ["-", filePath, chatGuid], {
          input: script,
          encoding: "utf8",
          maxBuffer: 5 * 1024 * 1024,
        });
        if (result.status !== 0) {
          fileResults.push({ file: filePath, error: result.stderr?.trim() });
        } else {
          fileResults.push({ file: filePath, sent: true });
        }
      } catch (err) {
        fileResults.push({ file: filePath, error: err.message });
      }
    }
    sendResult.file_results = fileResults;
  }

  return sendResult;
}

function getChatParticipants({ chat_id, chat_guid, name } = {}) {
  let chatRowId = chat_id;

  // Resolve by guid
  if (!chatRowId && chat_guid) {
    const safe = chat_guid.replace(/'/g, "''");
    const rows = querySqlite(`SELECT ROWID FROM chat WHERE guid = '${safe}' LIMIT 1`);
    if (rows.length > 0) chatRowId = rows[0].ROWID;
  }

  // Resolve by name (group name search)
  if (!chatRowId && name) {
    const safe = name.replace(/'/g, "''");
    const rows = querySqlite(`
      SELECT ROWID, guid, display_name FROM chat
      WHERE style = 43 AND LOWER(display_name) LIKE LOWER('%${safe}%')
      ORDER BY ROWID DESC LIMIT 1
    `);
    if (rows.length > 0) chatRowId = rows[0].ROWID;
  }

  if (!chatRowId) {
    return { error: "Chat not found. Provide chat_id, chat_guid, or group name." };
  }

  const participants = querySqlite(`
    SELECT h.id as handle_id FROM handle h
    JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
    WHERE chj.chat_id = ${Number(chatRowId)}
  `);

  const chatInfo = querySqlite(`SELECT guid, display_name, style FROM chat WHERE ROWID = ${Number(chatRowId)}`);

  return {
    chat_id: chatRowId,
    chat_guid: chatInfo[0]?.guid,
    name: chatInfo[0]?.display_name || "Unnamed",
    is_group: chatInfo[0]?.style === 43,
    participants: participants.map(p => ({
      identifier: p.handle_id,
      name: resolveIdentifier(p.handle_id),
    })),
  };
}

function getAttachments({ contact, chat_guid, limit = 20, mime_filter } = {}) {
  let whereClause;

  if (chat_guid) {
    const safe = chat_guid.replace(/'/g, "''");
    whereClause = `c.guid = '${safe}'`;
  } else if (contact) {
    const safe = contact.replace(/'/g, "''");
    const identifiers = resolveContactToIdentifiers(contact);
    const parts = [
      `LOWER(c.display_name) LIKE LOWER('%${safe}%')`,
      `LOWER(c.chat_identifier) LIKE LOWER('%${safe}%')`,
    ];
    for (const id of identifiers) {
      const safeId = id.replace(/'/g, "''");
      parts.push(`LOWER(c.chat_identifier) LIKE LOWER('%${safeId}%')`);
    }
    whereClause = `(${parts.join(" OR ")})`;
  } else {
    return { error: "Provide either contact or chat_guid" };
  }

  let mimeClause = "";
  if (mime_filter) {
    const safeMime = mime_filter.replace(/'/g, "''");
    mimeClause = `AND a.mime_type LIKE '${safeMime}%'`;
  }

  const rows = querySqlite(`
    SELECT
      a.filename, a.mime_type, a.transfer_name, a.total_bytes,
      m.is_from_me, m.date,
      h.id as handle_id,
      c.display_name, c.chat_identifier
    FROM attachment a
    JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
    JOIN message m ON m.ROWID = maj.message_id
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE ${whereClause}
    AND a.filename IS NOT NULL
    ${mimeClause}
    ORDER BY m.date DESC
    LIMIT ${Number(limit)}
  `);

  return {
    conversation: rows[0]?.display_name || resolveIdentifier(rows[0]?.chat_identifier) || contact || chat_guid,
    attachments: rows.map(r => ({
      filename: r.transfer_name || r.filename?.split("/").pop() || "unknown",
      path: r.filename?.replace(/^~/, homedir()),
      mime_type: r.mime_type || "unknown",
      size_bytes: r.total_bytes || 0,
      from: r.is_from_me === 1 ? "Me" : resolveIdentifier(r.handle_id),
      time: appleTimeToDate(r.date),
    })),
  };
}

function saveAttachment({ source_path, destination } = {}) {
  if (!source_path) return { error: "source_path is required" };

  // Expand ~ in source path
  const fullSource = source_path.replace(/^~/, homedir());
  if (!existsSync(fullSource)) {
    return { error: `Source file not found: ${source_path}` };
  }

  // Default destination is Desktop with original filename
  const filename = fullSource.split("/").pop();
  let destPath;
  if (destination) {
    destPath = destination.replace(/^~/, homedir());
    // If destination is a directory, append filename
    if (existsSync(destPath) && statSync(destPath).isDirectory()) {
      destPath = join(destPath, filename);
    }
  } else {
    destPath = join(homedir(), "Desktop", filename);
  }

  try {
    copyFileSync(fullSource, destPath);
    return { success: true, saved_to: destPath, filename, size_bytes: statSync(destPath).size };
  } catch (err) {
    return { error: `Failed to save: ${err.message}` };
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "imessage", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_conversations",
      description: "List recent conversations (individual and group) with resolved contact names. Shows group chats with participant counts.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of conversations to return (default 20)" },
        },
      },
    },
    {
      name: "get_messages",
      description: "Read messages from a conversation. Search by contact name, phone number, email, or group name. Shows resolved sender names in group chats and includes attachment info.",
      inputSchema: {
        type: "object",
        properties: {
          contact: { type: "string", description: "Contact name, phone number, email, or group chat name" },
          limit: { type: "number", description: "Number of messages to return (default 50)" },
        },
        required: ["contact"],
      },
    },
    {
      name: "search_messages",
      description: "Search all messages for a keyword or phrase. Shows resolved contact names and attachment info.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for" },
          limit: { type: "number", description: "Max results (default 30)" },
        },
        required: ["query"],
      },
    },
    {
      name: "send_message",
      description: "Send a message (iMessage, SMS, or RCS) to a contact or group chat. Accepts contact names, phone numbers, emails, or chat GUIDs. Can also send file attachments.",
      inputSchema: {
        type: "object",
        properties: {
          recipient: { type: "string", description: "Contact name, phone number, email, group name, or chat GUID (e.g. 'any;+;chat123...')" },
          message: { type: "string", description: "Message text to send" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of absolute file paths to send as attachments (images, PDFs, etc.)",
          },
        },
        required: ["recipient", "message"],
      },
    },
    {
      name: "get_chat_participants",
      description: "Get participants of a chat with resolved contact names. Useful for group chats.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "number", description: "Chat ROWID from get_conversations" },
          chat_guid: { type: "string", description: "Chat GUID (e.g. 'any;+;chat123...')" },
          name: { type: "string", description: "Group chat name to search for" },
        },
      },
    },
    {
      name: "get_attachments",
      description: "Get attachments (images, files, links) from a conversation. Filter by mime type (e.g. 'image' for photos, 'application/pdf' for PDFs). Returns file paths that can be read or saved.",
      inputSchema: {
        type: "object",
        properties: {
          contact: { type: "string", description: "Contact name, phone number, or email" },
          chat_guid: { type: "string", description: "Chat GUID for direct lookup" },
          limit: { type: "number", description: "Max attachments to return (default 20)" },
          mime_filter: { type: "string", description: "Filter by mime type prefix: 'image' for photos, 'video' for videos, 'application/pdf' for PDFs" },
        },
      },
    },
    {
      name: "save_attachment",
      description: "Save/copy a message attachment to a destination (defaults to Desktop). Use after get_attachments to save files.",
      inputSchema: {
        type: "object",
        properties: {
          source_path: { type: "string", description: "Full path to the attachment file (from get_attachments results)" },
          destination: { type: "string", description: "Destination path or directory (defaults to ~/Desktop)" },
        },
        required: ["source_path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    if (name === "get_conversations") result = getConversations(args);
    else if (name === "get_messages") result = getMessages(args);
    else if (name === "search_messages") result = searchMessages(args);
    else if (name === "send_message") result = sendMessage(args);
    else if (name === "get_chat_participants") result = getChatParticipants(args);
    else if (name === "get_attachments") result = getAttachments(args);
    else if (name === "save_attachment") result = saveAttachment(args);
    else throw new Error(`Unknown tool: ${name}`);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
