import { prisma } from "../prisma.ts";
import { openAiClient } from "../openai.ts";


function calculateTopN(totalResumes: number): number {
    const n = Math.ceil(totalResumes * 0.1);
    return Math.max(n, 5); 
}

async function fetchTopScreeningResults(jobId: string, topN: number) {
  return prisma.screeningResult.findMany({
    where: { jobId },
    orderBy: { finalScore: "desc" },
    take: topN,
    select: {
      id: true,
      resumeId: true,
      finalScore: true,
    },
  });
}


async function fetchEvaluationsForJob(
  jobId: string
): Promise<{ rawText: string; verdict: string }[]> {
  return prisma.evaluations.findMany({
    where: { jobId },
    select: { rawText: true, verdict: true },
    orderBy: { createdAt: "asc" },
  });
}

async function fetchJobMetadata(
  jobId: string
): Promise<{ title: string; overview: string | null } | null> {
  return prisma.job.findUnique({
    where: { id: jobId },
    select: { title: true, overview: true, bioText: true , skillsText: true, experienceText: true},
  });
}


function buildBatchedRerankerPrompt(
  jobData: { title: string; overview: string | null; bioText: string | null; skillsText: string | null; experienceText: string | null },
  evaluations: { rawText: string; verdict: string }[],
  candidates: { resumeId: string; content: string }[]
): string {
    const examplesBlock = evaluations
  .map(
    (e, i) => `
--- Example ${i + 1} ---
Resume:
${e.rawText}

Recruiter verdict: ${e.verdict}`.trim()
  )
  .join("\n\n");

const candidatesBlock = candidates
  .map(
    (c, i) => `
--- Candidate ${i + 1} (resumeId: ${c.resumeId}) ---
${c.content}`.trim()
  )
  .join("\n\n");

return `
You are a highly experienced recruiter tasked with ranking candidates for a job.

Your goal is to produce CONSISTENT, CALIBRATED, and COMPARATIVE scores across all candidates.

--------------------------------
## JOB REQUIREMENTS

Title: ${jobData.title}
${jobData.overview ? `Overview: ${jobData.overview}` : ""}

### Ideal Candidate Profile
${jobData.bioText ? `- Background: ${jobData.bioText}` : ""}
${jobData.skillsText ? `- Skills: ${jobData.skillsText}` : ""}
${jobData.experienceText ? `- Experience: ${jobData.experienceText}` : ""}

--------------------------------
## LEARN RECRUITER PREFERENCES

These are real past evaluations. 
You MUST learn implicit preferences, strictness, and trade-offs from them.

${examplesBlock}

--------------------------------
## SCORING FRAMEWORK (STRICT)

Evaluate each candidate across these dimensions:

1. Skill Match (0–1)
2. Experience Relevance (0–1)
3. Role Fit / Domain Fit (0–1)
4. Seniority Alignment (0–1)
5. Red Flags (penalty factor)

### Important Rules:
- Be STRICT. Do NOT give high scores easily.
- A candidate missing critical requirements MUST score low.
- Penalize vague, generic, or irrelevant resumes.
- Strong alignment across ALL dimensions is required for high scores (>0.8).
- Use examples above to calibrate harshness/leniency.

### Final Score:
Combine the factors into ONE final score between 0 and 1.
The score should reflect RELATIVE ranking among candidates.

--------------------------------
## EVALUATION INSTRUCTIONS

- Evaluate ALL candidates together (important for ranking).
- Compare candidates against EACH OTHER, not independently.
- Avoid score clustering (spread scores meaningfully).
- Use the FULL range (0–1).
- Be deterministic and consistent.

--------------------------------
## CANDIDATES

${candidatesBlock}

--------------------------------
## OUTPUT FORMAT (STRICT JSON ONLY)

Return ONLY a JSON object with this exact structure:

{
  "results": [
    {
      "resumeId": "<id>",
      "score": <float 0.0–1.0>,
      "explanation": "<concise reasoning referencing key strengths/weaknesses>"
    }
  ]
}

- Keep explanations short but specific.
- Do NOT include any extra text outside JSON.
`.trim();
//   const examplesBlock = evaluations
//     .map(
//       (e, i) => `
// --- Example ${i + 1} ---
// Resume:
// ${e.rawText}

// recruiter judgement: ${e.verdict}`.trim()
//     )
//     .join("\n\n");

//   const candidatesBlock = candidates
//     .map(
//       (c, i) => `
// --- Candidate ${i + 1} (id: ${c.resumeId}) ---
// ${c.content}`.trim()
//     )
//     .join("\n\n");

//   return `
// You are an expert recruiter evaluating resumes for a specific job.

// ## Job Details
// Title: ${jobData.title}
// ${jobData.overview ? `Overview : ${jobData.overview}` : ""}

// Here is what the recruiter is looking for in candidates for this job:
// ${jobData.bioText ? `Candidate overview: ${jobData.bioText}` : ""}
// ${jobData.skillsText ? `Skills: ${jobData.skillsText}` : ""}
// ${jobData.experienceText ? `Experience: ${jobData.experienceText}` : ""}

// ## Here is some real examples of how this recruiter has evaluated resumes for this job:
// Learn from these to calibrate your judgment.
// ${examplesBlock}

// ## Your Task
// Evaluate ALL of the following candidate resumes using the same judgment shown above.

// ${candidatesBlock}

// Respond ONLY with a JSON array named results, one entry per candidate, in this exact format:
// [
//   {
//     "resumeId": "<id>",
//     "score": <float between 0.0 and 1.0>,
//     "explanation": "<one concise paragraph>"
//   }
// ]
// `.trim();
}

