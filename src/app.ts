import express from "express";
import cors from "cors";

import userRoutes from "./routes/userRoutes.ts";
import resumeRoutes from "./routes/resumeRoutes.ts";
import jobRoutes from "./routes/jobRoutes.ts";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/users", userRoutes);
app.use('/api/resumes',resumeRoutes)
app.use('/api/jobs',jobRoutes)

export default app;
