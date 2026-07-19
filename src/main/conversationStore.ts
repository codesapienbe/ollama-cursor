import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs = require('sql.js');

type SqlPrimitive = string | number | null;

interface SqlJsQueryResult {
  columns: string[];
  values: SqlPrimitive[][];
}

interface SqlJsStatement {
  bind(values: SqlPrimitive[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, SqlPrimitive>;
  free(): boolean;
}

interface SqlJsDatabase {
  run(sql: string, params?: SqlPrimitive[]): SqlJsDatabase;
  exec(sql: string, params?: SqlPrimitive[]): SqlJsQueryResult[];
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
}

interface SqlJsModule {
  Database: new (data?: ArrayLike<number> | null) => SqlJsDatabase;
}

interface ParsedGraphifyNode {
  nodeKey: string;
  label: string;
  nodeType: string;
  filePath: string;
  community: string;
  metadataJson: string;
}

interface ParsedGraphifyEdge {
  fromNode: string;
  toNode: string;
  relation: string;
  weight: number | null;
  metadataJson: string;
}

interface ParsedGraphifyCommunity {
  communityId: string;
  label: string;
  summary: string;
  metadataJson: string;
}

export type ConversationMessageRole = 'user' | 'assistant' | 'system';

export interface StoredConversationMessage {
  id: string;
  sessionId: string;
  role: ConversationMessageRole;
  content: string;
  timestamp: number;
}

export interface ActiveConversation {
  sessionId: string;
  messages: StoredConversationMessage[];
}

export interface ConversationSessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  messageCount: number;
  noteCount: number;
  isActive: boolean;
}

export interface ConversationOverview {
  activeSessionId: string;
  totalSessions: number;
  sessions: ConversationSessionSummary[];
}

export interface SessionNote {
  id: string;
  sessionId: string;
  content: string;
  createdAt: number;
}

export interface GraphifyImportSummary {
  filesImported: number;
  nodesImported: number;
  edgesImported: number;
  communitiesImported: number;
}

export interface GraphifyStatus {
  sources: number;
  nodes: number;
  edges: number;
  communities: number;
  lastImportedAt: number;
}

const ACTIVE_SESSION_KEY = 'active_session_id';
const DATABASE_FILE_NAME = 'conversation-history.sqlite';
const TABLES = {
  sessions: 'olliberty_sessions',
  messages: 'olliberty_messages',
  notes: 'olliberty_notes',
  graphifySources: 'olliberty_graphify_sources',
  graphifyNodes: 'olliberty_graphify_nodes',
  graphifyEdges: 'olliberty_graphify_edges',
  graphifyCommunities: 'olliberty_graphify_communities',
  metadata: 'olliberty_metadata'
} as const;

const LEGACY_TABLES = {
  sessions: 'sessions',
  messages: 'messages',
  notes: 'notes',
  graphifySources: 'graphify_sources',
  graphifyNodes: 'graphify_nodes',
  graphifyEdges: 'graphify_edges',
  graphifyCommunities: 'graphify_communities',
  metadata: 'metadata'
} as const;

export class ConversationStore {
  private readonly databasePath: string;
  private readonly wasmDirectory: string;
  private initializationPromise?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private db?: SqlJsDatabase;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.databasePath = path.join(this.context.globalStorageUri.fsPath, DATABASE_FILE_NAME);
    this.wasmDirectory = path.join(this.context.extensionUri.fsPath, 'node_modules', 'sql.js', 'dist');
  }

  async getActiveConversation(): Promise<ActiveConversation> {
    await this.ensureInitialized();
    const sessionId = this.readActiveSessionId();
    return {
      sessionId,
      messages: this.readMessagesBySessionId(sessionId)
    };
  }

  async startNewSession(): Promise<ActiveConversation> {
    return this.withMutation(async () => {
      const timestamp = Date.now();
      const sessionId = this.createSession(timestamp);
      this.setActiveSessionId(sessionId);
      await this.persistDatabase();

      return {
        sessionId,
        messages: []
      };
    });
  }

