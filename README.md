# SuperNova: Privacy-First Browser Agent

**Smart India Hackathon 2026 | Problem Statement SIH26171: On-device Visual Perception for Light-weight Browser Agents**

SuperNova is a Chrome (Manifest V3) extension that **sees locally, reasons remotely and acts automatically**. It reads the page (DOM + screenshot), detects and redacts sensitive information **on the device**, and sends only the sanitized context to a server-side AI planner. The planner returns a structured action (click, type, scroll, navigate) that the extension executes.

- Demo video: [add link]
- Presentation: `docs/SIH26171_Supernova.pdf`

## How it works

1. **Capture:** the content script extracts up to 60 interactive DOM elements and the extension captures a screenshot.
2. **On-device privacy layer:**
   - OWL-ViT (zero-shot, via Transformers.js and ONNX Runtime Web, WebGPU with WASM fallback) detects faces, ID cards, credit cards and passports.
   - Tesseract.js OCR reads text drawn as pixels; regex rules flag PII.
   - Canvas black-box redaction produces a JPEG capped at 1280 px, plus a sanitized DOM.
3. **Trust boundary:** only the redacted JPEG, the sanitized DOM, the task and the action history leave the browser.
4. **Server (FastAPI + WebSocket):** checks the origin, re-scans the DOM for PII (and discards unsafe context), then asks a cloud VLM (Gemini Flash) for one Pydantic-validated JSON action.
5. **Act:** the extension executes the action through a safety gate, up to 10 steps per task.

## PII covered

Email, phone (+91 / +1), SSN, credit card, Aadhaar, PAN, date of birth, faces, and ID documents.
Names, gender and addresses are out of scope for now (roadmap: on-device NER).

## Repository layout

```
extension/   Chrome extension (background, content script, popup, offscreen ML, bundled models)
server/      FastAPI planner server (main.py)
test_range/  Local test website (ID cards, faces, shop, login, checkout)
docs/        Presentation, screenshots, evaluation notes
```

## Setup

**Requirements:** Chrome (Chromium), Python 3.10+, a Gemini API key.

1. Clone the repo and enter it.
2. Create a virtual environment and install dependencies:
   ```
   python -m venv venv
   venv\Scripts\activate        (Windows)   |   source venv/bin/activate   (macOS/Linux)
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and add your key(s). Then set the variable in your shell, for example on Windows PowerShell:
   ```
   $env:GEMINI_API_KEYS="your_key_1,your_key_2"
   ```
4. Start the server from the repo root:
   ```
   uvicorn server.main:app --reload --port 8000
   ```
5. Load the extension: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the `extension/` folder.
6. Model files are stored with Git LFS. Run `git lfs pull` after cloning if the models look empty.

## Try it

1. Open the test range in Chrome (open the home page in `test_range/`).
2. Go to **Documents & Faces**, click the SuperNova icon and press **Run Local Vision AI**. The popup shows the original and the redacted screenshot, and the redaction summary.
3. Go to **Profile**, type `Go to shop page and add wireless headphones and canvas backpack to cart` and press **Execute Task (DOM)**.

## Pilot results

Small pilot on our own test range (4 pages), measured on a laptop with Chrome.

| Metric | Result |
|---|---|
| In-scope PII covered | 26 / 30 items (4 pages) |
| False redactions | 2 boxes |
| Tasks completed | 8 / 10 (both failures were Gemini API overload) |
| Client memory | about 514 MB idle, about 563 MB during vision |
| Latency per step | about 15-16 s vision path, about 10 s DOM path (about 7.4 s on-device) |
| Payload vs raw screenshot | 97 KB to 62 KB (about 36-39% smaller) |

## Known limitations

- Names, gender and addresses are not redacted yet.
- Latency is dominated by the cloud planner call; smaller or self-hosted models are planned.
- Chromium only (Manifest V3 offscreen API); Firefox port is on the roadmap.
- Small test sample; not a formal benchmark.

## Team

Team SuperNova: [add member names]. Team ID: [add ID].

## License

MIT, see `LICENSE`.
