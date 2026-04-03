# Copyright (C) 2025 JMNL Innovation.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

import requests
import json
import time
import re
import logging
import uuid
from typing import List, Dict, Optional, Any
import re
from config import API_KEY, BASE_URL, OLLAMA_URL, LLM_MODELS, POLL_INTERVAL

# Configureer logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

class AIFeedbackService:
    def __init__(self):
        self.api_key = API_KEY
        self.base_url = BASE_URL
        self.ollama_url = OLLAMA_URL
        self.models = LLM_MODELS
        self.poll_interval = POLL_INTERVAL
        self.agent_id = f"agent-{uuid.uuid4().hex[:8]}"

    def _get_headers(self) -> Dict[str, str]:
        return {
            "X-API-Token": self.api_key,
            "Content-Type": "application/json"
        }

    def _extract_json(self, text: Any) -> Optional[Dict]:
        if isinstance(text, dict): return text
        if not isinstance(text, str): return None
        
        cleaned = re.sub(r'```(?:json|text)?\n?|```', '', text)
        match = re.search(r'\{.*\}', cleaned, re.DOTALL)
        if not match: return None

        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            logger.debug(f"JSONDecodeError voor tekst: {text}")
            return None

    def fetch_pending_tasks(self) -> List[Dict]:
        try:
            response = requests.get(
                self.base_url,
                headers=self._get_headers(),
                params={"action": "get_pending", "token": self.api_key}, # Fallback token in URL
                timeout=30
            )
            
            if response.status_code == 401:
                logger.error("Authenticatie mislukt. Controleer je API_KEY.")
                return []
            
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Fout bij ophalen taken: {e}")
            return []

    def get_model_feedback(self, task: Dict, model: str) -> Optional[Dict]:
        instruction = str(task.get('instruction') or "")
        criteria = str(task.get('criteria') or "")
        answer = str(task.get('chat_history') or "")

        # DOCUMENTATIE VAN DE PROMPT-OPBOUW:
        # 1. # CONTEXT: Gebruikt 'Persona Prompting'. Door de AI een expertrol te geven, 
        #    wordt de woordkeuze en diepgang van de analyse professioneler.
        #
        # 2. # INPUT DATA: Scheidt instructies strikt van de data van de gebruiker. 
        #    Dit voorkomt 'prompt injection' waarbij de team-tekst de AI probeert te foppen.
        #
        # 3. # JOUW EVALUATIEPROCES: Implementeert 'Chain-of-Thought'. 
        #    - Stap 1 (Essentie bepalen): Wat is de absolute kern die beantwoord moet worden?
        #    - Stap 2 (Semantische match): Zoek naar de intentie. Synoniemen of alternatieve
        #      verwoordingen die op hetzelfde neerkomen moeten positief gewaardeerd worden.
        #    - Stap 3 (Dekkingsanalyse): Identificeer de verschillende aspecten in de criteria 
        #      en controleer of de meerderheid hiervan aanwezig is.
        #
        # 4. # HINT-METHODIEK: Voorkomt dat de AI het antwoord 'spoilt'. De AI wordt 
        #    geïnstrueerd om hints te geven in plaats van oplossingen.
        #
        # 5. # OUTPUT SPECIFICATIES: Stelt harde grenzen aan de lengte (max 3 zinnen) 
        #    en de toon ('jullie'-vorm).
        #
        # 6. # VERPLICHTE JSON STRUCTUUR: Cruciaal voor machine-to-machine communicatie. 
        #    De AI wordt gedwongen om geen 'gelets' eromheen te typen, zodat Python de data kan parsen.

        prompt = f"""
        # CONTEXT
        Je bent een deskundige beoordelaar en recherche-instructeur voor een educatief spel. 
        Je taak is om het ingezonden werk van een team te analyseren en van feedback te voorzien.

        # INPUT DATA
        - **Opdracht voor het team**: {instruction}
        - **Beoordelingscriteria**: {criteria}
        - **Chatgeschiedenis (Team & Docent)**: {answer}

        # JOUW EVALUATIEPROCES (Denk stap-voor-stap)
        1. **Kern van de criteria**: Bepaal wat de intentie is van de criteria. Welke informatie of welk inzicht is essentieel?
        2. **Dekkingsanalyse**: Breek de criteria op in afzonderlijke aspecten of feiten. Controleer hoeveel van deze aspecten (minimaal 60-70%) in het antwoord van het team worden geraakt.
        3. **Semantische analyse**: Wees flexibel met de verwoording. Als een aspect niet letterlijk wordt genoemd, maar de strekking of de logische conclusie wel aanwezig is, telt dit als een match.
        4. **Scoretoewijzing**: 
           - Geef een 7 of hoger alleen als de meeste aspecten (de hoofdzaken) van de criteria behandeld zijn.
           - Een 10 is voor een antwoord dat alle aspecten en de volledige context dekt.

        # RICHTLIJNEN VOOR FEEDBACK (BELANGRIJK)
        - Geef NOOIT direct het juiste antwoord of de ontbrekende feiten letterlijk prijs aan het team.
        - Als het antwoord onvolledig is, geef dan een hint: wijs op een specifieke locatie, een persoon of een inconsistentie in hun verhaal.
        - Gebruik prikkelende vragen (bijv: "Hebben jullie de camerabeelden van de hal wel goed bekeken?") in plaats van feitelijke correcties.

        # OUTPUT SPECIFICATIES
        Geef je antwoord uitsluitend in JSON-formaat met de volgende velden:
        - "score": Een numerieke waarde tussen 0 en 10.
        - "feedback": Een sturende reactie met hints gericht aan het team in de 'jullie'-vorm. Verklap niets, maar wijs de weg (max 3 zinnen).

        # VERPLICHTE JSON STRUCTUUR
        Geef uitsluitend een JSON object terug zoals dit voorbeeld:
        {{
            "score": 7,
            "feedback": "Goede start, maar kijk nog eens naar de tijdlijn.",
        }}

        Begin nu met je analyse en output GEEN tekst voor of na de JSON.
        """
        
        try:
            start = time.time()
            resp = requests.post(
                self.ollama_url,
                json={"model": model, "prompt": prompt, "stream": False},
                timeout=300
            )
            resp.raise_for_status()
            duration = time.time() - start
            
            raw_response = resp.json().get("response", "")
            result = self._extract_json(raw_response)
            
            if result:
                result['duration'] = duration
                return result
            logger.warning(f"Model {model} gaf geen valide JSON. Raw response: {raw_response[:100]}...")
        except Exception as e:
            logger.warning(f"Model {model} fout: {e}")
        return None

    def claim_task(self, team_id: int) -> bool:
        try:
            resp = requests.post(
                f"{self.base_url}?action=claim_task&token={self.api_key}",
                headers=self._get_headers(),
                json={"team_id": team_id, "agent_id": self.agent_id},
                timeout=15
            )
            return resp.status_code == 200
        except Exception as e:
            logger.error(f"Fout bij claimen taak {team_id}: {e}")
            return False

    def submit_suggestion(self, team_id: int, message: str, level_up: bool):
        try:
            payload = {
                "team_id": team_id,
                "message": message,
                "level_up": level_up
            }
            resp = requests.post(
                f"{self.base_url}?action=send_suggestion&token={self.api_key}",
                headers=self._get_headers(),
                json=payload,
                timeout=30
            )
            resp.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Fout bij versturen suggestie voor team {team_id}: {e}")
            return False
            
    def send_heartbeat(self):
        try:
            resp = requests.post(
                f"{self.base_url}?action=heartbeat&token={self.api_key}",
                headers=self._get_headers(),
                json={"agent_id": self.agent_id},
                timeout=10
            )
            resp.raise_for_status()
        except Exception as e:
            logger.warning(f"Fout bij versturen heartbeat: {e}")

    def unregister_agent(self):
        try:
            requests.post(
                f"{self.base_url}?action=unregister_agent&token={self.api_key}",
                headers=self._get_headers(),
                json={"agent_id": self.agent_id},
                timeout=5
            )
            logger.info("Agent succesvol afgemeld.")
        except:
            pass

    def run(self):
        logger.info(f"AI Feedback Service gestart (ID: {self.agent_id}). Interval: {self.poll_interval}s")
        
        while True:
            # Stuur direct een heartbeat bij de start van elke cyclus
            self.send_heartbeat()

            tasks = self.fetch_pending_tasks()
            if tasks:
                logger.info(f"{len(tasks)} antwoorden gevonden om te verwerken.")
            
            for task in tasks:
                team_name = task.get('team_name', 'Onbekend')
                team_id = task['team_id']

                # Probeer de taak te claimen voordat we beginnen
                if not self.claim_task(team_id):
                    logger.info(f"Overslaan: Team '{team_name}' wordt al verwerkt door een andere agent.")
                    continue

                # Stuur een extra heartbeat vlak voordat we aan de zware LLM analyse beginnen
                self.send_heartbeat()

                for model in self.models:
                    logger.info(f"Analyseren: Team '{team_name}' met {model}...")
                    res = self.get_model_feedback(task, model)
                    
                    if res:
                        score = res.get('score', 0)
                        # Formatteer de feedback voor een individueel model
                        duration = res.get('duration', 0)
                        model_feedback = f"🤖 **AI Advies ({model})** - Score: {score}/10 (Tijdsduur: {duration:.2f}s)\n\n"
                        model_feedback += f"{res['feedback']}"
                        
                        can_level_up = score >= 7.0
                        
                        # Stuur de suggestie direct per model door naar de API
                        if self.submit_suggestion(task['team_id'], model_feedback, can_level_up):
                            logger.info(f"Suggestie van {model} verstuurd voor {team_name}")
                    else:
                        logger.warning(f"Model {model} gaf geen resultaat.")

            time.sleep(self.poll_interval)

if __name__ == "__main__":
    try:
        service = AIFeedbackService()
        service.run()
    except KeyboardInterrupt:
        logger.info("Service gestopt door gebruiker.")
        service.unregister_agent()
    except Exception as e:
        logger.critical(f"Kritieke fout in service: {e}")
        service.unregister_agent()
