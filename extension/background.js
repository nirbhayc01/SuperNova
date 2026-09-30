// extension/background.js
const T = {};
const WS_URL = "ws://127.0.0.1:8000/ws";
let socket = null;
let messageQueue = [];

let agentState = { text: "Agent standing by.", state: "READY", isLoading: false, step: 0, manifest: null, thumbnails: null, lastAction: null, lastReason: null };
let currentTask = ""; 
let actionHistory = []; 
let lastPlannedAction = null; 
let lastActionRecorded = true; // NEW: History tracker flag

let isAgentEnabled = true;
chrome.storage.local.get(['agentEnabled'], (res) => {
  if (res.agentEnabled !== undefined) isAgentEnabled = res.agentEnabled;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.agentEnabled) isAgentEnabled = changes.agentEnabled.newValue;
});

function updateState(text, state, isLoading) {
  agentState.text = text;
  agentState.state = state;
  agentState.isLoading = isLoading;
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", ...agentState }, () => {
    let _ = chrome.runtime.lastError; 
  });
}

// NEW: Centralized history recorder
function recordAction(result) {
  if (!lastPlannedAction || lastActionRecorded) return;
  actionHistory.push({ action: lastPlannedAction, result });
  if (actionHistory.length > 5) actionHistory.shift();
  lastActionRecorded = true;
}

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(WS_URL);
  
  socket.onopen = () => {
    while(messageQueue.length > 0) socket.send(messageQueue.shift());
  };
  
  socket.onmessage = (event) => {
    if (!isAgentEnabled) return; 
    
    const data = JSON.parse(event.data);
    
    if (data.status === "error") {
      console.error("[SuperNova Background] Server Error:", data.error);
      updateState(`Error: ${data.error}`, "ERROR", false);
      return;
    }

    if (data.status === "action_planned") {
      T.planned = performance.now();
      console.log("[TIMING] server round trip ms (network + Gemini):", Math.round(T.planned - T.sent));
      console.log("[TIMING] TOTAL from click to plan ms:", Math.round(T.planned - (T.start || T.sent)));
      lastPlannedAction = data.action;
      lastActionRecorded = false; // NEW: Prime the recorder for the incoming action
      agentState.lastAction = data.action.action;
      agentState.lastReason = data.action.reason;
      
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ["pii-patterns.js", "content.js"] })
            .then(() => {
              chrome.tabs.sendMessage(tabs[0].id, { type: "EXECUTE_ACTION", action: data.action }, () => {
                let _ = chrome.runtime.lastError; 
              });
            }).catch(err => console.log("[SuperNova] Injection safe-skip:", err));
        }
      });
    }
  };
  
  socket.onclose = (event) => { 
    if (event.code === 1008) {
      console.error("[SuperNova Background] WebSocket closed by server: Unauthorized Origin.");
      updateState("Server rejected connection (Unauthorized Origin).", "ERROR", false);
    }
    socket = null; 
  };
  socket.onerror = (err) => { socket = null; };
}

function sendToServer(payload) {
  if (!isAgentEnabled) return;
  connectWebSocket();
  const dataStr = JSON.stringify(payload);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(dataStr);
  } else {
    messageQueue.push(dataStr);
  }
}

connectWebSocket();

let offscreenCreating = null;

