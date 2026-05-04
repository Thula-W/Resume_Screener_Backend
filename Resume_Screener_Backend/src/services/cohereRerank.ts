import { prisma } from "../config/prisma";
import { JobStatus } from "@prisma/client";
import { cohereClient } from "../config/cohere"
import { fetchJobMetadata , fetchTopScreeningResults, fetchResumeContents} from "../utils/ranking/rerank";
import { JobData, RerankSaveItem } from "../types";


const COHERE_MODEL = "rerank-english-v3.0";
const MIN_RERANK_COUNT = 25;
const TOP_PERCENT = 0.25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// interface JobMetadata {
//   id: string;
//   title: string;
//   overview: string | null;
//   skillsText: string | null;
//   experienceText: string | null;
//   bioText: string | null;
// }

// interface ScreeningResultRow {
//   id: string;
//   resumeId: string;
//   finalScore: number;
// }

// interface ResumeContentRow {
//   resumeId: string;
//   content: string | null;
// }


function calculateTopN(totalResumes: number): number {
  if (totalResumes <= MIN_RERANK_COUNT) return totalResumes;
  const quarter = Math.ceil(totalResumes * TOP_PERCENT);
  return Math.min(Math.max(quarter, MIN_RERANK_COUNT), totalResumes);
}

// ---------------------------------------------------------------------------
// Helper: build the Cohere query string from the job record + evaluations
//
// Structure:
//   ROLE: <title>
//   OVERVIEW: <overview>
//   IDEAL CANDIDATE — SKILLS: <skillsText>
//   IDEAL CANDIDATE — EXPERIENCE: <experienceText>
//   IDEAL CANDIDATE — PROFILE: <bioText>
//   RECRUITER SIGNALS: <signal 1> | <signal 2> | ...
//
// Recruiter signals are the one-line judgement strings stored in Evaluations.
// They give Cohere direct human signal about what the recruiter actually cares
// about — e.g. "must have shipped production ML models" or "startup background
// strongly preferred". These are intentionally kept brief so they don't drown
// out the structured job fields.
// ---------------------------------------------------------------------------

