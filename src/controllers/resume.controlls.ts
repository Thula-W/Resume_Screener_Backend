import { prisma } from "../utils/prisma.ts";
import type { Request, Response } from "express";
import { supabase } from "../utils/supabase.ts";
import { resumeQueue } from "../utils/queue.ts";

/**
 * POST /upload-intent
 * Generate signed upload URLs for direct Supabase upload
 * Supports both single and bulk uploads
 * 
 * Request body:
 * {
 *   jobId: string,
 *   files: Array<{ name: string }> // for bulk, optional
 * }
 * 
 * Response:
 * {
 *   uploadIntents: Array<{ resumeId, signedUrl, expiresIn }>,
 *   constraints: { maxSizeMB, allowedTypes }
 * }
 */
export const uploadIntent = async (req: Request, res: Response) => {
  try {
    const firebaseUid = req.user.firebaseUid;
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
        const { data, error: urlError } = await supabase.storage
          .from("resumes")
          .createSignedUploadUrl(storagePath);

        if (urlError) {
          throw new Error(`Failed to generate signed URL: ${urlError.message}`);
        }

        return {
          resumeId: resume.id,
          storagePath: storagePath,
          signedUrl: data?.signedUrl,
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

/**
 * POST /upload-confirm
 * Confirms bulk resumne uploads and queues processing
 * 
 * Request body:
 * {
 *   jobId: string,
 *   resumes: Array<{
 *     resumeId: string
 *   }>
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   jobId: string,
 *   queueJobId: string,
 *   processedCount: number
 * }
 */
export const confirmUpload = async (req: Request, res: Response) => {
  try {
    const firebaseUid = req.user.firebaseUid;
    const { jobId, resumes } = req.body;

    if (!jobId || !resumes || !Array.isArray(resumes) || resumes.length === 0) {
      return res.status(400).json({
        error: "jobId and resumes array (with at least 1 item) are required",
      });
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

    // Validate all resumes exist and belong to this job
    const resumeIds = resumes.map((r) => r.resumeId);
    const existingResumes = await prisma.resume.findMany({
      where: {
        id: { in: resumeIds },
        jobId, // Verify they belong to this job
      },
    });

    if (existingResumes.length !== resumeIds.length) {
      return res.status(400).json({
        error: "One or more resumes not found or don't belong to this job",
      });
    }

    // Verify all are in PENDING status
    const invalidStatusResumes = existingResumes.filter(
      (r) => r.status !== "PENDING"
    );
    if (invalidStatusResumes.length > 0) {
      return res.status(400).json({
        error: `${invalidStatusResumes.length} resume(s) are not in PENDING status`,
      });
    }

    // Update all resumes to UPLOADED
    await prisma.resume.updateMany({
      where: { id: { in: resumeIds } },
      data: {
        status: "UPLOADED",
        uploadedAt: new Date(),
      },
    });

    await resumeQueue.addBulk(
      resumeIds.map((resumeId) => ({
        name: "process-resume",
        data: { resumeId },
        opts: {
         // jobId: resumeId, // prevents duplicates
          attempts: 3,
          backoff: { type: "exponential", delay: 3000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      }))
    );

    res.json({
      success: true,
      jobId,
      //queueJobId: queueJob.id,
    });
  } catch (error) {
    console.error("Upload confirm error:", error);
    res.status(500).json({ error: "Failed to confirm uploads" });
  }
};



