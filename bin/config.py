# config.py

# API-sleutel om bij DARKNET WEB CHAT de antwoorden te kunnen halen.
API_KEY = "dk_7fb2cf404b7baea461d6723f84404d73"

# URL van de webapplicatie API
BASE_URL = "https://darkwebchat.zebrawavesecurity.info/api"

# URL van de Ollama API
OLLAMA_URL = "http://localhost:11434/api/generate"

# Lijst met LLM-modellen die gebruikt worden voor de beoordeling
LLM_MODELS = [
    "qwen3:4b",
    "gpt-oss:120b-cloud",
]

# Interval in seconden voor het ophalen van nieuwe antwoorden
POLL_INTERVAL = 30