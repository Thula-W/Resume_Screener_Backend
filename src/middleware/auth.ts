import type { Request, Response, NextFunction } from "express";
import admin from "../config/firebase.ts";

export interface AuthRequest extends Request {
  headers: any;
  user?: {
    uid: string;
    email?: string;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next:NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);

    req.user = {
      uid: decoded.uid,
      email: decoded.email,
    };

    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};
