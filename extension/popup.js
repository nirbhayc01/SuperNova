// extension/popup.js

const scanBtn = document.getElementById("scanBtn");
const visionBtn = document.getElementById("visionBtn");
const taskInput = document.getElementById("taskInput");
const statusText = document.getElementById("statusText");
const statusSpinner = document.getElementById("statusSpinner");
const stateBadge = document.getElementById("stateBadge");
const agentToggle = document.getElementById("agentToggle");

// Load Agent Toggle State
chrome.storage.local.get(["agentEnabled"], (res) => {
  agentToggle.checked = res.agentEnabled !== false; // Default to true
});

agentToggle.addEventListener("change", (e) => {
  chrome.storage.local.set({ agentEnabled: e.target.checked });
  if (!e.target.checked) {
    chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Agent disabled.", state: "READY", isLoading: false });
  } else {
    // NEW: Force the agent back into a ready state so the buttons unlock
    chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Agent standing by.", state: "READY", isLoading: false });
  }
});

function setStatus(stateObj) {
  statusText.innerText = stateObj.step > 0 ? `Step ${stateObj.step}/10: ${stateObj.text}` : stateObj.text;
  stateBadge.innerText = stateObj.state;
  statusSpinner.style.display = stateObj.isLoading ? "block" : "none";
  
  const isDisabled = stateObj.isLoading || !agentToggle.checked;
  scanBtn.disabled = isDisabled;
  visionBtn.disabled = isDisabled;

  if (stateObj.state === "READY" || stateObj.state === "DONE") {
    stateBadge.style.color = "#34d399"; stateBadge.style.borderColor = "#059669";
  } else if (stateObj.state === "ERROR") {
    stateBadge.style.color = "#f87171"; stateBadge.style.borderColor = "#dc2626";
  } else {
    stateBadge.style.color = "#38bdf8"; stateBadge.style.borderColor = "#0284c7";
  }

  // Action Panel
  if (stateObj.lastAction && stateObj.lastReason) {
    document.getElementById("actionPanel").style.display = "block";
    document.getElementById("actionName").innerText = `Planned: ${stateObj.lastAction.toUpperCase()}`;
    document.getElementById("actionReason").innerText = stateObj.lastReason;
  } else {
    document.getElementById("actionPanel").style.display = "none";
  }

  // Redaction Panel
  if (stateObj.manifest) {
    document.getElementById("redactionPanel").style.display = "block";
    const cats = stateObj.manifest.categories || {};
    const parts = Object.keys(cats).map(k => `${cats[k].count} ${k}`);
    document.getElementById("redactionText").innerText = parts.length > 0 ? parts.join(", ") + " redacted" : "No PII found on screen";
    
    if (stateObj.thumbnails) {
      document.getElementById("thumbnails").style.display = "flex";
      document.getElementById("thumbBefore").src = stateObj.thumbnails.before;
      document.getElementById("thumbAfter").src = stateObj.thumbnails.after;
    } else {
      document.getElementById("thumbnails").style.display = "none";
    }
  } else {
    document.getElementById("redactionPanel").style.display = "none";
  }
}

chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
  if (response) setStatus(response);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS_UPDATE") setStatus(message);
});

scanBtn.addEventListener("click", async () => {
  if (!agentToggle.checked) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const task = taskInput.value.trim() || "Analyze screen and determine the next action.";
  if (!tab?.id) return;

  chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Extracting DOM...", state: "SCANNING", isLoading: true });

  try {
    await chrome.tabs.sendMessage(tab.id, { action: "START_SCAN", task, stepCount: 0 }); // Explicit 0 for new task
  } catch {
    chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Injecting script...", state: "INJECTING", isLoading: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["pii-patterns.js", "content.js"] });
    chrome.tabs.sendMessage(tab.id, { action: "START_SCAN", task, stepCount: 0 });
  }
});

visionBtn.addEventListener("click", () => {
  if (!agentToggle.checked) return;
  const task = taskInput.value.trim() || "Analyze the visual layout and determine the next action.";
  chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Capturing screen...", state: "VISION_ML", isLoading: true });
  chrome.runtime.sendMessage({ type: "RUN_VISION_FALLBACK", task: task });
}); 