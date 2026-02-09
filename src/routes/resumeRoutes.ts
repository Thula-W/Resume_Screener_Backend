import { Router } from "express";
import { authenticate } from "../middleware/auth.ts";

import { confirmUpload, uploadIntent } from "../controllers/resume.controlls.ts";
import { upload } from "../middleware/multer.ts";

const router = Router();

// router.post('/',authenticate, createResume);
router.get('/upload-intent',authenticate, uploadIntent)
router.post('/upload-confirm', authenticate, upload.single('file'), confirmUpload)


export default router;
