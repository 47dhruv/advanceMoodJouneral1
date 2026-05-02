# 🚀 AI Emotion & Sentiment Analysis Engine

A production-grade Emotion & Sentiment Analysis system built using Node.js, MongoDB, and advanced NLP techniques.

---

## 🔥 Features

* 🧠 Emotion Detection (happy, sad, angry, anxious, calm, etc.)
* 📊 Confidence & Intensity scoring
* 🧩 Multi-emotion detection (primary + secondary)
* 🧾 Explainability (evidence tracking)
* 📈 Emotion timeline (sentence-level analysis)
* 🌐 Hinglish language support
* ⚡ Optimized performance (O(W) complexity)
* 💾 MongoDB storage with analytics
* 🔁 Batch processing with concurrency control

---

## 🏗️ Tech Stack

* Node.js
* Express.js
* MongoDB (Atlas)
* Mongoose
* Axios
* Custom NLP Engine

---

## ⚙️ Installation

```bash
git clone https://github.com/your-username/emotion-analyzer.git
cd emotion-analyzer
npm install
```

---

## 🔑 Environment Setup

Create a `.env` file:

```env
MONGO_URI=your_mongodb_connection_string
OPENAI_API_KEY=your_api_key (optional)
```

---

## ▶️ Run the server

```bash
node server.js
```

---

## 📡 API Endpoints

### 1. Analyze Text

```http
POST /analyze
```

**Body:**

```json
{
  "text": "I feel stressed and nothing is going right"
}
```

---

### 2. Get History

```http
GET /history
```

---

### 3. Filter by Emotion

```http
GET /history/:emotion
```

---

### 4. Emotion Stats

```http
GET /stats
```

---

## 📊 Example Response

```json
{
  "emotion": "anxious",
  "confidence": 0.82,
  "intensity": 0.74,
  "keywords": ["stressed", "nothing", "wrong"],
  "summary": "User feels overwhelmed and stressed"
}
```

---

## 🧠 How It Works

* Preprocessing (contractions, Hinglish normalization)
* Phrase-level pattern detection
* Keyword-based scoring with reverse indexing
* Context-aware negation handling
* Softmax probability distribution
* Sentiment fallback system
* Optional OpenAI enhancement

---

## 🚀 Future Improvements

* Embedding-based semantic analysis
* Sarcasm detection upgrade
* Real-time dashboard
* User authentication system
* Mobile / Chrome extension

---

## 📌 Author

Dhruv Pandey

---

## ⭐ Show your support

If you like this project, give it a star ⭐ on GitHub!
