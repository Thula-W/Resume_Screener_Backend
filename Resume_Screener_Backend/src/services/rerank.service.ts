import { prisma } from '../config/prisma'
import { enqueueRerankChunks } from '../lib/queueClient';
import { JobData } from '../types';
import {
  fetchTopScreeningResults,
  fetchResumeContents,
  buildBatchedRerankerPrompt,
  callBatchedRerankerLLM,
  saveAllRerankedResults,
  fetchJobMetadata,
  fetchEvaluationsForJob,
  selectAnchors,
  chunkArray,
  calculateTopN,
} from '../utils/ranking/rerank';
import { JobStatus } from '@prisma/client';

const ANCHOR_BATCH_SIZE = 7; 
const SMALL_THRESHOLD = ANCHOR_BATCH_SIZE + 3; 

// Called by /internal/rerank-job (worker → container)
// Decides: run directly or fan out to rerank-chunks queue
export async function handleRerankJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where:  { id: jobId },
    select: { totalResumes: true },
  });
  const jobData = await fetchJobMetadata(jobId);
  if (!jobData) throw new Error(`Job not found: ${jobId}`);

  const topN = calculateTopN(job?.totalResumes ?? 0);

  await prisma.job.update({
    where: { id: jobId },
    data:  { status: JobStatus.RANKING },
  });

  if (topN <= SMALL_THRESHOLD) {
    const [evaluations, topResults] = await Promise.all([
      fetchEvaluationsForJob(jobId),
      fetchTopScreeningResults(jobId, topN, "RERANKED"),
    ]);

    const resumeIdToScreeningId = Object.fromEntries(
      topResults.map((r) => [r.resumeId, r.id])
    );
    const resumeIds = topResults.map((r) => r.resumeId);
    const candidates = await fetchResumeContents(resumeIds);

    if (candidates.length === 0) {
      console.warn(`No resume content available for job ${jobId}`);
      return;
    }
    const prompt = buildBatchedRerankerPrompt(jobData, evaluations, candidates);
    const results = await callBatchedRerankerLLM(prompt); 

    const toSave = results
      .filter((r) => resumeIdToScreeningId[r.resumeId])
      .map((r) => ({
        screeningResultId: resumeIdToScreeningId[r.resumeId],
        azendlyScore: r.score,
        explanation: r.explanation,
      }));

    await saveAllRerankedResults(toSave);
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: JobStatus.RANKED },
    });

  } else {
    await fanOutRerankChunks(jobId, topN, jobData);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Large path Phase 1 — fan out chunks to queue
// Preserves the anchor separation logic from the original
// ─────────────────────────────────────────────────────────────────────────────
async function fanOutRerankChunks(jobId: string, topN: number, jobData: JobData): Promise<void> {
  const topResults = await fetchTopScreeningResults(jobId, topN, "RERANKED");

  // ── Select anchors (high / mid / low) — same logic as original ───────────
  const anchors    = selectAnchors(topResults as { resumeId: string; id: string; rerankedScore: number | null;}[]);
  const anchorIds  = anchors.map((a) => a.resumeId);
  const anchorIdSet = new Set(anchorIds);

  const regularIds = topResults
    .map((r) => r.resumeId)
    .filter((id) => !anchorIdSet.has(id));

  const chunks = chunkArray(regularIds, ANCHOR_BATCH_SIZE);

  // Reset the DO in case of a re-run
  // (worker exposes a reset endpoint — see section 2 additions)
  await resetRerankTracker(jobId);

  // ── Enqueue each chunk — worker distributes to containers ─────────────────
  // anchorIds travel with every chunk so containers can include them in the
  // LLM call and return anchor scores for normalization
  await enqueueRerankChunks(
    chunks.map((chunkIds, i) => ({
      jobId,
      resumeIds:   chunkIds,   // regular candidates for this chunk
      anchorIds,               // anchors — sent to every chunk
      chunkIndex:  i,
      totalChunks: chunks.length,
      jobData,                  // job metadata for prompt construction
    }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Large path Phase 2 — process one chunk
// Called by /internal/rerank-chunk for each queue message
// Runs the LLM call and persists raw scores to RerankChunkResult
// ─────────────────────────────────────────────────────────────────────────────
export async function handleRerankChunk(
  jobId:      string,
  resumeIds:  string[],   // regular candidates only
  anchorIds:  string[],   // anchor IDs
  chunkIndex: number,
  jobData: JobData,
): Promise<void> {
  const evaluations = await fetchEvaluationsForJob(jobId);

  const anchorIdSet = new Set(anchorIds);
  const allIds      = [...anchorIds, ...resumeIds]; // anchors first, then regular

  // Fetch content for anchors + regular candidates in one query
  const candidates  = await fetchResumeContents(allIds);

  const prompt   = buildBatchedRerankerPrompt(jobData, evaluations, candidates);
  const results  = await callBatchedRerankerLLM(prompt);

  // ── Persist raw scores — both anchor and regular ──────────────────────────
  // Normalization happens later in finalize, so we store everything raw here
  await prisma.rerankChunkResult.createMany({
    data: results.map((r) => ({
      jobId,
      chunkIndex,
      resumeId:    r.resumeId,
      score:       r.score,
      explanation: r.explanation,
      isAnchor:    anchorIdSet.has(r.resumeId),
    })),
    skipDuplicates: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Large path Phase 3 — finalize
// Called by /internal/rerank-finalize after all chunks complete
// Runs the full normalization pipeline from the original logic
// ─────────────────────────────────────────────────────────────────────────────
export async function handleRerankFinalize(jobId: string): Promise<void> {
  // ── Load all chunk results from DB ────────────────────────────────────────
  const allChunkResults = await prisma.rerankChunkResult.findMany({
    where:   { jobId },
    orderBy: { chunkIndex: 'asc' },
  });

  if (allChunkResults.length === 0) {
    throw new Error(`No chunk results found for job ${jobId}`);
  }

  // ── Reconstruct the data structures the normalization logic expects ────────
  // anchorScoresPerBatch: one entry per chunk, each entry = anchor scores in that chunk
  const chunkIndices = [...new Set(allChunkResults.map((r) => r.chunkIndex))].sort(
    (a, b) => a - b
  );

  const anchorScoresPerBatch: { resumeId: string; score: number }[][] = [];
  const rawCandidateResults:  { resumeId: string; score: number; explanation: string }[] = [];
  const anchorExplanations = new Map<string, string>();

  // Identify which resumeIds are anchors (isAnchor=true)
  const anchorIdSet = new Set(
    allChunkResults.filter((r) => r.isAnchor).map((r) => r.resumeId)
  );

  for (const chunkIndex of chunkIndices) {
    const chunkRows = allChunkResults.filter((r) => r.chunkIndex === chunkIndex);

    // Anchor scores for this specific chunk
    const batchAnchorScores = chunkRows
      .filter((r) => r.isAnchor)
      .map((r) => ({ resumeId: r.resumeId, score: r.score }));

    // Latest explanation per anchor (last chunk wins — same as original loop)
    for (const row of chunkRows.filter((r) => r.isAnchor)) {
      anchorExplanations.set(row.resumeId, row.explanation);
    }

    anchorScoresPerBatch.push(batchAnchorScores);

    // Regular candidates from this chunk
    rawCandidateResults.push(
      ...chunkRows
        .filter((r) => !r.isAnchor)
        .map((r) => ({
          resumeId:    r.resumeId,
          score:       r.score,
          explanation: r.explanation,
        }))
    );
  }

  // ── Phase 3a: compute global anchor averages — identical to original ───────
  const globalAnchorAverages = computeAverageAnchorScores(anchorScoresPerBatch);

  // Need anchorIdMap (high/mid/low) — reconstruct from global averages
  // sorted descending by average score
  const sortedAnchors = [...globalAnchorAverages.entries()].sort(
    (a, b) => b[1] - a[1]
  );
  const anchorIdMap = {
    high: sortedAnchors[0][0],
    mid:  sortedAnchors[Math.floor((sortedAnchors.length - 1) / 2)][0],
    low:  sortedAnchors[sortedAnchors.length - 1][0],
  };

  // ── Phase 3b: normalize per batch — identical to original ─────────────────
  const normalizedResults: { resumeId: string; score: number; explanation: string }[] = [];
  let candidateIndex = 0;

  for (const batchAnchorScores of anchorScoresPerBatch) {
    const batchSlice = rawCandidateResults.slice(
      candidateIndex,
      candidateIndex + ANCHOR_BATCH_SIZE
    );

    const batchResultsWithAnchors = [
      ...batchAnchorScores.map((a) => ({
        resumeId:    a.resumeId,
        score:       a.score,
        explanation: anchorExplanations.get(a.resumeId) ?? '',
      })),
      ...batchSlice,
    ];

    const normalized = normalizeBatchScores(
      batchResultsWithAnchors,
      anchorIdMap,
      globalAnchorAverages
    );

    normalizedResults.push(
      ...normalized.filter((r) => !anchorIdSet.has(r.resumeId))
    );
    candidateIndex += ANCHOR_BATCH_SIZE;
  }

  // ── Phase 3c: build final results — identical to original ─────────────────
  const allResults = buildFinalResults(
    normalizedResults,
    anchorExplanations,
    globalAnchorAverages
  );

  // ── Phase 3d: map back to screeningResult IDs and save ────────────────────
  const topN       = allResults.length;
  const topResults = await fetchTopScreeningResults(jobId, topN, "RERANKED");

  const resumeIdToScreeningId = Object.fromEntries(
    topResults.map((r) => [r.resumeId, r.id])
  );

  const toSave = allResults
    .filter((r) => resumeIdToScreeningId[r.resumeId])
    .map((r) => ({
      screeningResultId: resumeIdToScreeningId[r.resumeId],
      azendlyScore:     r.score,
      explanation:       r.explanation,
    }));

  await saveAllRerankedResults(toSave);

  // ── Cleanup chunk results + update job status ─────────────────────────────
  await prisma.$transaction([
    prisma.rerankChunkResult.deleteMany({ where: { jobId } }),
    prisma.job.update({
      where: { id: jobId },
      data:  { status: JobStatus.RANKED },
    }),
  ]);

  console.log(
    `Reranking finalized for job ${jobId}. Saved ${toSave.length} reranked results.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — pulled from original, kept private here
// ─────────────────────────────────────────────────────────────────────────────

function computeAverageAnchorScores(
  anchorScoresPerBatch: { resumeId: string; score: number }[][]
): Map<string, number> {
  const accumulator = new Map<string, number[]>();

  for (const batchScores of anchorScoresPerBatch) {
    for (const { resumeId, score } of batchScores) {
      if (!accumulator.has(resumeId)) accumulator.set(resumeId, []);
      accumulator.get(resumeId)!.push(score);
    }
  }

  const averages = new Map<string, number>();
  for (const [resumeId, scores] of accumulator.entries()) {
    averages.set(resumeId, scores.reduce((a, b) => a + b, 0) / scores.length);
  }
  return averages;
}

function normalizeBatchScores(
  batchResults: { resumeId: string; score: number; explanation: string }[],
  anchorIds:    { high: string; mid: string; low: string },
  globalAnchorAverages: Map<string, number>
): { resumeId: string; score: number; explanation: string }[] {
  const actualHigh   = batchResults.find((r) => r.resumeId === anchorIds.high)?.score ?? null;
  const actualLow    = batchResults.find((r) => r.resumeId === anchorIds.low)?.score  ?? null;
  const expectedHigh = globalAnchorAverages.get(anchorIds.high) ?? null;
  const expectedLow  = globalAnchorAverages.get(anchorIds.low)  ?? null;

  if (
    actualHigh === null || actualLow === null ||
    expectedHigh === null || expectedLow === null ||
    actualHigh === actualLow
  ) {
    return batchResults.map((r) => ({
      ...r,
      score: Math.min(1.0, Math.max(0.0, r.score)),
    }));
  }

  const scale = (expectedHigh - expectedLow) / (actualHigh - actualLow);

  return batchResults.map((r) => {
    const normalized = expectedLow + (r.score - actualLow) * scale;
    return {
      ...r,
      score: Math.min(1.0, Math.max(0.0, normalized)),
    };
  });
}

function buildFinalResults(
  normalizedCandidateResults: { resumeId: string; score: number; explanation: string }[],
  anchorExplanations:         Map<string, string>,
  globalAnchorAverages:       Map<string, number>
): { resumeId: string; score: number; explanation: string }[] {
  const anchorResults = Array.from(globalAnchorAverages.entries()).map(
    ([resumeId, score]) => ({
      resumeId,
      score,
      explanation: anchorExplanations.get(resumeId) ?? '',
    })
  );
  return [...normalizedCandidateResults, ...anchorResults];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rerank tracker reset — called before fanning out chunks for a re-run
// Container calls worker which calls the DO
// ─────────────────────────────────────────────────────────────────────────────
async function resetRerankTracker(jobId: string): Promise<void> {
  const res = await fetch(
    `${process.env.WORKER_INTERNAL_URL}/internal/reset-rerank-tracker`,
    {
      method:  'POST',
      headers: { 'content-type': 'application/json', 'x-internal': '1' },
      body:    JSON.stringify({ jobId }),
    }
  );
  if (!res.ok) throw new Error(`Failed to reset rerank tracker: ${res.status}`);
}