import * as fs from "node:fs";
import * as path from "node:path";
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

  constructor(options?: { baseDir?: string }) {
    this.baseDir = options?.baseDir ?? ".tiny-agent/im";
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

    // Filter by cursor — return only messages after the cursor
    let startIndex = 0;
    if (options.cursor) {
      const cursorIndex = messages.findIndex(
        (m) => m.id === options.cursor,
      );
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const filtered = messages.slice(startIndex);
    const nextCursor =
      filtered.length > 0 ? filtered[filtered.length - 1]!.id : options.cursor;

    return {
      messages: filtered,
      nextCursor,
    };
  }

  // -----------------------------------------------------------------------
  // send — append agent message to outbox JSONL
  // -----------------------------------------------------------------------

  async send(message: AgentMessage): Promise<void> {
    const outboxPath = this.outboxPath(message.channel);
    this.ensureDir(path.dirname(outboxPath));
    fs.appendFileSync(outboxPath, JSON.stringify(message) + "\n", "utf-8");
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
