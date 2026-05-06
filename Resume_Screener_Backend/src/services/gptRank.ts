// src/services/gptRerankService.ts
// ─────────────────────────────────────────────────────────────────────────────
// GPT-4o-mini rubric-based final ranking
// Each resume is scored independently against a fixed rubric (1–10 per category)
// Scores are combined into azendlyScore using:
//   azendlyScore = round(0.6 + (0.2 * (finalScore + cohereScore) / 2 + 0.8 * llmScore) * 0.4, 4)
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma';
import { openAiClient } from '../config/openai';
import { JobStatus } from '@prisma/client';
import { JsonValue } from '@prisma/client/runtime/client';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobMetadata {
  title: string;
  overview: string | null;
  bioText: string | null;
  skillsText: string | null;
  experienceText: string | null;
  signals: string | null;
}

interface CandidateInput {
  screeningResultId: string;
  resumeId: string;
  finalScore: number;       // from vector pipeline (0–1)
  cohereScore: number;      // rerankedScore column (0–1)
  content: string;          // resume text
  resumeName: string;
  contactInfo: JsonValue;
}

interface CategoryScores {
  skillsMatch: number;          // 1–10
  experienceRelevance: number;  // 1–10
  roleDomainFit: number;        // 1–10
  seniorityAlignment: number;   // 1–10
  [key: string]: number;
}

interface LLMResult {
  resumeId: string;
  categoryScores: CategoryScores;
  explanation: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
  };
}

interface FinalResult {
  screeningResultId: string;
  resumeId: string;
  azendlyScore: number;
  categoryScores: CategoryScores;
  resumeName: string;
  contactInfo: JsonValue;
  explanation: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
  };
}

// ─── Prompt (fixed rubric — edit here to tune scoring behaviour) ──────────────

export const RUBRIC_SYSTEM_PROMPT = `
You are an expert technical recruiter evaluating resumes against a specific job.

Your task is to score each candidate independently against a strict rubric.
Do NOT compare candidates against each other — evaluate each one solely against the job requirements.


## THE INTEGRITY AUDIT (MANDATORY FIRST STEP)
Before applying the rubric, analyze the resume for "Keyword Stuffing" or "JD Mirroring":
1. **JD Mirroring**: Does the resume copy phrases from the Job Description word-for-word without unique professional context?
2. **Logic Check**: Do the sentences between keywords make logical sense? Are there "filler words" or gibberish? 
**PENALTY:** If a resume is identified as keyword-stuffed or logically incoherent, you must cap ALL scores at 3.

## SCORING RUBRIC

Score each category from 1 to 10 using these strict bands only if the Integrity Audit is passed, otherwise all scores must be 3 or below:

### 1. Skills Match (skillsMatch)
- 9–10: Meets or exceeds all required skills. Strong depth in core areas.
- 7–8:  Meets most required skills. Minor gaps in secondary skills only.
- 5–6:  Meets some skills. Noticeable gaps in important areas.
- 3–4:  Meets few required skills. Significant gaps.
- 1–2:  Almost no relevant skills present.

### 2. Experience Relevance (experienceRelevance)
- 9–10: Experience is directly relevant in domain, scale, and type. Strong track record.
- 7–8:  Mostly relevant experience. Some tangential roles.
- 5–6:  Partially relevant. Some applicable experience but notable gaps.
- 3–4:  Mostly irrelevant experience. Few transferable elements.
- 1–2:  No relevant experience.

### 3. Role / Domain Fit (roleDomainFit)
- 9–10: Worked in identical or near-identical domain and role type.
- 7–8:  Worked in closely related domain or role type.
- 5–6:  Some domain overlap. Different role type or industry.
- 3–4:  Weak domain connection.
- 1–2:  Completely different domain.

### 4. Seniority Alignment (seniorityAlignment)
- 9–10: Seniority level is a perfect match for the role.
- 7–8:  Slightly over or under-qualified but manageable.
- 5–6:  Noticeably over or under-qualified.
- 3–4:  Significant seniority mismatch.
- 1–2:  Completely wrong seniority level.

## IMPORTANT RULES
- Be STRICT. Reserve 9–10 for genuinely exceptional candidates.
- Less than 20% of candidates should score above 8 in any category.
- Base every score on concrete evidence from the resume. No assumptions.
- If a piece of information is missing from the resume, penalize accordingly.
- The summary must be 1–2 sentences maximum. Be direct and SPECIFIC must refer to actual content from the resume compared with the job requirements.
- Strengths and weaknesses must reference real content from the resume — no generic statements. Give 4,5 most important points  for each candidate, and be specific about what content led to that point.
- IN the explanation and stengths and weekenesses do not refer to other candidates, do not give vagues points .
- Every strength/weakness must follow this format: [Fact from Resume] <compared to> [Requirement from Job].Example: 'Has 4 years of AWS experience which exceeds the 2-year requirement.
- If a required skill is not mentioned in the resume, you must assume the candidate does NOT have it. Do not give the benefit of the doubt.
## OUTPUT FORMAT (STRICT JSON ONLY)

Return a JSON object with this exact structure:
{
  "results": [
    {
      "resumeId": "<id>",
      "isIntegrityFailure": <boolean>,
      "categoryScores": {
        "skillsMatch": <1–10>,
        "experienceRelevance": <1–10>,
        "roleDomainFit": <1–10>,
        "seniorityAlignment": <1–10>
      },
      "explanation": {
        "summary": "<1–2 sentence verdict>",
        "strengths": ["<specific strength>", "..."],
        "weaknesses": ["<specific weakness>", "..."]
      }
    }
  ]
}

Return ONLY the JSON. No preamble, no markdown, no extra text.
`.trim();

