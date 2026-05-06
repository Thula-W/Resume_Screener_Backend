import { r2 } from "../config/r2";
import {prisma} from "../config/prisma";
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openAiClient } from "../config/openai";
import { systemPrompt, JSON_STRUCTURE } from "../prompts/parse.prompts";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { constraints } from "../types";

// ---------- helpers --------------------------------
export const extractTextFromPDF = async (buffer: Buffer) => {
  const uint8Array = new Uint8Array(buffer);
  const pdf = await pdfjs.getDocument({ data: uint8Array }).promise;
  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((item: any) => item.str);
    text += strings.join(" ") + "\n";
  }
  return text;
};

export const downloadResumeFile = async (
  bucket: string,
  filePath: string
): Promise<Buffer> => {
  console.log("bucket", bucket);
  console.log("filePath", filePath);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: filePath,
  });

  const response = await r2.send(command);

  if (!response.Body) {
    throw new Error("Download returned no data.");
  }

  // R2 returns a Readable stream — collect it into a Buffer
  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return Buffer.concat(chunks);
};

export const extractJson = async (text: string) => {

    const response = await openAiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: `Here is the resume text to parse:${text}`
        }
      ],
      response_format: { type: "json_object" }
    });

    const json = response.choices[0].message.content;
    return json;
}

export const convertJsonToText = (data: any): { bio: string; experience: string; skills: string, attributes: any , contactInfo :any } => {
  // 1. Process Bio
  const bioLines: string[] = [];
  const bio = data.bio_bucket;

  if (bio.summary) bioLines.push(`Summary: ${bio.summary}`);

  if (bio.education && bio.education.length > 0) {
    const eduText = bio.education
      .map((e: any) => {
        let line = `- ${e.qualifications} from ${e.institution}`;
        if (e.honors && e.honors.length > 0) line += ` (Honors: ${e.honors.join(", ")})`;
        if (e.timeframe) line += ` [${e.timeframe}]`;
        return line;
      })
      .join("\n");
    bioLines.push(`Education:\n${eduText}`);
  }

  if (bio.extracurriculars && bio.extracurriculars.length > 0) {
    bioLines.push(`Extracurriculars: ${bio.extracurriculars.join(", ")}`);
  }

  // 2. Process Experience
  const expLines = data.experience_bucket.map((exp: any) => {
    const title =  exp.role  || "";
    const name = exp.name ? ` ${exp.name}` : "";
    const org = exp.organization ? ` at ${exp.organization}` : "";
    const time = exp.timeframe ? ` (${exp.timeframe})` : "";
    const header = exp.type === "Professional" ? `[${exp.type}] ${title}${org}${time}` : `[${exp.type}] ${name},${title}${org}${time}`;
    const desc = exp.description ? `\nDescription: ${exp.description}` : "";
    return `${header}${desc}`;
  });

  // 3. Process Skills
  const skillLines = data.skills_bucket
    .filter((s: any) => s.values && s.values.length > 0) // Skip empty categories
    .map((s: any) => `${s.category}: ${s.values.join(", ")}`);

  return {
    bio: bioLines.join("\n\n"),
    experience: expLines.join("\n\n"),
    skills: skillLines.join("\n"),
    attributes: data.attributes_bucket,
    contactInfo: data.contact_info_bucket
  };
}

