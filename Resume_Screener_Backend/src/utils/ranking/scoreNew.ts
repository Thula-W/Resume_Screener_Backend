import { ChunkRow,ResumeScore } from "../../types";
import { prisma } from "../../config/prisma";
// ---------------------------------------------------------------------------
// SQL: semantic similarity + tsvector FTS rank, per bucket, per resume
// ---------------------------------------------------------------------------

const CHUNK_SCORE_SQL = `
  SELECT
    re."resumeId" AS resume_id,

    -- Semantic: cosine similarity clamped to [0,1]
    MAX(CASE WHEN re.bucket = 'SKILLS'
      THEN GREATEST(0, 1 - (re.embedding <=> j."skillsEmbedding"::vector))
    END) AS skills_sem,

    MAX(CASE WHEN re.bucket = 'EXPERIENCE'
      THEN GREATEST(0, 1 - (re.embedding <=> j."experienceEmbedding"::vector))
    END) AS exp_sem,

    MAX(CASE WHEN re.bucket = 'BIO'
      THEN GREATEST(0, 1 - (re.embedding <=> j."bioEmbedding"::vector))
    END) AS bio_sem,

    -- Keyword: tsvector FTS rank (ts_rank normalised by document length = option 1)
    MAX(CASE WHEN re.bucket = 'SKILLS'
      THEN COALESCE(
        ts_rank(re.text_tsvector, plainto_tsquery('english', j."skillsText"), 1),
        0
      )
    END) AS skills_kw,

    MAX(CASE WHEN re.bucket = 'EXPERIENCE'
      THEN COALESCE(
        ts_rank(re.text_tsvector, plainto_tsquery('english', j."experienceText"), 1),
        0
      )
    END) AS exp_kw,

    MAX(CASE WHEN re.bucket = 'BIO'
      THEN COALESCE(
        ts_rank(re.text_tsvector, plainto_tsquery('english', j."bioText"), 1),
        0
      )
    END) AS bio_kw

  FROM "ResumeEmbedding" re
  JOIN "Job" j ON j.id::text = $1::text
  WHERE re."resumeId"::text = ANY($2::text[])
  GROUP BY re."resumeId"
`;

// ---------------------------------------------------------------------------
// RRF helpers
// ---------------------------------------------------------------------------

const RRF_K = 60; // standard constant; higher = less top-heavy
const MIN_POOL_FOR_RRF = 10;

/**
 * Given a list of raw scores, returns a map of id → RRF score.
 * Items are ranked descending by raw score; RRF = 1 / (k + rank).
 */
function rrfScores(
  items: Array<{ id: string; score: number }>
): Map<string, number> {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const out    = new Map<string, number>();
  sorted.forEach(({ id }, i) => {
    out.set(id, 1 / (RRF_K + i + 1)); // rank is 1-indexed
  });
  return out;
}

/**
 * Merge two ranked lists (semantic + keyword) for a single bucket via RRF.
 * Returns a map of id → merged RRF score.
 */
function mergeBucketRRF(
  semItems: Array<{ id: string; score: number }>,
  kwItems:  Array<{ id: string; score: number }>
): Map<string, number> {
  const semRRF = rrfScores(semItems);
  const kwRRF  = rrfScores(kwItems);

  const allIds = new Set([...semRRF.keys(), ...kwRRF.keys()]);
  const merged = new Map<string, number>();

  for (const id of allIds) {
    merged.set(id, (semRRF.get(id) ?? 0) + (kwRRF.get(id) ?? 0));
  }

  return merged;
}

/**
 * Normalise a Map of scores to [0, 1] using min-max scaling.
 * If all scores are identical the map is returned unchanged (avoids /0).
 */
function minMaxNorm(scores: Map<string, number>): Map<string, number> {
  const vals = [...scores.values()];
  const min  = Math.min(...vals);
  const max  = Math.max(...vals);
  if (max === min) return scores;

  const out = new Map<string, number>();
  for (const [id, v] of scores) {
    out.set(id, (v - min) / (max - min));
  }
  return out;
}


function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// scoreChunkRRF  — drop-in replacement, same signature & return shape
// ---------------------------------------------------------------------------

