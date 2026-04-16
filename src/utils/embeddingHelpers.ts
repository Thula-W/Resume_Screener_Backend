import { openAiClient } from "./openai.ts";
import { prisma } from "./prisma.ts";
import { v4 as uuidv4 } from "uuid";


export const withRetry = async (fn: () => Promise<void>, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) console.error("All retries failed:", err);
      else await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // exponential backoff
    }
  }
};

export const generateEmbedding = async (text: string): Promise<number[]> => {
  const response = await openAiClient.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
};

export const processResumeEmbeddings = async (data: {
  resumeId: string;
  buckets: { skills: string; bio: string; experience: string };
}) => {
  const { resumeId, buckets } = data;

  const segments = [
      { bucket: "SKILLS", text: buckets.skills },
      { bucket: "BIO", text: buckets.bio },
      { bucket: "EXPERIENCE", text: buckets.experience },
    ].filter((s) => s.text && s.text.trim().length > 0);

    if (segments.length === 0) {
      console.log(`No segments to embed for resume ${resumeId}`);
      return;
    }

  try {
        // Generate embeddings in parallel
    const embeddings = await Promise.all(
      segments.map((s) => generateEmbedding(s.text!))
    );

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const vector = `[${embeddings[i].join(",")}]`;
      const id = uuidv4();

      await prisma.$executeRaw`
        INSERT INTO "ResumeEmbedding"
        ( "id","resumeId", "bucket", "text", "embedding")
        VALUES (
          ${id},
          ${resumeId},
          ${segment.bucket},
          ${segment.text},
          ${vector}::vector
        )
      `;
    }

    await prisma.resume.update({
      where: { id: resumeId },
      data: { status: "EMBEDDED" },
    });

    console.log(`Resume embeddings completed for ${resumeId}`);
  } catch (error) {
    console.error(`Error processing resume embeddings for ${resumeId}:`, error);
    throw error;
  }
};

export const processJobEmbedding = async (data: {
  jobId: string;
  // Accept either an individual bucket update or a full set of bucket texts.
  bucketType?: "SKILLS" | "BIO" | "EXPERIENCE";
  text?: string;
  skills?: string;
  bio?: string;
  experience?: string;
}) => {
  const { jobId, bucketType, text, skills, bio, experience } = data;

  try {
    if (skills || bio || experience) {
      // Full payload: embed all three segments in parallel.
      const [skillsEmbedding, bioEmbedding, experienceEmbedding] = await Promise.all([
        generateEmbedding(skills ?? ""),
        generateEmbedding(bio ?? ""),
        generateEmbedding(experience ?? ""),
      ]);

      const sVec = `[${skillsEmbedding.join(",")}]`;
      const bVec = `[${bioEmbedding.join(",")}]`;
      const eVec = `[${experienceEmbedding.join(",")}]`;

      await prisma.$executeRaw`
        UPDATE "Job"
        SET 
          "skillsEmbedding" = ${sVec}::vector,
          "bioEmbedding" = ${bVec}::vector,
          "experienceEmbedding" = ${eVec}::vector
        WHERE "id" = ${jobId}
      `;

      console.log(`Job embeddings completed for ${jobId}`);
      return;
    }

    // Fallback: single-bucket update (legacy behavior)
    if (!bucketType || !text) {
      throw new Error("Missing required fields for job embedding");
    }

    const embedding = await generateEmbedding(text);
    const vectorString = `[${embedding.join(",")}]`;

    if (bucketType === "SKILLS") {
      await prisma.$executeRaw`
        UPDATE "Job"
        SET 
          "skillsText" = ${text},
          "skillsEmbedding" = ${vectorString}::vector
        WHERE "id" = ${jobId}
      `;
    } else if (bucketType === "BIO") {
      await prisma.$executeRaw`
        UPDATE "Job"
        SET 
          "bioText" = ${text},
          "bioEmbedding" = ${vectorString}::vector
        WHERE "id" = ${jobId}
      `;
    } else if (bucketType === "EXPERIENCE") {
      await prisma.$executeRaw`
        UPDATE "Job"
        SET 
          "experienceText" = ${text},
          "experienceEmbedding" = ${vectorString}::vector
        WHERE "id" = ${jobId}
      `;
    }

    // const updateData: any = {};
    // if (bucketType === "SKILLS") {
    //   updateData.skillsText = text;
    //   updateData.skillsEmbedding = `[${embedding.join(",")}]`;
    // } else if (bucketType === "BIO") {
    //   updateData.bioText = text;
    //   updateData.bioEmbedding = `[${embedding.join(",")}]`;
    // } else if (bucketType === "EXPERIENCE") {
    //   updateData.experienceText = text;
    //   updateData.experienceEmbedding = `[${embedding.join(",")}]`;
    // }
    // await prisma.job.update({
    //   where: { id: jobId },
    //   data: updateData,
    // });

    console.log(`Job embedding completed for ${jobId}, bucket: ${bucketType}`);
  } catch (error) {
    console.error(`Error processing job embedding for ${jobId}:`, error);
    throw error;
  }
};