export const checkHardConstraints = (candidate: constraints, constraints: constraints):boolean => {
  // Years of experience
  if (
    constraints.yearsOfExperience &&
    candidate.yearsOfExperience < constraints.yearsOfExperience
  ) {
    console.log(`Disqualified due to years of experience ${candidate.yearsOfExperience} < ${constraints.yearsOfExperience}`);
    return false;
  }

  // Education
  const educationRank = {
    diploma: 1,
    bachelors: 2,
    masters: 3,
    phd: 4
  } as const;

  type EducationLevel = keyof typeof educationRank;
  if (
    constraints.education &&
    educationRank[candidate.education.toLowerCase() as EducationLevel] < (educationRank[constraints.education.toLowerCase() as EducationLevel] ?? 0)
  ) {
    console.log(`Disqualified due to education level ${candidate.education} < ${constraints.education}`);
    return false;
  }

  // Languages
  if (constraints.languages?.length > 0) {
    const hasAllLanguages = constraints.languages.every(lang =>
      candidate.languages.includes(lang)
    );
    if (!hasAllLanguages) {
      console.log(`Disqualified due to languages ${candidate.languages} missing ${constraints.languages}`);
      return false
    };
  }

  // Certifications
  if (constraints.certifications?.length > 0) {
    const hasCerts = constraints.certifications.every(cert =>
      candidate.certifications.includes(cert)
    );
    if (!hasCerts) {
      console.log(`Disqualified due to certifications ${candidate.certifications} missing ${constraints.certifications}`);
      return false
    };
  }

  return true;
}

export const combineResumeText = (data: {
  bio: string;
  experience: string;
  skills: string;
}) => {
  return `
BIO:
${data.bio}

EXPERIENCE:
${data.experience}

SKILLS:
${data.skills}
  `.trim();
};


//----------------------------------------------------------
// export const processResume = async (resumeId: string, constraints: any) => {
//     console.log(resumeId);
//     try {
//       const resume = await prisma.resume.findUnique({
//         where: { id: resumeId },
//       });
//       console.log(resume?.storagePath)
//       if (!resume) throw new Error("Resume not found");

//       // const paths = resume.storagePath.split("/");

//       const fileBuffer = await downloadResumeFile(
//           'resumes',
//           resume.storagePath
//       );

//       const text = await extractTextFromPDF(fileBuffer);
//       console.log(text)

//       const json = await extractJson(text) || "{}";
//       console.log(json);


//       const bucketTexts = convertJsonToText(JSON.parse(json));

//       const { attributes, ...restBuckets } = bucketTexts;
//       const content = combineResumeText(restBuckets);
//       const qualified = checkHardConstraints(attributes, constraints);
//       const status = qualified ? "PARSED" : "DISQUALIFIED";

//       await prisma.resume.update({
//         where: { id: resumeId },
//         data: {
//           content: content,
//           status: status
//         },
//       });
      
//       if (qualified){
//         await resumeEmbeddingsQueue.add("process-resume-embeddings", {
//           resumeId,
//           buckets: restBuckets,
//         });
//       }

//       return bucketTexts;
      
//     } catch (error) {
//       console.log("error:", error);
//       throw error;
//     }
    
// }

