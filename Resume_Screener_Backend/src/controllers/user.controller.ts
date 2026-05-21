import type { Request, Response } from "express";
import { prisma } from "../config/prisma";
import { AuthRequest } from "../middleware/auth";

// export const getMe = async (req: AuthRequest, res: Response) => {
//   const { id, email } = req.user!;

//   let user = await prisma.user.findUnique({
//     where: { id },
//   });

//   if (!user) {
//     user = await prisma.user.create({
//       data: {
//         firebaseUid: id,
//         email: email || ''
//       },
//     });   
//   }

//   res.json(user);
// };
