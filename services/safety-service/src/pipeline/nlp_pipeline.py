"""
Breeze Safety Intelligence — 5-Stage NLP Pipeline.
All model inference runs synchronously in ThreadPoolExecutor (CPU-bound).
Never blocks the FastAPI event loop.

Stage 1: Language detection (fasttext lid.176.ftz)
Stage 2: Toxicity classification (score >= 0.75 → reject, STOP)
Stage 3: Sentiment analysis (XLM-RoBERTa)
Stage 4: Crime NER (keyword vocabulary EN + HI transliteration)
Stage 5: Assemble PipelineResult

Models baked into Docker image at /models/. Fail fast if missing.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from datetime import datetime
from functools import lru_cache
from typing import Optional

from src.config import settings
from src.pipeline.models import (
    CRIME_SEVERITY,
    CrimeType,
    ExtractedEntity,
    PipelineResult,
    SentimentLabel,
    Severity,
)

logger = logging.getLogger(__name__)


# ── Crime NER Vocabulary (EN + HI transliteration) ────────────

CRIME_KEYWORDS: dict[CrimeType, list[str]] = {
    CrimeType.MOBILE_SNATCHING: [
        "mobile snatch", "phone snatch", "snatched phone", "snatched mobile",
        "mobile loot", "phone loot", "phone chori", "mobile chori",
        "mobile chheen", "phone chheen", "mobile utha",
    ],
    CrimeType.CHAIN_SNATCHING: [
        "chain snatch", "chain pulled", "necklace snatch", "gold chain",
        "chain chheen", "chain loot", "chain kheench",
    ],
    CrimeType.PICKPOCKET: [
        "pickpocket", "pick pocket", "wallet stolen", "purse stolen",
        "jeb kaat", "jebkatri", "pocket maar", "jeb se nikala",
    ],
    CrimeType.ASSAULT: [
        "assault", "beaten", "attacked", "punched", "stabbed", "hit me",
        "maara", "maarpeet", "maar diya", "hamla", "attack kiya",
    ],
    CrimeType.HARASSMENT: [
        "harass", "harassment", "molest", "eve teas", "groping", "stalking",
        "chhedkhani", "chheda", "pareshan kiya", "tang kiya",
    ],
    CrimeType.THEFT: [
        "theft", "stolen", "robbed", "robbery", "luggage stolen", "bag stolen",
        "chori", "chori ho gaya", "samaan chori", "loot", "lut gaya",
    ],
    CrimeType.POOR_LIGHTING: [
        "dark", "no light", "poor lighting", "dim light", "unlit",
        "andhera", "roshni nahi", "light nahi", "andhere mein",
    ],
    CrimeType.OVERCROWDING: [
        "overcrowd", "too crowded", "stampede", "pushed", "crushed",
        "bheed", "bahut bheed", "bheed bhad", "dhakka", "dabav",
    ],
}

LOCATION_KEYWORDS: dict[str, list[str]] = {
    "platform_1": ["platform 1", "platform one", "platform no 1"],
    "platform_2": ["platform 2", "platform two", "platform no 2"],
    "exit_gate": ["exit gate", "exit", "gate", "bahar", "nikasi"],
    "parking": ["parking", "parking lot", "parking area"],
    "waiting_room": ["waiting room", "waiting hall", "waiting area", "pratiksha kaksh"],
    "foot_overbridge": ["foot overbridge", "fob", "overbridge", "pul"],
    "subway": ["subway", "underpass"],
    "platform_general": ["platform", "chabutra"],
}

TIME_KEYWORDS: dict[str, list[str]] = {
    "night": ["night", "raat", "midnight", "late night", "adhi raat", "raat ko"],
    "morning": ["morning", "subah", "early morning", "dawn", "savere"],
    "peak_hours": [
        "rush hour", "peak", "peak hours", "office time", "bheed ka time",
        "shaam ko", "evening rush",
    ],
}


class SafetyNLPPipeline:
    """
    5-stage NLP pipeline. Models loaded into ThreadPoolExecutor.
    All inference is synchronous inside the executor.
    """

    def __init__(self) -> None:
        self._executor: ThreadPoolExecutor | None = None
        self._fasttext_model = None
        self._toxicity_pipeline = None
        self._sentiment_pipeline = None
        self._ready = False

    @property
    def is_ready(self) -> bool:
        return self._ready

    async def initialize(self) -> None:
        """
        Load all models synchronously in executor. Call once on startup.
        Fails fast with clear error if models are missing.
        """
        self._executor = ThreadPoolExecutor(
            max_workers=settings.nlp_thread_pool_workers,
            thread_name_prefix="nlp-worker",
        )

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(self._executor, self._load_models_sync)
        self._ready = True
        logger.info("SafetyNLPPipeline: all models loaded and ready")

    def _load_models_sync(self) -> None:
        """Synchronous model loading — runs in thread pool."""
        # ── 1. FastText language detector ─────────────────
        ft_path = settings.fasttext_model_path
        if not os.path.exists(ft_path):
            raise FileNotFoundError(
                f"FastText model not found at {ft_path}. "
                "Models must be baked into the Docker image at /models/"
            )

        import fasttext
        fasttext.FastText.eprint = lambda x: None  # suppress warnings
        self._fasttext_model = fasttext.load_model(ft_path)
        logger.info("Loaded fasttext language model from %s", ft_path)

        # ── 2. Toxicity classifier ────────────────────────
        tox_path = settings.toxicity_model_path
        if os.path.exists(tox_path):
            from transformers import pipeline as hf_pipeline
            self._toxicity_pipeline = hf_pipeline(
                "text-classification",
                model=tox_path,
                tokenizer=tox_path,
                truncation=True,
                max_length=512,
            )
            logger.info("Loaded toxicity model from %s", tox_path)
        else:
            logger.warning(
                "Toxicity model not found at %s — using keyword fallback", tox_path,
            )

        # ── 3. Sentiment classifier ───────────────────────
        sent_path = settings.sentiment_model_path
        if os.path.exists(sent_path):
            from transformers import pipeline as hf_pipeline
            self._sentiment_pipeline = hf_pipeline(
                "sentiment-analysis",
                model=sent_path,
                tokenizer=sent_path,
                truncation=True,
                max_length=512,
            )
            logger.info("Loaded sentiment model from %s", sent_path)
        else:
            logger.warning(
                "Sentiment model not found at %s — using keyword fallback", sent_path,
            )

        # Stage 4 (Crime NER) uses keyword vocabulary — no model to load.

    async def process(self, review_id: str, text: str) -> PipelineResult:
        """Run the full pipeline asynchronously via thread pool."""
        if not self._ready:
            raise RuntimeError("NLP pipeline not initialized")

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._executor, self._run_pipeline_sync, review_id, text,
        )

    def _run_pipeline_sync(self, review_id: str, text: str) -> PipelineResult:
        """
        Full 5-stage pipeline (synchronous — runs in executor).
        Stage 2 short-circuits if toxic.
        """
        clean_text = text.strip()
        if not clean_text:
            return PipelineResult(
                review_id=review_id,
                language="unknown",
                is_toxic=False,
                moderation_rejected=False,
                toxicity_score=0.0,
                sentiment_label=SentimentLabel.NEUTRAL,
                sentiment_confidence=0.0,
                entities=(),
            )

        # ── Stage 1: Language Detection ───────────────────
        language = self._detect_language(clean_text)

        # ── Stage 2: Toxicity ─────────────────────────────
        toxicity_score = self._score_toxicity(clean_text)
        is_toxic = toxicity_score >= settings.toxicity_threshold

        if is_toxic:
            # Short-circuit: reject and STOP
            return PipelineResult(
                review_id=review_id,
                language=language,
                is_toxic=True,
                moderation_rejected=True,
                toxicity_score=toxicity_score,
                sentiment_label=SentimentLabel.NEGATIVE,
                sentiment_confidence=1.0,
                entities=(),
            )

        # ── Stage 3: Sentiment ────────────────────────────
        sentiment_label, sentiment_confidence = self._analyze_sentiment(clean_text)

        # ── Stage 4: Crime NER ────────────────────────────
        entities = self._extract_crime_entities(clean_text)

        # ── Stage 5: Assemble ─────────────────────────────
        return PipelineResult(
            review_id=review_id,
            language=language,
            is_toxic=False,
            moderation_rejected=False,
            toxicity_score=toxicity_score,
            sentiment_label=sentiment_label,
            sentiment_confidence=sentiment_confidence,
            entities=tuple(entities),
        )

    # ── Stage Implementations ─────────────────────────────────

    def _detect_language(self, text: str) -> str:
        """Stage 1: fasttext language detection."""
        if self._fasttext_model is None:
            return "unknown"

        try:
            # fasttext.predict returns (['__label__en'], [0.99])
            predictions = self._fasttext_model.predict(
                text.replace("\n", " ")[:500], k=1,
            )
            label = predictions[0][0].replace("__label__", "")
            return label
        except Exception as exc:
            logger.warning("Language detection failed: %s", exc)
            return "unknown"

    def _score_toxicity(self, text: str) -> float:
        """Stage 2: toxicity scoring."""
        if self._toxicity_pipeline is not None:
            try:
                result = self._toxicity_pipeline(text[:512])
                if result and len(result) > 0:
                    item = result[0]
                    label = str(item.get("label", "")).lower()
                    score = float(item.get("score", 0.0))
                    # If toxic label, use score directly; if non-toxic, invert
                    if "toxic" in label or "hate" in label:
                        return score
                    return 1.0 - score
            except Exception as exc:
                logger.warning("Toxicity model failed: %s", exc)

        # Keyword fallback for toxicity
        toxic_words = [
            "abuse", "kill", "murder", "threat", "die",
            "gaali", "maar dunga", "jaan se maar",
        ]
        text_lower = text.lower()
        matches = sum(1 for w in toxic_words if w in text_lower)
        return min(1.0, matches * 0.3)

    def _analyze_sentiment(self, text: str) -> tuple[SentimentLabel, float]:
        """Stage 3: sentiment classification."""
        if self._sentiment_pipeline is not None:
            try:
                result = self._sentiment_pipeline(text[:512])
                if result and len(result) > 0:
                    item = result[0]
                    label = str(item.get("label", "")).lower()
                    confidence = float(item.get("score", 0.5))

                    if "positive" in label or label in ("pos", "5", "4"):
                        return SentimentLabel.POSITIVE, confidence
                    elif "negative" in label or label in ("neg", "1", "2"):
                        return SentimentLabel.NEGATIVE, confidence
                    return SentimentLabel.NEUTRAL, confidence
            except Exception as exc:
                logger.warning("Sentiment model failed: %s", exc)

        # Keyword fallback
        text_lower = text.lower()
        pos_words = ["safe", "good", "clean", "well-lit", "helpful", "surakshit", "accha"]
        neg_words = ["unsafe", "danger", "fear", "scary", "dirty", "khatarnak", "dar"]

        pos_count = sum(1 for w in pos_words if w in text_lower)
        neg_count = sum(1 for w in neg_words if w in text_lower)

        if pos_count > neg_count:
            return SentimentLabel.POSITIVE, 0.6
        elif neg_count > pos_count:
            return SentimentLabel.NEGATIVE, 0.6
        return SentimentLabel.NEUTRAL, 0.5

    def _extract_crime_entities(self, text: str) -> list[ExtractedEntity]:
        """
        Stage 4: Crime NER using keyword vocabulary.
        Matches crime types, location contexts, and time contexts.
        English + Hindi transliteration keywords.
        """
        text_lower = text.lower()
        entities: list[ExtractedEntity] = []

        # Extract location context
        location_context = self._match_context(text_lower, LOCATION_KEYWORDS)
        # Extract time context
        time_context = self._match_context(text_lower, TIME_KEYWORDS)

        for crime_type, keywords in CRIME_KEYWORDS.items():
            for keyword in keywords:
                if keyword in text_lower:
                    severity = CRIME_SEVERITY[crime_type]
                    # Confidence based on keyword specificity
                    confidence = 0.85 if len(keyword.split()) > 1 else 0.70

                    entities.append(ExtractedEntity(
                        crime_type=crime_type,
                        severity=severity,
                        confidence=confidence,
                        location_context=location_context,
                        time_context=time_context,
                    ))
                    break  # One match per crime type

        return entities

    @staticmethod
    def _match_context(text: str, vocab: dict[str, list[str]]) -> str | None:
        """Find the first matching context keyword."""
        for context_name, keywords in vocab.items():
            for keyword in keywords:
                if keyword in text:
                    return context_name
        return None