// const a = await downloadResumeFile('azendly-resumes', "666842d0-b371-471a-ac42-840687bb6083/464a14cb-ecbc-4ee0-86df-57cc6046405a/1776409774975_80037666-a823-4482-83ff-7829c87880a3_Thulana_Weerasekara.pdf")
// const txt = await extractTextFromPDF(a);
// console.log(txt);
// const resumetext = `Thulana Weerasekara  Ñ   Gampaha, Sri Lanka     +94 70 585 1334  #   thulanaweerasekara4@gmail.com  §   Github   ï   LinkedIn  Professional Summary  Final year Computer Science and Engineering undergraduate at the University of Moratuwa, with hands on experience as a Software Engineer Intern at GTN Technologies. Experienced in building and maintaining frontend and backend features using Angular, JavaScript, Node.js, and modern web technologies.   Strong foundation in software engineering with exposure to AI/ML driven applications. Fast learner with strong problem solving skills.  Technologies worked with  Programming Languages:   JavaScript, TypeScript, Python, Java, C++  Frontend:   Angular, React.js  Backend:   Node.js, Express.js  Databases:   PostgreSQL, MySQL, MongoDB, Firebase Firestore  Machine Learning & AI:   Pandas, scikit-learn, HuggingFace, LangChain, OpenAI  Tools & Platforms:   Git, GitLab, Prisma, Firebase Authentication, Playwright, AWS AppConfig  Education  BSc Engineering (Hons) in Computer Science and Engineering  University of Moratuwa   Present Specialization: Data Science and Engineering CGPA: 3.7 / 4.00 Dean’s List: Semester 3  GCE Advanced Level  Ananda College   2020 Island Rank: 152 Z-Score: 2.5114  Work Experience  Software Engineer Intern  GTN Technologies (Pvt) Ltd, Colombo 02   Dec 2024 – Aug 2025  •   Rapidly onboarded to Angular (new stack) and independently delivered production CRs and bug fixes within 2 weeks of joining.  •   Developed, enhanced, and maintained features across multiple production applications including Ru- bix, GTN Invest, MircoInvest, CCP, and RegWizard.  •   Independently owned and maintained the CCP web application, handling feature enhancements, bug fixes, and change requests while ensuring functional correctness and application stability.  •   Collaborated closely with cross functional teams (QA, backend engineers, delivery team) in an agile sprint based environment.  •   Designed and executed automated test cases using Playwright, improving confidence in releases.  •   Performed manual testing and validation to ensure high quality, bug free deployments.
// •   Followed coding best practices, version control workflows, and code review processes using Git and GitLab.  •   Implemented a configuration retrieval service integrated with AWS AppConfig, supporting secure and reliable frontend configuration management.  Projects  SkyCast AI   §   2  •   Developed a full stack smart weather application with React frontend and Node.js, Express (Type- Script) backend.  •   Integrated OpenWeather One Call API 3.0 with geolocation support to automatically fetch and display real time weather data, forecasts, alerts and historical weather data.  •   Designed and implemented dual AI powered chat agents (Default and Historian) with distinct func- tional scopes using OpenAI GPT-4o-mini for real-time and historical weather intelligence.  •   Enabled tool calling within chat agents to dynamically fetch weather data for new locations and historical dates.  •   Implemented input guardrails and validation to restrict chat interactions to relevant weather related queries, improving response reliability and preventing misuse.  •   Implemented 10 minute local storage caching to reduce redundant API calls and improve performance.  •   Added backend rate limiting to prevent API abuse and ensure system reliability.  Azendly   Ongoing  •   Designed and implemented an AI powered full stack SaaS platform to automate resume screening and candidate job matching.  •   Built a secure backend using Node.js, Express, and Prisma with PostgreSQL for storing user profiles, resume metadata, and job roles.  •   Integrated Firebase Authentication for user login and access control, ensuring each user’s data is isolated and protected.  •   Implemented AI driven resume analysis to compare semantic similarity and to extract key skills, expe- rience, and keywords from uploaded resumes, enabling automated ranking against job requirements.  •   Designed RESTful APIs with authentication and authorization middleware, enabling secure CRUD operations for resumes and user data.  MWP Visual Generation   Ongoing  •   To address the difficulties and scarcity of math visual generation, Developed an AI driven system to automatically generate accurate visuals for lower primary math word problems.  •   Iteratively explored an error judging framework for math word problems before pivoting to visual generation based on impact and feasibility analysis.  •   Extended the MATH2VISUAL framework with three new question categories: Object attribute iden- tification , Pattern recognition and Counting exercises.  •   Visuals generated using Text to Image models and as well as from SVG generations are evaluated to decide the best perfoming approach for each question category.  •   LLM based SVG synthesis and web-agent retrieval is used to overcome missing visual assets.  •   Designed evaluation metrics for the generated visuals including accuracy, clarity, completeness, and cognitive load.
// MediBot  •   Developed a medical assistant chatbot using Retrieval-Augmented Generation.  •   Implemented semantic search using PineconeDB and LangChain over a medical textbook corpus for knowledge retrieval.  CardioCare  •   Built a cardiovascular disease prediction system using a hybrid CNN-LSTM model.  •   Developed a MERN stack web interface for file upload and result visualization, ensuring usability and clarity for clinicians.  SCMS  •   Built a supply chain management system for logistic operations and order tracking with an easy to use dashboard.  •   Implemented frontend features using React with backend integration via Node.js and Express.js.  HyperLocal B2B Marketplace  •   Built a real-time web platform for B2B trading with geospatial business discovery and buyer seller communication.  •   Integrated Firebase Authentication for secure login.  MS-LED for Long Document Summarization  •   Enhanced document summarization of the Longformer Encoder-Decoder (LED) model using a multi stage summarization pipeline.  •   Overcame the 16k token limitation through document chunking and recursive summary merging.  •   Achieved improved summarization accuracy across both short and 16k+ token documents.  Certifications  Fundamentals of Deep Learning – NVIDIA Intro to Machine Learning – Kaggle Pandas – Kaggle  Languages  •   English (Fluent)  •   Sinhala (Native)  References  Mr. Amila Manathunga  Head of Engineering – Frontend Development GTN Technologies (Pvt) Ltd Email: m.amila@gtngroup.com Phone: +94 77 336 2792  Prof. Dulani Meedeniya  Senior Lecturer Department of Computer Science and Engineering Faculty of Engineering University of Moratuwa Email: dulanim@cse.mrt.ac.lk Phone: +94 71 393 5801`

