import type { Request, Response } from "express";
import { prisma } from "../utils/prisma.ts";
import { jobEmbeddingsQueue } from "../utils/queue.ts";
import { combineResumeText, convertJsonToText, extractJson, extractTextFromPDF } from "../utils/resumeHelpers.ts";
import {AddEvaluationsRequest} from "../types.ts"

export const addJob = async (req: Request, res: Response) => {
  const { title, overview, skills, bio, experience, constraints } = req.body ?? {};
  const firebaseUid = (req as any).user?.firebaseUid;

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

    await jobEmbeddingsQueue.add("process-job-embeddings", {
      jobId: job.id,
      skills,
      bio,
      experience,
    });
    
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
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  };

//-------------------------------- helpers --------------------------------
const parseEvaluationRequest = async (
  req: Request
): Promise<AddEvaluationsRequest> => {
  const jobId = req.params.jobId;
  const files = req.files as Record<string, Express.Multer.File[]>;

  const pairs = [0, 1, 2]
    .map((i) => {
      const fileEntry = files[`cv_${i}`]?.[0];
      const verdict = req.body[`verdict_${i}`];

      if (!fileEntry || !verdict) return null;

      const cv = new File([fileEntry.buffer], fileEntry.originalname, {
        type: "application/pdf",
      });

      return { cv, verdict };
    })
    .filter(Boolean);

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
    const json = await extractJson(text);
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

