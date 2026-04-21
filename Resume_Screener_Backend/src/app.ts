import express from "express";
import cors from "cors";

import userRoutes from "./routes/userRoutes";
import resumeRoutes from "./routes/resumeRoutes";
import jobRoutes from "./routes/jobRoutes";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/users", userRoutes);
app.use('/api/resumes',resumeRoutes)
app.use('/api/jobs',jobRoutes)

export default app;
