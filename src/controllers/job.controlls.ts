import type { Request, Response } from "express";
import { prisma } from "../utils/prisma.ts";
import { jobEmbeddingsQueue } from "../utils/queue.ts";

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