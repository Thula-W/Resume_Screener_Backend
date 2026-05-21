import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { combineResumeText, convertJsonToText, extractJson, extractTextFromPDF } from "../utils/resumeHelpers";
import type {AddEvaluationsRequest, EvaluationPair} from "../types"
import { processJobEmbedding, withRetry } from "../utils/embeddingHelpers";
import { JobStatus } from "@prisma/client";

export const getJobsOfUser = async (req: Request, res: Response) => {
  const id = (req as any).user?.id;

  if (!id) {
    return res.status(401).json({ error: "Unauthorized" });
  }


  try {
    let user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user?.id) {
      throw new Error("You must be logged in to create a job");
    }

    const jobs = await prisma.job.findMany({
      where: { userId: user?.id },
      select :{id: true, title: true, overview: true, status: true, totalResumes:true, skillsText: true, bioText: true, experienceText: true}
    });
    res.status(200).json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err });
  }
};

export const getRankingsForJob = async (req: Request, res: Response) => {
  const id = (req as any).user?.id;
  const { jobId } = req.body as { jobId: string };

  if (!id) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    let job = await prisma.job.findUnique({
      where: { id: jobId },
    });

    if (job?.status !== JobStatus.RANKED){
      return res.status(400).json({ error: "Job not ranked yet" });
    } 

    // 1. Fetch from database with the 'resume' relation
    const topPicks = await prisma.screeningResult.findMany({
      where: { 
        jobId: jobId, 
        azendlyScore: { not: null } 
      },
      select: { 
        resumeId: true, 
        azendlyScore: true, 
        explanation: true,
        resume: {
          select: {
            name: true,
            contactInfo: true 
          }
        }
      },
      orderBy: { 
        azendlyScore: "desc" 
      },
    });

    // 2. Format and destructure JSON safely for the client response
    const formattedTopPicks = topPicks.map(pick => {
      // Cast Prisma's Json type into your expected contact shape
      const contact = (pick.resume?.contactInfo as { email?: string; phone?: string; location?: string }) || {};

      return {
        resumeId: pick.resumeId,
        name: pick.resume?.name || "Unknown Candidate",
        email: contact.email || "",
        phone: contact.phone || "",
        location: contact.location || "",
        azendlyScore: pick.azendlyScore,
        explanation: pick.explanation
      };
    });

    // 3. Return the clean payload
    res.status(200).json(formattedTopPicks);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err });
  }
};

export const addJob = async (req: Request, res: Response) => {
  const { title, overview, skills, bio, experience, constraints, signals } = req.body ?? {};
  const id = (req as any).user?.id;

  if (!id) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!title ) {
    return res
      .status(400)
      .json({ error: "Missing required fields" });
  }

  try {
    let user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user?.id) {
      throw new Error("You must be logged in to create a job");
    }
    const job = await prisma.job.create({
      data: {
        userId: user?.id,
        title,
        overview,
        constraints: constraints ?? null,
        skillsText: skills ?? null,
        bioText: bio ?? null,
        experienceText: experience ?? null,
        signals: signals?? null,
      },
    });

    withRetry(() => processJobEmbedding({ jobId: job.id, skills, bio, experience })).catch((err) =>
      console.error(`Embedding failed for job ${job.id}:`, err)
    );
 
    res.status(201).json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err });
  }
};

export const addEvaluations = async (req: Request, res: Response) => {
try {
      const request = await parseEvaluationRequest(req);
      await processEvaluations(request);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  };

export const checkJobStatus = async (req: Request, res: Response, next: NextFunction) => {
  const { jobId } = req.body;
  const id = (req as any).user?.id;

  if (!id) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    let user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user){
      throw new Error("You must be logged in to check job status");
    }
    const job = await prisma.job.findUnique({
      where: { id: jobId, userId: user?.id },
      select: { status: true },
    });
    
    if (job?.status === JobStatus.SCORED){
      next();
    }
    else{
      res.status(400).json({ error: "Job not ready for reranking" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err });
  }
};

export const deleteJob = async (req: Request, res: Response) => {
  const { jobId } = req.body;
  const id = (req as any).user?.id;

  const user = await prisma.user.findUnique({
    where: { id },
  });

  const job = await prisma.job.findUnique({
    where: { id: jobId, userId: user?.id },
  });
  if (!id || !user || !job) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    console.log(`Starting full purge for Job ID: ${jobId}`);

    await prisma.$transaction(async (tx) => {
      // 1. Get all Resume IDs linked to this job
      const resumes = await tx.resume.findMany({
        where: { jobId },
        select: { id: true },
      });
      const resumeIds = resumes.map((r) => r.id);

      console.log(`- Found ${resumeIds.length} resumes. Clearing child records...`);

      // 2. Delete downstream Resume dependencies
      await tx.resumeEmbedding.deleteMany({ where: { resumeId: { in: resumeIds } } });
      await tx.screeningResult.deleteMany({ where: { resumeId: { in: resumeIds } } });
      await tx.parsedResume.deleteMany({ where: { resumeId: { in: resumeIds } } });
      await tx.batchFailure.deleteMany({ where: { resumeId: { in: resumeIds } } });

      // 3. Delete Job-specific dependencies
      await tx.evaluations.deleteMany({ where: { jobId } });
      await tx.rerankChunkResult.deleteMany({ where: { jobId } });

      // 4. Delete Resumes
      // We do this after clearing child records but before deleting Batches/Jobs
      await tx.resume.deleteMany({ where: { jobId } });

      // 5. Delete Batches
      await tx.uploadBatch.deleteMany({ where: { jobId } });

      // 6. Finally, delete the Job itself
      await tx.job.delete({ where: { id: jobId } });
    });

    res.status(200).json({ success: true, message: `Job ${jobId} and all associated data deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  } 
}

//-------------------------------- helpers --------------------------------
const parseEvaluationRequest = async (
  req: Request
): Promise<AddEvaluationsRequest> => {
  const jobId = req.params.jobId as string;
  const files = req.files as Record<string, Express.Multer.File[]>;

  const pairs = [0, 1, 2]
    .map((i) => {
      const fileEntry = files[`cv_${i}`]?.[0];
      const verdict = req.body[`verdict_${i}`];

      if (!fileEntry || !verdict) return null;

      const cv = new File([new Uint8Array(fileEntry.buffer)], fileEntry.originalname, {
        type: "application/pdf",
      });

      return { cv, verdict };
    })
    .filter((item): item is EvaluationPair => item !== null);;

  if (!pairs.length) throw new Error("No valid CV+verdict pairs found in request.");

  return { jobId, pairs };
};


const processEvaluations = async (req: AddEvaluationsRequest): Promise<void> => {
  const { jobId, pairs } = req;

  if (!jobId) throw new Error("jobId is required.");
  if (!pairs?.length) throw new Error("At least one CV+verdict pair is required.");
  if (pairs.length > 3) throw new Error("Maximum of 3 pairs allowed.");

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job not found: ${jobId}`);

  for (const { cv, verdict } of pairs) {
    if (!cv || !verdict?.trim()) {
      throw new Error("Each pair must have a PDF file and a non-empty verdict.");
    }

    const buffer = Buffer.from(await cv.arrayBuffer());
    const text = await extractTextFromPDF(buffer);
    const json = await extractJson(text) || "{}";
    const bucketTexts = convertJsonToText(JSON.parse(json));

    const { attributes, ...restBuckets } = bucketTexts;
    const rawText = combineResumeText(restBuckets);

    await prisma.evaluations.create({
      data: {
        jobId,
        rawText,
        verdict: verdict.trim(),
      },
    });
  }
};

