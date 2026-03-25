// lib/audioVoiceDb.ts
// Unified DB module for voices, dubbings and TTS tasks (Qwen3-TTS based)

import { getDb } from "@/lib/transcriptionDb"; // ← your existing DB factory

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

export type VoiceTag =
  | "conversational"
  | "narration"
  | "social media"
  | "entertainment"
  | "advertisement"
  | "educational";

export interface VoiceRecord {
  id: string;
  name: string;
  language: string;       // e.g. "English", "Chinese"
  accent?: string;        // e.g. "American", "British"
  tags: VoiceTag[];
  description?: string;
  /** Path to the short reference clip used for cloning → used as preview */
  previewPath: string;
  /** Optional saved prompt / embedding file from --save-prompt */
  promptPath?: string;
  sourceType: "microphone" | "file";
  createdAt: Date;
  updatedAt?: Date;
}

export type TtsTaskKind = "voice_profile" | "dubbing";
export type TtsTaskStatus = "queued" | "running" | "completed" | "failed";

export interface TtsTaskRecord {
  id: string;
  kind: TtsTaskKind;
  title: string;
  status: TtsTaskStatus;
  progress: number;       // 0–100
  stage?: string;         // e.g. "transcribe", "translate", "synthesize"
  message?: string;
  inputJson?: string;
  resultJson?: string;
  artifactPath?: string;  // final wav / safetensors / etc
  createdAt: Date;
  updatedAt?: Date;
}

export interface DubbingRecord {
  id: string;
  title: string;
  /** Original or translated script (depending on stage) */
  text: string;
  lang: string;           // target language code e.g. "zh", "en"
  /** Voice prompt / embedding used for synthesis */
  promptPath: string;
  /** Final generated dubbed audio file */
  outputPath: string;
  createdAtMs: number;
}

// ────────────────────────────────────────────────
// Schema & init
// ────────────────────────────────────────────────

let initialized = false;

async function ensureSchema() {
  if (initialized) return;
  const db = await getDb();

  // Voices table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS voices (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      language        TEXT NOT NULL,
      accent          TEXT,
      tags_json       TEXT NOT NULL DEFAULT '[]',
      description     TEXT,
      preview_path    TEXT NOT NULL,
      prompt_path     TEXT,
      source_type     TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
  `);

  // TTS tasks (voice creation + dubbing pipeline steps)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tts_tasks (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      status          TEXT NOT NULL,
      progress        REAL NOT NULL DEFAULT 0,
      stage           TEXT,
      message         TEXT,
      input_json      TEXT,
      result_json     TEXT,
      artifact_path   TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
  `);

  // Completed dubbings (final results)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS dubbings (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      text            TEXT NOT NULL,
      lang            TEXT NOT NULL,
      prompt_path     TEXT NOT NULL,
      output_path     TEXT NOT NULL,
      created_at_ms   INTEGER NOT NULL
    );
  `);

  // Indexes
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_voices_created    ON voices(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tts_kind_created  ON tts_tasks(kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dubbings_created  ON dubbings(created_at_ms DESC);
  `);

  // Optional migrations (safe to run multiple times)
  try { await db.execute(`ALTER TABLE voices ADD COLUMN prompt_path TEXT`); } catch {}
  try { await db.execute(`ALTER TABLE voices ADD COLUMN accent TEXT`); } catch {}

  initialized = true;
}

// ────────────────────────────────────────────────
// Voices CRUD
// ────────────────────────────────────────────────

export async function listVoices(): Promise<VoiceRecord[]> {
  await ensureSchema();
  const db = await getDb();

  const rows = await db.select<any[]>(
    `SELECT * FROM voices ORDER BY datetime(created_at) DESC`
  );

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    language: r.language,
    accent: r.accent ?? undefined,
    tags: JSON.parse(r.tags_json ?? "[]"),
    description: r.description ?? undefined,
    previewPath: r.preview_path,
    promptPath: r.prompt_path ?? undefined,
    sourceType: r.source_type as "microphone" | "file",
    createdAt: new Date(r.created_at),
    updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
  }));
}

export async function getVoice(id: string): Promise<VoiceRecord | undefined> {
  await ensureSchema();
  const db = await getDb();
  const rows = await db.select<any[]>(`SELECT * FROM voices WHERE id = ?`, [id]);
  if (!rows.length) return undefined;
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    language: r.language,
    accent: r.accent ?? undefined,
    tags: JSON.parse(r.tags_json ?? "[]"),
    description: r.description ?? undefined,
    previewPath: r.preview_path,
    promptPath: r.prompt_path ?? undefined,
    sourceType: r.source_type as "microphone" | "file",
    createdAt: new Date(r.created_at),
    updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
  };
}

export async function createVoice(
  data: Omit<VoiceRecord, "id" | "createdAt" | "updatedAt">
): Promise<VoiceRecord> {
  await ensureSchema();
  const db = await getDb();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.execute(
    `INSERT INTO voices (
      id, name, language, accent, tags_json, description, preview_path, prompt_path, source_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.language,
      data.accent?.trim() ? data.accent.trim() : "General",
      JSON.stringify(data.tags),
      data.description ?? null,
      data.previewPath,
      data.promptPath ?? null,
      data.sourceType,
      now,
      now,
    ]
  );

  return {
    id,
    name: data.name,
    language: data.language,
    accent: data.accent?.trim() ? data.accent.trim() : "General",
    tags: data.tags,
    description: data.description,
    previewPath: data.previewPath,
    promptPath: data.promptPath,
    sourceType: data.sourceType,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export async function updateVoiceName(id: string, name: string): Promise<void> {
  await ensureSchema();
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE voices SET name = ?, updated_at = ? WHERE id = ?`,
    [name, now, id]
  );
}

