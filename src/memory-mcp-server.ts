#!/usr/bin/env node
/**
 * Memory MCP Server for NanoClaw
 * Runs on the host (inside the container), exposes memory_search, memory_write,
 * memory_get tools via MCP stdio to container agents.
 *
 * Env vars:
 *   MEMORY_DIR  — path to the group's memory directory (e.g. /workspace/extra/memory)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MEMORY_DIR_RAW = process.env.MEMORY_DIR;
if (!MEMORY_DIR_RAW) {
  process.stderr.write('[memory-mcp] MEMORY_DIR env var is required\n');
  process.exit(1);
}
const MEMORY_DIR: string = MEMORY_DIR_RAW;

const DAILY_DIR = path.join(MEMORY_DIR, 'memory');
const LONG_TERM_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
const DB_PATH = path.join(MEMORY_DIR, '.memory-index.db');

// Ensure directories exist
fs.mkdirSync(DAILY_DIR, { recursive: true });

// Initialize MEMORY.md if missing
if (!fs.existsSync(LONG_TERM_FILE)) {
  fs.writeFileSync(
    LONG_TERM_FILE,
    '# Memoria de Largo Plazo\n\n## Preferencias\n\n## Decisiones\n\n## Hechos\n\n## Patrones\n',
  );
}

// Open SQLite with FTS5
const db = new Database(DB_PATH);
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    file,
    line_start UNINDEXED,
    content,
    tokenize='porter unicode61'
  );
  CREATE TABLE IF NOT EXISTS memory_meta (
    file TEXT PRIMARY KEY,
    last_modified INTEGER,
    line_count INTEGER
  );
`);

// --- helpers ---

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Resolve a file alias/relative-path to an absolute path, preventing traversal. */
function resolveFile(fileAlias: string): string {
  let resolved: string;
  if (fileAlias === 'today') {
    resolved = path.join(DAILY_DIR, `${getToday()}.md`);
  } else if (fileAlias === 'yesterday') {
    resolved = path.join(DAILY_DIR, `${getYesterday()}.md`);
  } else {
    resolved = path.resolve(MEMORY_DIR, fileAlias);
  }
  const memDirReal = path.resolve(MEMORY_DIR);
  if (!resolved.startsWith(memDirReal + path.sep) && resolved !== memDirReal) {
    throw new Error(`Path traversal not allowed: ${fileAlias}`);
  }
  return resolved;
}

function getRelativePath(absPath: string): string {
  return path.relative(MEMORY_DIR, absPath);
}

function chunkFile(
  content: string,
): Array<{ lineStart: number; text: string }> {
  const lines = content.split('\n');
  const CHUNK_SIZE = 10;
  const OVERLAP = 2;
  const chunks: Array<{ lineStart: number; text: string }> = [];

  for (let i = 0; i < lines.length; i += CHUNK_SIZE - OVERLAP) {
    const end = Math.min(i + CHUNK_SIZE, lines.length);
    chunks.push({ lineStart: i + 1, text: lines.slice(i, end).join('\n') });
    if (end >= lines.length) break;
  }
  return chunks;
}

const stmtGetMeta = db.prepare<[string], { last_modified: number }>(
  'SELECT last_modified FROM memory_meta WHERE file = ?',
);
const stmtDeleteFts = db.prepare('DELETE FROM memory_fts WHERE file = ?');
const stmtInsertFts = db.prepare(
  'INSERT INTO memory_fts(file, line_start, content) VALUES (?, ?, ?)',
);
const stmtUpsertMeta = db.prepare(
  'INSERT OR REPLACE INTO memory_meta(file, last_modified, line_count) VALUES (?, ?, ?)',
);
const stmtDeleteMeta = db.prepare('DELETE FROM memory_meta WHERE file = ?');

function indexFile(absPath: string): void {
  const relPath = getRelativePath(absPath);
  try {
    const stat = fs.statSync(absPath);
    const mtime = Math.floor(stat.mtimeMs);
    const meta = stmtGetMeta.get(relPath);
    if (meta && meta.last_modified === mtime) return;

    const content = fs.readFileSync(absPath, 'utf-8');
    const chunks = chunkFile(content);

    stmtDeleteFts.run(relPath);
    for (const chunk of chunks) {
      stmtInsertFts.run(relPath, chunk.lineStart, chunk.text);
    }
    stmtUpsertMeta.run(relPath, mtime, content.split('\n').length);
  } catch {
    stmtDeleteFts.run(relPath);
    stmtDeleteMeta.run(relPath);
  }
}

function forceReindex(absPath: string): void {
  stmtDeleteMeta.run(getRelativePath(absPath));
  indexFile(absPath);
}

function scanAndIndex(): void {
  if (fs.existsSync(LONG_TERM_FILE)) indexFile(LONG_TERM_FILE);
  if (fs.existsSync(DAILY_DIR)) {
    for (const f of fs.readdirSync(DAILY_DIR)) {
      if (f.endsWith('.md')) indexFile(path.join(DAILY_DIR, f));
    }
  }
}

scanAndIndex();

// --- MCP server ---

