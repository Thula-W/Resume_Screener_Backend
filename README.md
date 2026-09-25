# Azendly — Automated AI Resume Screening & Reranking Pipeline

> An event-driven, cost-engineered recruitment platform designed to help small HR teams and hiring managers filter hundreds of inbound applicants down to the top 10% high-signal candidates in minutes.

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)](#)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=flat&logo=node.js&logoColor=white)](#)
[![Cloudflare Workers & Queues](https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white)](#)
[![PostgreSQL & pgvector](https://img.shields.io/badge/PostgreSQL-pgvector-336791?style=flat&logo=postgresql&logoColor=white)](#)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4o--mini-412991?style=flat&logo=openai&logoColor=white)](#)
[![Cohere](https://img.shields.io/badge/Rerank-Cohere-39594C?style=flat)](#)

---

## 📌 Problem & Motivation

Modern job postings routinely receive **100+ applications within the first hour** of going live. For small HR departments and lean engineering teams, reviewing this volume creates severe recruitment bottlenecks. Traditional keyword-based Applicant Tracking Systems (ATS) rely on brittle string matches, filtering out strong candidates who use alternative phrasing. Manual review, on the other hand, demands dozens of hours per role.

**Azendly** solves this by implementing a **multi-stage retrieval and reranking funnel** mirroring how senior recruiters evaluate profiles while eliminating personal bias and keeping monthly compute infrastructure costs **below $10**.

---

## 🏗️ Architecture & Data Pipeline

Azendly processes resumes asynchronously across distributed edge workers and queues to ensure low latency and zero UI blocking:

```
[ Frontend: React / TypeScript ]
               │
               │  1. Bulk Upload (Batches)
               ▼
[ Cloudflare R2 Object Storage ]
               │
               │  2. Event Trigger & Async Job Dispatch
               ▼
[ Cloudflare Queues & Workers ]
               │
               │  3. Text Extraction & Structured JSON Parsing
               ▼
[ OpenAI GPT-4o-mini ] ───► Strict JSON Extraction (Skills, Exp, Summary, PII)
               │
               ├───► PII Redaction & Isolated Relational Storage
               │
               │  4. 3-Bucket Chunking (Overview, Experience, Skills)
               ▼
[ text-embedding-3-small ]
               │
               │  5. Ingestion of Multi-Vector Embeddings
               ▼
[ PostgreSQL + pgvector (Prisma) ]
```

---

## 🎯 Multi-Stage Candidate Ranking Funnel

To balance processing latency, semantic depth, and LLM token costs, candidates pass through an asymmetric narrowing pipeline:

```
 100% Total Resumes Uploaded
   │
   │  Stage 1: Hybrid Retrieval (Semantic Cosine Similarity + Keyword Search)
   ▼
  Top 25% Candidates
   │
   │  Stage 2: Cross-Encoder Reranking (Cohere Rerank API)
   ▼
  Top 10% Candidates
   │
   │  Stage 3: Deep LLM Qualitative Evaluation & Score Breakdown
   ▼
 Final Ranked Shortlist with Match Justifications
```

1. **Stage 1 — Multi-Vector Hybrid Retrieval (100%  --> 25%):** 
   Both job requirements and candidate profiles are decomposed into three dedicated representations: **Skills**, **Experience**, and **Role Overview**. Embeddings are generated using `text-embedding-3-small` and queried against indexed `pgvector` columns alongside full-text keyword matching to minimize hallucinations and capture semantic synonyms.
2. **Stage 2 — Cross-Encoder Reranking (25% --> 10%):** 
   The top quartile is processed by the **Cohere Rerank** engine to compute deep contextual relevance across full career histories rather than isolated vector chunks.
3. **Stage 3 — Qualitative Evaluation:** 
   The final top 10% undergo LLM rubric evaluation to generate actionable match breakdowns, candidate strengths, and potential skill gaps for hiring managers.

---

## ⚡ Key Engineering Highlights

* **Asynchronous Parallel Processing:** Decoupled document ingestion using Cloudflare Workers and Queues, slashing resume processing turnaround by 80%.
* **Bias-Mitigating PII Anonymization:** Personally Identifiable Information (name, contact info, demographics) is isolated at the extraction phase and omitted during ranking algorithms.
* **Cost Engineering:** Multi-stage filtering limits expensive cross-encoder and LLM evaluations to high-probability candidates, sustaining monthly operational expenses below $10.
* **Enforced Schema Validation:** Ingestion outputs utilize OpenAI structured JSON outputs to prevent schema drift and protect downstream Prisma queries.

---

## 🛠️ Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React, TypeScript, Tailwind CSS, Vite |
| **Backend & Routing** | Node.js, Express, RESTful APIs, Prisma ORM |
| **Cloud & Distributed Compute** | Cloudflare Workers, Cloudflare Queues, Cloudflare R2 |
| **Database & Vector Store** | PostgreSQL, `pgvector` (Supabase) |
| **AI / Machine Learning** | OpenAI (`gpt-4o-mini`, `text-embedding-3-small`), Cohere Rerank API |
| **Auth & Communications** | Supabase Auth, Resend (Transactional Email) |

---



## 🔒 Security & Privacy

* **Isolated PII Data:** Candidate contact details and demographic identifiers are separated into isolated relational records and stripped prior to semantic scoring and LLM evaluation.
* **Presigned Secure Storage:** Resumes uploaded to Cloudflare R2 are accessed strictly via short-lived presigned URLs.
* **Role-Based Tenant Access:** Supabase Row Level Security (RLS) policies prevent cross-team candidate leakage.
