import { prisma } from "../config/prisma";
import type { Request, Response } from "express";
import { r2 } from "../config/r2";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AuthRequest } from "../middleware/auth";
import { enqueueToExtractQueue } from "../lib/queueClient";
import { JobStatus } from '@prisma/client';

export const uploadIntent = async (req: AuthRequest, res: Response) => {
  try {
    const firebaseUid = req.user?.id;
    const { jobId, files } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required" });
    }

    // Verify job ownership
    const job = await prisma.job.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const user = await prisma.user.findUnique({
      where: { firebaseUid },
    });

    if (!user || job.userId !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Handle both single and bulk uploads
    const fileList = files && Array.isArray(files) ? files : [{ name: "resume.pdf" }];
    const currentResumeCount = await prisma.resume.count({
      where: { jobId },
    });

    const totalResumes = currentResumeCount + fileList.length;
    const RESUME_LIMIT = 100; // Adjust as needed

    if (totalResumes > RESUME_LIMIT) {
      return res.status(409).json({
        error: `Resume limit exceeded. Current: ${currentResumeCount}, Attempting to add: ${fileList.length}, Limit: ${RESUME_LIMIT}`,
      });
    }

    // Generate signed URLs and create resume records
    const uploadIntents = await Promise.all(
      fileList.map(async (file) => {
        const fileId = `${Date.now()}_${crypto.randomUUID()}`;
        const fileName = file.name || "resume.pdf";
        const storagePath = `${firebaseUid}/${jobId}/${fileId}_${fileName}`;

        // Create resume record with PENDING status
        const resume = await prisma.resume.create({
          data: {
            jobId,
            storagePath,
            status: "PENDING",
          },
        });

        // Generate signed URL (2 hour expiry)
        const signedUrl = await getSignedUrl(
          r2,
          new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: storagePath,
            ContentType: "application/pdf",
          }),
          { expiresIn: 60*60*2 }
        );

        return {
          resumeId: resume.id,
          storagePath: storagePath,
          signedUrl: signedUrl,
          expiresIn: 60 * 60 * 2, // 2 hours in seconds
        };
      })
    );

    res.json({
      uploadIntents,
      constraints: {
        maxSizeMB: 5,
        allowedTypes: ["application/pdf"],
      },
    });
  } catch (error) {
    console.error("Upload intent error:", error);
    res.status(500).json({ error: error });
  }
}

export const confirmUpload = async (req: AuthRequest, res: Response) => {
  try {
    const firebaseUid = req.user?.id;
    const { jobId, resumes, triggerScoring = false } = req.body;
    // ↑ new: optional triggerScoring flag from client

    if (!jobId || !resumes || !Array.isArray(resumes) || resumes.length === 0) {
      return res.status(400).json({ error: 'jobId and resumes array required' });
    }

    const [job, user] = await Promise.all([
      prisma.job.findUnique({ where: { id: jobId } }),
      prisma.user.findUnique({ where: { firebaseUid } }),
    ]);

    if (!job)                        return res.status(404).json({ error: 'Job not found' });
    if (!user || job.userId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const resumeIds = resumes.map((r: { resumeId: string }) => r.resumeId);

    const existingResumes = await prisma.resume.findMany({
      where: { id: { in: resumeIds }, jobId },
    });

    if (existingResumes.length !== resumeIds.length) {
      return res.status(400).json({ error: 'One or more resumes not found or wrong job' });
    }

    const notPending = existingResumes.filter((r) => r.status !== 'PENDING');
    if (notPending.length > 0) {
      return res.status(400).json({ error: `${notPending.length} resume(s) not in PENDING status` });
    }

    // ── 1. Create batch record ─────────────────────────────────────────────
    const batch = await prisma.uploadBatch.create({
      data: { jobId, totalResumes: resumeIds.length },
    });

    // ── 2. Atomically increment job.totalResumes (multi-batch safe) ────────
    await prisma.$transaction([
      prisma.job.update({
        where: { id: jobId },
        data:  {
          totalResumes: { increment: resumeIds.length },
          status:       'PROCESSING',
          // If client wants scoring, mark it now — DO will pick it up
          ...(triggerScoring ? { scoringRequested: true } : {}),
        },
      }),
      prisma.resume.updateMany({
        where: { id: { in: resumeIds } },
        data:  { status: 'UPLOADED', uploadedAt: new Date(), batchId: batch.id },
      }),
    ]);

    // ── 3. Enqueue to Cloudflare Queue via Worker binding ──────────────────
    // The container calls back to the worker's internal enqueue endpoint
    // (container doesn't have direct queue bindings)
    const messages = resumeIds.map((resumeId) => ({ resumeId, jobId }));
    await enqueueToExtractQueue(messages);
    // ↑ see section 5 below

    return res.json({ success: true, jobId, batchId: batch.id });

  } catch (error) {
    console.error('Upload confirm error:', error);
    return res.status(500).json({ error});
  }
};

// Internal endpoint — worker calls this to read totalResumes for DO
export const getJobTotal = async (req: Request, res: Response) => {
  const { jobId } = req.query as { jobId: string };
  const job = await prisma.job.findUnique({
    where:  { id: jobId },
    select: { totalResumes: true },
  });
  res.json({ totalResumes: job?.totalResumes ?? 0 });
};

// Internal endpoint — worker calls this to validate trigger-scoring request
export const validateTrigger = async (req: AuthRequest, res: Response) => {
  const { jobId } = req.body;
  const firebaseUid = req.user?.id;

  const [job, user] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    prisma.user.findUnique({ where: { firebaseUid } }),
  ]);

  if (!job)                          return res.status(404).json({ error: 'Job not found' });
  if (!user || job.userId !== user.id)  return res.status(403).json({ error: 'Forbidden' });
  if (job.totalResumes === 0)        return res.status(400).json({ error: 'No resumes uploaded yet' });
  if (job.status === JobStatus.RANKED)       return res.status(400).json({ error: 'Already scored' });

  // Mark scoringRequested in DB as well (source of truth backup)
  await prisma.job.update({
    where: { id: jobId },
    data:  { scoringRequested: true },
  });

  return res.json({ ok: true });
};



