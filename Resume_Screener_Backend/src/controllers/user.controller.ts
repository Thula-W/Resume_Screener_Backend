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

export const addFeedBack = async (req: AuthRequest, res: Response) => {
  const  feedback  = req.body.feedback;
  const userId = req.body.userId || req.user?.id;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const savedFeedback = await prisma.feedback.create({
      data: {
        userId: userId, 
        rating: feedback.rating,
        feedback: feedback.feedback,
        company: feedback.company,
        hiresPerMonth: feedback.hiresPerMonth,
        avgResumesPerRole: feedback.avgResumesPerRole,
        suggestions: feedback.suggestions,
      },
    });
    res.json(savedFeedback);
  } catch (error) {
    console.error("Error saving feedback:", error);
    res.status(500).json({ error: "Failed to save feedback" });
}}

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


class LimitExceededError extends Error {
  constructor(public type: 'resumes' | 'rankings', public limit: number, public used: number) {
    super(`${type} limit reached (${used}/${limit})`)
  }
}

// ── Increment resume usage ──────────────────────────────────────────────
export async function incrementResumeUsage(userId: string, count: number = 1) {
  return prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    })
    if (!subscription) throw new Error('No subscription found')

    const ledger = await tx.usageLedger.findUnique({
      where: {
        subscriptionId_periodStart: {
          subscriptionId: subscription.id,
          periodStart: subscription.currentPeriodStart,
        },
      },
    })
    if (!ledger) throw new Error('No active usage period')

    if (ledger.resumesUsed + count > subscription.plan.resumeLimit) {
      throw new LimitExceededError('resumes', subscription.plan.resumeLimit, ledger.resumesUsed)
    }

    return tx.usageLedger.update({
      where: { id: ledger.id },
      data: { resumesUsed: { increment: count } },
    })
  })
}

// ── Increment ranking usage ─────────────────────────────────────────────
export async function incrementRankingUsage(userId: string, count: number = 1) {
  return prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    })
    if (!subscription) throw new Error('No subscription found')

    const ledger = await tx.usageLedger.findUnique({
      where: {
        subscriptionId_periodStart: {
          subscriptionId: subscription.id,
          periodStart: subscription.currentPeriodStart,
        },
      },
    })
    if (!ledger) throw new Error('No active usage period')

    if (ledger.rankingsUsed + count > subscription.plan.rankingLimit) {
      throw new LimitExceededError('rankings', subscription.plan.rankingLimit, ledger.rankingsUsed)
    }

    return tx.usageLedger.update({
      where: { id: ledger.id },
      data: { rankingsUsed: { increment: count } },
    })
  })
}

export { LimitExceededError }

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
