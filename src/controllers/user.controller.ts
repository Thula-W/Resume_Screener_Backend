import type { Request, Response } from "express";
import { prisma } from "../utils/prisma.ts";

export const getMe = async (req: Request, res: Response) => {
  const { firebaseUid, email } = req.user!;

  let user = await prisma.user.findUnique({
    where: { firebaseUid: firebaseUid },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        firebaseUid: firebaseUid,
        email: email
      },
    });
  }

  res.json(user);
};
