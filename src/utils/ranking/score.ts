/**
 * Resume Scoring Service
 *
 * Approach:
 *  - Resumes are split into chunks of 50
 *  - 3 chunks run in parallel at a time (150 resumes per wave)
 *  - Each chunk = 1 SQL query (cosine + keyword similarity inside Postgres)
 *  - Transient DB errors are retried with exponential backoff
 *  - Failed chunks are isolated — one bad chunk never kills the whole batch
 *  - All writes are upserts — safe to re-run after any crash
 *
 * Requires Postgres extensions (free on Supabase / Neon):
 *   CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector
 *   CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- word_similarity
 *
 * Requires schema addition on ScreeningResult:
 *   @@unique([resumeId, jobId])
 */

import {prisma} from "../../config/prisma"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CHUNK_SIZE   = 50;   // resumes per SQL query — sweet spot for free-tier Postgres
const CONCURRENCY  = 3;    // parallel chunks per wave (3 × 50 = 150 resumes/wave)
const MAX_RETRIES  = 3;    // retry attempts on transient errors
const BASE_DELAY   = 500;  // ms — doubles each retry (500, 1000, 2000)
const MODEL_VERSION = "sql-pgvector-v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChunkRow {
  resume_id: string;
  skills_sem:  number;
  skills_kw:   number;
  exp_sem:     number;
  exp_kw:      number;
  bio_sem:     number;
  bio_kw:      number;
}

export interface ResumeScore {
  resumeId:        string;
  skillScore:      number;
  experienceScore: number;
  bioScore:        number;
  finalScore:      number;
  explanation:     string;
}

