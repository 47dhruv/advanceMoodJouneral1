# 🧠 AI Emotion Analyzer (Mood Journal App)

A full-stack AI-powered emotion analysis platform that detects user emotions from text using a hybrid NLP + AI system, with real-time analysis, explainability, and persistent storage.

🔗 Live Demo: https://advance-mood-jouneral1.vercel.app/

---

## 🚀 Overview

This project combines **rule-based NLP, statistical modeling, and AI APIs** to analyze emotional state from user input.

It is designed as a **production-ready system**, not just a basic sentiment tool.

---

## ✨ Key Features

### 🧠 Emotion Intelligence
- Detects **Top 2 emotions**
- Softmax-based confidence scoring
- Emotion intensity (0–1 scale)
- Multi-emotion handling

### 📊 Sentiment Analysis
- Score range: **-1 (negative) → +1 (positive)**
- Context-aware polarity detection

### 🌍 Advanced NLP Support
- Hinglish normalization (Hindi → English mapping)
- Sarcasm detection ("yeah right", "just perfect")
- Negation handling ("not happy" → sad)
- Repeated character normalization ("soooo")

### ⚡ Performance Optimizations
- O(W) keyword scanning using reverse index
- TTL + LRU cache system
- Batch processing with concurrency control

### 🧩 Explainable AI
- Evidence tracking (why emotion was detected)
- Keyword extraction
- Sentence-wise emotion timeline

### 💾 Backend & Storage
- MongoDB Atlas for storing user data/history
- REST API architecture
- Deployed on Vercel

---

## 🛠 Tech Stack

### Frontend
- React / Next.js
- Tailwind CSS

### Backend
- Node.js
- Express.js

### Database
- MongoDB Atlas

### AI & NLP
- Custom heuristic engine
- OpenAI API (fallback + enhancement)

---

## 📦 API Example

### Request
```json
{
  "text": "I feel very stressed and overwhelmed"
}