// ─── Helper: fetch job metadata (includes signals) ────────────────────────────

export async function fetchJobMetadataWithSignals(jobId: string): Promise<JobMetadata> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      title: true,
      overview: true,
      bioText: true,
      skillsText: true,
      experienceText: true,
      signals: true,
    },
  });
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

// ─── Helper: fetch top 10% candidates by rerankedScore ───────────────────────

export async function fetchTopTenPercentCandidates(
  jobId: string
): Promise<CandidateInput[]> {

  const job = await prisma.job.findUnique({
    where:  { id: jobId },
    select: { totalResumes: true },
  });

    const totalResumes = job?.totalResumes ?? 0;
    const topN = Math.min(
    Math.max(10, Math.ceil(totalResumes * 0.1)), 
    totalResumes
    );

  // Step 2: fetch top N by rerankedScore
  const topResults = await prisma.screeningResult.findMany({
    where: { jobId, rerankedScore: { not: null } },
    orderBy: { rerankedScore: 'desc' },
    take: topN,
    select: {
      id: true,
      resumeId: true,
      finalScore: true,
      rerankedScore: true,
    },
  });

  // Step 3: fetch resume content for all
  const resumeIds = topResults.map((r) => r.resumeId);
  const resumes = await prisma.resume.findMany({
    where: { id: { in: resumeIds } },
    select: { id: true, content: true, name: true, contactInfo: true },
  });

  const contentMap = new Map(
    resumes
      .filter((r): r is { id: string; content: string; name: string; contactInfo: JsonValue } => r.content !== null)
      .map((r) => [r.id, { content: r.content, name: r.name, contactInfo: r.contactInfo }])
  );

  // Step 4: combine — drop any resume with no content
  return topResults
    .filter((r) => contentMap.has(r.resumeId))
    .map((r) => ({
      screeningResultId: r.id,
      resumeId: r.resumeId,
      resumeName: contentMap.get(r.resumeId)!.name,
      contactInfo: contentMap.get(r.resumeId)!.contactInfo,
      finalScore: r.finalScore,
      cohereScore: r.rerankedScore!,
      content: contentMap.get(r.resumeId)!.content,
    }));
}

// ─── Helper: chunk array into batches ────────────────────────────────────────

export function chunkCandidates<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// ─── Helper: build prompt for a batch of candidates ──────────────────────────

export function buildRubricPrompt(
  job: JobMetadata,
  evaluations: { rawText: string; verdict: string }[],
  candidates: CandidateInput[]
): string {
  const jobBlock = `
    ## JOB DETAILS
    Title: ${job.title}
    ${job.overview ? `Overview: ${job.overview}` : ''}
    ${job.bioText ? `Ideal Candidate Background: ${job.bioText}` : ''}
    ${job.skillsText ? `Required Skills: ${job.skillsText}` : ''}
    ${job.experienceText ? `Required Experience: ${job.experienceText}` : ''}
    ${job.signals ? `\n## RECRUITER SIGNALS\n${job.signals}` : ''}
    `.trim();

  const examplesBlock =
    evaluations.length > 0
      ? `\n## RECRUITER EVALUATION EXAMPLES\nLearn the recruiter's standards and strictness from these past evaluations:\n\n` +
        evaluations
          .map(
            (e, i) => `--- Example ${i + 1} ---\nResume:\n${e.rawText}\n\nRecruiter verdict: ${e.verdict}`
          )
          .join('\n\n')
      : '';

  const candidatesBlock =
    `\n## Top 10% CANDIDATES TO EVALUATE\n\n` +
    candidates
      .map(
        (c, i) =>
          `--- Candidate ${i + 1} (resumeId: ${c.resumeId}) ---\n${c.content}`
      )
      .join('\n\n');

  return `${jobBlock}\n\n${examplesBlock}\n\n${candidatesBlock}`.trim();
}

// ─── Helper: call GPT-4o-mini for one batch ───────────────────────────────────