export interface BatchResult {
  total:      number;
  succeeded:  number;
  failed:     number;
  skipped:    number;   // resumes with suspiciously zero scores (bad embedding)
  scores:     ResumeScore[];
  failures:   { resumeId: string; error: string }[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// SQL — scores a chunk of up to 50 resumes in one round-trip
// ---------------------------------------------------------------------------

const CHUNK_SCORE_SQL = `
  SELECT
    re."resumeId" AS resume_id,

    MAX(CASE WHEN re.bucket = 'SKILLS'
      THEN GREATEST(0, 1 - (re.embedding <=> j."skillsEmbedding"::vector))
    END) AS skills_sem,

    MAX(CASE WHEN re.bucket = 'SKILLS'
      THEN COALESCE(word_similarity(j."skillsText", re.text), 0)
    END) AS skills_kw,

    MAX(CASE WHEN re.bucket = 'EXPERIENCE'
      THEN GREATEST(0, 1 - (re.embedding <=> j."experienceEmbedding"::vector))
    END) AS exp_sem,

    MAX(CASE WHEN re.bucket = 'EXPERIENCE'
      THEN COALESCE(word_similarity(j."experienceText", re.text), 0)
    END) AS exp_kw,

    MAX(CASE WHEN re.bucket = 'BIO'
      THEN GREATEST(0, 1 - (re.embedding <=> j."bioEmbedding"::vector))
    END) AS bio_sem,

    MAX(CASE WHEN re.bucket = 'BIO'
      THEN COALESCE(word_similarity(j."bioText", re.text), 0)
    END) AS bio_kw

  FROM "ResumeEmbedding" re
  JOIN "Job" j ON j.id::text = $1::text
  WHERE re."resumeId"::text = ANY($2::text[])
  GROUP BY re."resumeId"
`;

// ---------------------------------------------------------------------------
// Score a single chunk of resume IDs
// ---------------------------------------------------------------------------

async function scoreChunk(
  jobId: string,
  resumeIds: string[]
): Promise<{ scores: ResumeScore[]; skipped: string[] }> {
  const rows = await prisma.$queryRawUnsafe<ChunkRow[]>(
    CHUNK_SCORE_SQL,
    jobId,
    resumeIds
  );

  const scores: ResumeScore[] = [];
  const skipped: string[] = [];

  // Track which IDs came back — anything missing has no embeddings at all
  const returnedIds = new Set(rows.map((r) => r.resume_id));
  const missingIds  = resumeIds.filter((id) => !returnedIds.has(id));

  if (missingIds.length > 0) {
    console.warn(
      `[scorer] ${missingIds.length} resume(s) returned no rows — missing embeddings:`,
      missingIds
    );
    skipped.push(...missingIds);
  }

  for (const row of rows) {
    // Within-bucket weighted scores
    console.log(row)
    const skillScore      = row.skills_sem * 0.35 + row.skills_kw  * 0.65;
    const experienceScore = row.exp_sem    * 0.60 + row.exp_kw     * 0.40;
    const bioScore        = row.bio_sem    * 0.75 + row.bio_kw     * 0.25;

    // Final weighted roll-up
    const finalScore =
      skillScore      * 0.45 +
      experienceScore * 0.35 +
      bioScore        * 0.20;

    // A zero final score across all three buckets almost certainly means
    // the job embeddings are NULL — flag it instead of silently writing 0
    if (finalScore <= 0.001) {
      console.warn(
        `[scorer] resume ${row.resume_id} scored 0.000 — ` +
        `likely null job embedding. Skipping.`
      );
      skipped.push(row.resume_id);
      continue;
    }

    scores.push({
      resumeId: row.resume_id,
      skillScore:      round(skillScore),
      experienceScore: round(experienceScore),
      bioScore:        round(bioScore),
      finalScore:      round(finalScore),
      explanation:     buildExplanation(skillScore, experienceScore, bioScore, finalScore),
    });
  }

  return { scores, skipped };
}

// ---------------------------------------------------------------------------
// Persist a chunk's scores in one upsert
// ---------------------------------------------------------------------------

async function persistChunk(
  jobId: string,
  scores: ResumeScore[]
): Promise<void> {
  if (scores.length === 0) return;

  // Prisma doesn't support multi-row upserts natively, so we use a transaction
  // with individual upserts. For 50 rows this is fast (~5ms) and keeps type safety.
  await prisma.$transaction(
    scores.map((s) =>
      prisma.screeningResult.upsert({
        where:  { resumeId_jobId: { resumeId: s.resumeId, jobId } },
        create: {
          resumeId:        s.resumeId,
          jobId,
          skillScore:      s.skillScore,
          experienceScore: s.experienceScore,
          bioScore:   s.bioScore,      
          finalScore:      s.finalScore,
        //   explanation:     s.explanation,
          modelVersion:    MODEL_VERSION,
        },
        update: {
          skillScore:      s.skillScore,
          experienceScore: s.experienceScore,
          bioScore:   s.bioScore,
          finalScore:      s.finalScore,
        //   explanation:     s.explanation,
          modelVersion:    MODEL_VERSION,
        },
      })
    )
  );

  // Mark resumes READY in one batch update
  await prisma.resume.updateMany({
    where: { id: { in: scores.map((s) => s.resumeId) } },
    data:  { status: "READY" },
  });
}

// ---------------------------------------------------------------------------
// Process one chunk with retry
// ---------------------------------------------------------------------------

async function processChunkWithRetry(
  jobId: string,
  resumeIds: string[],
  chunkIndex: number
): Promise<{
  scores:   ResumeScore[];
  skipped:  string[];
  failed:   { resumeId: string; error: string }[];
}> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { scores, skipped } = await scoreChunk(jobId, resumeIds);
      await persistChunk(jobId, scores);

      if (attempt > 1) {
        console.log(`[scorer] chunk ${chunkIndex} succeeded on attempt ${attempt}`);
      }

      return { scores, skipped, failed: [] };

    } catch (err) {
      lastError = err;
      const isTransient = isTransientError(err);

      if (!isTransient || attempt === MAX_RETRIES) {
        // Permanent failure — mark every resume in this chunk as failed
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[scorer] chunk ${chunkIndex} failed permanently:`, error);

        return {
          scores:  [],
          skipped: [],
          failed:  resumeIds.map((resumeId) => ({ resumeId, error })),
        };
      }

      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      console.warn(
        `[scorer] chunk ${chunkIndex} attempt ${attempt} failed (transient), ` +
        `retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  // Should never reach here but TypeScript needs it
  const error = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    scores:  [],
    skipped: [],
    failed:  resumeIds.map((resumeId) => ({ resumeId, error })),
  };
}

// ---------------------------------------------------------------------------
// Main entry point — score all EMBEDDED resumes for a job
// ---------------------------------------------------------------------------

export async function scoreResumesForJob(jobId: string): Promise<BatchResult> {
  const startMs = Date.now();

  // 1. Fetch all resume IDs that need scoring
  const resumes = await prisma.resume.findMany({
    where:  { jobId, status: "EMBEDDED" },
    select: { id: true },
  });

  if (resumes.length === 0) {
    console.log(`[scorer] job ${jobId}: no EMBEDDED resumes to score`);
    return {
      total: 0, succeeded: 0, failed: 0, skipped: 0,
      scores: [], failures: [], durationMs: 0,
    };
  }

  console.log(`[scorer] job ${jobId}: scoring ${resumes.length} resumes`);

  // 2. Split into chunks of 50
  const allIds = resumes.map((r) => r.id);
  const chunks = chunkArray(allIds, CHUNK_SIZE);

  console.log(
    `[scorer] ${chunks.length} chunks of up to ${CHUNK_SIZE}, ` +
    `running ${CONCURRENCY} at a time`
  );

  // 3. Process waves: CONCURRENCY chunks at a time
  const allScores:   ResumeScore[]                      = [];
  const allFailures: { resumeId: string; error: string }[] = [];
  let   totalSkipped = 0;

  for (let waveStart = 0; waveStart < chunks.length; waveStart += CONCURRENCY) {
    const wave        = chunks.slice(waveStart, waveStart + CONCURRENCY);
    const waveNumber  = Math.floor(waveStart / CONCURRENCY) + 1;
    const totalWaves  = Math.ceil(chunks.length / CONCURRENCY);

    console.log(`[scorer] wave ${waveNumber}/${totalWaves} — ${wave.length} chunk(s) in parallel`);

    // Run this wave's chunks in parallel
    const waveResults = await Promise.all(
      wave.map((chunkIds, i) =>
        processChunkWithRetry(jobId, chunkIds, waveStart + i + 1)
      )
    );

    for (const result of waveResults) {
      allScores.push(...result.scores);
      allFailures.push(...result.failed);
      totalSkipped += result.skipped.length;
    }
  }

  const durationMs = Date.now() - startMs;

  console.log(
    `[scorer] job ${jobId} complete in ${durationMs}ms — ` +
    `${allScores.length} scored, ${allFailures.length} failed, ${totalSkipped} skipped`
  );

  return {
    total:     resumes.length,
    succeeded: allScores.length,
    failed:    allFailures.length,
    skipped:   totalSkipped,
    scores:    allScores,
    failures:  allFailures,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Score a single resume (for real-time path — called right after embedding)
// ---------------------------------------------------------------------------

export async function scoreSingleResume(
  resumeId: string,
  jobId: string
): Promise<ResumeScore> {
  const { scores, skipped } = await scoreChunk(jobId, [resumeId]);

  if (skipped.includes(resumeId)) {
    throw new Error(
      `Resume ${resumeId} has missing or null embeddings. ` +
      `Ensure embedding step completed before scoring.`
    );
  }

  const score = scores[0];
  if (!score) {
    throw new Error(`No score produced for resume ${resumeId}`);
  }

  await persistChunk(jobId, [score]);
  return score;
}

// ---------------------------------------------------------------------------
// Fetch ranked results
// ---------------------------------------------------------------------------

export async function getRankedResumes(
  jobId:    string,
  limit     = 50,
  minScore  = 0
) {
  return prisma.screeningResult.findMany({
    where:   { jobId, finalScore: { gte: minScore } },
    orderBy: { finalScore: "desc" },
    take:    limit,
    include: {
      resume: {
        select: {
          id:          true,
        //   status:      true,
          storagePath: true,
        //   parsed:      { select: { parsedJson: true } },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function round(n: number, decimals = 4): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("connection") ||
    msg.includes("timeout")    ||
    msg.includes("too many clients") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("57p03") ||   // cannot_connect_now
    msg.includes("08006")      // connection_failure
  );
}

function buildExplanation(
  skill: number,
  exp:   number,
  bio:   number,
  final: number
): string {
  const pct   = (n: number) => `${Math.round(n * 100)}%`;
  const grade = (n: number) =>
    n >= 0.8 ? "excellent" : n >= 0.6 ? "good" : n >= 0.4 ? "moderate" : "weak";

  return (
    `Final: ${pct(final)}. ` +
    `Skills (45%): ${pct(skill)} [${grade(skill)}]. ` +
    `Experience (35%): ${pct(exp)} [${grade(exp)}]. ` +
    `Bio (20%): ${pct(bio)} [${grade(bio)}].`
  );
}


// const a = await scoreResumesForJob("68722bb7-0d26-4a6e-bd19-edb334c25a68")
// console.log(a)
// const b  = await getRankedResumes("68722bb7-0d26-4a6e-bd19-edb334c25a68")
// console.log(b)