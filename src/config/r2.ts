import 'dotenv/config';
import { S3Client } from "@aws-sdk/client-s3";

export const r2 = new S3Client({
  region: "auto", // R2 doesn't use standard AWS regions
  endpoint: process.env.R2_ENDPOINT, // The URL from Step 1
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});