function buildCohereQuery(
  job: JobData,
  signals: string[]
): string {
  const parts: string[] = [];

  parts.push(`ROLE: ${job.title}`);

  if (job.overview?.trim()) {
    parts.push(`OVERVIEW: ${job.overview.trim()}`);
  }
  if (job.skillsText?.trim()) {
    parts.push(`IDEAL CANDIDATE — SKILLS: ${job.skillsText.trim()}`);
  }
  if (job.experienceText?.trim()) {
    parts.push(`IDEAL CANDIDATE — EXPERIENCE: ${job.experienceText.trim()}`);
  }
  if (job.bioText?.trim()) {
    parts.push(`IDEAL CANDIDATE — PROFILE: ${job.bioText.trim()}`);
  }
  if (signals.length > 0) {
    parts.push(`RECRUITER SIGNALS: ${signals.join(" | ")}`);
  }

  parts.push(`INSTRUCTION: Rank candidates based on semantic relevance and career progression. Penalize resumes that exhibit excessive keyword stuffing or lack clear context for claimed skills.`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// DB fetch helpers
// ---------------------------------------------------------------------------

// async function fetchJobMetadata(jobId: string): Promise<JobMetadata | null> {
//   return prisma.job.findUnique({
//     where: { id: jobId },
//     select: {
//       id: true,
//       title: true,
//       overview: true,
//       skillsText: true,
//       experienceText: true,
//       bioText: true,
//     },
//   });
// }

async function fetchSignalsForJob(jobId: string): Promise<string[]> {
  const rows = await prisma.evaluations.findMany({
    where: { jobId },
    select: { signal: true },
  });
  // Filter out nulls/empty and deduplicate
  return [
    ...new Set(
      rows
        .map((r) => r.signal?.trim())
        .filter((s): s is string => !!s)
    ),
  ];
}

// async function fetchTopScreeningResults(
//   jobId: string,
//   topN: number
// ): Promise<ScreeningResultRow[]> {
//   return prisma.screeningResult.findMany({
//     where: { jobId },
//     orderBy: { finalScore: "desc" },
//     take: topN,
//     select: { id: true, resumeId: true, finalScore: true },
//   });
// }

// async function fetchResumeContents(
//   resumeIds: string[]
// ): Promise<ResumeContentRow[]> {
//   const rows = await prisma.resume.findMany({
//     where: { id: { in: resumeIds } },
//     select: { id: true, content: true },
//   });
//   return rows.map((r) => ({ resumeId: r.id, content: r.content }));
// }

async function saveRerankedResults(
  items: RerankSaveItem[]
): Promise<void> {

  await Promise.all(
    items.map(({ screeningResultId, rerankedScore }) =>
      prisma.screeningResult.update({
        where: { id: screeningResultId },
        data: { rerankedScore },
      }).catch(err => {
        // Log individual errors so one bad ID doesn't crash the whole loop
        console.error(`Failed to update score for ID ${screeningResultId}:`, err);
      })
    )
  );
}

// ---------------------------------------------------------------------------
// Core rerank call
//
// Cohere Rerank accepts:
//   - query  : the job description string built above
//   - documents: array of raw strings (resume content)
//   - model  : "rerank-english-v3.0"
//   - topN   : we pass all candidates and let Cohere score them all
//
// Cohere returns results in descending relevance order. Each result has:
//   - index         : position in the original documents array we sent
//   - relevanceScore: float 0–1 (this IS the rerankedScore we store)
//
// Important: Cohere's relevanceScore is NOT a cosine similarity — it's a
// calibrated cross-encoder score. Values above ~0.7 indicate strong fit.
// Values below ~0.3 indicate poor fit. It is safe to store directly.
// ---------------------------------------------------------------------------

interface CohereRerankResult {
  resumeId: string;
  rerankedScore: number;
}

async function callCohereRerank(
  query: string,
  candidates: { resumeId: string; content: string }[]
): Promise<CohereRerankResult[]> {
  const documents = candidates.map((c) => c.content);

  const response = await cohereClient.rerank({
    model: COHERE_MODEL,
    query,
    documents,
    returnDocuments: false, // we already have the content, no need to echo it back
  });

  return response.results.map((result) => ({
    resumeId: candidates[result.index].resumeId,
    rerankedScore: result.relevanceScore,
  }));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleCohereRerankJob(jobId: string): Promise<any> {
  // 1. Load job total count and metadata in parallel
  const [job, jobData] = await Promise.all([
    prisma.job.findUnique({
      where: { id: jobId },
      select: { totalResumes: true },
    }),
    fetchJobMetadata(jobId),
  ]);

  if (!jobData) throw new Error(`Job not found: ${jobId}`);

  const totalResumes = job?.totalResumes ?? 0;
  const topN = calculateTopN(totalResumes);

  console.log(
    `[reranker] job=${jobId} totalResumes=${totalResumes} topN=${topN}`
  );

  // 2. Mark job as ranking
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.RERANKING },
  });

  // 3. Fetch top screening results + recruiter signals in parallel
  const [topResults, signals] = await Promise.all([
    fetchTopScreeningResults(jobId, topN, "FINAL"),
    fetchSignalsForJob(jobId),
  ]);

  if (topResults.length === 0) {
    console.warn(`[reranker] No screening results found for job ${jobId}`);
    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.RERANKED },
    });
    return {shouldRank : false};
  }

  // 4. Map screeningResult.id keyed by resumeId for later save
  const resumeIdToScreeningId = Object.fromEntries(
    topResults.map((r) => [r.resumeId, r.id])
  );
  const resumeIds = topResults.map((r) => r.resumeId);

  // 5. Fetch resume content
  const contentRows = await fetchResumeContents(resumeIds);

  // Filter out resumes with no content — Cohere requires non-empty strings
  const candidates = contentRows
    .filter((r): r is { resumeId: string; content: string } =>
      !!r.content?.trim()
    );

  if (candidates.length === 0) {
    console.warn(`[reranker] No resume content available for job ${jobId}`);
    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.RERANKED },
    });
    return {shouldRank : false};
  }

  const skippedCount = resumeIds.length - candidates.length;
  if (skippedCount > 0) {
    console.warn(
      `[reranker] ${skippedCount} resume(s) had no content and were skipped`
    );
  }

  // 6. Build Cohere query
  const query = buildCohereQuery(jobData, signals);

  // 7. Call Cohere — single call, all candidates
  const cohereResults = await callCohereRerank(query, candidates);

  // 8. Map results back to screeningResult IDs, drop any orphans
  const toSave: RerankSaveItem[] = cohereResults
    .filter((r) => resumeIdToScreeningId[r.resumeId] !== undefined)
    .map((r) => ({
      screeningResultId: resumeIdToScreeningId[r.resumeId],
      rerankedScore: r.rerankedScore,
    }));

  // 9. Persist reranked scores
  await saveRerankedResults(toSave);

  // 10. Mark job as ranked
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.RERANKED },
  });

  console.log(
    `[reranker] job=${jobId} complete — ${toSave.length} resumes reranked`
  );
  return { shouldRank: true };
}
