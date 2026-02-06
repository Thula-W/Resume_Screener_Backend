import type { Request, Response } from "express";
import { prisma } from "../utils/prisma.ts";

export const getMe = async (req: Request, res: Response) => {
  const { uid, email } = req.user!;

  let user = await prisma.user.findUnique({
    where: { firebaseUid: uid },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        firebaseUid: uid,
        email: email
      },
    });
  }

  res.json(user);
};
