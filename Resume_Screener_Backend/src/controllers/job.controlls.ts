import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { combineResumeText, convertJsonToText, extractJson, extractTextFromPDF } from "../utils/resumeHelpers";
import type {AddEvaluationsRequest, EvaluationPair} from "../types"
import { processJobEmbedding, withRetry } from "../utils/embeddingHelpers";
import { JobStatus } from "@prisma/client";

export const addJob = async (req: Request, res: Response) => {
  const { title, overview, skills, bio, experience, constraints } = req.body ?? {};
  const firebaseUid = (req as any).user?.id;

  if (!firebaseUid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!title ) {
    return res
      .status(400)
      .json({ error: "Missing required fields" });
  }

  try {
    let user = await prisma.user.findUnique({
      where: { firebaseUid },
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
  const firebaseUid = (req as any).user?.id;

  if (!firebaseUid) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    let user = await prisma.user.findUnique({
      where: { firebaseUid },
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

