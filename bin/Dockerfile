# darkwebchat-ai — the DarkNet negotiator agent.
#
# Polls this project's REST API for negotiations waiting on a reply, asks a
# local Ollama model to draft one, and posts it back as an operator suggestion.
# The chat works fully without it; this only adds the suggestions.
#
# The build context is the PROJECT, not this directory:
#
#   docker build -t darkwebchat-ai:latest -f bin/Dockerfile .
#
# and in node.conf that is the three-field form of DOCKER_BUILD_IMAGES:
#
#   "darkwebchat-ai:latest|../projects/darkwebchat|../projects/darkwebchat/bin/Dockerfile"
#
# It lives with the application rather than under dockers/ because it speaks the
# application's API. get_pending, claim_task, send_suggestion and heartbeat are
# a contract between two files in one repository, and pinning them to the same
# commit is what keeps an agent from talking to a server that has moved on.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY bin/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Twee bestanden: process_ai_feedback.py is de lus en de API, negotiator.py is
# wat er gezegd wordt. Ze zijn gesplitst zodat de onderhandelaar te testen is
# zonder server, en ze horen allebei in de image.
COPY bin/process_ai_feedback.py bin/negotiator.py ./

# config.py is deliberately absent — it is gitignored and .dockerignore keeps a
# developer's local copy out of the image. Everything is configured through the
# environment; see the table in the project README.
#
# Non-root: this agent holds an API key for the chat server, and nothing it does
# needs any privilege at all.
USER nobody

CMD ["python", "process_ai_feedback.py"]