export async function scoreOneBatch(
  job: JobMetadata,
  evaluations: { rawText: string; verdict: string }[],
  batch: CandidateInput[]
): Promise<LLMResult[]> {
  const userPrompt = buildRubricPrompt(job, evaluations, batch);

  const response = await openAiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RUBRIC_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = response.choices[0].message.content ?? '{}';
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`GPT returned invalid JSON for batch: ${raw.slice(0, 200)}`);
  }

  const results: any[] = Array.isArray(parsed)
    ? parsed
    : (parsed.results ?? parsed.resumes ?? parsed.data ?? []);

  if (!Array.isArray(results)) {
    throw new Error(`Unexpected GPT response structure: ${raw.slice(0, 200)}`);
  }

  // Validate and map
  return results.map((r: any) => {
    const cs = r.categoryScores ?? {};
    return {
      resumeId: r.resumeId,
      categoryScores: {
        skillsMatch: Number(cs.skillsMatch ?? 5),
        experienceRelevance: Number(cs.experienceRelevance ?? 5),
        roleDomainFit: Number(cs.roleDomainFit ?? 5),
        seniorityAlignment: Number(cs.seniorityAlignment ?? 5),
      },
      explanation: {
        summary: r.explanation?.summary ?? '',
        strengths: Array.isArray(r.explanation?.strengths) ? r.explanation.strengths : [],
        weaknesses: Array.isArray(r.explanation?.weaknesses) ? r.explanation.weaknesses : [],
      },
    };
  });
}

// ─── Helper: compute llmScore (0–1) from category scores (1–10) ──────────────

export function computeLLMScore(categoryScores: CategoryScores): number {
  const { skillsMatch, experienceRelevance, roleDomainFit, seniorityAlignment } =
    categoryScores;
  const avg = (skillsMatch + experienceRelevance + roleDomainFit + seniorityAlignment) / 4;
  return avg / 10; // normalize to 0–1
}

// ─── Helper: compute final azendlyScore ──────────────────────────────────────
// Formula: 0.6 + (0.2 * (finalScore + cohereScore) / 2 + 0.8 * llmScore) * 0.4

export function computeAzendlyScore(
  finalScore: number,
  cohereScore: number,
  llmScore: number
): number {
  const raw =
    0.5 +
    (0.2 * ((finalScore + cohereScore) / 2) + 0.8 * llmScore) * 0.5;
  return Math.round(raw * 10000) / 100;
}

// ─── Helper: save all results to DB in a single transaction ──────────────────

export async function saveGPTRankResults(results: FinalResult[]): Promise<void> {
  await prisma.$transaction(
    results.map((r) =>
      prisma.screeningResult.update({
        where: { id: r.screeningResultId },
        data: {
          azendlyScore: r.azendlyScore,
          categoryScores: r.categoryScores,
          explanation: JSON.stringify(r.explanation),
        },
      })
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export async function handleGPTRankJob(jobId: string): Promise<FinalResult[] | void> {

   await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.RANKING },
    });
  // 1. Fetch job metadata (title, overview, skills, bio, experience, signals)
  const job = await fetchJobMetadataWithSignals(jobId);

  // 2. Fetch recruiter evaluation examples for few-shot calibration
  const evaluations = await prisma.evaluations.findMany({
    where: { jobId },
    select: { rawText: true, verdict: true },
    orderBy: { createdAt: 'asc' },
  });

  // 3. Fetch top 10% candidates by rerankedScore with their resume content
  const candidates = await fetchTopTenPercentCandidates(jobId);

  if (candidates.length === 0) {
    console.warn(`No candidates with resume content found for job ${jobId}`);
    return;
  }

  console.log(
    `[gptRerank] job=${jobId} candidates=${candidates.length} batches=${Math.ceil(candidates.length / 10)}`
  );

  // 4. Split into batches of 10
  const batches = chunkCandidates(candidates, 5);

  // 5. Score all batches in parallel
  const batchResults = await Promise.all(
    batches.map((batch, i) => {
      console.log(`[gptRerank] scoring batch ${i + 1}/${batches.length} (${batch.length} candidates)`);
      return scoreOneBatch(job, evaluations, batch);
    })
  );

  // 6. Flatten all LLM results
  const llmResults = batchResults.flat();

  // 7. Build a map from resumeId → LLM result for lookup
  const llmResultMap = new Map<string, LLMResult>(
    llmResults.map((r) => [r.resumeId, r])
  );

  // 8. Combine with pipeline scores and compute azendlyScore
  const finalResults: FinalResult[] = candidates
    .filter((c) => llmResultMap.has(c.resumeId))
    .map((c) => {
      const llm = llmResultMap.get(c.resumeId)!;
      const llmScore = computeLLMScore(llm.categoryScores);
      const azendlyScore = computeAzendlyScore(c.finalScore, c.cohereScore, llmScore);

      return {
        screeningResultId: c.screeningResultId,
        resumeId: c.resumeId,
        azendlyScore,
        categoryScores: llm.categoryScores,
        explanation: llm.explanation,
        resumeName: c.resumeName,
        contactInfo: c.contactInfo,
      };
    });

  // 9. Save everything to DB
  await saveGPTRankResults(finalResults);

  // 10. Update job status to RANKED
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.RANKED },
  });

  return finalResults;
}