async function callBatchedRerankerLLM(
  prompt: string
): Promise<{ resumeId: string; score: number; explanation: string }[]> {
  const response = await openAiClient.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0].message.content ?? "{}";
  const parsed = JSON.parse(raw);

  // Model may return { results: [...] } or directly [...] — handle both
  const results = Array.isArray(parsed) ? parsed :  (parsed.results ?? parsed.resumes ?? parsed.data ?? []);
  if (!Array.isArray(results)) {
    throw new Error(`Unexpected LLM batch response structure: ${raw}`);
  }

  return results.map((r: any) => ({
    resumeId: r.resumeId,
    score: r.score,
    explanation: r.explanation,
  }));
}

async function fetchResumeContents(
  resumeIds: string[]
): Promise<{ resumeId: string; content: string }[]> {
  const resumes = await prisma.resume.findMany({
    where: { id: { in: resumeIds } },
    select: { id: true, content: true },
  });

  return resumes
    .filter((r): r is { id: string; content: string } => r.content !== null)
    .map((r) => ({ resumeId: r.id, content: r.content }));
}

async function saveAllRerankedResults(
  results: { screeningResultId: string; rerankedScore: number; explanation: string }[]
): Promise<void> {
  await prisma.$transaction(
    results.map(({ screeningResultId, rerankedScore, explanation }) =>
      prisma.screeningResult.update({
        where: { id: screeningResultId },
        data: { rerankedScore, explanation },
      })
    )
  );
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─────────────────────────────────────────────
// MAIN: Reranks using a single batched LLM call
// ─────────────────────────────────────────────
export async function rerankResumesForJob(jobId: string): Promise<void> {
  const jobData = await fetchJobMetadata(jobId);
  if (!jobData) throw new Error(`Job not found: ${jobId}`);

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { resumeCount: true },
  });

  const totalResumes = job?.resumeCount ?? 0;
  const topN = calculateTopN(totalResumes);
  console.log(`Total resumes: ${totalResumes} → Reranking top ${topN}`);

  const [evaluations, topResults] = await Promise.all([
    fetchEvaluationsForJob(jobId),
    fetchTopScreeningResults(jobId, topN),
  ]);

  const resumeIds = topResults.map((r) => r.resumeId);
  const candidates = await fetchResumeContents(resumeIds);

  if (candidates.length === 0) {
    console.warn(`No resume content available for job ${jobId}`);
    return;
  }

  const resumeIdToScreeningId = Object.fromEntries(
    topResults.map((r) => [r.resumeId, r.id])
  );

  // Split candidates into chunks of 5
  const chunks = chunkArray(candidates, 5);
  console.log(`Split into ${chunks.length} chunks of up to 5 resumes each`);

  const allLlmResults = [];

  for (const chunk of chunks) {
    const prompt = buildBatchedRerankerPrompt(
      jobData,
      evaluations,
      chunk
    );

    const chunkResults = await callBatchedRerankerLLM(prompt);
    allLlmResults.push(...chunkResults);
  }


  const toSave = allLlmResults
    .filter((r) => resumeIdToScreeningId[r.resumeId])
    .map((r) => ({
      screeningResultId: resumeIdToScreeningId[r.resumeId],
      rerankedScore: r.score,
      explanation: r.explanation,
    }));

  await saveAllRerankedResults(toSave);

  console.log(`Reranking complete for job ${jobId}. Scored ${toSave.length} resumes.`);
}

await rerankResumesForJob("68722bb7-0d26-4a6e-bd19-edb334c25a68")

