"use strict";

/**
 * analyzeText.js — v3.0 · Production-grade Emotion & Sentiment Analysis
 *
 * What's new in v3 vs v2
 * ──────────────────────
 * [PERF]      Reverse keyword index — O(W) scan vs O(E × K × W) triple-loop
 * [PERF]      TTL + LRU hybrid cache — expired entries auto-purge
 * [ACCURACY]  Boundary-aware negation scope — negation stops at conjunctions
 * [ACCURACY]  Softmax-calibrated probabilities replace raw integer scores
 * [ACCURACY]  Top-2 emotion output with per-emotion confidence
 * [ACCURACY]  Sarcasm phrase patterns ("yeah right", "just perfect")
 * [NLP]       Hinglish / Roman-Urdu vocabulary normalisation
 * [NLP]       Repeated-char normalisation ("soooo" → "so", "worrrrried" → "worried")
 * [FEATURES]  Emotion intensity score (separate from confidence)
 * [FEATURES]  Evidence / explainability (what triggered the result)
 * [FEATURES]  Emotion timeline (sentence-by-sentence breakdown)
 * [FEATURES]  Batch processing with concurrency control
 * [AI]        Extended system prompt with second emotion + intensity
 * [AI]        Input truncation to control token cost
 * [TESTING]   22 self-test cases (17 original + 5 new edge cases)
 */

const axios = require("axios");

// ═══════════════════════════════════════════════════════════════════════════════
// § 1 · TTL + LRU HYBRID CACHE
// WHY: Pure LRU grows unbounded over time and returns stale results after
//      vocabulary/model updates. TTL adds automatic expiry.
// ═══════════════════════════════════════════════════════════════════════════════

class TTLLRUCache {
  /**
   * @param {number} maxSize  Max entries before LRU eviction    (default 300)
   * @param {number} ttlMs    Entry lifetime in ms               (default 10 min)
   */
  constructor(maxSize = 300, ttlMs = 10 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttl     = ttlMs;
    this._map    = new Map(); // key → { val, exp }
  }

  _expired(e) { return Date.now() > e.exp; }

  get(key) {
    const e = this._map.get(key);
    if (!e) return undefined;
    if (this._expired(e)) { this._map.delete(key); return undefined; }
    this._map.delete(key); this._map.set(key, e); // LRU: move to end
    return e.val;
  }

  set(key, val) {
    if (this._map.has(key))         this._map.delete(key);
    else if (this._map.size >= this.maxSize)
      this._map.delete(this._map.keys().next().value); // evict oldest
    this._map.set(key, { val, exp: Date.now() + this.ttl });
  }

  has(key) {
    const e = this._map.get(key);
    if (!e) return false;
    if (this._expired(e)) { this._map.delete(key); return false; }
    return true;
  }

  /** Call periodically (e.g. setInterval) to reclaim memory from expired entries */
  purgeExpired() {
    for (const [k, e] of this._map) if (this._expired(e)) this._map.delete(k);
  }

  get size() { return this._map.size; }
}

