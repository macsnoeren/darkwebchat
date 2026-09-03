# Copyright (C) 2025 JMNL Innovation.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""De lus: taken ophalen, claimen, laten schrijven, suggestie terugsturen.

Wat er gezegd wordt staat in negotiator.py. Dit bestand gaat alleen over de API
en het pollen, zodat de onderhandelaar te testen is zonder server.
"""

import json
import logging
import os
import re
import signal
import sys
import time
import uuid
from typing import Any, Dict, List, Optional

import requests

import negotiator

# ============================================================
# CONFIGURATIE
# ============================================================
#
# Twee bronnen, in deze volgorde: een environment variable wint, anders komt de
# waarde uit bin/config.py. Die volgorde is er voor de container — die krijgt
# alles via de environment en heeft geen config.py — terwijl een checkout op een
# laptop met bin/config.py blijft werken zoals hij deed.

try:
    import config as _config
except ImportError:
    _config = None


def _setting(name, default=None, required=False):
    # <NAME>_FILE first, so a secret can be mounted as a file instead of standing
    # in compose.yml where it would be committed. Same convention as the
    # postgres images and docker secrets.
    path = os.environ.get(f"{name}_FILE")
    if path:
        try:
            return open(path).read().strip()
        except OSError as exc:
            raise SystemExit(f"{name}_FILE={path} is niet te lezen: {exc}")

    value = os.environ.get(name)
    if value is None and _config is not None:
        value = getattr(_config, name, None)
    if value is None:
        value = default
    if required and not value:
        raise SystemExit(
            f"{name} is niet gezet. Zet de environment variable, of vul hem in "
            f"in bin/config.py (zie bin/config.py.sample)."
        )
    return value


API_KEY    = _setting("API_KEY", required=True)
BASE_URL   = _setting("BASE_URL",   "http://localhost:3000/api")
OLLAMA_URL = _setting("OLLAMA_URL", "http://localhost:11434/api/generate")

# Komma-gescheiden in de environment, een lijst in config.py.
_models = _setting("LLM_MODELS", "qwen2.5:1.5b")
LLM_MODELS = (
    [m.strip() for m in _models.split(",") if m.strip()]
    if isinstance(_models, str) else list(_models)
)

POLL_INTERVAL = int(_setting("POLL_INTERVAL", 30))

# De vraagprijs en de bodem staan in de losgeldbrief die de deelnemers krijgen,
# dus ze horen instelbaar te zijn zonder de persona aan te raken.
negotiator.ASK_BTC   = float(_setting("RANSOM_BTC", negotiator.ASK_BTC))
negotiator.FLOOR_BTC = float(_setting("FLOOR_BTC",  negotiator.FLOOR_BTC))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


class DarkNetNegotiator:
    def __init__(self):
        self.api_key       = API_KEY
        self.base_url      = BASE_URL
        self.ollama_url    = OLLAMA_URL
        self.models        = LLM_MODELS
        self.poll_interval = POLL_INTERVAL
        self.agent_id      = f"darknet-agent-{uuid.uuid4().hex[:8]}"

    def _get_headers(self) -> Dict[str, str]:
        return {
            "X-API-Token": self.api_key,
            "Content-Type": "application/json",
        }

    # ── berichten ────────────────────────────────────────────

    @staticmethod
    def _deadline_from(task: Dict) -> str:
        """De deadline van de oefening als iets wat een mens zou zeggen.

        De server stuurt ISO, en dat neemt het model letterlijk over — dan staat
        er "betaal voor 02:19:03 UTC 04-09-2026" in de chat, wat geen
        onderhandelaar ooit typt.
        """
        raw = str(task.get("deadline") or "")
        try:
            when = time.strptime(raw.split(".")[0].rstrip("Z"), "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return "vanavond 23:00"
        stamp = time.strftime("%H:%M", when)
        if time.strftime("%Y-%m-%d", when) == time.strftime("%Y-%m-%d", time.gmtime()):
            return f"vandaag om {stamp}"
        return f"{time.strftime('%d-%m', when)} om {stamp}"

    @staticmethod
    def _messages_from(task: Dict) -> List[Dict]:
        """De berichtenlijst, met een terugval op het platte transcript.

        De server stuurt sinds deze versie een `messages`-array mee, juist omdat
        het platte transcript geen betrouwbare scheiding heeft tussen wie er
        praat en wat er getypt is: een bedrijf dat "[21:10] DarkNet Operator: …"
        intypt, staat in dat transcript als de hacker zelf. Draait de worker
        tegen een oudere server, dan valt hij terug op parsen — met dezelfde
        zwakte, die de guard in negotiator.py dan moet opvangen.
        """
        raw = task.get("messages")
        if isinstance(raw, list) and raw:
            out = []
            for item in raw:
                if not isinstance(item, dict):
                    continue
                out.append({
                    "who":       "darknet" if item.get("who") == "darknet" else "company",
                    "timestamp": str(item.get("timestamp") or ""),
                    "text":      str(item.get("text") or item.get("chat") or ""),
                })
            return out

        messages = []
        for line in str(task.get("chat_history") or "").split("\n"):
            # De afzender mag zelf een dubbele punt bevatten: het transcript
            # schrijft "ABN-AMRE Finance (Team: ABNM-C5R1): …". Daarom telt een
            # complete haakjesgroep hier als één teken.
            match = re.match(r"^\[([^\]]*)\]\s*((?:\([^)]*\)|[^:(])+?)\s*:\s*(.*)$", line)
            if not match:
                if messages:
                    messages[-1]["text"] += "\n" + line
                continue
            stamp, sender, text = match.groups()
            messages.append({
                "who": "darknet" if "darknet operator" in sender.lower() else "company",
                "timestamp": stamp, "text": text,
            })
        return messages

    # ── API ──────────────────────────────────────────────────

    def fetch_pending_tasks(self) -> List[Dict]:
        """Haal alle actieve chats op die een bedrijfsbericht bevatten en niet geclaimd zijn."""
        try:
            response = requests.get(
                self.base_url,
                headers=self._get_headers(),
                params={"action": "get_pending", "token": self.api_key},
                timeout=30,
            )
            if response.status_code == 401:
                # Niet naar config.py verwijzen: in een container bestaat dat
                # bestand niet en komt de sleutel uit API_KEY_FILE of API_KEY.
                logger.error(
                    "Authenticatie mislukt: de server kent deze API_KEY niet. "
                    "Maak er een aan in het dashboard onder API en zet die in "
                    "API_KEY_FILE, API_KEY of bin/config.py."
                )
                return []
            response.raise_for_status()
            tasks = response.json()
            logger.info(f"{len(tasks)} taak/taken opgehaald.")
            return tasks
        except Exception as e:
            logger.error(f"Fout bij ophalen taken: {e}")
            return []

    def claim_task(self, chat_id: str) -> bool:
        try:
            resp = requests.post(
                f"{self.base_url}?action=claim_task&token={self.api_key}",
                headers=self._get_headers(),
                json={"team_id": chat_id, "agent_id": self.agent_id},
                timeout=15,
            )
            return resp.status_code == 200
        except Exception as e:
            logger.error(f"Fout bij claimen {chat_id}: {e}")
            return False

    def submit_suggestion(self, chat_id: str, message: str, state: Dict,
                          warning: str = "") -> bool:
        try:
            payload = {
                "team_id":  chat_id,
                "message":  message,
                "level_up": False,
                # De server slaat dit op in ai_suggestions.agent_id en toont het
                # in het dashboard. Zonder dit veld valt hij terug op "unknown"
                # en is niet meer te zien welke agent of welk model een
                # suggestie heeft geschreven — precies wat je wilt weten als er
                # meerdere modellen tegelijk meedraaien.
                "agent_id": self.agent_id,
                # De staat reist mee met de suggestie en wordt pas canoniek als
                # deze suggestie ook echt verstuurd wordt. Elk model schrijft
                # een eigen samenvatting, en alleen die van het bericht dat in
                # het gesprek belandt mag het geheugen worden.
                "state":    state,
                "warning":  warning,
            }
            resp = requests.post(
                f"{self.base_url}?action=send_suggestion&token={self.api_key}",
                headers=self._get_headers(),
                json=payload,
                timeout=30,
            )
            resp.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Fout bij versturen suggestie voor {chat_id}: {e}")
            return False

    def send_heartbeat(self):
        try:
            requests.post(
                f"{self.base_url}?action=heartbeat&token={self.api_key}",
                headers=self._get_headers(),
                json={"agent_id": self.agent_id},
                timeout=10,
            )
        except Exception as e:
            logger.warning(f"Heartbeat mislukt: {e}")

    def unregister_agent(self):
        try:
            requests.post(
                f"{self.base_url}?action=unregister_agent&token={self.api_key}",
                headers=self._get_headers(),
                json={"agent_id": self.agent_id},
                timeout=5,
            )
            logger.info("Agent afgemeld.")
        except Exception:
            pass

    # ── lus ──────────────────────────────────────────────────

    def handle_task(self, task: Dict) -> bool:
        chat_id   = task.get('team_id', '')
        team_name = task.get('team_name', 'Onbekend')
        company   = task.get('company',   team_name)

        messages = self._messages_from(task)
        deadline = self._deadline_from(task)

        any_success = False
        for model in self.models:
            logger.info(f"  Model: {model} …")
            start = time.time()
            try:
                result = negotiator.negotiate(
                    ollama_url=self.ollama_url, model=model, chat_id=chat_id,
                    company=company, messages=messages, state=task.get("state"),
                    deadline=deadline,
                )
            except Exception as e:
                logger.warning(f"  [{model}] Onverwachte fout: {e}")
                continue

            if result["injection"]:
                kinds = ", ".join(sorted({h["type"] for h in result["guard_hits"]})) or "door model gemeld"
                logger.warning(f"  [{model}] Manipulatiepoging genegeerd ({kinds}).")

            if not result["message"]:
                # Geen suggestie is een zichtbaar gat voor de operator. Een
                # onderhandelaar die uit zijn rol stapt is dat niet, en die
                # wordt daarom hierboven weggegooid.
                logger.warning(f"  [{model}] Geen bericht: {result['rejected_reason']}.")
                continue

            duration = time.time() - start
            logger.info(
                f"  [{model}] fase={result['phase']} vraagprijs={result['state']['ask']} "
                f"({duration:.1f}s): {result['message'][:80]}…"
            )
            if self.submit_suggestion(chat_id, result["message"], result["state"],
                                      result["warning"]):
                any_success = True
            else:
                logger.warning(f"  [{model}] Versturen mislukt.")

        return any_success

    def run(self):
        logger.info(f"DarkNet Negotiator gestart (ID: {self.agent_id}) | Interval: {self.poll_interval}s")
        logger.info(f"Verbonden met: {self.base_url}")
        logger.info(f"Modellen: {', '.join(self.models)}")
        logger.info(f"Vraagprijs {negotiator.ASK_BTC} BTC, bodem {negotiator.FLOOR_BTC} BTC.")

        while True:
            self.send_heartbeat()

            for task in self.fetch_pending_tasks():
                chat_id   = task.get('team_id', '')
                team_name = task.get('team_name', 'Onbekend')
                company   = task.get('company',   team_name)

                if not chat_id:
                    logger.warning("Taak zonder team_id overgeslagen.")
                    continue

                if not self.claim_task(chat_id):
                    logger.info(f"Overgeslagen: {company} / {team_name} – al geclaimd.")
                    continue

                logger.info(f"Verwerken: {company} / Team: {team_name}")
                self.send_heartbeat()

                if not self.handle_task(task):
                    logger.error(f"Alle modellen faalden voor {company} / {team_name}.")

            time.sleep(self.poll_interval)


if __name__ == "__main__":
    service = DarkNetNegotiator()

    # 'docker stop' stuurt SIGTERM, en zonder handler stopt Python zonder zich
    # af te melden. De server ruimt een agent na 90 seconden zelf op, maar tot
    # die tijd staat er een spook in het dashboard — verwarrend precies op het
    # moment dat je containers aan het herstarten bent.
    def _terminate(signum, frame):
        logger.info("SIGTERM ontvangen, afmelden en stoppen.")
        service.unregister_agent()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _terminate)

    try:
        service.run()
    except KeyboardInterrupt:
        logger.info("Service gestopt door gebruiker.")
        service.unregister_agent()
    except Exception as e:
        logger.critical(f"Kritieke fout: {e}", exc_info=True)
        service.unregister_agent()
