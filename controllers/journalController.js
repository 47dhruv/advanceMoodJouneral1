const Journal = require("../models/Journal");
const analyzeText = require("../utils/analyze");

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 40;

function sanitizeRegexInput(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePagination(query) {
  const page = Math.max(1, parseNumber(query.page, 1));
  const requestedLimit = Math.max(1, parseNumber(query.limit, DEFAULT_LIMIT));
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
}

function parseSort(query) {
  const allowed = new Set(["createdAt", "emotion", "ambience"]);
  const sortBy = allowed.has(query.sortBy) ? query.sortBy : "createdAt";
  const order = query.order === "asc" ? 1 : -1;
  return { [sortBy]: order };
}

function buildFilters(userId, query) {
  const filters = { userId };

  if (query.emotion) {
    filters.emotion = query.emotion.trim();
  }

  if (query.ambience) {
    filters.ambience = query.ambience.trim();
  }

  if (query.search && query.search.trim()) {
    filters.text = {
      $regex: sanitizeRegexInput(query.search.trim()),
      $options: "i"
    };
  }

  return filters;
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) {
    return [];
  }

  return keywords
    .filter((word) => typeof word === "string" && word.trim())
    .map((word) => word.trim().toLowerCase())
    .slice(0, 12);
}

function summarizeDistributions(entries, key) {
  return entries.reduce((acc, entry) => {
    const raw = typeof entry[key] === "string" ? entry[key].trim() : "";
    const value = raw || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function buildKeywordRanking(entries, limit = 8) {
  const counts = new Map();
  entries.forEach((entry) => {
    (entry.keywords || []).forEach((word) => {
      const normalized = String(word || "").trim().toLowerCase();
      if (!normalized) {
        return;
      }
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}

function toDayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function calculateStreaks(entries) {
  const uniqueDays = Array.from(
    new Set(entries.map((entry) => toDayKey(entry.createdAt)))
  ).sort();

  if (uniqueDays.length === 0) {
    return { currentStreakDays: 0, longestStreakDays: 0 };
  }

  let currentStreakDays = 1;
  for (let i = uniqueDays.length - 1; i > 0; i -= 1) {
    const previous = new Date(uniqueDays[i - 1]);
    const current = new Date(uniqueDays[i]);
    const diffDays = (current - previous) / (1000 * 60 * 60 * 24);
    if (diffDays === 1) {
      currentStreakDays += 1;
      continue;
    }
    break;
  }

  let longestStreakDays = 1;
  let running = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    const previous = new Date(uniqueDays[i - 1]);
    const current = new Date(uniqueDays[i]);
    const diffDays = (current - previous) / (1000 * 60 * 60 * 24);
    if (diffDays === 1) {
      running += 1;
      longestStreakDays = Math.max(longestStreakDays, running);
    } else {
      running = 1;
    }
  }

  return { currentStreakDays, longestStreakDays };
}

function buildInsights(entries) {
  const totalEntries = entries.length;
  const emotionDistribution = summarizeDistributions(entries, "emotion");
  const ambienceDistribution = summarizeDistributions(entries, "ambience");
  const sortedByLatest = [...entries].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const topEmotion =
    Object.entries(emotionDistribution).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    null;
  const mostUsedAmbience =
    Object.entries(ambienceDistribution).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    null;

  const avgLength =
    totalEntries === 0
      ? 0
      : Math.round(
          entries.reduce((sum, entry) => sum + (entry.text?.length || 0), 0) /
            totalEntries
        );

  const topKeywords = buildKeywordRanking(entries, 8);
  const recentKeywords = sortedByLatest
    .flatMap((entry) => entry.keywords || [])
    .filter(Boolean)
    .slice(0, 5);
  const { currentStreakDays, longestStreakDays } = calculateStreaks(entries);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const entriesLast7Days = entries.filter(
    (entry) => new Date(entry.createdAt) >= sevenDaysAgo
  ).length;

  return {
    totalEntries,
    topEmotion,
    mostUsedAmbience,
    averageEntryLength: avgLength,
    entriesLast7Days,
    currentStreakDays,
    longestStreakDays,
    recentKeywords,
    topKeywords,
    emotionDistribution,
    ambienceDistribution
  };
}

function validateJournalPayload(payload) {
  const userId = typeof payload.userId === "string" ? payload.userId.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const ambience =
    typeof payload.ambience === "string" && payload.ambience.trim()
      ? payload.ambience.trim()
      : "custom";

  if (!userId) {
    return { error: "userId is required" };
  }

  if (!text) {
    return { error: "text is required" };
  }

  if (text.length < 3) {
    return { error: "text must be at least 3 characters long" };
  }

  return { userId, text, ambience };
}

async function createEntry(req, res) {
  try {
    const validated = validateJournalPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const requestedEmotion =
      typeof req.body.emotion === "string" && req.body.emotion.trim()
        ? req.body.emotion.trim()
        : null;
    const requestedSummary =
      typeof req.body.summary === "string" ? req.body.summary.trim() : "";
    const requestedKeywords = normalizeKeywords(req.body.keywords);
    const autoAnalyze = req.body.autoAnalyze === true;

    let analysis = null;
    if (autoAnalyze) {
      analysis = await analyzeText(validated.text);
    }

    const entry = await Journal.create({
      userId: validated.userId,
      text: validated.text,
      ambience: validated.ambience,
      emotion: analysis?.emotion || requestedEmotion || "neutral",
      keywords:
        analysis?.keywords || (requestedKeywords.length ? requestedKeywords : []),
      summary: analysis?.summary || requestedSummary
    });

    return res.status(201).json({
      entry,
      meta: { analyzed: Boolean(analysis) }
    });
  } catch (error) {
    console.error("Failed to create journal entry:", error.message);
    return res.status(500).json({ error: "Failed to save journal entry" });
  }
}

async function analyzeEntry(req, res) {
  try {
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    const result = await analyzeText(text);
    return res.json(result);
  } catch (error) {
    console.error("Failed to analyze entry:", error.message);
    return res.status(500).json({ error: "Failed to analyze text" });
  }
}

async function analyzeAndSaveEntry(req, res) {
  try {
    const validated = validateJournalPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const analysis = await analyzeText(validated.text);

    const entry = await Journal.create({
      userId: validated.userId,
      text: validated.text,
      ambience: validated.ambience,
      emotion: analysis.emotion,
      keywords: normalizeKeywords(analysis.keywords),
      summary: analysis.summary || ""
    });

    return res.status(201).json({ entry, analysis });
  } catch (error) {
    console.error("Failed to analyze and save entry:", error.message);
    return res.status(500).json({ error: "Failed to analyze and save entry" });
  }
}

async function listEntries(req, res) {
  try {
    const userId =
      typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const filters = buildFilters(userId, req.query);
    const sort = parseSort(req.query);

    const [total, items] = await Promise.all([
      Journal.countDocuments(filters),
      Journal.find(filters).sort(sort).skip(skip).limit(limit).lean()
    ]);

    const totalPages = total === 0 ? 1 : Math.ceil(total / limit);

    return res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1
      }
    });
  } catch (error) {
    console.error("Failed to list entries:", error.message);
    return res.status(500).json({ error: "Failed to fetch journal entries" });
  }
}

async function getInsights(req, res) {
  try {
    const userId =
      typeof req.params.userId === "string" ? req.params.userId.trim() : "";
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const entries = await Journal.find({ userId }).lean();
    const insights = buildInsights(entries);
    return res.json(insights);
  } catch (error) {
    console.error("Failed to build insights:", error.message);
    return res.status(500).json({ error: "Failed to fetch insights" });
  }
}

module.exports = {
  createEntry,
  analyzeEntry,
  analyzeAndSaveEntry,
  listEntries,
  getInsights
};
