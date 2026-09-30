# server/main.py

import json
import re
import base64
import os
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from typing import Optional

from google import genai
from google.genai import types

app = FastAPI(title="SuperNova Agent Server")

# 1. INITIALIZE THE MULTI-KEY CLIENT POOL WITH EXTENDED TIMEOUTS
keys_env = os.environ.get("GEMINI_API_KEYS", "")
if keys_env:
    api_keys = [k.strip() for k in keys_env.split(",") if k.strip()]
else:
    single_key = os.environ.get("GEMINI_API_KEY")
    api_keys = [single_key] if single_key else []

if not api_keys:
    print("[Server] Warning: No API keys found. Defaulting to local credentials.")
    client_pool = [genai.Client(http_options={'timeout': 120000})]
else:
    print(f"[Server] Successfully loaded {len(api_keys)} API keys into the pool.")
    client_pool = [genai.Client(api_key=k, http_options={'timeout': 120000}) for k in api_keys]

app.state.current_client_idx = 0

# 2. PYDANTIC SCHEMAS
class Coordinates(BaseModel):
    x: int = Field(description="The X pixel coordinate")
    y: int = Field(description="The Y pixel coordinate")

class BrowserAction(BaseModel):
    action: str = Field(description="The action to perform: 'click', 'type', 'scroll', 'navigate', 'ask_confirmation', or 'done'")
    selector: Optional[str] = Field(default=None, description="The CSS selector of the target element (prefer '[data-supernova-id=\"...\"]')")
    coords: Optional[Coordinates] = Field(default=None, description="The x and y coordinates for fallback visual clicking")
    value: Optional[str] = Field(default=None, description="The text to type, scroll direction ('down'/'up'), or URL to navigate to")
    requires_confirmation: bool = Field(description="Set to true for irreversible actions (payments, form submissions, navigation)")
    reason: str = Field(description="Brief explanation of why this action was chosen")

LEAK_PATTERNS = [
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,7}\b", re.IGNORECASE), # Email
    re.compile(r"(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}(?!\d)|(?<!\d)\+?1[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}(?!\d)"), # Phone
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),                                               # SSN
    re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{16}\b"),                              # Credit Card
    re.compile(r"\b[2-9]\d{3}[-\s]?\d{4}[-\s]?\d{4}\b"),                                # Aadhaar
    re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b", re.IGNORECASE),                              # PAN 
    re.compile(r"\b(0?[1-9]|[12]\d|3[01])[-\/.](0?[1-9]|1[0-2])[-\/.](19|20)\d{2}\b", re.IGNORECASE)  # DOB
]