export async function deleteVoice(id: string): Promise<void> {
  await ensureSchema();
  const db = await getDb();
  await db.execute(`DELETE FROM voices WHERE id = ?`, [id]);
}

// ────────────────────────────────────────────────
// Dubbing CRUD (completed dubbings)
// ────────────────────────────────────────────────

export async function listDubbings(): Promise<DubbingRecord[]> {
  await ensureSchema();
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT * FROM dubbings ORDER BY created_at_ms DESC`
  );
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    text: r.text,
    lang: r.lang,
    promptPath: r.prompt_path,
    outputPath: r.output_path,
    createdAtMs: Number(r.created_at_ms),
  }));
}

export async function getDubbing(id: string): Promise<DubbingRecord | undefined> {
  await ensureSchema();
  const db = await getDb();
  const rows = await db.select<any[]>(`SELECT * FROM dubbings WHERE id = ?`, [id]);
  if (!rows.length) return undefined;
  const r = rows[0];
  return {
    id: r.id,
    title: r.title,
    text: r.text,
    lang: r.lang,
    promptPath: r.prompt_path,
    outputPath: r.output_path,
    createdAtMs: Number(r.created_at_ms),
  };
}

export async function saveDubbing(record: DubbingRecord): Promise<void> {
  await ensureSchema();
  const db = await getDb();
  await db.execute(
    `INSERT OR REPLACE INTO dubbings (
      id, title, text, lang, prompt_path, output_path, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.title,
      record.text,
      record.lang,
      record.promptPath,
      record.outputPath,
      record.createdAtMs,
    ]
  );
}

// ────────────────────────────────────────────────
// TTS Tasks (progress tracking for both voice creation & dubbing)
// ────────────────────────────────────────────────

export async function createTtsTask(input: {
  kind: TtsTaskKind;
  title: string;
  inputJson?: string;
}): Promise<TtsTaskRecord> {
  await ensureSchema();
  const db = await getDb();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.execute(
    `INSERT INTO tts_tasks (
      id, kind, title, status, progress, stage, message, input_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.kind, input.title, "queued", 0, null, null, input.inputJson ?? null, now, now]
  );

  return {
    id,
    kind: input.kind,
    title: input.title,
    status: "queued",
    progress: 0,
    stage: undefined,
    message: undefined,
    inputJson: input.inputJson,
    resultJson: undefined,
    artifactPath: undefined,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export async function updateTtsTask(
  id: string,
  patch: Partial<Pick<TtsTaskRecord, "status" | "progress" | "stage" | "message" | "resultJson" | "artifactPath">>
): Promise<void> {
  await ensureSchema();
  const db = await getDb();
  const now = new Date().toISOString();

  const sets: string[] = ["updated_at = ?"];
  const values: any[] = [now];

  if ("status" in patch)    { sets.push("status = ?");    values.push(patch.status); }
  if ("progress" in patch)  { sets.push("progress = ?");  values.push(clamp(patch.progress ?? 0)); }
  if ("stage" in patch)     { sets.push("stage = ?");     values.push(patch.stage ?? null); }
  if ("message" in patch)   { sets.push("message = ?");   values.push(patch.message ?? null); }
  if ("resultJson" in patch){ sets.push("result_json = ?"); values.push(patch.resultJson ?? null); }
  if ("artifactPath" in patch){ sets.push("artifact_path = ?"); values.push(patch.artifactPath ?? null); }

  const sql = `UPDATE tts_tasks SET ${sets.join(", ")} WHERE id = ?`;
  values.push(id);

  await db.execute(sql, values);
}

export async function listTtsTasks(kind?: TtsTaskKind): Promise<TtsTaskRecord[]> {
  await ensureSchema();
  const db = await getDb();

  let query = `SELECT * FROM tts_tasks`;
  const params: any[] = [];
  if (kind) {
    query += ` WHERE kind = ?`;
    params.push(kind);
  }
  query += ` ORDER BY datetime(created_at) DESC`;

  const rows = await db.select<any[]>(query, params);

  return rows.map(r => ({
    id: r.id,
    kind: r.kind as TtsTaskKind,
    title: r.title,
    status: r.status as TtsTaskStatus,
    progress: clamp(Number(r.progress) || 0),
    stage: r.stage ?? undefined,
    message: r.message ?? undefined,
    inputJson: r.input_json ?? undefined,
    resultJson: r.result_json ?? undefined,
    artifactPath: r.artifact_path ?? undefined,
    createdAt: new Date(r.created_at),
    updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
  }));
}

export async function getTtsTask(id: string): Promise<TtsTaskRecord | undefined> {
  await ensureSchema();
  const db = await getDb();
  const rows = await db.select<any[]>(`SELECT * FROM tts_tasks WHERE id = ?`, [id]);
  if (!rows.length) return undefined;
  const r = rows[0];
  return {
    id: r.id,
    kind: r.kind as TtsTaskKind,
    title: r.title,
    status: r.status as TtsTaskStatus,
    progress: clamp(Number(r.progress) || 0),
    stage: r.stage ?? undefined,
    message: r.message ?? undefined,
    inputJson: r.input_json ?? undefined,
    resultJson: r.result_json ?? undefined,
    artifactPath: r.artifact_path ?? undefined,
    createdAt: new Date(r.created_at),
    updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
  };
}

// Helper
function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}