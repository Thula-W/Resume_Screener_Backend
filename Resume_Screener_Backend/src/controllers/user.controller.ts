import type { Request, Response } from "express";
import { prisma } from "../config/prisma";
import { AuthRequest } from "../middleware/auth";
import {RemainingCredits} from "../types";


export const getCreditDetails = async (req: AuthRequest, res: Response) => {
    // const userId = req.user?.id;
    const userId  = req.body.userId || req.user?.id;

    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    const credits = await getRemainingCredits(userId);

    if (!credits) {
        return res.status(404).json({ error: "Credits not found" });
    }

    res.json(credits);
}

// ------------------------------------  helpers --------------------------------

async function getRemainingCredits(userId: string): Promise<RemainingCredits | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  })

  if (!subscription) return null

  const ledger = await prisma.usageLedger.findUnique({
    where: {
      subscriptionId_periodStart: {
        subscriptionId: subscription.id,
        periodStart: subscription.currentPeriodStart,
      },
    },
  })

  if (!ledger) return null // no ledger for the current period — needs renewal/reset

  const { plan } = subscription

  return {
    resumesRemaining: plan.resumeLimit - ledger.resumesUsed,
    rankingsRemaining: plan.rankingLimit - ledger.rankingsUsed,
    resumeLimit: plan.resumeLimit,
    rankingLimit: plan.rankingLimit,
    resumesUsed: ledger.resumesUsed,
    rankingsUsed: ledger.rankingsUsed,
    periodStart: ledger.periodStart,
    periodEnd: ledger.periodEnd,
  }
}


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