  async activateSession(sessionId: string): Promise<ActiveConversation | null> {
    return this.withMutation(async () => {
      if (!this.sessionExists(sessionId)) {
        return null;
      }

      this.setActiveSessionId(sessionId);
      await this.persistDatabase();

      return {
        sessionId,
        messages: this.readMessagesBySessionId(sessionId)
      };
    });
  }

  async appendMessage(
    sessionId: string,
    role: ConversationMessageRole,
    content: string,
    timestamp = Date.now()
  ): Promise<StoredConversationMessage> {
    return this.withMutation(async () => {
      if (!this.sessionExists(sessionId)) {
        throw new Error(`Conversation session '${sessionId}' was not found.`);
      }

      const id = this.generateMessageId();
      this.databaseOrThrow().run(
        `
          INSERT INTO ${TABLES.messages} (id, session_id, role, content, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `,
        [id, sessionId, role, content, timestamp]
      );

      this.databaseOrThrow().run(
        `
          UPDATE ${TABLES.sessions}
          SET updated_at = ?
          WHERE id = ?
        `,
        [timestamp, sessionId]
      );

      await this.persistDatabase();

      return {
        id,
        sessionId,
        role,
        content,
        timestamp
      };
    });
  }

  async addNote(sessionId: string, content: string, createdAt = Date.now()): Promise<SessionNote> {
    return this.withMutation(async () => {
      if (!this.sessionExists(sessionId)) {
        throw new Error(`Conversation session '${sessionId}' was not found.`);
      }

      const id = this.generateNoteId();
      this.databaseOrThrow().run(
        `
          INSERT INTO ${TABLES.notes} (id, session_id, content, created_at)
          VALUES (?, ?, ?, ?)
        `,
        [id, sessionId, content, createdAt]
      );
      await this.persistDatabase();

      return {
        id,
        sessionId,
        content,
        createdAt
      };
    });
  }

  async listNotes(sessionId: string, limit = 50): Promise<SessionNote[]> {
    await this.ensureInitialized();
    if (!this.sessionExists(sessionId)) {
      throw new Error(`Conversation session '${sessionId}' was not found.`);
    }

    return this.readNotesBySessionId(sessionId, limit);
  }

