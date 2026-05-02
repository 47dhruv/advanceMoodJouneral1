import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import "./App.css";

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || "http://localhost:5000"
});

const AMBIENCE_OPTIONS = [
  "custom",
  "forest",
  "rain",
  "cafe",
  "lofi",
  "night",
  "sunrise"
];

const EMOTION_OPTIONS = ["", "happy", "sad", "angry", "anxious", "calm", "neutral"];

const initialInsights = {
  totalEntries: 0,
  topEmotion: null,
  mostUsedAmbience: null,
  averageEntryLength: 0,
  entriesLast7Days: 0,
  currentStreakDays: 0,
  longestStreakDays: 0,
  recentKeywords: [],
  topKeywords: [],
  emotionDistribution: {},
  ambienceDistribution: {}
};

function App() {
  const skipNetworkForTests = process.env.NODE_ENV === "test";
  const [userId, setUserId] = useState("123");
  const [text, setText] = useState("");
  const [ambience, setAmbience] = useState("forest");
  const [autoAnalyze, setAutoAnalyze] = useState(true);

  const [analysis, setAnalysis] = useState(null);
  const [entries, setEntries] = useState([]);
  const [insights, setInsights] = useState(initialInsights);

  const [draftFilters, setDraftFilters] = useState({
    search: "",
    emotion: "",
    ambience: ""
  });
  const [filters, setFilters] = useState({
    search: "",
    emotion: "",
    ambience: ""
  });

  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 8,
    total: 0,
    totalPages: 1,
    hasNext: false,
    hasPrevious: false
  });

  const [loadingEntries, setLoadingEntries] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");

  const totalKeywords = useMemo(() => {
    return insights.topKeywords.reduce((sum, item) => sum + item.count, 0);
  }, [insights.topKeywords]);

  const fetchEntries = useCallback(async (activePage = page, activeFilters = filters) => {
    setLoadingEntries(true);
    setError("");

    try {
      const response = await api.get(`/api/journal/${encodeURIComponent(userId)}`, {
        params: {
          page: activePage,
          limit: 8,
          emotion: activeFilters.emotion || undefined,
          ambience: activeFilters.ambience || undefined,
          search: activeFilters.search || undefined
        }
      });

      const data = response.data || {};
      const items = Array.isArray(data) ? data : data.items || [];
      const pageInfo = data.pagination || {
        page: 1,
        limit: 8,
        total: items.length,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false
      };

      setEntries(items);
      setPagination(pageInfo);
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Failed to load journal entries.");
    } finally {
      setLoadingEntries(false);
    }
  }, [filters, page, userId]);

  const fetchInsights = useCallback(async () => {
    setError("");
    try {
      const response = await api.get(`/api/journal/insights/${encodeURIComponent(userId)}`);
      setInsights({ ...initialInsights, ...(response.data || {}) });
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Failed to load insights.");
    }
  }, [userId]);

  useEffect(() => {
    if (skipNetworkForTests) {
      return;
    }
    fetchEntries(page, filters);
  }, [page, filters, fetchEntries, skipNetworkForTests]);

  useEffect(() => {
    if (skipNetworkForTests) {
      return;
    }
    fetchInsights();
  }, [fetchInsights, skipNetworkForTests]);

  const handleAnalyze = async () => {
    const cleanText = text.trim();
    if (!cleanText) {
      setError("Write something first to analyze.");
      return;
    }

    setAnalyzing(true);
    setError("");

    try {
      const response = await api.post("/api/journal/analyze", { text: cleanText });
      setAnalysis(response.data || null);
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Unable to analyze this text.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSave = async () => {
    const cleanText = text.trim();
    if (!cleanText) {
      setError("Write something before saving.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      if (autoAnalyze) {
        const response = await api.post("/api/journal/analyze-and-save", {
          userId,
          text: cleanText,
          ambience
        });
        setAnalysis(response.data?.analysis || null);
      } else {
        await api.post("/api/journal", {
          userId,
          text: cleanText,
          ambience,
          autoAnalyze: false
        });
      }

      setText("");
      await Promise.all([fetchEntries(1, filters), fetchInsights()]);
      setPage(1);
    } catch (requestError) {
      setError(requestError.response?.data?.error || "Failed to save journal entry.");
    } finally {
      setSaving(false);
    }
  };

  const applyFilters = () => {
    setFilters(draftFilters);
    setPage(1);
  };

  const resetFilters = () => {
    const cleared = { search: "", emotion: "", ambience: "" };
    setDraftFilters(cleared);
    setFilters(cleared);
    setPage(1);
  };

  return (
    <div className="app-shell">
      <div className="aurora" />
      <main className="layout">
        <section className="hero panel reveal-1">
          <div>
            <p className="eyebrow">Journal Studio</p>
            <h1>Advanced Mood Journal</h1>
            <p className="hero-copy">
              Capture daily notes, auto-analyze emotional patterns, and track streaks with smart insights.
            </p>
          </div>
          <div className="identity">
            <label htmlFor="userId">User ID</label>
            <input
              id="userId"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="Enter user id"
            />
          </div>
        </section>

        {error ? (
          <section className="panel error reveal-1">
            <p>{error}</p>
          </section>
        ) : null}

        <section className="panel compose reveal-2">
          <h2>Write Entry</h2>
          <textarea
            placeholder="What happened today?"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />

          <div className="compose-toolbar">
            <label>
              Ambience
              <select value={ambience} onChange={(event) => setAmbience(event.target.value)}>
                {AMBIENCE_OPTIONS.map((item) => (
                  <option value={item} key={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={autoAnalyze}
                onChange={(event) => setAutoAnalyze(event.target.checked)}
              />
              Smart save with AI analysis
            </label>
          </div>

          <div className="action-row">
            <button type="button" className="btn secondary" onClick={handleAnalyze} disabled={analyzing}>
              {analyzing ? "Analyzing..." : "Analyze"}
            </button>
            <button type="button" className="btn primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Entry"}
            </button>
          </div>

          {analysis ? (
            <div className="analysis-card">
              <p>
                <strong>Emotion:</strong> {analysis.emotion || "unknown"}
              </p>
              <p>
                <strong>Summary:</strong> {analysis.summary || "No summary"}
              </p>
              <p>
                <strong>Keywords:</strong> {(analysis.keywords || []).join(", ") || "None"}
              </p>
            </div>
          ) : null}
        </section>

        <section className="panel stats reveal-2">
          <h2>Insights</h2>
          <div className="stats-grid">
            <article>
              <p className="stat-label">Total Entries</p>
              <p className="stat-value">{insights.totalEntries}</p>
            </article>
            <article>
              <p className="stat-label">Top Emotion</p>
              <p className="stat-value">{insights.topEmotion || "-"}</p>
            </article>
            <article>
              <p className="stat-label">Most Used Ambience</p>
              <p className="stat-value">{insights.mostUsedAmbience || "-"}</p>
            </article>
            <article>
              <p className="stat-label">Current Streak</p>
              <p className="stat-value">{insights.currentStreakDays} days</p>
            </article>
            <article>
              <p className="stat-label">Longest Streak</p>
              <p className="stat-value">{insights.longestStreakDays} days</p>
            </article>
            <article>
              <p className="stat-label">Avg. Entry Length</p>
              <p className="stat-value">{insights.averageEntryLength} chars</p>
            </article>
          </div>

          <div className="distribution">
            <div>
              <h3>Emotion Mix</h3>
              {Object.keys(insights.emotionDistribution).length === 0 ? (
                <p className="empty">No data yet.</p>
              ) : (
                Object.entries(insights.emotionDistribution).map(([label, count]) => (
                  <div className="bar-row" key={label}>
                    <span>{label}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill emotion"
                        style={{ width: `${Math.round((count / Math.max(insights.totalEntries, 1)) * 100)}%` }}
                      />
                    </div>
                    <strong>{count}</strong>
                  </div>
                ))
              )}
            </div>

            <div>
              <h3>Top Keywords</h3>
              {insights.topKeywords.length === 0 ? (
                <p className="empty">No keywords yet.</p>
              ) : (
                insights.topKeywords.map((item) => (
                  <div className="bar-row" key={item.keyword}>
                    <span>{item.keyword}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill keyword"
                        style={{ width: `${Math.round((item.count / Math.max(totalKeywords, 1)) * 100)}%` }}
                      />
                    </div>
                    <strong>{item.count}</strong>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="panel reveal-3">
          <div className="entries-header">
            <h2>Entries</h2>
            <p>{pagination.total} records</p>
          </div>

          <div className="filters">
            <input
              placeholder="Search entries"
              value={draftFilters.search}
              onChange={(event) =>
                setDraftFilters((prev) => ({
                  ...prev,
                  search: event.target.value
                }))
              }
            />

            <select
              value={draftFilters.emotion}
              onChange={(event) =>
                setDraftFilters((prev) => ({
                  ...prev,
                  emotion: event.target.value
                }))
              }
            >
              <option value="">All emotions</option>
              {EMOTION_OPTIONS.filter(Boolean).map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>

            <select
              value={draftFilters.ambience}
              onChange={(event) =>
                setDraftFilters((prev) => ({
                  ...prev,
                  ambience: event.target.value
                }))
              }
            >
              <option value="">All ambience</option>
              {AMBIENCE_OPTIONS.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>

            <button className="btn tertiary" type="button" onClick={applyFilters}>
              Apply
            </button>
            <button className="btn ghost" type="button" onClick={resetFilters}>
              Reset
            </button>
          </div>

          {loadingEntries ? (
            <p className="empty">Loading entries...</p>
          ) : entries.length === 0 ? (
            <p className="empty">No entries match the current filters.</p>
          ) : (
            <div className="entry-grid">
              {entries.map((entry) => (
                <article className="entry-card" key={entry._id}>
                  <div className="entry-meta">
                    <span>{entry.emotion || "neutral"}</span>
                    <span>{entry.ambience || "custom"}</span>
                  </div>
                  <p>{entry.text}</p>
                  {entry.summary ? <small>{entry.summary}</small> : null}
                  <time>
                    {new Date(entry.createdAt).toLocaleString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </time>
                </article>
              ))}
            </div>
          )}

          <div className="pager">
            <button
              className="btn ghost"
              type="button"
              disabled={!pagination.hasPrevious}
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            >
              Previous
            </button>
            <p>
              Page {pagination.page} of {pagination.totalPages}
            </p>
            <button
              className="btn ghost"
              type="button"
              disabled={!pagination.hasNext}
              onClick={() => setPage((prev) => prev + 1)}
            >
              Next
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