const server = new Server(
  { name: 'memory', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_search',
      description:
        'Full-text search (BM25) across all memory: long-term MEMORY.md and daily logs. ' +
        'Returns ranked snippets. Use this before writing to check existing notes.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query',
          },
          max_results: {
            type: 'number',
            description: 'Max results to return (default 5, max 20)',
          },
          date_from: {
            type: 'string',
            description: 'Filter daily logs from this date (YYYY-MM-DD)',
          },
          date_to: {
            type: 'string',
            description: 'Filter daily logs to this date (YYYY-MM-DD)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_write',
      description:
        'Write to memory. Use target="daily" to append to today\'s daily log, ' +
        'target="long_term" to update MEMORY.md. ' +
        'mode="append" adds content at the end; mode="replace_section" replaces a ## section.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['daily', 'long_term'],
            description: '"daily" for today\'s log, "long_term" for MEMORY.md',
          },
          content: { type: 'string', description: 'Markdown content to write' },
          section: {
            type: 'string',
            description:
              'Section heading for replace_section mode (e.g. "Preferencias")',
          },
          mode: {
            type: 'string',
            enum: ['append', 'replace_section'],
            description: '"append" or "replace_section"',
          },
        },
        required: ['target', 'content', 'mode'],
      },
    },
    {
      name: 'memory_get',
      description:
        'Read a memory file. Aliases: "today" (today\'s log), "yesterday". ' +
        'Or use relative paths: "MEMORY.md", "memory/2026-03-15.md".',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description:
              '"today", "yesterday", "MEMORY.md", or relative path like "memory/2026-03-15.md"',
          },
          line_start: {
            type: 'number',
            description: 'Optional 1-indexed start line',
          },
          line_end: {
            type: 'number',
            description: 'Optional end line (inclusive)',
          },
        },
        required: ['file'],
      },
    },
  ],
}));

interface SearchRow {
  file: string;
  line_start: number;
  content: string;
  rank: number;
}

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  // ── memory_search ──────────────────────────────────────────────────────────
  if (name === 'memory_search') {
    const {
      query,
      max_results = 5,
      date_from,
      date_to,
    } = args as {
      query: string;
      max_results?: number;
      date_from?: string;
      date_to?: string;
    };
    const limit = Math.min(max_results ?? 5, 20);

    try {
      // Fetch extra rows when date filtering so we can trim after
      const fetchLimit =
        date_from || date_to ? Math.min(limit * 5, 100) : limit;
      const rows = db
        .prepare(
          `SELECT file, line_start, content, rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, fetchLimit) as SearchRow[];

      const filtered =
        date_from || date_to
          ? rows
              .filter((row) => {
                const m = row.file.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
                if (!m) return true; // Keep MEMORY.md and other files
                const d = m[1];
                if (date_from && d < date_from) return false;
                if (date_to && d > date_to) return false;
                return true;
              })
              .slice(0, limit)
          : rows;

      if (filtered.length === 0) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }

      const text = filtered
        .map(
          (r) =>
            `**${r.file}** (line ${r.line_start}):\n${r.content.slice(0, 600)}`,
        )
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  // ── memory_write ───────────────────────────────────────────────────────────
  if (name === 'memory_write') {
    const { target, content, section, mode } = args as {
      target: 'daily' | 'long_term';
      content: string;
      section?: string;
      mode: 'append' | 'replace_section';
    };

    let filePath: string;

    if (target === 'daily') {
      filePath = path.join(DAILY_DIR, `${getToday()}.md`);
      const existing = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf-8')
        : '';
      const sep = existing
        ? existing.endsWith('\n\n')
          ? ''
          : existing.endsWith('\n')
            ? '\n'
            : '\n\n'
        : '';
      fs.writeFileSync(filePath, existing + sep + content);
    } else {
      // long_term -> MEMORY.md
      filePath = LONG_TERM_FILE;
      const existing = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf-8')
        : '# Memoria de Largo Plazo\n';

      if (mode === 'replace_section' && section) {
        const lines = existing.split('\n');
        const sectionHeader = `## ${section}`;
        const sectionIdx = lines.findIndex(
          (line) => line.trim() === sectionHeader,
        );

        if (sectionIdx === -1) {
          // Append new section
          fs.writeFileSync(
            filePath,
            existing.trimEnd() + `\n\n${sectionHeader}\n\n${content}\n`,
          );
        } else {
          const nextIdx = lines.findIndex(
            (line, idx) => idx > sectionIdx && line.startsWith('## '),
          );
          const endIdx = nextIdx === -1 ? lines.length : nextIdx;
          const before = lines.slice(0, sectionIdx + 1).join('\n');
          const after = lines.slice(endIdx).join('\n');
          const newContent =
            before + '\n\n' + content + '\n' + (after ? '\n' + after : '');
          fs.writeFileSync(filePath, newContent.trimEnd() + '\n');
        }
      } else {
        const sep = existing.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(filePath, existing + sep + content);
      }
    }

    forceReindex(filePath);
    const linesWritten = content.split('\n').length;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            file: getRelativePath(filePath),
            lines_written: linesWritten,
          }),
        },
      ],
    };
  }

  // ── memory_get ─────────────────────────────────────────────────────────────
  if (name === 'memory_get') {
    const { file, line_start, line_end } = args as {
      file: string;
      line_start?: number;
      line_end?: number;
    };

    let filePath: string;
    try {
      filePath = resolveFile(file);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    if (!fs.existsSync(filePath)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              text: '',
              path: getRelativePath(filePath),
              lines: 0,
            }),
          },
        ],
      };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const allLines = raw.split('\n');

    let text: string;
    if (line_start !== undefined || line_end !== undefined) {
      const start = (line_start ?? 1) - 1;
      const end = line_end ?? allLines.length;
      text = allLines.slice(start, end).join('\n');
    } else {
      text = raw;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            text,
            path: getRelativePath(filePath),
            lines: allLines.length,
          }),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
