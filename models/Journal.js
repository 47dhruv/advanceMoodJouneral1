const mongoose = require("mongoose");

const journalSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, trim: true },
    ambience: { type: String, default: "custom", trim: true },
    text: { type: String, required: true, trim: true, minlength: 3, maxlength: 4000 },
    emotion: { type: String, default: "neutral", trim: true },
    keywords: { type: [String], default: [] },
    summary: { type: String, default: "", maxlength: 600 }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

journalSchema.index({ userId: 1, createdAt: -1 });
journalSchema.index({ userId: 1, emotion: 1, ambience: 1 });

module.exports = mongoose.model("Journal", journalSchema);