async function setupOffscreenDocument(path) {
  const existingContexts = await chrome.runtime.getContexts({ 
    contextTypes: ['OFFSCREEN_DOCUMENT'], 
    documentUrls: [chrome.runtime.getURL(path)] 
  });
  if (existingContexts.length > 0) return;
  
  if (offscreenCreating) { 
    await offscreenCreating; 
    return; 
  }
  
  offscreenCreating = chrome.offscreen.createDocument({ 
    url: path, 
    reasons: ['WORKERS'], 
    justification: 'Run local ML models' 
  }).finally(() => { 
    offscreenCreating = null; 
  });
  
  await offscreenCreating;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse(agentState);
    return true;
  }
  
  if (message.type === "UPDATE_SERVER_STATE") {
    if (message.state === "DONE" || message.state === "READY" || message.state === "ERROR") {
        currentTask = "";
        actionHistory = [];
        lastPlannedAction = null;
        lastActionRecorded = true; // NEW: Reset recording flag on finish/error
        agentState.manifest = null;
        agentState.thumbnails = null;
        agentState.lastAction = null;
        agentState.lastReason = null;
        agentState.step = 0;
    }
    updateState(message.text, message.state, message.isLoading);
  }
  else if (message.type === "SEND_TO_SERVER") {
    if (!isAgentEnabled) return;
    if (!message.payload) {
      updateState("Context extraction failed.", "ERROR", false);
      sendResponse({ status: "error", error: "Null payload" });
      return;
    }
    currentTask = message.payload.task; 
    agentState.step = message.payload.stepCount !== undefined ? message.payload.stepCount : 1;
    agentState.manifest = message.payload.redactionManifest;
    agentState.thumbnails = null; 
    
    // NEW: Use the safe action recorder
    if (message.payload.last_action_result) recordAction(message.payload.last_action_result);
    message.payload.action_history = actionHistory;

    updateState("Context sent. AI planning...", "THINKING", true); 
    T.start = null;
    T.sent = performance.now();
    sendToServer(message.payload);
    sendResponse({ status: "Queued for server" });
  } 
  else if (message.type === "RUN_VISION_FALLBACK") {
    if (!isAgentEnabled) return;
    const userTask = message.task || "Process visual fallback";
    T.start = performance.now();

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        updateState("No active tab found.", "ERROR", false);
        return;
      }

      let domPayload = null;
      try {
        domPayload = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { action: "EXTRACT_DOM", task: userTask }, (res) => {
            if (chrome.runtime.lastError || !res?.payload) {
              chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["pii-patterns.js", "content.js"] })
                .then(() => {
                  chrome.tabs.sendMessage(tab.id, { action: "EXTRACT_DOM", task: userTask }, (retryRes) => {
                    resolve(retryRes?.payload || null);
                  });
                }).catch(() => resolve(null));
            } else {
              resolve(res.payload);
            }
          });
        });
      } catch (err) {
        console.warn("[SuperNova] Parallel DOM extraction fallback warning:", err);
      }

      chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 80 }, async (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          updateState("Screen capture failed.", "ERROR", false);
          return;
        }
        T.captured = performance.now();

        await setupOffscreenDocument('offscreen.html');
        chrome.runtime.sendMessage({ action: "ANALYZE_IMAGE", imageData: dataUrl }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[SuperNova Background] ANALYZE_IMAGE error:", chrome.runtime.lastError.message);
            updateState("Vision pipeline unreachable.", "ERROR", false);
            return;
          }
          if (!response || response.status !== "success") {
            updateState("Vision analysis failed.", "ERROR", false);
            return;
          }
          T.visionDone = performance.now();
          console.log("[TIMING] DOM+capture ms:", Math.round(T.captured - T.start));
          console.log("[TIMING] on-device vision+OCR+redaction ms:", Math.round(T.visionDone - T.captured));
          console.log("[SIZE] raw KB:", Math.round(dataUrl.length*0.75/1024), "redacted KB:", Math.round(response.redactedImage.length*0.75/1024));

          const domManifest = domPayload?.redactionManifest || { total: 0, categories: {} };
          const visionCategories = response.categories || {};
          const mergedCategories = {};
          
          Object.keys(domManifest.categories).forEach(cat => {
            mergedCategories[cat] = { count: domManifest.categories[cat].count, sources: [...domManifest.categories[cat].sources] };
          });
          Object.keys(visionCategories).forEach(cat => {
            if (mergedCategories[cat]) {
              mergedCategories[cat].count += visionCategories[cat].count;
              visionCategories[cat].sources.forEach(src => {
                if (!mergedCategories[cat].sources.includes(src)) mergedCategories[cat].sources.push(src);
              });
            } else {
              mergedCategories[cat] = { count: visionCategories[cat].count, sources: [...visionCategories[cat].sources] };
            }
          });

          // FIXED: Compute total directly from the merged counts instead of blindly adding OCR boxes
          let totalRedactedRegions = 0;
          Object.values(mergedCategories).forEach(cat => {
            totalRedactedRegions += cat.count;
          });

          // NEW: Use the safe action recorder
          if (domPayload?.last_action_result) recordAction(domPayload.last_action_result);

          agentState.step = domPayload?.stepCount !== undefined ? domPayload.stepCount : 1;
          agentState.thumbnails = { before: dataUrl, after: response.redactedImage };
          agentState.manifest = { total: totalRedactedRegions, categories: mergedCategories };

          const safePayload = {
            type: "context_update",
            task: userTask,
            dom: { tree: domPayload?.dom?.tree || [], redactedFields: domPayload?.dom?.redactedFields || [] },
            screenshot: response.redactedImage,
            action_history: actionHistory,
            redactionManifest: agentState.manifest
          };

          currentTask = userTask;
          updateState("Vision, DOM, and OCR context dispatched.", "THINKING", true);
          T.sent = performance.now();
          sendToServer(safePayload);
        });
      });
    });
    sendResponse({ status: "Processing hybrid context" });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    if (isAgentEnabled && agentState.state === "SCANNING" && currentTask !== "") {
      updateState("New page loaded. Resuming task...", "SCANNING", true);
      
      // NEW: Log the click that caused this cross-page navigation
      recordAction({ success: true, executed_action: lastPlannedAction?.action, note: "Page navigated after this action" });

      setTimeout(() => {
        chrome.scripting.executeScript({ target: { tabId }, files: ["pii-patterns.js", "content.js"] })
          .then(() => {
            chrome.tabs.sendMessage(tabId, { action: "START_SCAN", task: currentTask, stepCount: agentState.step }, () => {
               let _ = chrome.runtime.lastError;
            });
          })
          .catch(err => console.log("[SuperNova] Auto-resume injection skipped:", err));
      }, 1500);
    }
  }
});

// NEW: Warm-up offscreen document instantly so Vision AI doesn't timeout on the first run
setupOffscreenDocument('offscreen.html').catch(e => console.warn("[SuperNova] Offscreen warm-up failed:", e));