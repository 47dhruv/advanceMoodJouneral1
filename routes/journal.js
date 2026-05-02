const express = require("express");
const router = express.Router();
const {
  createEntry,
  analyzeEntry,
  analyzeAndSaveEntry,
  listEntries,
  getInsights
} = require("../controllers/journalController");

router.post("/analyze", analyzeEntry);
router.post("/analyze-and-save", analyzeAndSaveEntry);
router.post("/", createEntry);
router.get("/insights/:userId", getInsights);
router.get("/:userId", listEntries);

module.exports = router;