export const  scoreChunkRRF = async (
  jobId:     string,
  resumeIds: string[]
): Promise<{ scores: ResumeScore[]; skipped: string[] }> => {

  const rows = await prisma.$queryRawUnsafe<ChunkRow[]>(
    CHUNK_SCORE_SQL,
    jobId,
    resumeIds
  );

  const scores:  ResumeScore[] = [];
  const skipped: string[]      = [];

  // Detect completely missing rows (no embeddings at all)
  const returnedIds = new Set(rows.map((r) => r.resume_id));
  for (const id of resumeIds) {
    if (!returnedIds.has(id)) {
      console.warn(`[scorer] no embedding rows for resume ${id} — skipping`);
      skipped.push(id);
    }
  }

  if (rows.length === 0) return { scores, skipped };

  const useRRF = rows.length >= MIN_POOL_FOR_RRF;
  // ── Build per-bucket ranked lists across all rows in this chunk ──────────
  for (const row of rows) {
    const id = row.resume_id;

    let skillScore: number;
    let experienceScore: number;
    let bioScore: number;

    if (useRRF) {
      // ── RRF path (meaningful only with enough candidates) ──────────────
      const buckets = ["skills", "exp", "bio"] as const;
      type Bucket = typeof buckets[number];

      const semLists: Record<Bucket, Array<{ id: string; score: number }>> =
        { skills: [], exp: [], bio: [] };
      const kwLists: Record<Bucket, Array<{ id: string; score: number }>> =
        { skills: [], exp: [], bio: [] };

      for (const r of rows) {
        semLists.skills.push({ id: r.resume_id, score: r.skills_sem ?? 0 });
        semLists.exp   .push({ id: r.resume_id, score: r.exp_sem    ?? 0 });
        semLists.bio   .push({ id: r.resume_id, score: r.bio_sem    ?? 0 });
        kwLists.skills .push({ id: r.resume_id, score: r.skills_kw  ?? 0 });
        kwLists.exp    .push({ id: r.resume_id, score: r.exp_kw     ?? 0 });
        kwLists.bio    .push({ id: r.resume_id, score: r.bio_kw     ?? 0 });
      }

      const skillsRRF = minMaxNorm(mergeBucketRRF(semLists.skills, kwLists.skills));
      const expRRF    = minMaxNorm(mergeBucketRRF(semLists.exp,    kwLists.exp));
      const bioRRF    = minMaxNorm(mergeBucketRRF(semLists.bio,    kwLists.bio));

      skillScore      = skillsRRF.get(id) ?? 0;
      experienceScore = expRRF   .get(id) ?? 0;
      bioScore        = bioRRF   .get(id) ?? 0;

    } else {
      // ── Direct weighted blend — preserves absolute signal ──────────────
      // sem weights higher because cosine similarity is well-calibrated;
      // ts_rank is unbounded so we cap it at 1 before blending
      skillScore      = row.skills_sem * 0.60 + Math.min(row.skills_kw, 1) * 0.40;
      experienceScore = row.exp_sem    * 0.70 + Math.min(row.exp_kw,    1) * 0.30;
      bioScore        = row.bio_sem    * 0.75 + Math.min(row.bio_kw,    1) * 0.25;
    }

    const finalScore =
      skillScore      * 0.46 +
      experienceScore * 0.50 +
      bioScore        * 0.04;

    if (finalScore <= 0.001) {
      console.warn(
        `[scorer] resume ${id} scored 0.000 — likely null job embeddings. Skipping.`
      );
      skipped.push(id);
      continue;
    }

    scores.push({
      resumeId:        id,
      skillScore:      round(skillScore),
      experienceScore: round(experienceScore),
      bioScore:        round(bioScore),
      finalScore:      round(finalScore),
    //   explanation:     buildExplanation(skillScore, experienceScore, bioScore, finalScore),
    });
  }

  return { scores, skipped };
}

//   const buckets = ["skills", "exp", "bio"] as const;
//   type Bucket = typeof buckets[number];

//   const semLists: Record<Bucket, Array<{ id: string; score: number }>> = {
//     skills: [], exp: [], bio: [],
//   };
//   const kwLists: Record<Bucket, Array<{ id: string; score: number }>> = {
//     skills: [], exp: [], bio: [],
//   };

//   for (const row of rows) {
//     semLists.skills.push({ id: row.resume_id, score: row.skills_sem ?? 0 });
//     semLists.exp   .push({ id: row.resume_id, score: row.exp_sem    ?? 0 });
//     semLists.bio   .push({ id: row.resume_id, score: row.bio_sem    ?? 0 });

//     kwLists.skills .push({ id: row.resume_id, score: row.skills_kw  ?? 0 });
//     kwLists.exp    .push({ id: row.resume_id, score: row.exp_kw     ?? 0 });
//     kwLists.bio    .push({ id: row.resume_id, score: row.bio_kw     ?? 0 });
//   }

//   // ── RRF merge + normalise per bucket ────────────────────────────────────

//   const skillsRRF = minMaxNorm(mergeBucketRRF(semLists.skills, kwLists.skills));
//   const expRRF    = minMaxNorm(mergeBucketRRF(semLists.exp,    kwLists.exp));
//   const bioRRF    = minMaxNorm(mergeBucketRRF(semLists.bio,    kwLists.bio));

//   // ── Per-resume roll-up ───────────────────────────────────────────────────

//   for (const row of rows) {
//     const id = row.resume_id;

//     const skillScore      = skillsRRF.get(id) ?? 0;
//     const experienceScore = expRRF   .get(id) ?? 0;
//     const bioScore        = bioRRF   .get(id) ?? 0;

//     // Weighted roll-up — same weights as before
//     const finalScore =
//       skillScore      * 0.36 +
//       experienceScore * 0.60 +
//       bioScore        * 0.04;

//     if (finalScore <= 0.001) {
//       console.warn(
//         `[scorer] resume ${id} scored 0.000 after RRF — ` +
//         `likely null job embeddings. Skipping.`
//       );
//       skipped.push(id);
//       continue;
//     }

//     scores.push({
//       resumeId:        id,
//       skillScore:      round(skillScore),
//       experienceScore: round(experienceScore),
//       bioScore:        round(bioScore),
//       finalScore:      round(finalScore),
//     //   explanation:     buildExplanation(skillScore, experienceScore, bioScore, finalScore),
//     });
//   }

//   return { scores, skipped };
// }