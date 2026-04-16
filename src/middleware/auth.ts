import type { Request, Response, NextFunction } from "express";
import { supabaseAuth } from "../config/supabase.ts";
// import admin from "../config/firebase.ts";

export interface AuthRequest extends Request {
  headers: any;
  user?: {
    id: string;
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
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    req.user = {
      id: data.user.id,
      email: data.user.email ?? undefined,
    };

    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};