// processResumeEmbeddings({
//   resumeId: "00f19276-6735-486f-96d2-03e8b6e44ea9",
//   buckets: {
//   bio: 'Summary: Final year Computer Science and Engineering undergraduate at the University of Moratuwa, with hands on experience as a Software Engineer Intern at GTN Technologies. Experienced in building and maintaining frontend and backend features using Angular, JavaScript, Node.js, and modern web technologies. Strong foundation in software engineering with exposure to AI/ML driven applications. Fast learner with strong problem solving skills.\n' +
//     '\n' +
//     'Education:\n' +
//     '- BSc Engineering (Hons) in Computer Science and Engineering from University of Moratuwa (Honors: Dean’s List: Semester 3) [Present]\n' +
//     '- GCE Advanced Level from Ananda College [2020]',
//   experience: '[Professional] Software Engineer Intern at GTN Technologies (Pvt) Ltd (Dec 2024 – Aug 2025)\n' +
//     'Description: Rapidly onboarded to Angular (new stack) and independently delivered production CRs and bug fixes within 2 weeks of joining. Developed, enhanced, and maintained features across multiple production applications including Ru-bix, GTN Invest, MircoInvest, CCP, and RegWizard. Independently owned and maintained the CCP web application, handling feature enhancements, bug fixes, and change requests while ensuring functional correctness and application stability. Collaborated closely with cross functional teams (QA, backend engineers, delivery team) in an agile sprint based environment. Designed and executed automated test cases using Playwright, improving confidence in releases. Performed manual testing and validation to ensure high quality, bug free deployments. Followed coding best practices, version control workflows, and code review processes using Git and GitLab. Implemented a configuration retrieval service integrated with AWS AppConfig, supporting secure and reliable frontend configuration management.\n' +
//     '\n' +
//     '[Project]  SkyCast AI,\n' +
//     'Description: Developed a full stack smart weather application with React frontend and Node.js, Express (TypeScript) backend. Integrated OpenWeather One Call API 3.0 with geolocation support to automatically fetch and display real time weather data, forecasts, alerts and historical weather data. Designed and implemented dual AI powered chat agents (Default and Historian) with distinct functional scopes using OpenAI GPT-4o-mini for real-time and historical weather intelligence. Enabled tool calling within chat agents to dynamically fetch weather data for new locations and historical dates. Implemented input guardrails and validation to restrict chat interactions to relevant weather related queries, improving response reliability and preventing misuse. Implemented 10 minute local storage caching to reduce redundant API calls and improve performance. Added backend rate limiting to prevent API abuse and ensure system reliability.\n' +
//     '\n' +
//     '[Project]  Azendly, (Ongoing)\n' +
//     'Description: Designed and implemented an AI powered full stack SaaS platform to automate resume screening and candidate job matching. Built a secure backend using Node.js, Express, and Prisma with PostgreSQL for storing user profiles, resume metadata, and job roles. Integrated Firebase Authentication for user login and access control, ensuring each user’s data is isolated and protected. Implemented AI driven resume analysis to compare semantic similarity and to extract key skills, experience, and keywords from uploaded resumes, enabling automated ranking against job requirements. Designed RESTful APIs with authentication and authorization middleware, enabling secure CRUD operations for resumes and user data.\n' +
//     '\n' +
//     '[Project]  MWP Visual Generation, (Ongoing)\n' +
//     'Description: To address the difficulties and scarcity of math visual generation, Developed an AI driven system to automatically generate accurate visuals for lower primary math word problems. Iteratively explored an error judging framework for math word problems before pivoting to visual generation based on impact and feasibility analysis. Extended the MATH2VISUAL framework with three new question categories: Object attribute identification, Pattern recognition and Counting exercises. Visuals generated using Text to Image models and as well as from SVG generations are evaluated to decide the best performing approach for each question category. LLM based SVG synthesis and web-agent retrieval is used to overcome missing visual assets. Designed evaluation metrics for the generated visuals including accuracy, clarity, completeness, and cognitive load.\n' +
//     '\n' +
//     '[Project]  MediBot,\n' +
//     'Description: Developed a medical assistant chatbot using Retrieval-Augmented Generation. Implemented semantic search using PineconeDB and LangChain over a medical textbook corpus for knowledge retrieval.\n' +
//     '\n' +
//     '[Project]  CardioCare,\n' +
//     'Description: Built a cardiovascular disease prediction system using a hybrid CNN-LSTM model. Developed a MERN stack web interface for file upload and result visualization, ensuring usability and clarity for clinicians.\n' +
//     '\n' +
//     '[Project]  SCMS,\n' +
//     'Description: Built a supply chain management system for logistic operations and order tracking with an easy to use dashboard. Implemented frontend features using React with backend integration via Node.js and Express.js.\n' +
//     '\n' +
//     '[Project]  HyperLocal B2B Marketplace,\n' +
//     'Description: Built a real-time web platform for B2B trading with geospatial business discovery and buyer seller communication. Integrated Firebase Authentication for secure login.\n' +
//     '\n' +
//     '[Project]  MS-LED for Long Document Summarization,\n' +
//     'Description: Enhanced document summarization of the Longformer Encoder-Decoder (LED) model using a multi stage summarization pipeline. Overcame the 16k token limitation through document chunking and recursive summary merging. Achieved improved summarization accuracy across both short and 16k+ token documents.',
//   skills: 'Technical Skills: JavaScript, TypeScript, Python, Java, C++, Angular, React.js, Node.js, Express.js, PostgreSQL, MySQL, MongoDB, Firebase Firestore, Pandas, scikit-learn, HuggingFace, LangChain, OpenAI, Git, GitLab, Prisma, Firebase Authentication, Playwright, AWS AppConfig\n' +
//     'Certifications: Fundamentals of Deep Learning – NVIDIA, Intro to Machine Learning – Kaggle, Pandas – Kaggle'
// }});