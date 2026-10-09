# Build from the repository root: docker build -f backend/worker/Dockerfile .
FROM python:3.11-slim-bookworm
WORKDIR /app
COPY backend/worker/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home tallythis
COPY --chown=tallythis:tallythis backend/worker/app ./app
ENV PORT=8091 PYTHONUNBUFFERED=1
USER tallythis
EXPOSE 8091
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8091}"]
