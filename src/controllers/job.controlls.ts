import type { Request, Response } from "express";
import { prisma } from "../utils/prisma.ts";

export const addJob = async (req: Request, res: Response) => {
  const { title, description, requirements } = req.body ?? {};
  const firebaseUid = (req as any).user?.firebaseUid;

  if (!firebaseUid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!title || !description) {
    return res
      .status(400)
      .json({ error: "Both 'title' and 'description' are required" });
  }

  try {
    let user = await prisma.user.findUnique({
      where: { firebaseUid },
    });

    const job = await prisma.job.create({
      data: {
        userId: user?.id,
        title,
        description,
        requirements: requirements ?? null,
      },
    });

    res.status(201).json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
};