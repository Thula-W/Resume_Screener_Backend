import { Router } from "express";
import {prisma} from "../utils/prisma.ts";
import { authenticate } from "../middleware/auth.ts";

import { getMe } from "../controllers/user.controller.ts";

const router = Router();

router.post('/',authenticate, getMe);

// router.get("/", async (req, res) => {
//   const users = await prisma.user.findMany();
//   res.json(users);
// });

export default router;
