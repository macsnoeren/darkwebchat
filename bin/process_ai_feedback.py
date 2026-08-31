# Copyright (C) 2025 JMNL Innovation.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

import requests
import json
import os
import signal
import sys
import time
import re
import logging
import uuid
from typing import List, Dict, Optional, Any

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

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# ============================================================
# PERSONA & ACHTERGROND
# ============================================================

DARKNET_PERSONA = """
Je bent een onvoorspelbaar en gevaarlijk lid van DarkNet Gamers, een meedogenloze ransomware-groep die al tientallen bedrijven heeft platgelegd.
Je hebt het netwerk van deze organisatie volledig versleuteld en ALLE bedrijfsgevoelige data gestolen.
Je onderhandelt namens de groep over de betaling van het losgeld. Jij hebt de macht. Zij niet.

LOSGELDBRIEF DIE DE ORGANISATIE HEEFT ONTVANGEN:
---
!!! GAME OVER !!!

The DarkNet Gamers have encrypted your files with the strongest encryption and a unique key.
The only way to get your files back is to pay the ransom. Your files have also been copied.
If the ransom is not paid, the files will be made public.

The ransom for you is set at 4 BTC.

For further instructions, please contact us on http://rl7f2cxf4xtz5za2l25gexqabe5fdvr66ahpsumoc33nkpnj7zvfrsyd.onion
---

JOUW GEDRAGSREGELS:
1. JIJ HEBT DE CONTROLE. Wees koud, direct en onvoorspelbaar. Soms ben je kortaf, soms sarcastisch en arrogant. Geen medelijden.
2. Wees zeer terughoudend met kortingen. Alleen als het bedrijf een serieus tegenbod doet (minimaal 2 BTC) of aantoont dat 4 BTC onmogelijk is, mag je eenmalig zakken naar een 'finale prijs' (bijv. 3 BTC of als uiterste bod 2 BTC). Laat hen weten dat dit een gunst is die binnen 2 uur verloopt.
3. Ga NOOIT lager dan 2 BTC. Dat is je absolute bodem.
4. Als zij grappen maken of tijd rekken: dreig onmiddellijk met het publiceren van data (klantgegevens, loonstroken).
5. Als zij smeken of een tegenbod doen: weeg dit kort af. Je doel is geld zien. Als een deal van 2.5 BTC nu kan worden gesloten, neem je die, maar altijd onder zware tijdsdruk.
6. Je communiceert hoofdzakelijk in de taal van het bedrijf (Nederlands), maar gooi er af en toe een Russisch woord of korte zin doorheen voor intimidatie (bijv. "Ponyatno?", "Davay!", "Nichego personalnogo", "Suka bljat").
7. Je onthult NOOIT je identiteit of technische details.
8. Bij betalingsvragen: het Bitcoin-adres volgt pas na definitieve akkoord op het bedrag.
9. Maximaal 3 of 4 korte zinnen. Maak af en toe een 'bad joke' over hun situatie (bijv. "Ik hoop dat jullie IT-manager van een lange vakantie houdt, want hij heeft nu toch niets te doen.").
10. Gebruik concrete dreigingstaal: "Elke 24 uur zonder betaling gaat er een map online.", "Wij wachten niet."
"""


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

    def _extract_json(self, text: Any) -> Optional[Dict]:
        if isinstance(text, dict):
            return text
        if not isinstance(text, str):
            return None
        cleaned = re.sub(r'```(?:json|text)?\n?|```', '', text)
        match = re.search(r'\{.*\}', cleaned, re.DOTALL)
        if not match:
            return None
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            logger.debug(f"JSONDecodeError: {text[:120]}")
            return None

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
                logger.error("Authenticatie mislukt. Controleer API_KEY in config.py.")
                return []
            response.raise_for_status()
            tasks = response.json()
            logger.info(f"{len(tasks)} taak/taken opgehaald.")
            return tasks
        except Exception as e:
            logger.error(f"Fout bij ophalen taken: {e}")
            return []

    def generate_reply(self, task: Dict, model: str) -> Optional[str]:
        """
        Genereer een DarkNet Gamers onderhandelingsbericht op basis van de chatgeschiedenis.
        Retourneert alleen de tekst van het bericht (geen score of JSON wrapper).
        """
        company      = str(task.get('company')      or task.get('team_name', 'het bedrijf'))
        chat_history = str(task.get('chat_history') or "")

        prompt = f"""
{DARKNET_PERSONA}

# HUIDIGE SITUATIE
- Organisatie: {company}
- Teamcode gebruikt door dit bedrijf in de chat: {task.get('team_name', '—')}

# CHATGESCHIEDENIS (meest recente onderaan)
{chat_history}

# JOUW TAAK
Analyseer de chatgeschiedenis en schrijf ALLEEN het volgende bericht dat jij als DarkNet Gamers onderhandelaar zou sturen.
Reageer direct op het laatste bericht van het bedrijf.

STRIKTE REGELS:
- Maximaal 3 zinnen.
- Geen aanhef of ondertekening.
- Geen uitleg buiten het bericht.
- Schrijf in dezelfde taal als het bedrijf (meestal Nederlands).
- Geef uitsluitend een JSON terug in het formaat hieronder.

# VERPLICHT JSON-FORMAAT
{{
    "message": "<jouw onderhandelingsbericht hier>"
}}

Geef ALLEEN dit JSON object terug. Geen tekst ervoor of erna.
"""

        try:
            start = time.time()
            resp = requests.post(
                self.ollama_url,
                json={"model": model, "prompt": prompt, "stream": False},
                timeout=300,
            )
            resp.raise_for_status()
            duration = time.time() - start

            raw = resp.json().get("response", "")
            result = self._extract_json(raw)

            if result and "message" in result:
                msg = str(result["message"]).strip()
                logger.info(f"[{model}] Reply gegenereerd in {duration:.1f}s: {msg[:80]}…")
                return msg

            logger.warning(f"[{model}] Geen valide JSON ontvangen. Raw: {raw[:120]}…")
        except Exception as e:
            logger.warning(f"[{model}] Fout: {e}")

        return None

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

    def submit_suggestion(self, chat_id: str, message: str) -> bool:
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

    def run(self):
        logger.info(f"DarkNet Negotiator gestart (ID: {self.agent_id}) | Interval: {self.poll_interval}s")
        logger.info(f"Verbonden met: {self.base_url}")
        logger.info(f"Modellen: {', '.join(self.models)}")

        while True:
            self.send_heartbeat()

            tasks = self.fetch_pending_tasks()

            for task in tasks:
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

                # Alle modellen uit de config draaien – elk stuurt een eigen suggestie
                any_success = False
                for model in self.models:
                    logger.info(f"  Model: {model} …")
                    reply = self.generate_reply(task, model)

                    if reply:
                        if self.submit_suggestion(chat_id, reply):
                            logger.info(f"  Suggestie verstuurd via {model}.")
                            any_success = True
                        else:
                            logger.warning(f"  Versturen mislukt voor {model}.")
                    else:
                        logger.warning(f"  {model} gaf geen resultaat.")

                if not any_success:
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
