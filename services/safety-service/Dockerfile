# ─────────────────────────────────────────────────────────────
# Breeze Safety Intelligence Service — Dockerfile
# Models must be baked in at build time, NOT downloaded at runtime.
# ─────────────────────────────────────────────────────────────

FROM python:3.11-slim AS base

WORKDIR /app

# System deps for fasttext compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc g++ && \
    rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Bake models into image ────────────────────────────────────
# Models must exist at build time. Build will fail without them.
COPY models/ /models/

# ── Application code ──────────────────────────────────────────
COPY src/ /app/src/

ENV PYTHONPATH=/app
ENV SAFETY_MODEL_BASE_PATH=/models
ENV SAFETY_FASTTEXT_MODEL_PATH=/models/lid.176.ftz
ENV SAFETY_TOXICITY_MODEL_PATH=/models/toxicity
ENV SAFETY_SENTIMENT_MODEL_PATH=/models/sentiment
ENV SAFETY_NER_MODEL_PATH=/models/ner

EXPOSE 3004

# 2 workers: each loads ~1.1GB of NLP models = ~2.2GB total
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", \
     "-b", "0.0.0.0:3004", "--timeout", "120", "--graceful-timeout", "30", \
     "src.main:app"]
