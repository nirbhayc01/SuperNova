// extension/content.js

if (!window.supernovaAgentInjected) {
  window.supernovaAgentInjected = true;
  window.activeTask = "";
  window.stepCount = 0;
  window.MAX_STEPS = 10;
  window.lastActionSignature = "";
  window.duplicateActionCount = 0;
  
  // Navigation locks to prevent Race Conditions
  window.isNavigating = false;
  window.nextStepTimer = null;

  function showAgentToast(message, color = "#38bdf8") {
    let toast = document.getElementById("supernova-agent-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "supernova-agent-toast";
      toast.style.position = "fixed";
      toast.style.bottom = "20px";
      toast.style.right = "20px";
      toast.style.zIndex = "2147483647";
      toast.style.background = "rgba(15, 23, 42, 0.95)";
      toast.style.color = "#f8fafc";
      toast.style.padding = "10px 16px";
      toast.style.borderRadius = "8px";
      toast.style.boxShadow = "0 8px 24px rgba(0,0,0,0.3)";
      toast.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      toast.style.fontSize = "12px";
      toast.style.fontWeight = "600";
      toast.style.display = "flex";
      toast.style.alignItems = "center";
      toast.style.gap = "8px";
      toast.style.border = `1px solid ${color}`;
      toast.style.transition = "all 0.3s ease";
      document.body.appendChild(toast);
    }
    toast.style.borderColor = color;
    toast.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span> ${message}`;
    
    if (window.supernovaToastTimer) clearTimeout(window.supernovaToastTimer);
    window.supernovaToastTimer = setTimeout(() => { toast?.remove(); }, 4000);
  }

  function generateSelector(el, index) {
    el.setAttribute("data-supernova-id", index.toString());
    return `[data-supernova-id="${index}"]`;
  }

  // Stage 3: Live DOM Text Node Scrubber
  function scrubLiveTextNodes() {
    let categoryCounts = {};
    PII_PATTERNS.forEach(p => categoryCounts[p.name] = 0);
    let totalRedacted = 0;
    
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    
    while ((node = walker.nextNode())) {
      if (node.parentElement && ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) continue;

      let text = node.nodeValue;
      let nodeChanged = false;

      PII_PATTERNS.forEach(pattern => {
        const matches = text.match(pattern.regex);
        if (matches) {
          categoryCounts[pattern.name] += matches.length;
          totalRedacted += matches.length;
          text = text.replace(pattern.regex, pattern.placeholder);
          nodeChanged = true;
        }
      });

      if (nodeChanged) {
        node.nodeValue = text;
      }
    }
    
    return { categoryCounts, totalRedacted };
  }

 function extractAndRedactDOM(task) {
    try {
      showAgentToast(`SuperNova: Step ${window.stepCount + 1}/${window.MAX_STEPS} - Analyzing DOM...`, "#38bdf8");
      
      document.querySelectorAll("[data-supernova-id]").forEach(el => el.removeAttribute("data-supernova-id"));

      const textRedactionStats = scrubLiveTextNodes();
      
      // 1. Gather raw elements and viewport boundaries
      const rawElements = Array.from(document.querySelectorAll("button, a, input, select, textarea, [role='button'], [tabindex='0']"));
      const inViewport = [];
      const outOfViewport = [];
      
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;

      // 2. Filter hidden elements and categorize by viewport presence
      rawElements.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

        const isVisible = (rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0);
        if (isVisible) {
          inViewport.push({ el, rect });
        } else {
          outOfViewport.push({ el, rect });
        }
      });

      // 3. Prioritize viewport elements, then fill the remainder up to the 60 cap
      const prioritizedElements = [...inViewport, ...outOfViewport].slice(0, 60);

      const tree = [];
      const domCategories = {};
      let totalRedacted = textRedactionStats.totalRedacted;

      Object.keys(textRedactionStats.categoryCounts).forEach(cat => {
        if (textRedactionStats.categoryCounts[cat] > 0) {
          domCategories[cat] = { count: textRedactionStats.categoryCounts[cat], sources: ["dom"] };
        }
      });

      function addRedaction(name, count = 1) {
        if (!domCategories[name]) domCategories[name] = { count: 0, sources: ["dom"] };
        domCategories[name].count += count;
        totalRedacted += count;
      }

      // 4. Process, Redact, and Stamp ONLY the selected elements
      prioritizedElements.forEach((item, index) => {
        const { el, rect } = item;
        const tag = el.tagName.toLowerCase();
        const inputType = el.getAttribute("type") || "";
        const autocomplete = el.getAttribute("autocomplete") || "";
        let textContent = el.innerText || el.getAttribute("value") || el.getAttribute("placeholder") || "";
        let ariaLabel = el.getAttribute("aria-label") || "";
        let isRedacted = false;

        if (inputType === "password") {
          textContent = "[PASSWORD]"; isRedacted = true;
          addRedaction("password");
        } else if (inputType === "email" || autocomplete.includes("email")) {
          textContent = "[EMAIL]"; isRedacted = true;
          addRedaction("email");
        }

        PII_PATTERNS.forEach(pattern => {
          const textMatches = textContent.match(pattern.regex);
          if (textMatches) {
            addRedaction(pattern.name, textMatches.length);
            textContent = textContent.replace(pattern.regex, pattern.placeholder);
            isRedacted = true;
          }

          const ariaMatches = ariaLabel.match(pattern.regex);
          if (ariaMatches) {
            addRedaction(pattern.name, ariaMatches.length);
            ariaLabel = ariaLabel.replace(pattern.regex, pattern.placeholder);
            isRedacted = true;
          }
        });

        tree.push({
          id: index,
          tag: tag,
          selector: generateSelector(el, index), // Stamp applied here
          role: el.getAttribute("role") || tag,
          ariaLabel: ariaLabel,
          text: textContent.trim().slice(0, 100),
          bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          redacted: isRedacted
        });
      });

      return {
        type: "context_update",
        task: task || window.activeTask,
        stepCount: window.stepCount + 1,
        dom: { tree: tree, redactedFields: Object.keys(domCategories) },
        screenshot: null,
        redactionManifest: { 
          total: totalRedacted, 
          categories: domCategories 
        }
      };
    } catch (err) {
      console.error("[SuperNova Content] extractAndRedactDOM error:", err);
      return null;
    }
  }

  function submitActiveOrTarget(element) {
    if (!element) return;
    const enterDown = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
    const enterPress = new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
    const enterUp = new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
    
    element.dispatchEvent(enterDown);
    element.dispatchEvent(enterPress);
    element.dispatchEvent(enterUp);

    const parentForm = element.closest("form");
    if (parentForm) {
      try { parentForm.requestSubmit(); } catch { parentForm.submit(); }
    }
  }
  
  function triggerNextStep(lastActionResult = null) {
    try {
      if (window.isNavigating) return; // Abort if page is dying

      window.stepCount++;
      if (window.stepCount >= window.MAX_STEPS) {
        showAgentToast(`SuperNova: Reached step limit (${window.MAX_STEPS}). Stopping.`, "#f59e0b");
        window.activeTask = "";
        chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Task finished (Max steps reached).", state: "DONE", isLoading: false });
        return;
      }

      // Assign to tracker so we can cancel it if navigation occurs
      window.nextStepTimer = setTimeout(() => {
        try {
          if (window.isNavigating) return; // Double-check safety
          
          // Ensure popup doesn't hang if a task dies unexpectedly
          if (!window.activeTask) {
            chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Agent standing by.", state: "READY", isLoading: false });
            return;
          }
          
          const nextPayload = extractAndRedactDOM(window.activeTask);
          if (lastActionResult) {
            nextPayload.last_action_result = lastActionResult;
          }
          chrome.runtime.sendMessage({ type: "SEND_TO_SERVER", payload: nextPayload });
        } catch (err) {
          console.error("[SuperNova Content] Timer execution error:", err);
          window.activeTask = "";
          chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Error during next step: " + err.message, state: "ERROR", isLoading: false });
        }
      }, 2500);
    } catch (err) {
      console.error("[SuperNova Content] triggerNextStep error:", err);
      window.activeTask = "";
      chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Error triggering next step: " + err.message, state: "ERROR", isLoading: false });
    }
  }

 function executeBrowserAction(action) {
    try {
      if (window.isNavigating) return; // Abort if page is dying

      console.log("[SuperNova Content] Executing planned action:", action);

      if (action.action === "done") {
        showAgentToast("SuperNova: Task completed successfully!", "#10b981");
        window.activeTask = ""; window.stepCount = 0; window.lastActionSignature = ""; window.duplicateActionCount = 0;
        chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Task completed!", state: "DONE", isLoading: false });
        return;
      }

      // 1. Resolve target element early so we can inspect it for the safety gate
      let targetElement = null;
      if (action.selector) {
        try { targetElement = document.querySelector(action.selector); } catch (e) { console.error("[SuperNova Content] querySelector error:", e); }
      }

      // 2. NEW: Client-side Safety Gate
      const riskyWords = /\b(pay|buy|purchase|order|delete|remove|submit|confirm|transfer|send)\b/i;
      let needsSafetyGate = action.action === "ask_confirmation" || action.requires_confirmation === true;
      let safetyReason = action.reason;

      if (action.action === "navigate") {
        needsSafetyGate = true;
        safetyReason = "Agent requested cross-site navigation.";
      } else if (targetElement && (action.action === "click" || action.action === "type")) {
        const elText = (targetElement.innerText || targetElement.value || targetElement.placeholder || "").toLowerCase();
        const elAria = (targetElement.getAttribute("aria-label") || "").toLowerCase();
        
        if (riskyWords.test(elText) || riskyWords.test(elAria)) {
          needsSafetyGate = true;
          safetyReason = `Target element contains sensitive keywords indicating an irreversible action.`;
        }
      }

      if (needsSafetyGate) {
        showAgentToast("SuperNova: Awaiting user confirmation...", "#f59e0b");
        const proceed = confirm(`[SuperNova Safety Gate]\n\nReason: ${safetyReason}\nAction: ${action.action.toUpperCase()} on target: ${action.selector || action.value || "Screen Coordinates"}\n\nDo you want to proceed?`);
        if (!proceed) {
          showAgentToast("SuperNova: Action canceled by user.", "#f87171");
          window.activeTask = "";
          chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Action canceled.", state: "READY", isLoading: false });
          return;
        }
      }

      // FIXED: Short-circuit and proceed to next step if the user approved an ask_confirmation action
      if (action.action === "ask_confirmation") {
        showAgentToast("SuperNova: Action confirmed, proceeding...", "#34d399");
        setTimeout(() => triggerNextStep({ success: true, executed_action: "ask_confirmation" }), 600);
        return;
      }

      // 3. Duplicate Action Signature
      const actionSig = `${action.action}-${action.selector}-${action.value}-${window.location.href}-${Math.round(window.scrollY)}`;
      if (window.lastActionSignature === actionSig) {
        window.duplicateActionCount++;
        const activeEl = document.activeElement;
        if (window.duplicateActionCount >= 2 && activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
          submitActiveOrTarget(activeEl);
        }

        showAgentToast("SuperNova: No visible change. Requesting new plan...", "#f59e0b");
        triggerNextStep({ success: false, reason: `Repeated action '${action.action}' on '${action.selector}' resulted in no visible change. Try another selector, scroll, or choose another step.`, failed_action: action });
        return;
      }
      window.lastActionSignature = actionSig;
      window.duplicateActionCount = 0;

      // 4. Execute Actions
      if (action.action === "scroll") {
        showAgentToast("SuperNova: Scrolling page...", "#38bdf8");
        if (targetElement) {
          try { targetElement.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { console.error("[SuperNova Content] Scroll into view error:", e); }
        } else {
          const direction = (action.value && action.value.toLowerCase() === "up") ? -window.innerHeight * 0.75 : window.innerHeight * 0.75;
          window.scrollBy({ top: direction, behavior: "smooth" });
        }
        setTimeout(() => triggerNextStep({ success: true, executed_action: "scroll" }), 800);
        return;
      }

      if (action.action === "navigate") {
        let targetUrl = (action.value || "").trim();
        if (!targetUrl) {
          triggerNextStep({ success: false, reason: "No destination URL provided." });
          return;
        }
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
        showAgentToast(`SuperNova: Navigating to ${targetUrl}...`, "#38bdf8");
        window.location.href = targetUrl;
        return;
      }

      showAgentToast(`SuperNova: Executing ${action.action}...`, "#34d399");

      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
        const originalOutline = targetElement.style.outline;
        targetElement.style.outline = "3px solid #00e676";

        setTimeout(() => {
          try {
            if (window.isNavigating) return;

            targetElement.style.outline = originalOutline;

            if (action.action === "click") {
              targetElement.click();
              targetElement.focus();
              const isSearchElement = targetElement.type === "submit" || targetElement.closest("form") || (action.selector && action.selector.toLowerCase().includes("search"));
              if (isSearchElement) submitActiveOrTarget(targetElement);
            } 
            else if (action.action === "type" && action.value) {
              targetElement.focus();
              let textToType = action.value;
              let wantsSubmit = false;

              if (textToType.includes("\\n") || textToType.includes("\n")) {
                textToType = textToType.replace(/\\n/g, "").replace(/\n/g, "");
                wantsSubmit = true;
              }

              targetElement.value = textToType;
              targetElement.dispatchEvent(new Event("input", { bubbles: true }));
              targetElement.dispatchEvent(new Event("change", { bubbles: true }));

              const tag = targetElement.tagName.toLowerCase();
              const isSearchField = tag === "input" && (
                targetElement.type === "search" || 
                targetElement.name.toLowerCase().includes("q") || 
                targetElement.name.toLowerCase().includes("search") || 
                targetElement.id.toLowerCase().includes("search") ||
                (targetElement.placeholder && targetElement.placeholder.toLowerCase().includes("search"))
              );

              if (wantsSubmit || isSearchField) {
                setTimeout(() => submitActiveOrTarget(targetElement), 400);
              }
            }

            triggerNextStep({ success: true, executed_action: action.action });
          } catch (innerErr) {
            console.error("[SuperNova Content] Action execution timeout error:", innerErr);
            triggerNextStep({ success: false, reason: "Error executing action: " + innerErr.message });
          }
        }, 600);
      } else {
        console.warn(`[SuperNova] Selector '${action.selector}' not found in DOM.`);
        showAgentToast(`SuperNova: Element not found (${action.selector})`, "#f87171");
        triggerNextStep({ success: false, reason: `Target element '${action.selector}' was not found in the DOM. Try scrolling or an alternative element.`, failed_action: action });
      }
    } catch (err) {
      console.error("[SuperNova Content] executeBrowserAction error:", err);
      triggerNextStep({ success: false, reason: "Fatal error in action execution: " + err.message });
    }
  }

  // Hard lock the agent when the page begins unloading
  window.addEventListener("beforeunload", () => {
    window.isNavigating = true; 
    if (window.nextStepTimer) clearTimeout(window.nextStepTimer); // Kill any pending scans immediately

    if (window.activeTask) {
      chrome.runtime.sendMessage({
        type: "UPDATE_SERVER_STATE",
        text: "Navigation detected. Resuming on new page...",
        state: "SCANNING",
        isLoading: true
      }, () => {
        let _ = chrome.runtime.lastError;
      });
    }
  });

 chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.action === "START_SCAN") {
        window.isNavigating = false;
        window.activeTask = message.task;
        window.stepCount = message.stepCount !== undefined ? message.stepCount : 0; // Don't blind-reset
        window.lastActionSignature = "";
        window.duplicateActionCount = 0;
        
        const payload = extractAndRedactDOM(message.task);
        if (payload) chrome.runtime.sendMessage({ type: "SEND_TO_SERVER", payload: payload });
        sendResponse({ status: "Scan dispatched" });
      } else if (message.action === "EXTRACT_DOM") {
        if (message.task && window.activeTask !== message.task) {
          window.activeTask = message.task;
          window.stepCount = message.stepCount !== undefined ? message.stepCount : 0;
          window.lastActionSignature = "";
          window.duplicateActionCount = 0;
          window.isNavigating = false;
        }
        sendResponse({ status: "success", payload: extractAndRedactDOM(window.activeTask), stepCount: window.stepCount });
      } else if (message.type === "EXECUTE_ACTION") {
        executeBrowserAction(message.action);
        sendResponse({ status: "Action handled" });
      }
    } catch (err) {
      console.error("[SuperNova Content] Message listener error:", err);
      window.activeTask = "";
      chrome.runtime.sendMessage({ type: "UPDATE_SERVER_STATE", text: "Error handling message: " + err.message, state: "ERROR", isLoading: false });
      sendResponse({ status: "error", error: err.message });
    }
  });
}