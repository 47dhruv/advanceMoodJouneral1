require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/assignment1";

app.use(cors({
  origin: "https://advance-mood-jouneral1.vercel.app"
}));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
});

app.use("/api/journal", require("./routes/journal"));

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