  async importGraphifyFiles(filePaths: string[]): Promise<GraphifyImportSummary> {
    const uniquePaths = Array.from(new Set(filePaths.map(filePath => path.resolve(filePath))));
    return this.withMutation(async () => {
      const summary: GraphifyImportSummary = {
        filesImported: 0,
        nodesImported: 0,
        edgesImported: 0,
        communitiesImported: 0
      };

      for (const filePath of uniquePaths) {
        let parsed: unknown;
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          parsed = JSON.parse(content) as unknown;
        } catch (error) {
          const maybeFsError = error as NodeJS.ErrnoException;
          if (maybeFsError.code === 'ENOENT') {
            continue;
          }
          throw error;
        }

        const sourceType = this.detectGraphifySourceType(filePath);
        const parsedDoc = this.parseGraphifyDocument(parsed);
        const sourceId = this.generateGraphifySourceId(filePath);

        this.databaseOrThrow().run(
          `
            INSERT INTO ${TABLES.graphifySources} (id, source_path, source_type, imported_at, payload_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_path) DO UPDATE SET
              id = excluded.id,
              source_type = excluded.source_type,
              imported_at = excluded.imported_at,
              payload_json = excluded.payload_json
          `,
          [sourceId, filePath, sourceType, Date.now(), JSON.stringify(parsed)]
        );

        this.databaseOrThrow().run(`DELETE FROM ${TABLES.graphifyNodes} WHERE source_id = ?`, [sourceId]);
        this.databaseOrThrow().run(`DELETE FROM ${TABLES.graphifyEdges} WHERE source_id = ?`, [sourceId]);
        this.databaseOrThrow().run(`DELETE FROM ${TABLES.graphifyCommunities} WHERE source_id = ?`, [sourceId]);

        for (const node of parsedDoc.nodes) {
          this.databaseOrThrow().run(
            `
              INSERT INTO ${TABLES.graphifyNodes} (
                source_id, node_key, label, node_type, file_path, community, metadata_json
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [
              sourceId,
              node.nodeKey,
              node.label,
              node.nodeType,
              node.filePath,
              node.community,
              node.metadataJson
            ]
          );
          summary.nodesImported += 1;
        }

        for (const edge of parsedDoc.edges) {
          this.databaseOrThrow().run(
            `
              INSERT INTO ${TABLES.graphifyEdges} (
                source_id, from_node, to_node, relation, weight, metadata_json
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `,
            [sourceId, edge.fromNode, edge.toNode, edge.relation, edge.weight, edge.metadataJson]
          );
          summary.edgesImported += 1;
        }

        for (const community of parsedDoc.communities) {
          this.databaseOrThrow().run(
            `
              INSERT INTO ${TABLES.graphifyCommunities} (
                source_id, community_id, label, summary, metadata_json
              )
              VALUES (?, ?, ?, ?, ?)
            `,
            [sourceId, community.communityId, community.label, community.summary, community.metadataJson]
          );
          summary.communitiesImported += 1;
        }

        summary.filesImported += 1;
      }

      if (summary.filesImported > 0) {
        await this.persistDatabase();
      }

      return summary;
    });
  }

  async getGraphifyStatus(): Promise<GraphifyStatus> {
    await this.ensureInitialized();
    return {
      sources: this.readCount(`SELECT COUNT(*) AS total FROM ${TABLES.graphifySources}`),
      nodes: this.readCount(`SELECT COUNT(*) AS total FROM ${TABLES.graphifyNodes}`),
      edges: this.readCount(`SELECT COUNT(*) AS total FROM ${TABLES.graphifyEdges}`),
      communities: this.readCount(`SELECT COUNT(*) AS total FROM ${TABLES.graphifyCommunities}`),
      lastImportedAt: this.readMax(`SELECT MAX(imported_at) AS last_imported FROM ${TABLES.graphifySources}`)
    };
  }

  async buildGraphifyPromptContext(query: string, maxNodes = 6): Promise<string> {
    await this.ensureInitialized();
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) {
      return '';
    }

    const candidates: Array<{
      nodeKey: string;
      label: string;
      nodeType: string;
      filePath: string;
      community: string;
      score: number;
    }> = [];

    const statement = this.databaseOrThrow().prepare(
      `
        SELECT node_key, label, node_type, file_path, community
        FROM ${TABLES.graphifyNodes}
      `
    );

    while (statement.step()) {
      const row = statement.getAsObject();
      const label = this.readStringColumn(row.label);
      const nodeType = this.readStringColumn(row.node_type);
      const filePath = this.readStringColumn(row.file_path);
      const community = this.readStringColumn(row.community);
      const score = this.scoreGraphNode(`${label} ${nodeType} ${filePath} ${community}`, tokens);
      if (score <= 0) {
        continue;
      }

      candidates.push({
        nodeKey: this.readStringColumn(row.node_key),
        label,
        nodeType,
        filePath,
        community,
        score
      });
    }
    statement.free();

    const topNodes = candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, maxNodes));

    if (!topNodes.length) {
      return '';
    }

    const edgeLines = new Set<string>();
    for (const node of topNodes.slice(0, 4)) {
      const edgeStatement = this.databaseOrThrow().prepare(
        `
          SELECT from_node, to_node, relation
          FROM ${TABLES.graphifyEdges}
          WHERE from_node = ? OR to_node = ?
          LIMIT 5
        `
      );
      edgeStatement.bind([node.nodeKey, node.nodeKey]);
      while (edgeStatement.step()) {
        const row = edgeStatement.getAsObject();
        edgeLines.add(
          `${this.readStringColumn(row.from_node)} --${this.readStringColumn(row.relation)}--> ${this.readStringColumn(row.to_node)}`
        );
      }
      edgeStatement.free();
    }

    const nodeLines = topNodes.map(node => {
      const typeChunk = node.nodeType ? ` [${node.nodeType}]` : '';
      const fileChunk = node.filePath ? ` (${node.filePath})` : '';
      const communityChunk = node.community ? ` {${node.community}}` : '';
      return `- ${node.label}${typeChunk}${fileChunk}${communityChunk}`;
    });

    const relationLines = Array.from(edgeLines).slice(0, 8);
    return [
      'Graphify structural context:',
      ...nodeLines,
      ...(relationLines.length ? ['', 'Graph relationships:', ...relationLines.map(line => `- ${line}`)] : [])
    ].join('\n');
  }

  async getOverview(limit?: number): Promise<ConversationOverview> {
    await this.ensureInitialized();
    const effectiveLimit = typeof limit === 'number' ? Math.max(1, Math.trunc(limit)) : null;
    const activeSessionId = this.readActiveSessionId();
    const sessions: ConversationSessionSummary[] = [];
    const query = [
      'SELECT',
      '  s.id,',
      '  s.created_at,',
      '  s.updated_at,',
      '  COALESCE(msg.last_message_at, s.updated_at) AS last_message_at,',
      '  COALESCE(msg.message_count, 0) AS message_count,',
      '  COALESCE(nt.note_count, 0) AS note_count',
      `FROM ${TABLES.sessions} AS s`,
      'LEFT JOIN (',
      '  SELECT session_id, COUNT(*) AS message_count, MAX(timestamp) AS last_message_at',
      `  FROM ${TABLES.messages}`,
      '  GROUP BY session_id',
      ') AS msg',
      '  ON msg.session_id = s.id',
      'LEFT JOIN (',
      '  SELECT session_id, COUNT(*) AS note_count',
      `  FROM ${TABLES.notes}`,
      '  GROUP BY session_id',
      ') AS nt',
      '  ON nt.session_id = s.id',
      'ORDER BY',
      '  CASE WHEN s.id = ? THEN 0 ELSE 1 END,',
      '  last_message_at DESC',
      ...(effectiveLimit === null ? [] : ['LIMIT ?'])
    ].join('\n');

    const statement = this.databaseOrThrow().prepare(
      query
    );

    statement.bind(
      effectiveLimit === null
        ? [activeSessionId]
        : [activeSessionId, effectiveLimit]
    );
    while (statement.step()) {
      const row = statement.getAsObject();
      sessions.push({
        id: this.readStringColumn(row.id),
        createdAt: this.readNumberColumn(row.created_at),
        updatedAt: this.readNumberColumn(row.updated_at),
        lastMessageAt: this.readNumberColumn(row.last_message_at),
        messageCount: this.readNumberColumn(row.message_count),
        noteCount: this.readNumberColumn(row.note_count),
        isActive: this.readStringColumn(row.id) === activeSessionId
      });
    }
    statement.free();

    const totalSessions = this.readCount(`SELECT COUNT(*) AS total FROM ${TABLES.sessions}`);

    return {
      activeSessionId,
      totalSessions,
      sessions
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initialize();
    }

    await this.initializationPromise;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });

    const SQL = await initSqlJs({
      locateFile: (file: string) => path.join(this.wasmDirectory, file)
    }) as SqlJsModule;

    const existingDbBytes = await this.readDatabaseFile();
    this.db = existingDbBytes
      ? new SQL.Database(existingDbBytes)
      : new SQL.Database();

    this.databaseOrThrow().run('PRAGMA foreign_keys = ON;');
    this.databaseOrThrow().run(
      `
        CREATE TABLE IF NOT EXISTS ${TABLES.sessions} (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ${TABLES.messages} (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES ${TABLES.sessions}(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_olliberty_messages_session_row
        ON ${TABLES.messages} (session_id, row_id);

        CREATE TABLE IF NOT EXISTS ${TABLES.notes} (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES ${TABLES.sessions}(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_olliberty_notes_session_created
        ON ${TABLES.notes} (session_id, created_at);

        CREATE TABLE IF NOT EXISTS ${TABLES.graphifySources} (
          id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL UNIQUE,
          source_type TEXT NOT NULL,
          imported_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_olliberty_graphify_sources_imported
        ON ${TABLES.graphifySources} (imported_at);

        CREATE TABLE IF NOT EXISTS ${TABLES.graphifyNodes} (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          node_key TEXT NOT NULL,
          label TEXT NOT NULL,
          node_type TEXT NOT NULL,
          file_path TEXT NOT NULL,
          community TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          FOREIGN KEY (source_id) REFERENCES ${TABLES.graphifySources}(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_olliberty_graphify_nodes_key
        ON ${TABLES.graphifyNodes} (node_key);

        CREATE INDEX IF NOT EXISTS idx_olliberty_graphify_nodes_source
        ON ${TABLES.graphifyNodes} (source_id);

        CREATE TABLE IF NOT EXISTS ${TABLES.graphifyEdges} (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          from_node TEXT NOT NULL,
          to_node TEXT NOT NULL,
          relation TEXT NOT NULL,
          weight REAL,
          metadata_json TEXT NOT NULL,
          FOREIGN KEY (source_id) REFERENCES ${TABLES.graphifySources}(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_olliberty_graphify_edges_nodes
        ON ${TABLES.graphifyEdges} (from_node, to_node);

        CREATE INDEX IF NOT EXISTS idx_olliberty_graphify_edges_source
        ON ${TABLES.graphifyEdges} (source_id);

        CREATE TABLE IF NOT EXISTS ${TABLES.graphifyCommunities} (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          label TEXT NOT NULL,
          summary TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          FOREIGN KEY (source_id) REFERENCES ${TABLES.graphifySources}(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_olliberty_graphify_communities_source
        ON ${TABLES.graphifyCommunities} (source_id);

        CREATE TABLE IF NOT EXISTS ${TABLES.metadata} (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `
    );

    let shouldPersist = false;
    if (this.migrateFromLegacySchema()) {
      shouldPersist = true;
    }
    const activeSessionId = this.readActiveSessionIdRaw();
    if (!activeSessionId || !this.sessionExists(activeSessionId)) {
      const sessionId = this.createSession(Date.now());
      this.setActiveSessionId(sessionId);
      shouldPersist = true;
    }

    if (!existingDbBytes) {
      shouldPersist = true;
    }

    if (shouldPersist) {
      await this.persistDatabase();
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();

    const resultPromise = this.mutationQueue.then(operation, operation);
    this.mutationQueue = resultPromise.then(
      () => undefined,
      () => undefined
    );

    return resultPromise;
  }

  private async readDatabaseFile(): Promise<Uint8Array | undefined> {
    try {
      const file = await fs.readFile(this.databasePath);
      return new Uint8Array(file);
    } catch (error) {
      const maybeFsError = error as NodeJS.ErrnoException;
      if (maybeFsError.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private readMessagesBySessionId(sessionId: string): StoredConversationMessage[] {
    const messages: StoredConversationMessage[] = [];
    const statement = this.databaseOrThrow().prepare(
      `
        SELECT id, session_id, role, content, timestamp
        FROM ${TABLES.messages}
        WHERE session_id = ?
        ORDER BY row_id ASC
      `
    );

    statement.bind([sessionId]);
    while (statement.step()) {
      const row = statement.getAsObject();
      messages.push({
        id: this.readStringColumn(row.id),
        sessionId: this.readStringColumn(row.session_id),
        role: this.readRoleColumn(row.role),
        content: this.readStringColumn(row.content),
        timestamp: this.readNumberColumn(row.timestamp)
      });
    }
    statement.free();

    return messages;
  }

  private readNotesBySessionId(sessionId: string, limit: number): SessionNote[] {
    const notes: SessionNote[] = [];
    const statement = this.databaseOrThrow().prepare(
      `
        SELECT id, session_id, content, created_at
        FROM ${TABLES.notes}
        WHERE session_id = ?
        ORDER BY created_at DESC, row_id DESC
        LIMIT ?
      `
    );

    statement.bind([sessionId, Math.max(1, Math.trunc(limit))]);
    while (statement.step()) {
      const row = statement.getAsObject();
      notes.push({
        id: this.readStringColumn(row.id),
        sessionId: this.readStringColumn(row.session_id),
        content: this.readStringColumn(row.content),
        createdAt: this.readNumberColumn(row.created_at)
      });
    }
    statement.free();

    return notes;
  }

  private readRoleColumn(value: SqlPrimitive): ConversationMessageRole {
    const role = this.readStringColumn(value);
    if (role === 'user' || role === 'assistant' || role === 'system') {
      return role;
    }
    throw new Error(`Unsupported stored conversation role '${role}'.`);
  }

  private readCount(query: string): number {
    const result = this.databaseOrThrow().exec(query);
    if (!result.length || !result[0].values.length) {
      return 0;
    }

    return this.readNumberColumn(result[0].values[0][0]);
  }

  private readMax(query: string): number {
    const result = this.databaseOrThrow().exec(query);
    if (!result.length || !result[0].values.length) {
      return 0;
    }

    const value = result[0].values[0][0];
    if (value === null) {
      return 0;
    }

    return this.readNumberColumn(value);
  }

  private detectGraphifySourceType(filePath: string): string {
    const fileName = path.basename(filePath).toLowerCase();
    if (fileName === 'graph.json') {
      return 'graph';
    }
    if (fileName.includes('analysis')) {
      return 'analysis';
    }
    if (fileName.includes('label')) {
      return 'labels';
    }
    return 'graphify-json';
  }

  private generateGraphifySourceId(filePath: string): string {
    const digest = createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 24);
    return `gsrc_${digest}`;
  }

  private parseGraphifyDocument(document: unknown): {
    nodes: ParsedGraphifyNode[];
    edges: ParsedGraphifyEdge[];
    communities: ParsedGraphifyCommunity[];
  } {
    const nodes = this.parseGraphifyNodes(document);
    const edges = this.parseGraphifyEdges(document);
    const communities = this.parseGraphifyCommunities(document);
    return { nodes, edges, communities };
  }

  private parseGraphifyNodes(document: unknown): ParsedGraphifyNode[] {
    const rawNodes = this.pickObjectArray(document, [
      ['nodes'],
      ['graph', 'nodes'],
      ['data', 'nodes']
    ]);
    if (!rawNodes) {
      return [];
    }

    const nodes: ParsedGraphifyNode[] = [];
    for (const rawNode of rawNodes) {
      const nodeKey = this.toOptionalString(rawNode.id)
        ?? this.toOptionalString(rawNode.key)
        ?? this.toOptionalString(rawNode.name)
        ?? this.toOptionalString(rawNode.label);
      if (!nodeKey) {
        continue;
      }

      nodes.push({
        nodeKey,
        label: this.toOptionalString(rawNode.label) ?? this.toOptionalString(rawNode.name) ?? nodeKey,
        nodeType: this.toOptionalString(rawNode.type) ?? this.toOptionalString(rawNode.kind) ?? '',
        filePath: this.toOptionalString(rawNode.file)
          ?? this.toOptionalString(rawNode.path)
          ?? this.toOptionalString(rawNode.file_path)
          ?? '',
        community: this.toOptionalString(rawNode.community)
          ?? this.toOptionalString(rawNode.cluster)
          ?? this.toOptionalString(rawNode.group)
          ?? '',
        metadataJson: JSON.stringify(rawNode)
      });
    }

    return this.uniqueBy(nodes, node => node.nodeKey);
  }

  private parseGraphifyEdges(document: unknown): ParsedGraphifyEdge[] {
    const rawEdges = this.pickObjectArray(document, [
      ['edges'],
      ['links'],
      ['graph', 'edges'],
      ['graph', 'links']
    ]);
    if (!rawEdges) {
      return [];
    }

    const edges: ParsedGraphifyEdge[] = [];
    for (const rawEdge of rawEdges) {
      const fromNode = this.toOptionalString(rawEdge.source)
        ?? this.toOptionalString(rawEdge.from)
        ?? this.toOptionalString(rawEdge.src)
        ?? this.toOptionalString(rawEdge.u);
      const toNode = this.toOptionalString(rawEdge.target)
        ?? this.toOptionalString(rawEdge.to)
        ?? this.toOptionalString(rawEdge.dst)
        ?? this.toOptionalString(rawEdge.v);
      if (!fromNode || !toNode) {
        continue;
      }

      const relation = this.toOptionalString(rawEdge.relation)
        ?? this.toOptionalString(rawEdge.type)
        ?? this.toOptionalString(rawEdge.kind)
        ?? 'related_to';

      const weight = this.toOptionalNumber(rawEdge.weight)
        ?? this.toOptionalNumber(rawEdge.score)
        ?? this.toOptionalNumber(rawEdge.value)
        ?? null;

      edges.push({
        fromNode,
        toNode,
        relation,
        weight,
        metadataJson: JSON.stringify(rawEdge)
      });
    }

    return this.uniqueBy(edges, edge => `${edge.fromNode}|${edge.relation}|${edge.toNode}`);
  }

  private parseGraphifyCommunities(document: unknown): ParsedGraphifyCommunity[] {
    const arrayCommunities = this.pickObjectArray(document, [
      ['communities'],
      ['community_labels']
    ]);

    const communities: ParsedGraphifyCommunity[] = [];
    if (arrayCommunities) {
      for (const rawCommunity of arrayCommunities) {
        const communityId = this.toOptionalString(rawCommunity.id)
          ?? this.toOptionalString(rawCommunity.community)
          ?? this.toOptionalString(rawCommunity.key)
          ?? this.toOptionalString(rawCommunity.label);
        if (!communityId) {
          continue;
        }

        communities.push({
          communityId,
          label: this.toOptionalString(rawCommunity.label) ?? communityId,
          summary: this.toOptionalString(rawCommunity.summary)
            ?? this.toOptionalString(rawCommunity.description)
            ?? '',
          metadataJson: JSON.stringify(rawCommunity)
        });
      }
    }

    const labelMap = this.pickRecord(document, [
      ['labels'],
      ['community_labels_map']
    ]);
    if (labelMap) {
      for (const [communityId, labelValue] of Object.entries(labelMap)) {
        const label = this.toOptionalString(labelValue);
        if (!label) {
          continue;
        }
        communities.push({
          communityId,
          label,
          summary: '',
          metadataJson: JSON.stringify({ communityId, label })
        });
      }
    }

    return this.uniqueBy(communities, community => community.communityId);
  }

  private pickObjectArray(document: unknown, paths: string[][]): Array<Record<string, unknown>> | null {
    for (const targetPath of paths) {
      const value = this.readPath(document, targetPath);
      if (Array.isArray(value)) {
        return value.filter(this.isRecord);
      }
    }
    return null;
  }

  private pickRecord(document: unknown, paths: string[][]): Record<string, unknown> | null {
    for (const targetPath of paths) {
      const value = this.readPath(document, targetPath);
      if (this.isRecord(value)) {
        return value;
      }
    }
    return null;
  }

  private readPath(source: unknown, targetPath: string[]): unknown {
    let current: unknown = source;
    for (const segment of targetPath) {
      if (!this.isRecord(current) || !(segment in current)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private toOptionalString(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    return null;
  }

  private toOptionalNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  private tokenizeQuery(query: string): string[] {
    const tokens = query.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [];
    return Array.from(new Set(tokens)).slice(0, 10);
  }

  private scoreGraphNode(haystack: string, tokens: string[]): number {
    const normalizedHaystack = haystack.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (normalizedHaystack.includes(token)) {
        score += 1;
      }
    }
    return score;
  }

  private uniqueBy<T>(items: T[], keySelector: (item: T) => string): T[] {
    const seen = new Set<string>();
    const uniqueItems: T[] = [];
    for (const item of items) {
      const key = keySelector(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueItems.push(item);
    }
    return uniqueItems;
  }

  private migrateFromLegacySchema(): boolean {
    const migrations: Array<{
      source: string;
      target: string;
      columns: string[];
      replace?: boolean;
    }> = [
      {
        source: LEGACY_TABLES.sessions,
        target: TABLES.sessions,
        columns: ['id', 'created_at', 'updated_at']
      },
      {
        source: LEGACY_TABLES.messages,
        target: TABLES.messages,
        columns: ['id', 'session_id', 'role', 'content', 'timestamp']
      },
      {
        source: LEGACY_TABLES.notes,
        target: TABLES.notes,
        columns: ['id', 'session_id', 'content', 'created_at']
      },
      {
        source: LEGACY_TABLES.graphifySources,
        target: TABLES.graphifySources,
        columns: ['id', 'source_path', 'source_type', 'imported_at', 'payload_json']
      },
      {
        source: LEGACY_TABLES.graphifyNodes,
        target: TABLES.graphifyNodes,
        columns: ['source_id', 'node_key', 'label', 'node_type', 'file_path', 'community', 'metadata_json']
      },
      {
        source: LEGACY_TABLES.graphifyEdges,
        target: TABLES.graphifyEdges,
        columns: ['source_id', 'from_node', 'to_node', 'relation', 'weight', 'metadata_json']
      },
      {
        source: LEGACY_TABLES.graphifyCommunities,
        target: TABLES.graphifyCommunities,
        columns: ['source_id', 'community_id', 'label', 'summary', 'metadata_json']
      },
      {
        source: LEGACY_TABLES.metadata,
        target: TABLES.metadata,
        columns: ['key', 'value'],
        replace: true
      }
    ];

    let migrated = false;
    for (const migration of migrations) {
      migrated = this.migrateLegacyTable(migration) || migrated;
    }

    return migrated;
  }

  private migrateLegacyTable(migration: {
    source: string;
    target: string;
    columns: string[];
    replace?: boolean;
  }): boolean {
    if (migration.source === migration.target || !this.tableExists(migration.source)) {
      return false;
    }

    const beforeCount = this.readCount(`SELECT COUNT(*) AS total FROM ${migration.target}`);
    const insertKeyword = migration.replace ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
    const columns = migration.columns.join(', ');

    this.databaseOrThrow().run(
      `${insertKeyword} INTO ${migration.target} (${columns}) SELECT ${columns} FROM ${migration.source}`
    );

    const afterCount = this.readCount(`SELECT COUNT(*) AS total FROM ${migration.target}`);
    return afterCount > beforeCount;
  }

  private tableExists(tableName: string): boolean {
    const result = this.databaseOrThrow().exec(
      `
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
      `,
      [tableName]
    );

    return result.length > 0 && result[0].values.length > 0;
  }

  private sessionExists(sessionId: string): boolean {
    const result = this.databaseOrThrow().exec(
      `SELECT 1 AS exists_flag FROM ${TABLES.sessions} WHERE id = ? LIMIT 1`,
      [sessionId]
    );
    return result.length > 0 && result[0].values.length > 0;
  }

  private createSession(timestamp: number): string {
    const sessionId = this.generateSessionId();
    this.databaseOrThrow().run(
      `
        INSERT INTO ${TABLES.sessions} (id, created_at, updated_at)
        VALUES (?, ?, ?)
      `,
      [sessionId, timestamp, timestamp]
    );
    return sessionId;
  }

  private readActiveSessionId(): string {
    const activeSessionId = this.readActiveSessionIdRaw();
    if (!activeSessionId) {
      throw new Error('Active conversation session is missing.');
    }
    return activeSessionId;
  }

  private readActiveSessionIdRaw(): string | null {
    const result = this.databaseOrThrow().exec(
      `SELECT value FROM ${TABLES.metadata} WHERE key = ? LIMIT 1`,
      [ACTIVE_SESSION_KEY]
    );
    if (!result.length || !result[0].values.length) {
      return null;
    }

    return this.readStringColumn(result[0].values[0][0]);
  }

  private setActiveSessionId(sessionId: string): void {
    this.databaseOrThrow().run(
      `
        INSERT INTO ${TABLES.metadata} (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      [ACTIVE_SESSION_KEY, sessionId]
    );
  }

  private async persistDatabase(): Promise<void> {
    const dbBytes = this.databaseOrThrow().export();
    await fs.writeFile(this.databasePath, Buffer.from(dbBytes));
  }

  private readStringColumn(value: SqlPrimitive): string {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    throw new Error('Expected a string-compatible SQLite value.');
  }

  private readNumberColumn(value: SqlPrimitive): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    throw new Error('Expected a numeric SQLite value.');
  }

  private generateSessionId(): string {
    return `sess_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  private generateMessageId(): string {
    return `msg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  private generateNoteId(): string {
    return `note_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  private databaseOrThrow(): SqlJsDatabase {
    if (!this.db) {
      throw new Error('Conversation database is not initialized.');
    }
    return this.db;
  }
}