def assert_no_pii_leak(tree_nodes: list) -> bool:
    for node in tree_nodes:
        text = str(node.get("text") or "")
        aria = str(node.get("ariaLabel") or "")
        content_to_check = f"{text} {aria}"
        
        for pattern in LEAK_PATTERNS:
            if pattern.search(content_to_check):
                return False
    return True

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Hardening (a): Strict Origin Validation Gate
    origin = websocket.headers.get("origin")
    if not origin or not origin.startswith("chrome-extension://"):
        print(f"[Security Gate] Rejected connection from unauthorized origin: {origin}")
        await websocket.close(code=1008, reason="Unauthorized origin")
        return

    await websocket.accept()
    print(f"[Server] Client extension connected via WebSocket (Origin: {origin}).")
    
    try:
        while True:
            raw_data = await websocket.receive_text()
            payload = json.loads(raw_data)
            
            msg_type = payload.get("type")
            if msg_type == "context_update":
                dom_tree = payload.get("dom", {}).get("tree", [])
                user_task = payload.get("task", "Analyze screen and determine the next action.")
                screenshot_data = payload.get("screenshot")
                last_action_result = payload.get("last_action_result")
                action_history = payload.get("action_history", [])
                
                # Check DOM tree text for leaks
                if not assert_no_pii_leak(dom_tree):
                    print("[Security Gate] Unredacted PII detected in DOM tree! Discarding context.")
                    await websocket.send_text(json.dumps({"status": "error", "error": "PII_LEAK"}))
                    continue

                if screenshot_data:
                    header, encoded = screenshot_data.split(",", 1)
                    image_bytes = base64.b64decode(encoded)
                    
                    filepath = os.path.join(os.path.dirname(__file__), "redacted_screenshot.jpg")
                    with open(filepath, "wb") as f:
                        f.write(image_bytes)
                    print(f"[Server] SUCCESS! Saved visually redacted screenshot to: {filepath}")

                print(f"[Server] Received sanitized context. Task: {user_task}")
                
                failure_context = ""
                if last_action_result and not last_action_result.get("success"):
                    failure_context = (
                        f"\nPREVIOUS ACTION FAILED / HAD NO EFFECT:\n"
                        f"- Reason: {last_action_result.get('reason')}\n"
                        f"- Failed Action: {json.dumps(last_action_result.get('failed_action'))}\n"
                        f"- CRITICAL: Do NOT repeat this exact action. Try another selector, scroll to find elements, or choose another step.\n"
                    )

                history_context = ""
                if action_history:
                    history_context = "\nRECENT ACTION HISTORY (Do not repeat completed steps):\n"
                    for i, item in enumerate(action_history):
                        act = item.get("action", {})
                        res = item.get("result", {})
                        status = "SUCCESS" if res.get("success") else f"FAILED: {res.get('reason', 'Unknown error')}"
                        target = act.get('selector') or act.get('value') or 'Screen'
                        history_context += f"{i+1}. Planned: '{act.get('action')}' on '{target}' -> {status}\n"

                prompt = (
                    f"Task: {user_task}\n"
                    f"{failure_context}"
                    f"{history_context}\n"
                    f"Sanitized DOM Tree:\n{json.dumps(dom_tree, indent=2)}\n\n"
                    "Action Guidelines:\n"
                    "1. 'click': Click an element. ALWAYS select from the DOM tree by referencing its selector (e.g. '[data-supernova-id=\"4\"]').\n"
                    "2. 'type': Enter text into an input or textarea. To automatically press ENTER and submit the form/search, append '\\n' to the value (e.g., 'my search query\\n').\n"
                    "3. 'scroll': Use when the target element is likely lower down or higher up on the page. Set 'value' to 'down' or 'up'.\n"
                    "4. 'navigate': Use ONLY when the user explicitly directs navigating to a new domain. Set 'value' to the full URL and set 'requires_confirmation' to true.\n"
                    "5. 'done': Return when the user's task has been achieved. CRITICAL: If the user's task was simply to click a link, navigate, or perform a single action, and the Action History shows you just successfully did so, you MUST return 'done' to prevent infinite loops.\n"
                    "6. Avoid loops: Never execute the same action with the same selector twice in a row if the page state has not changed."
                )
                
                contents = []
                if screenshot_data:
                    header, encoded = screenshot_data.split(",", 1)
                    image_bytes = base64.b64decode(encoded)
                    contents.append(types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"))
                    prompt += "\nUse the provided redacted screenshot to help identify visual layouts and context."
                
                contents.append(types.Part.from_text(text=prompt))
                
                response = None
                last_error = None
                max_attempts = len(client_pool) * 2 if client_pool else 2
                
                for attempt in range(max_attempts):
                    current_idx = websocket.app.state.current_client_idx
                    client = client_pool[current_idx]
                    
                    try:
                        print(f"[Server] Dispatching context to Gemini (Key #{current_idx + 1}, Attempt {attempt + 1})...")
                        response = await client.aio.models.generate_content(
                            model='gemini-3.6-flash',
                            contents=contents,
                            config=types.GenerateContentConfig(
                                response_mime_type="application/json",
                                response_schema=BrowserAction,
                                temperature=0.1
                            )
                        )
                        break
                        
                    except Exception as e:
                        error_str = str(e)
                        err_type = type(e).__name__
                        last_error = e
                        
                        # NEW: Kill dead network loops quickly
                        if "Connect" in err_type and attempt >= 2:
                            print("[Server] Cannot reach Google after 3 tries. Check network/VPN/firewall.")
                            raise e
                        
                        transient_errors = ["429", "Resource Exhausted", "503", "500", "502", "504", "Bad Gateway", "Gateway Timeout", "Service Unavailable", "Internal Server Error"]
                        transient_types = ["ReadError", "ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "TimeoutException", "TimeoutError", "RemoteProtocolError", "ConnectionResetError", "Timeout"]
                        
                        if any(err in error_str for err in transient_errors) or any(t in err_type for t in transient_types):
                            backoff_time = min(2.0 * (1.5 ** attempt), 8.0)
                            print(f"[Server] API Overload or Transient Issue ({err_type}: {error_str[:80]}...). Rotating key and backing off for {backoff_time:.1f}s...")
                            websocket.app.state.current_client_idx = (current_idx + 1) % len(client_pool)
                            await asyncio.sleep(backoff_time)
                        else:
                            raise e 
                
                if response is None:
                    raise last_error
                
                ai_action = json.loads(response.text)
                print(f"[Server] AI Planner Output:\n{json.dumps(ai_action, indent=2)}")
                
                await websocket.send_text(json.dumps({
                    "status": "action_planned",
                    "action": ai_action
                }))
                
    except WebSocketDisconnect:
        print("[Server] Client disconnected.")
    except Exception as e:
        error_msg = str(e)
        err_type = type(e).__name__
        print(f"[Server] Error: {err_type} - {error_msg}")
        
        transient_types = ["ReadError", "ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "TimeoutException", "TimeoutError", "RemoteProtocolError", "ConnectionResetError", "Timeout"]
        friendly_error = "API keys rate-limited, network dropped, or Google servers overloaded. Please wait a moment." \
            if any(err in error_msg for err in ["429", "503", "500", "502", "504"]) or any(t in err_type for t in transient_types) \
            else "An error occurred in the AI Planner."
            
        await websocket.send_text(json.dumps({
            "status": "error",
            "error": friendly_error
        }))
