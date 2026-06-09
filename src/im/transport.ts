import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  UserMessage,
  AgentMessage,
  UserMessageTransport,
  ReceivedUserMessages,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// ImCliTransport — local JSONL file backend
// ---------------------------------------------------------------------------

export class ImCliTransport implements UserMessageTransport {
  private readonly baseDir: string;

  constructor(options: { baseDir: string }) {
    this.baseDir = options.baseDir;
  }

  // -----------------------------------------------------------------------
  // post — append a user message to the inbox (demo / CLI helper)
  // -----------------------------------------------------------------------

  async post(message: UserMessage): Promise<void> {
    const inboxPath = this.inboxPath(message.channel);
    this.ensureDir(path.dirname(inboxPath));
    fs.appendFileSync(inboxPath, JSON.stringify(message) + "\n", "utf-8");
  }

  // -----------------------------------------------------------------------
  // receive — read inbox JSONL, filter by cursor, return messages + nextCursor
  // -----------------------------------------------------------------------

  async receive(options: {
    channel: string;
    cursor?: string;
    waitMs?: number;
  }): Promise<ReceivedUserMessages> {
    const inboxPath = this.inboxPath(options.channel);
    const messages = this.readJsonlMessages(inboxPath);
    return sliceAfterCursor(messages, options.cursor, (message) => message.id);
  }

  // -----------------------------------------------------------------------
  // send — append agent message to outbox JSONL
  // -----------------------------------------------------------------------

  async send(message: AgentMessage): Promise<void> {
    const storedMessage = {
      ...message,
      id: message.id ?? this.createAgentMessageId(),
    };
    const outboxPath = this.outboxPath(message.channel);
    this.ensureDir(path.dirname(outboxPath));
    fs.appendFileSync(outboxPath, JSON.stringify(storedMessage) + "\n", "utf-8");
  }

  // -----------------------------------------------------------------------
  // ack — update cursor file
  // -----------------------------------------------------------------------

  async ack(options: {
    channel: string;
    messageId: string;
  }): Promise<void> {
    const cursorPath = this.cursorPath(options.channel);
    this.ensureDir(path.dirname(cursorPath));
    fs.writeFileSync(cursorPath, options.messageId, "utf-8");
  }

  readCursorSync(channel: string): string | undefined {
    const cursorPath = this.cursorPath(channel);
    if (!fs.existsSync(cursorPath)) {
      return undefined;
    }
    const cursor = fs.readFileSync(cursorPath, "utf-8").trim();
    return cursor.length > 0 ? cursor : undefined;
  }

  // -----------------------------------------------------------------------
  // pollNewMessages — read and return immediately (no actual polling wait)
  // -----------------------------------------------------------------------

  async pollNewMessages(options: {
    channel: string;
    cursor?: string;
    waitMs?: number;
  }): Promise<UserMessage[]> {
    const result = await this.receive(options);
    return result.messages;
  }

  // -----------------------------------------------------------------------
  // receiveSync — synchronous version for TUI polling
  // -----------------------------------------------------------------------

  receiveSync(options: {
    channel: string;
    cursor?: string;
  }): { messages: UserMessage[]; nextCursor?: string } {
    const inboxPath = this.inboxPath(options.channel);
    const messages = this.readJsonlMessages(inboxPath);
    return sliceAfterCursor(messages, options.cursor, (message) => message.id);
  }

  // -----------------------------------------------------------------------
  // readOutboxSync — read agent messages from outbox (for TUI display)
  // -----------------------------------------------------------------------

  readOutboxSync(options: {
    channel: string;
    cursor?: string;
  }): { messages: AgentMessage[]; nextCursor?: string; cursorFound?: false } {
    const outboxPath = this.outboxPath(options.channel);
    if (!fs.existsSync(outboxPath)) {
      return { messages: [], nextCursor: options.cursor };
    }

    const content = fs.readFileSync(outboxPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    const allMessages: AgentMessage[] = [];

    for (const line of lines) {
      try {
        allMessages.push(JSON.parse(line) as AgentMessage);
      } catch {
        // Skip malformed
      }
    }

    return sliceAfterCursor(allMessages, options.cursor, agentMessageCursor);
  }

  private createAgentMessageId(): string {
    return `agent-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  }

  // -----------------------------------------------------------------------
  // Path helpers
  // -----------------------------------------------------------------------

  private inboxPath(channel: string): string {
    return path.join(this.baseDir, `${channel}.inbox.jsonl`);
  }

  private outboxPath(channel: string): string {
    return path.join(this.baseDir, `${channel}.outbox.jsonl`);
  }

  private cursorPath(channel: string): string {
    return path.join(this.baseDir, "cursors", `${channel}.cursor`);
  }

  // -----------------------------------------------------------------------
  // File I/O helpers
  // -----------------------------------------------------------------------

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private readJsonlMessages(filePath: string): UserMessage[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    const messages: UserMessage[] = [];

    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as UserMessage);
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }
}

function sliceAfterCursor<T>(
  messages: T[],
  cursor: string | undefined,
  cursorFor: (message: T) => string,
): { messages: T[]; nextCursor?: string; cursorFound?: false } {
  if (cursor === undefined) {
    return {
      messages,
      nextCursor:
        messages.length > 0 ? cursorFor(messages[messages.length - 1]!) : undefined,
    };
  }

  const cursorIndex = messages.findIndex((message) => cursorFor(message) === cursor);
  if (cursorIndex === -1) {
    return { messages: [], nextCursor: cursor, cursorFound: false };
  }

  const filtered = messages.slice(cursorIndex + 1);
  return {
    messages: filtered,
    nextCursor:
      filtered.length > 0 ? cursorFor(filtered[filtered.length - 1]!) : cursor,
  };
}

function agentMessageCursor(message: AgentMessage): string {
  return message.id ?? message.createdAt;
}
