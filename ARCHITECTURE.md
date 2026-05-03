
---

## 🧠 Core Components

### 1. API Layer
- POST /api/journal → store entries
- GET /api/journal/:userId → fetch entries
- POST /api/journal/analyze → emotion analysis
- GET /api/journal/insights/:userId → aggregated insights

---

### 2. Database Layer (MongoDB)
Stores:
- userId
- text
- ambience (forest/ocean/etc)
- emotion result
- keywords
- timestamps

---

### 3. Emotion Analysis Layer
Hybrid approach:
- Fast heuristic NLP (keyword + pattern based)
- OpenAI API (fallback for accuracy)

---

### 4. Cache Layer
- TTL + LRU cache
- Stores previous analysis results
- Reduces repeated computation and API calls

---

# ❗ REQUIRED ANSWERS (IMPORTANT)

---

## 1️⃣ How would you scale this to 100k users?

To handle 100k users, the system can be scaled using:

### 🔹 Backend Scaling
- Deploy multiple server instances (horizontal scaling)
- Use load balancer (e.g., Nginx / Vercel edge)

### 🔹 Database Scaling
- Use MongoDB Atlas cluster
- Enable indexing on:
  - userId
  - createdAt
- Use read replicas for heavy read operations

### 🔹 Caching
- Move from in-memory cache → Redis (distributed cache)

### 🔹 API Optimization
- Use pagination for journal fetch
- Use batch processing for analysis

### 🔹 Async Processing
- Offload heavy LLM calls to background jobs (queue system like BullMQ)

---

## 2️⃣ How would you reduce LLM cost?

LLM cost is a major concern. Optimizations:

### 🔹 Heuristic First Approach
- Use local NLP engine first
- Call LLM only if confidence is low

### 🔹 Input Truncation
- Limit text size (~1000–1500 chars)

### 🔹 Caching Results
- Same input → same output → reuse result

### 🔹 Batch Requests
- Analyze multiple entries together when possible

### 🔹 Lower-cost Models
- Use lightweight models (like GPT-4o-mini)

---

## 3️⃣ How would you cache repeated analysis?

### 🔹 Strategy Used

- Implement **TTL + LRU cache**
- Key = hashed input text
- Value = emotion result

### 🔹 Behavior
- Frequently used entries stay in cache (LRU)
- Old entries expire automatically (TTL)

### 🔹 Future Upgrade
- Use Redis:
  - Shared across servers
  - Persistent caching
  - Faster lookup

---

## 4️⃣ How would you protect sensitive journal data?

Journal data is highly sensitive. Protection includes:

### 🔐 Data Security
- Store secrets in `.env`
- Never expose API keys

### 🔐 Database Security
- Use MongoDB authentication
- Enable IP whitelisting

### 🔐 Encryption
- Encrypt sensitive fields (optional)
- Use HTTPS for all API calls

### 🔐 Access Control
- Validate userId before returning data
- Add authentication (JWT) in production

### 🔐 Rate Limiting
- Prevent abuse using API limits

---

## ⚡ Performance Summary

| Feature | Benefit |
|--------|--------|
| Cache (TTL + LRU) | Faster response |
| Heuristic Engine | Reduced API calls |
| MongoDB Indexing | Fast queries |
| Async Processing | Better scalability |

---

## 🎯 Design Decisions

- Hybrid NLP + AI approach → balance of speed & accuracy
- Explainability → evidence-based output
- Hinglish support → real-world usage
- Modular design → easy scaling

---

## 🔮 Future Improvements

- Redis distributed caching
- Microservices architecture
- Real-time analytics dashboard
- User authentication system