// const buckets = await extractJson(resumetext);
// console.log(buckets)
// const job = await prisma.job.findUnique({
//       where: { id: "33cbd954-0d06-4d7c-8f9d-7b27d9461541" },
//     });
// console.log(job?.constraints);
// const text = await processResume("00f19276-6735-486f-96d2-03e8b6e44ea9", job.constraints);

//console.log(text);
// const sanitized = await extractJson(text);

// const t = {
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
//     '[Project]  AI-Powered Resume Screener SaaS, (Ongoing)\n' +
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
// }
// console.log(t.bio);
// console.log("-----------------------")
// console.log(t.experience);
// const a = {
//   bio: 'Summary: Experienced Systems Engineer with a strong background in software development and cloud technologies.\n' +
//     '\n' +
//     'Education:\n' +
//     '- M.S. in Computer Science from Georgia Institute of Technology\n' +
//     '- B.S. in Software Engineering from Texas A&M University (Honors: Summa Cum Laude)',
//   experience: '[Professional] Senior Systems Engineer at CloudStream Technologies\n' +
//     'Description: Architected a distributed data pipeline handling 5TB/day, reducing processing costs by 22%. Orchestrated the migration of 200+ microservices to Kubernetes, improving deployment frequency by 300%. Led a cross-functional team of 8 to deliver an internal API gateway used by 50+ developers.\n' +
//     '\n' +
//     '[Professional] Software Developer II at NexGen FinTech\n' +
//     'Description: Developed and maintained secure payment processing modules using Node.js and PostgreSQL. Implemented automated unit and integration testing suites, achieving 92% code coverage. Reduced database query response times by 45% through strategic indexing and query refactoring.\n' +
//     '\n' +
//     '[Professional] Junior Web Developer at Blue Horizon Agency\n' +
//     'Description: Built responsive front-end components for 15+ client websites using React and Tailwind CSS. Collaborated with UI/UX designers to translate Figma wireframes into high-performance code.\n' +
//     '\n' +
//     '[Project] Creator at Open Source\n' +
//     'Description: Created a zero-knowledge encryption CLI tool for local secret management; earned 400+ stars on GitHub.\n' +        
//     '\n' +
//     '[Project] Developer\n' +
//     'Description: Developed a Python-based simulation using reinforcement learning to optimize urban traffic light timing.',
//   skills: 'Technical Skills: Python, Go, JavaScript (TypeScript), SQL, Rust, AWS (Lambda, EKS, RDS), Docker, Terraform, CI/CD (GitHub Actions, Jenkins), React, Express, Redis, Kafka, GraphQL, Git\n' +
//     'Certifications: AWS Certified Solutions Architect – Professional, Certified Kubernetes Administrator (CKA), HashiCorp Certified: Terraform Associate\n' +
//     'Coursework: Computing Systems'
// }

// console.log(a.bio);