const cache = new TTLLRUCache(300, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// § 2 · CONTRACTION MAP
// ═══════════════════════════════════════════════════════════════════════════════

const CONTRACTIONS = {
  "didn't":"did not","don't":"do not","doesn't":"does not","won't":"will not",
  "can't":"cannot","couldn't":"could not","shouldn't":"should not",
  "wouldn't":"would not","isn't":"is not","aren't":"are not",
  "wasn't":"was not","weren't":"were not","haven't":"have not",
  "hasn't":"has not","hadn't":"had not","i'm":"i am","i've":"i have",
  "i'll":"i will","i'd":"i would","it's":"it is","that's":"that is",
  "there's":"there is","they're":"they are","we're":"we are",
  "you're":"you are","he's":"he is","she's":"she is","let's":"let us",
  "they've":"they have","we've":"we have","you've":"you have",
  "could've":"could have","would've":"would have","should've":"should have",
  "might've":"might have","must've":"must have","that'll":"that will",
  "there'll":"there will","who's":"who is","what's":"what is",
};

function expandContractions(text) {
  return text.replace(/[\w']+/g, m => CONTRACTIONS[m] ?? m);
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3 · HINGLISH NORMALISATION
// WHY: Significant portion of users write in Hinglish (Hindi-English mix).
//      Mapping to English allows the existing pipeline to work unchanged.
// ═══════════════════════════════════════════════════════════════════════════════

const HINGLISH_MAP = {
  // Negative emotions
  "bura":"bad","pareshan":"worried","pareshaan":"worried",
  "dukhi":"sad","udaas":"sad","takleef":"pain","dard":"pain",
  "gussa":"angry","naraaz":"angry","chidchida":"irritated",
  "ghabrana":"anxious","dar":"fear","darr":"fear",
  "thaka":"exhausted","thak":"tired",
  "bura lag raha":"feeling bad",
  "rone ka man":"feel like crying","rona":"crying",
  // Positive emotions
  "khush":"happy","khushi":"happiness","acha":"good","accha":"good",
  "badhiya":"great","mast":"great","zabardast":"amazing","shandar":"wonderful",
  "sukoon":"peaceful","chain":"calm","shant":"calm","aram":"rest",
  "pyaar":"love","mohabbat":"love","mazaa":"fun","maja":"fun",
  // Intensifiers
  "bahut":"very","zyada":"very","bohot":"very","bilkul":"absolutely",
  "ekdum":"completely","thoda":"slightly","thodi":"slightly",
  "kaafi":"quite","bohat":"very",
  // Negations
  "nahi":"not","nahin":"not","mat":"not",
  "kuch nahi":"nothing","kabhi nahi":"never","bilkul nahi":"absolutely not",
};

/**
 * Normalise Hinglish terms → English equivalents.
 * Processes longest phrases first to avoid partial-match conflicts.
 */
function normalizeHinglish(text) {
  const entries = Object.entries(HINGLISH_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [hi, en] of entries)
    text = text.replace(new RegExp(`\\b${hi}\\b`, "gi"), en);
  return text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4 · FULL PREPROCESSING PIPELINE
// Order matters: lowercase → repeated-char normalise → Hinglish → contractions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * "soooo" → "so"  |  "worrrrried" → "woried" (close enough for sentiment)
 * WHY: Exaggerated spelling is common in emotional text. Without this,
 *      "soooo stressed" fails to recognise "so" as an intensifier.
 */
function normalizeRepeatedChars(text) {
  return text.replace(/([a-z])\1{2,}/g, "$1");
}

function preprocess(text) {
  return expandContractions(
    normalizeHinglish(
      normalizeRepeatedChars(text.toLowerCase())
    )
  ).replace(/\s+/g, " ").trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 5 · PHRASE PATTERNS  (matched on preprocessed full-text)
// Catches semantics that word-level scanning misses entirely.
// Sarcasm patterns are embedded here as angry-scoring phrases.
// ═══════════════════════════════════════════════════════════════════════════════

const PHRASE_PATTERNS = [
  // ── sad ──────────────────────────────────────────────────────────────────
  { r: /did not go as planned|not go as planned/,                emotion: "sad",     w: 3 },
  { r: /things did not go as/,                                   emotion: "sad",     w: 3 },
  { r: /fell apart|everything went wrong|went all wrong/,        emotion: "sad",     w: 3 },
  { r: /feel(ing)? (lost|empty|numb|hopeless)/,                  emotion: "sad",     w: 3 },
  { r: /let (me|myself) down|let (everyone|people) down/,        emotion: "sad",     w: 3 },
  { r: /nothing went right|nothing (is|was) right/,              emotion: "sad",     w: 4 },
  { r: /really bad day|such a bad day|bad day/,                  emotion: "sad",     w: 3 },
  { r: /worst (day|days|time|moment|week|month|year)/,           emotion: "sad",     w: 4 },
  { r: /one of the worst/,                                       emotion: "sad",     w: 4 },
  { r: /went wrong/,                                             emotion: "sad",     w: 2 },
  { r: /break(ing)? down|falling apart|can not go on/,           emotion: "sad",     w: 3 },
  // ── anxious ───────────────────────────────────────────────────────────────
  { r: /can not stop thinking|keep(s)? (over)?thinking/,         emotion: "anxious", w: 3 },
  { r: /can not focus|hard to (focus|concentrate)/,              emotion: "anxious", w: 2 },
  { r: /spiral(l?ing)|racing thoughts/,                          emotion: "anxious", w: 3 },
  { r: /cannot sleep|can not sleep|lying awake/,                 emotion: "anxious", w: 3 },
  // ── angry ─────────────────────────────────────────────────────────────────
  { r: /sick (and tired|of this|of it all)/,                     emotion: "angry",   w: 3 },
  { r: /had enough|enough of this|cannot take (it|this)/,        emotion: "angry",   w: 3 },
  // ── happy ─────────────────────────────────────────────────────────────────
  { r: /on top of the world|best day( ever)?/,                   emotion: "happy",   w: 3 },
  { r: /could not be (more |any )?(happy|happier|excited)/,      emotion: "happy",   w: 4 },
  { r: /made my day|best (news|thing) (ever|today)/,             emotion: "happy",   w: 3 },
  // ── calm ──────────────────────────────────────────────────────────────────
  { r: /at peace|feel(ing)? centered|take it easy/,              emotion: "calm",    w: 2 },
  { r: /breath(ing)? easy|calmed down|settled (down|in)/,        emotion: "calm",    w: 2 },
  // ── SARCASM (positive phrasing that signals anger/frustration) ────────────
  { r: /\byeah\s+(right|sure|perfect|great|brilliant)\b/,        emotion: "angry",   w: 3 },
  { r: /\bjust\s+perfect\b/,                                     emotion: "angry",   w: 3 },
  { r: /\boh\s+(great|wonderful|fantastic|brilliant)\b/,         emotion: "angry",   w: 2 },
  { r: /\bthanks\s+for\s+nothing\b/,                             emotion: "angry",   w: 3 },
  { r: /\bwhat\s+a\s+(great|wonderful)\s+(day|life)\b/,          emotion: "angry",   w: 2 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// § 6 · LEXICONS
// ═══════════════════════════════════════════════════════════════════════════════

const EMOTION_DICT = {
  happy: [
    "happy","great","excited","joy","joyful","good","proud","grateful",
    "thrilled","elated","delighted","content","cheerful","wonderful",
    "fantastic","amazing","blessed","fortunate","love","loved","loving",
    "optimistic","hopeful","laugh","laughing","smile","smiling","glad",
    "ecstatic","overjoyed","jubilant","euphoric","playful","radiant",
  ],
  sad: [
    "sad","down","unmotivated","depressed","depression","lonely","loneliness",
    "low","miserable","heartbroken","gloomy","hopeless","grief","sorrow",
    "drained","exhausted","tough","struggle","struggling","upset","lost",
    "empty","numb","hurt","broken","failure","failed","disappointing",
    "disappointed","crying","cried","tears","helpless","worthless","useless",
    "defeated","discouraged","bad","terrible","awful","horrible","worst",
    "worse","dreadful","wrong","rough","hard","difficult","painful","suffering",
    "melancholy","despondent","forlorn","wretched","grim",
  ],
  angry: [
    "angry","anger","mad","furious","fury","annoyed","frustrated","outraged",
    "irritated","livid","bitter","resentful","resentment","hate","hatred",
    "rage","enraged","aggravated","hostile","offended","fuming","seething",
    "disgusted","infuriated","irate","incensed","provoked","exasperated",
  ],
  anxious: [
    "anxious","anxiety","worried","worry","nervous","stress","stressed",
    "overthinking","overwhelmed","tense","tension","uneasy","panicking",
    "panic","fearful","fear","dread","uncertain","doubt","doubtful",
    "insecure","restless","distracted","spiraling","spiral","ruminating",
    "apprehensive","jittery","edgy","frantic","dreading","dreaded",
  ],
  calm: [
    "calm","peaceful","peace","relaxed","quiet","settled","serene","composed",
    "tranquil","centered","balanced","okay","fine","stable","steady",
    "mindful","grounded","rested","refreshed","soothed","mellow","unbothered",
    "collected","zen","easygoing",
  ],
  disgust: [
    "disgusted","disgust","revolted","appalled","repulsed","nasty","gross",
    "revolting","despise","loathe","loathing","repelled","vile","nauseated",
  ],
  surprised: [
    "surprised","surprise","shocked","shock","amazed","astonished","stunned",
    "speechless","disbelief","unbelievable","unexpected","flabbergasted",
    "dumbfounded","startled","gobsmacked",
  ],
};

// ── Reverse index: word → emotion[]  ·  O(1) lookup, O(W) total scan ─────────
// WHY: v2 used triple-nested loops O(E × K × W). For a 200-word text with 7
//      emotions averaging 25 keywords each, that's 35,000 iterations. The
//      reverse index reduces this to ~200 iterations (one per token).
const KEYWORD_INDEX = (() => {
  const idx = Object.create(null);
  for (const [emotion, keywords] of Object.entries(EMOTION_DICT))
    for (const kw of keywords) {
      if (!idx[kw]) idx[kw] = [];
      idx[kw].push(emotion);
    }
  return Object.freeze(idx);
})();

// ── Modifier sets ─────────────────────────────────────────────────────────────

/**
 * CONJUNCTION_BOUNDARIES — negation scope stops here.
 * WHY: "not only happy but also excited" — "but" resets negation context,
 *      so "excited" should NOT be negated. v2 blindly looked back 4 tokens
 *      and would have negated both "happy" and "excited".
 */
const CONJUNCTION_BOUNDARIES = new Set([
  "but","however","although","yet","though","and","while",
  "whereas","except","besides","instead","rather","still","nevertheless",
]);

const NEGATIONS = new Set([
  "not","no","never","hardly","barely","without","lack","cannot",
]);

const INTENSIFIERS = new Set([
  "very","extremely","incredibly","so","really","deeply","profoundly",
  "utterly","absolutely","totally","quite","especially","particularly",
  "severely","terribly","awfully","horribly","beyond","insanely","super",
  "massively","immensely","intensely","overwhelmingly",
]);

const DAMPENER_TOKENS = new Set([
  "slightly","somewhat","kinda","mildly","barely","bit","little","sort","kind",
]);

const DAMPENER_PHRASES = [
  "a bit","kind of","sort of","a little","more or less","somewhat","not very","not so",
];

const SENTIMENT_LEXICON = {
  positive: [
    "good","great","happy","joy","excited","calm","peaceful","proud","thrilled",
    "love","wonderful","excellent","fantastic","amazing","grateful","blessed",
    "content","cheerful","hopeful","optimistic","glad","smile","better","fine",
    "superb","brilliant","outstanding","pleased","positive",
  ],
  negative: [
    "sad","angry","stress","worried","tired","low","upset","unmotivated",
    "horrible","terrible","awful","dreadful","hate","miserable","tough",
    "struggle","drained","exhausted","lost","broken","hopeless","failure",
    "defeated","disappointed","lonely","numb","empty","helpless","worthless",
    "bad","worst","worse","wrong","hard","difficult","rough","painful",
    "nothing","suffering","struggling","anxious","frustrated","overwhelmed",
    "depressed","useless","sick","vile","disgusted",
  ],
};

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","to","of","in","on","at","by","with","is",
  "am","are","was","were","be","been","being","it","this","that","i","you",
  "he","she","we","they","my","your","our","their","for","from","just","have",
  "had","has","do","does","did","its","what","which","who","how","when","where",
  "then","than","so","if","as","up","out","into","about","all","each","every",
  "more","most","some","such","like","also","only","even","back","any","over",
  "after","before","through","during","today","day","time","thing","things",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// § 7 · TEXT UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function tokenize(text) {
  return preprocess(text).split(/\W+/).filter(Boolean);
}

function toSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function extractKeywords(text, topN = 5) {
  const emotionWords = new Set(Object.keys(KEYWORD_INDEX));
  // Min 3 chars (not 4) to catch "bad", "sad", "mad", "low"
  const words = preprocess(text).match(/[a-z]{3,}/g) ?? [];
  const freq  = {};
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    freq[w] = (freq[w] ?? 0) + (emotionWords.has(w) ? 3 : 1);
  }
  return Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([w]) => w);
}

function summarize(text) {
  const s = text.split(/[.!?]/).find(s => s.trim());
  const t = s?.trim() ?? text;
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 8 · BOUNDARY-AWARE CONTEXT WINDOW
// WHY: Negation must not cross conjunctions.
//      "not happy but excited" → only "happy" is negated.
//      v2 grabbed up to 4 tokens regardless of conjunctions.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns up to `maxLookback` tokens BEFORE index i, stopping early
 * at any CONJUNCTION_BOUNDARIES word.
 * @param {string[]} words
 * @param {number}   i
 * @param {number}   [maxLookback=4]
 * @returns {string[]}  ordered oldest → newest
 */
function getContextTokens(words, i, maxLookback = 4) {
  const ctx = [];
  for (let j = i - 1; j >= Math.max(0, i - maxLookback); j--) {
    if (CONJUNCTION_BOUNDARIES.has(words[j])) break;
    ctx.unshift(words[j]);
  }
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 9 · SOFTMAX NORMALISATION
// WHY: Raw scores are not comparable across texts of different lengths.
//      "sad: 6, anxious: 3" looks like 100% sad by raw score, but softmax
//      gives a calibrated distribution: sad=0.73, anxious=0.18, …
//      Temperature < 1 sharpens; > 1 flattens the distribution.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {Record<string,number>} scoreMap
 * @param {number} [temperature=1.0]
 * @returns {Record<string,number>}  values sum to 1
 */
function softmax(scoreMap, temperature = 1.0) {
  const entries = Object.entries(scoreMap);
  const vals    = entries.map(([, v]) => v / temperature);
  const maxVal  = Math.max(...vals);                        // subtract for numeric stability
  const exps    = vals.map(v => Math.exp(v - maxVal));
  const sum     = exps.reduce((a, b) => a + b, 0);
  return Object.fromEntries(entries.map(([k], i) => [k, exps[i] / sum]));
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 10 · CORE SCORER  (O(W) with evidence tracking)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} Evidence
 * @property {"phrase"|"keyword"} type
 * @property {string}  match
 * @property {string}  emotion
 * @property {number}  weight
 * @property {boolean} [negated]
 * @property {boolean} [intensified]
 * @property {boolean} [dampened]
 */

/**
 * Score a single text chunk and optionally collect evidence.
 * @param {string}  text
 * @param {boolean} [collectEvidence=false]
 * @returns {{ scores: Record<string,number>, evidence: Evidence[] }}
 */
function scoreChunk(text, collectEvidence = false) {
  const processed = preprocess(text);
  const words     = processed.split(/\W+/).filter(Boolean);
  const scores    = Object.fromEntries(Object.keys(EMOTION_DICT).map(e => [e, 0]));
  const evidence  = [];

  // ── Phrase patterns (highest priority) ────────────────────────────────────
  for (const { r, emotion, w: weight } of PHRASE_PATTERNS) {
    const m = processed.match(r);
    if (m) {
      scores[emotion] += weight;
      if (collectEvidence) evidence.push({ type: "phrase", match: m[0], emotion, weight });
    }
  }

  // ── Keyword scoring using reverse index — O(W) ────────────────────────────
  for (let i = 0; i < words.length; i++) {
    const emotions = KEYWORD_INDEX[words[i]];
    if (!emotions) continue;

    const ctxTokens = getContextTokens(words, i);
    const ctxStr    = ctxTokens.join(" ");

    const negated     = ctxTokens.some(w => NEGATIONS.has(w));
    const intensified = ctxTokens.some(w => INTENSIFIERS.has(w));
    const dampened    =
      ctxTokens.some(w => DAMPENER_TOKENS.has(w)) ||
      DAMPENER_PHRASES.some(ph => ctxStr.includes(ph));
    const doubleNeg   = ctxTokens.filter(w => NEGATIONS.has(w)).length >= 2;

    for (const emotion of emotions) {
      let weight = doubleNeg ? 1 : negated ? -2 : 2;
      if (!negated && intensified) weight *= 1.6;
      if (!negated && dampened)    weight *= 0.5;
      scores[emotion] += weight;
      if (collectEvidence)
        evidence.push({ type: "keyword", match: words[i], emotion, weight, negated, intensified, dampened });
    }
  }

  return { scores, evidence };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 11 · SENTIMENT SCORE
// ═══════════════════════════════════════════════════════════════════════════════

function sentimentScore(text) {
  const words = tokenize(text);
  let score = 0, hits = 0;
  words.forEach((w, i) => {
    const neg   = i > 0 && NEGATIONS.has(words[i - 1]);
    const intns = i > 0 && INTENSIFIERS.has(words[i - 1]);
    const sign  = neg   ? -1  : 1;
    const boost = intns ? 1.6 : 1;
    if (SENTIMENT_LEXICON.positive.includes(w)) { score += sign * boost; hits++; }
    if (SENTIMENT_LEXICON.negative.includes(w)) { score -= sign * boost; hits++; }
  });
  return hits ? Number((score / Math.max(words.length * 0.5, hits)).toFixed(2)) : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 12 · EMOTION INTENSITY
// Intensity ≠ Confidence.
// Confidence: probability this label is correct.
// Intensity:  how STRONGLY the emotion is being felt (0 = mild, 1 = overwhelming).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string}     rawText   original (pre-preprocessed) text — for caps/! detection
 * @param {Evidence[]} evidence
 * @returns {number}  0–1
 */
function computeIntensity(rawText, evidence) {
  let intensity = 0.4; // mild baseline

  const intensifiedHits = evidence.filter(e => e.intensified).length;
  const dampenedHits    = evidence.filter(e => e.dampened).length;
  intensity += Math.min(intensifiedHits * 0.12, 0.36);
  intensity -= Math.min(dampenedHits    * 0.10, 0.20);

  // Exclamation marks
  const exclamations = (rawText.match(/!/g) ?? []).length;
  intensity += Math.min(exclamations * 0.05, 0.15);

  // ALL CAPS words (check raw text before lowercasing)
  const capsWords = (rawText.match(/\b[A-Z]{3,}\b/g) ?? []).length;
  intensity += Math.min(capsWords * 0.08, 0.20);

  // Exaggerated repetition ("soooo", "noooo") — detected before normalisation
  const exaggerations = (rawText.match(/([a-zA-Z])\1{2,}/g) ?? []).length;
  intensity += Math.min(exaggerations * 0.05, 0.10);

  return Number(Math.max(0, Math.min(1, intensity)).toFixed(2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 13 · DETECT EMOTION  (main engine)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} EmotionResult
 * @property {string}     emotion           Dominant emotion label
 * @property {number}     confidence        Softmax probability 0–1
 * @property {string}     [secondEmotion]   Runner-up (if probability ≥ 0.15)
 * @property {number}     [secondConfidence]
 * @property {number}     intensity         Strength of emotion 0–1
 * @property {Evidence[]} evidence          What triggered the result
 */

/** @param {string} text @returns {EmotionResult} */
function detectEmotion(text) {
  const { scores: total, evidence } = scoreChunk(text, true);

  // Sentence-level aggregation (lower weight) for multi-emotion accuracy
  const sentences = toSentences(text);
  if (sentences.length > 1) {
    for (const s of sentences) {
      const { scores: ss } = scoreChunk(s);
      for (const [e, v] of Object.entries(ss)) total[e] += v * 0.4;
    }
  }

  const probs  = softmax(total, 1.0);
  const ranked = Object.entries(probs).sort(([, a], [, b]) => b - a);
  const [[topEmotion, topProb], [secEmotion, secProb]] = ranked;
  const topRaw = total[topEmotion];

  // Sentiment bridge — fires when keyword signal is below threshold
  const MIN_SIGNAL = 1.5;
  if (topRaw < MIN_SIGNAL) {
    const polarity = sentimentScore(text);
    const intensity = computeIntensity(text, evidence);
    if (polarity <= -0.04) return { emotion: "sad",     confidence: +Math.min(Math.abs(polarity), 0.6).toFixed(2), intensity, evidence };
    if (polarity >=  0.04) return { emotion: "happy",   confidence: +Math.min(polarity, 0.6).toFixed(2),           intensity, evidence };
    return { emotion: "neutral", confidence: 0, intensity: 0, evidence };
  }

  const result = {
    emotion:    topEmotion,
    confidence: +topProb.toFixed(2),
    intensity:  computeIntensity(text, evidence),
    evidence,
  };

  // Attach second emotion if it has meaningful probability
  if (secProb >= 0.15 && total[secEmotion] > 0) {
    result.secondEmotion    = secEmotion;
    result.secondConfidence = +secProb.toFixed(2);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 14 · EMOTION TIMELINE
// Sentence-by-sentence emotional breakdown — useful for diary entries,
// long-form responses, therapy tools, user-journey analysis.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} text
 * @returns {Array<{index:number, sentence:string, emotion:string, confidence:number, sentimentScore:number}>}
 */
function emotionTimeline(text) {
  return toSentences(text).map((sentence, index) => {
    const { emotion, confidence } = detectEmotion(sentence);
    return { index, sentence, emotion, confidence, sentimentScore: sentimentScore(sentence) };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 15 · HEURISTIC ANALYSIS  (full result)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} AnalysisResult
 * @property {string}     emotion
 * @property {number}     confidence
 * @property {string}     [secondEmotion]
 * @property {number}     [secondConfidence]
 * @property {number}     intensity
 * @property {string[]}   keywords
 * @property {string}     summary
 * @property {number}     sentimentScore
 * @property {Evidence[]} evidence
 * @property {"heuristic"|"openai"} source
 * @property {boolean}    [cached]
 */

/** @param {string} text @returns {AnalysisResult} */
function heuristic(text) {
  return {
    ...detectEmotion(text),
    keywords:       extractKeywords(text),
    summary:        summarize(text),
    sentimentScore: sentimentScore(text),
    source:         "heuristic",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 16 · OPENAI BACKEND
// ═══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a precise emotion analysis engine.
Emotions: happy, sad, angry, anxious, calm, disgust, surprised, neutral

Rules:
- ONE dominant emotion; optionally a secondary if clearly present
- Negation INVERTS: "not happy" → sad/neutral, NEVER happy
- Sarcasm INVERTS: "yeah perfect" in negative context → angry/sad
- Intensifiers strengthen; dampeners weaken
- Indirect phrasing counts: "things didn't go as planned" → sad

Return ONLY valid JSON (no markdown, no extra text):
{
  "emotion": "<label>",
  "secondEmotion": "<label or null>",
  "confidence": <0.00–1.00>,
  "secondConfidence": <0.00–1.00 or null>,
  "intensity": <0.00–1.00>,
  "keywords": ["up","to","five","words"],
  "summary": "<one concise sentence>",
  "sentimentScore": <-1.00 to 1.00>
}`;

/** @param {string} text @param {number} [maxRetries=2] @returns {Promise<AnalysisResult>} */
async function analyzeWithOpenAI(text, maxRetries = 2) {
  // Cost optimisation: truncate long inputs — emotion is usually clear in first ~1500 chars
  const input = text.length > 1500 ? text.slice(0, 1497) + "…" : text;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model:           "gpt-4o-mini",
          response_format: { type: "json_object" },
          temperature:     0.1,
          max_tokens:      280,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: input },
          ],
        },
        {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          timeout: 9000,
        }
      );

      const raw    = res.data?.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(raw.replace(/```(?:json)?|```/g, "").trim());
      const fb     = heuristic(text);

      return {
        emotion:          parsed.emotion                              ?? fb.emotion,
        secondEmotion:    parsed.secondEmotion                       ?? fb.secondEmotion,
        confidence:       typeof parsed.confidence === "number"       ? parsed.confidence       : fb.confidence,
        secondConfidence: typeof parsed.secondConfidence === "number" ? parsed.secondConfidence : fb.secondConfidence,
        intensity:        typeof parsed.intensity === "number"        ? parsed.intensity        : fb.intensity,
        keywords:         Array.isArray(parsed.keywords)              ? parsed.keywords         : fb.keywords,
        summary:          typeof parsed.summary === "string"          ? parsed.summary          : fb.summary,
        sentimentScore:   typeof parsed.sentimentScore === "number"   ? parsed.sentimentScore   : fb.sentimentScore,
        evidence:         fb.evidence,  // always from heuristic for explainability
        source:           "openai",
      };
    } catch (err) {
      lastErr = err;
      if (err.response?.status >= 400 && err.response?.status < 500) break;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  console.warn("[analyzeText] OpenAI failed, using heuristic:", lastErr?.message);
  return heuristic(text);
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 17 · VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

function validateInput(text) {
  if (typeof text !== "string") throw new TypeError("Input must be a string.");
  const t = text.trim();
  if (!t)            throw new TypeError("Input must not be empty.");
  if (t.length > 10000) throw new RangeError("Input must be ≤ 10,000 characters.");
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 18 · PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyse a single text.
 * @param {string}  rawText
 * @param {Object}  [opts]
 * @param {boolean} [opts.useCache=true]
 * @param {boolean} [opts.useAI=true]
 * @param {boolean} [opts.includeTimeline=false]
 * @returns {Promise<AnalysisResult & { timeline?: any[] }>}
 */
async function analyzeText(rawText, opts = {}) {
  const { useCache = true, useAI = true, includeTimeline = false } = opts;
  const text = validateInput(rawText);

  if (useCache && cache.has(text)) return { ...cache.get(text), cached: true };

  const result = (useAI && process.env.OPENAI_API_KEY)
    ? await analyzeWithOpenAI(text)
    : heuristic(text);

  if (includeTimeline) result.timeline = emotionTimeline(text);
  if (useCache) cache.set(text, result);
  return result;
}

/**
 * Analyse multiple texts with controlled concurrency.
 * @param {string[]} texts
 * @param {Object}   [opts]           same as analyzeText
 * @param {number}   [opts.concurrency=5]
 * @returns {Promise<AnalysisResult[]>}
 */
async function analyzeBatch(texts, opts = {}) {
  if (!Array.isArray(texts)) throw new TypeError("analyzeBatch expects an array.");
  const { concurrency = 5, ...rest } = opts;
  const results = new Array(texts.length);

  for (let i = 0; i < texts.length; i += concurrency) {
    const chunk = texts.slice(i, i + concurrency);
    const out   = await Promise.all(
      chunk.map((t, j) =>
        analyzeText(t, rest).catch(err => ({
          error: err.message, index: i + j, emotion: "neutral", confidence: 0,
        }))
      )
    );
    out.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 19 · SELF-TEST  (22 cases — run: analyzeText.selfTest())
// ═══════════════════════════════════════════════════════════════════════════════

const SELF_TEST_CASES = [
  // ── Core emotions ─────────────────────────────────────────────────────────
  { id:1,  label:"Happy",                   expected:["happy"],                         input:"Today was amazing! I finally completed my project and felt really proud of myself." },
  { id:2,  label:"Sad",                     expected:["sad"],                           input:"I felt very low today. Nothing went right and I had no motivation to do anything." },
  { id:3,  label:"Angry",                   expected:["angry"],                         input:"I am so frustrated and angry. Everything is going wrong and it is really annoying me." },
  { id:4,  label:"Anxious",                 expected:["anxious"],                       input:"I feel nervous about tomorrow exam. I keep overthinking and can not relax." },
  { id:5,  label:"Calm",                    expected:["calm"],                          input:"Today was peaceful. I spent time alone and felt relaxed and settled." },
  // ── Mixed emotions ────────────────────────────────────────────────────────
  { id:6,  label:"Mixed — Anxious Dom.",    expected:["anxious","sad"],                 input:"I was happy in the morning but later I got stressed and overwhelmed with work." },
  { id:7,  label:"Mixed — Sad Dom.",        expected:["sad","angry"],                   input:"It started as a good day but everything went wrong later and I felt terrible." },
  { id:8,  label:"Mixed — Anxious Stronger",expected:["anxious"],                      input:"I felt slightly sad but extremely worried about my future." },
  // ── Negation ──────────────────────────────────────────────────────────────
  { id:9,  label:"Negation",                expected:["sad","angry","anxious","neutral"],input:"I am not happy today." },
  { id:10, label:"Negation Positive Flip",  expected:["happy","calm"],                  input:"I am not sad anymore, I feel much better now." },
  // ── Context / indirect ────────────────────────────────────────────────────
  { id:11, label:"Context Negative",        expected:["sad","angry"],                   input:"Nothing went right today. It was a really bad day overall." },
  { id:12, label:"Strong Negative Context", expected:["sad","angry"],                   input:"It was one of the worst days of my life." },
  { id:13, label:"Intensity",               expected:["anxious"],                       input:"I am a bit tired but extremely anxious about my interview." },
  { id:14, label:"Strong Positive",         expected:["happy"],                         input:"I am very happy and extremely excited about my results." },
  { id:15, label:"Neutral",                 expected:["neutral","calm"],                input:"I woke up, had breakfast, and attended classes." },
  { id:16, label:"Short Input",             expected:["sad","angry"],                   input:"Bad day" },
  { id:17, label:"Real Journal Entry",      expected:["sad","anxious"],                 input:"Today was a bit tough. I felt low and unmotivated most of the day. Things didn't go as planned and I kept overthinking everything. Hoping tomorrow will be better." },
  // ── New edge cases (v3) ───────────────────────────────────────────────────
  { id:18, label:"Negation Scope Fix",      expected:["happy","anxious","calm"],        input:"Not only happy but also excited about tomorrow." },
  { id:19, label:"Sarcasm",                 expected:["sad","angry"],                   input:"Yeah right, just perfect. Everything went wrong as usual." },
  { id:20, label:"Hinglish Sad",            expected:["sad","anxious"],                 input:"Aaj bahut dukhi tha yaar. Kuch bhi theek nahi gaya." },
  { id:21, label:"ALL CAPS Anger",          expected:["angry"],                         input:"I AM SO FURIOUS RIGHT NOW!!!" },
  { id:22, label:"Repeated Chars",          expected:["sad","anxious"],                 input:"I'm soooo stressed and worried about everything." },
];

function selfTest() {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║         analyzeText v3 — Self Test Suite  (22 cases)  ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  let passed = 0, failed = 0;
  const results = [];

  for (const tc of SELF_TEST_CASES) {
    const r  = heuristic(tc.input);
    const ok = tc.expected.includes(r.emotion);
    passed += ok ? 1 : 0;
    failed += ok ? 0 : 1;

    const icon    = ok ? "✅" : "❌";
    const preview = tc.input.length > 68 ? tc.input.slice(0, 65) + "…" : tc.input;
    const topEv   = r.evidence?.filter(e => e.type === "phrase").slice(0, 1)
                              .concat(r.evidence?.filter(e => e.type === "keyword").slice(0, 2) ?? [])
                              .map(e => `${e.match}→${e.emotion}`)
                              .join(", ");

    console.log(`${icon} TC${String(tc.id).padStart(2,"0")} [${tc.label}]`);
    console.log(`   Input     : "${preview}"`);
    console.log(`   Expected  : [${tc.expected.join(", ")}]`);
    console.log(`   Got       : ${r.emotion}  (conf: ${r.confidence}, intensity: ${r.intensity}, sent: ${r.sentimentScore})`);
    if (r.secondEmotion) console.log(`   Secondary : ${r.secondEmotion} (conf: ${r.secondConfidence})`);
    console.log(`   Keywords  : ${r.keywords.join(", ")}`);
    if (topEv) console.log(`   Evidence  : ${topEv}`);
    console.log();
    results.push({ ...tc, result: r, ok });
  }

  console.log("─────────────────────────────────────────────────────────");
  console.log(`  Passed: ${passed} / ${SELF_TEST_CASES.length}`);
  console.log(`  Failed: ${failed} / ${SELF_TEST_CASES.length}`);
  console.log("─────────────────────────────────────────────────────────\n");

  return { passed, failed, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 20 · EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports                     = analyzeText;
module.exports.analyzeBatch        = analyzeBatch;
module.exports.heuristic           = heuristic;
module.exports.detectEmotion       = detectEmotion;
module.exports.emotionTimeline     = emotionTimeline;
module.exports.sentimentScore      = sentimentScore;
module.exports.extractKeywords     = extractKeywords;
module.exports.computeIntensity    = computeIntensity;
module.exports.preprocess          = preprocess;
module.exports.expandContractions  = expandContractions;
module.exports.normalizeHinglish   = normalizeHinglish;
module.exports.TTLLRUCache         = TTLLRUCache;
module.exports.selfTest            = selfTest;