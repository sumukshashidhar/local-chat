// ── Utilities ──

function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function debugLoggingEnabled() {
  try {
    return (
      localStorage.getItem("local-chat-debug") === "1" ||
      new URLSearchParams(window.location.search).has("debug")
    );
  } catch {
    return false;
  }
}

const DEBUG_LOGS = debugLoggingEnabled();

function logDebug(message, details) {
  if (!DEBUG_LOGS) return;
  console.debug("[local-chat]", message, details || "");
}

function logError(message, error) {
  console.error(`[local-chat] ${message}`, error);
}

function errorMessage(error, fallback = "Something went wrong") {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function readResponseError(response) {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;

  try {
    const data = JSON.parse(text);
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // Fall back to raw text below.
  }

  return text;
}

// ── State ──

const state = {
  sessionId: generateSessionId(),
  messages: [],
  isStreaming: false,
  abortController: null,
  thinkingEnabled: false,
  currentChatId: null,
  isDirty: false,
  savedChats: [],
  sidebarOpen: false,
};

// ── DOM Refs ──

const $ = (sel) => document.querySelector(sel);
const modelSearchInput = $("#model-search");
const modelSelect = $("#model-select");
const themeSelect = $("#theme-select");
const systemToggle = $("#system-toggle");
const systemPanel = $("#system-panel");
const systemPrompt = $("#system-prompt");
const messagesEl = $("#messages");
const chatForm = $("#chat-form");
const input = $("#input");
const sendBtn = $("#send-btn");
const thinkingToggle = $("#thinking-toggle");
const clearBtn = $("#clear-btn");
const overlay = $(".sidebar-overlay");
const toastsEl = $("#toasts");
const SEND_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STOP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>';
let allModels = [];
let allThemes = [];
let unsupportedThinkingModelWarned = "";

let sidebar, sidebarToggle, newChatBtn, chatList;

// ── Dialog API (replaces confirm/prompt/alert) ──

const AppDialog = (() => {
  const dialog = $("#app-dialog");
  const messageEl = dialog.querySelector(".dialog-message");
  const inputEl = dialog.querySelector(".dialog-input");
  const cancelBtn = dialog.querySelector(".dialog-cancel");
  const confirmBtn = dialog.querySelector(".dialog-confirm");
  let resolvePromise = null;

  cancelBtn.addEventListener("click", () => {
    const resolve = resolvePromise;
    resolvePromise = null;
    dialog.close();
    if (resolve) resolve(false);
  });

  dialog.addEventListener("close", () => {
    const resolve = resolvePromise;
    resolvePromise = null;
    if (resolve) resolve(false);
  });

  dialog.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const resolve = resolvePromise;
    resolvePromise = null;
    dialog.close();
    if (resolve) {
      if (inputEl.style.display !== "none") {
        resolve(inputEl.value);
      } else {
        resolve(true);
      }
    }
  });

  return {
    confirm(message, { danger = false } = {}) {
      return new Promise((resolve) => {
        resolvePromise = resolve;
        messageEl.textContent = message;
        inputEl.style.display = "none";
        cancelBtn.style.display = "";
        confirmBtn.textContent = "OK";
        confirmBtn.classList.toggle("danger", danger);
        dialog.showModal();
      });
    },

    prompt(message, defaultValue = "") {
      return new Promise((resolve) => {
        resolvePromise = resolve;
        messageEl.textContent = message;
        inputEl.style.display = "";
        inputEl.value = defaultValue;
        cancelBtn.style.display = "";
        confirmBtn.textContent = "Save";
        confirmBtn.classList.remove("danger");
        dialog.showModal();
        requestAnimationFrame(() => {
          inputEl.focus();
          inputEl.select();
        });
      });
    },
  };
})();

// ── Toasts ──

function showToast(message, type = "info", duration = 3000) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastsEl.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("visible"));
  });

  setTimeout(() => {
    toast.classList.remove("visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, duration);
}

// ── Content Formatting ──

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttribute(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeHref(href) {
  try {
    const url = new URL(href, window.location.origin);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return href;
    }
  } catch {
    // Invalid links are rendered inert.
  }

  return "#";
}

function formatContent(text) {
  if (!text) return "";

  // Extract code blocks BEFORE escaping so their contents stay raw
  const codeBlocks = [];
  let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\u0000CB${idx}\u0000`;
  });

  // Extract inline code before escaping
  const inlineCode = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000IC${idx}\u0000`;
  });

  // Now escape remaining text
  s = escapeHtml(s);

  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic
  s = s.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "<em>$1</em>");
  s = s.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "<em>$1</em>");

  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Headers
  s = s.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // Lists
  s = s.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  s = s.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  s = s.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Links
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label, href) =>
      `<a href="${escapeAttribute(safeHref(href))}" target="_blank" rel="noopener">${label}</a>`
  );

  // Horizontal rule
  s = s.replace(/^(-{3,}|\*{3,})$/gm, "<hr>");

  // Paragraphs
  s = s
    .split("\n\n")
    .map((p) => {
      p = p.trim();
      if (!p) return "";
      if (/^<(h[2-4]|ul|pre|hr)/.test(p) || p.includes("\u0000")) return p;
      return `<p>${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  // Restore code blocks and inline code
  codeBlocks.forEach((block, i) => {
    s = s.replace(`\u0000CB${i}\u0000`, block);
  });
  inlineCode.forEach((code, i) => {
    s = s.replace(`\u0000IC${i}\u0000`, code);
  });

  return s;
}

function cleanAssistantContent(text) {
  if (typeof text !== "string") return "";
  return text.replace(/<\/?response>/gi, "");
}

// ── Scroll Management ──

let shouldAutoScroll = true;

messagesEl.addEventListener("scroll", () => {
  const threshold = 60;
  shouldAutoScroll =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
    threshold;
});

function scrollToBottom(force = false) {
  if (force || shouldAutoScroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ── Message Rendering (Incremental) ──

function createMessageElement(role, content, index, animate = true) {
  const div = document.createElement("div");
  div.className = `message ${role}${animate ? " entering" : ""}`;
  div.dataset.index = index;
  div.tabIndex = 0;

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  if (role === "assistant") {
    contentDiv.innerHTML = formatContent(cleanAssistantContent(content).trim());
  } else {
    contentDiv.innerHTML = formatContent(content);
  }

  div.appendChild(contentDiv);

  const actionsDiv = document.createElement("div");
  actionsDiv.className = "message-actions";

  if (role === "user") {
    actionsDiv.innerHTML = `
      <button class="action-btn edit-btn" title="Edit">&#9998;</button>
      <button class="action-btn delete-btn" title="Delete">&times;</button>
    `;
  } else {
    actionsDiv.innerHTML = `
      <button class="action-btn edit-btn" title="Edit">&#9998;</button>
      <button class="action-btn retry-btn" title="Retry">&#8635;</button>
    `;
  }

  div.appendChild(actionsDiv);

  if (animate) {
    div.addEventListener("animationend", () => div.classList.remove("entering"), {
      once: true,
    });
  }

  return div;
}

function clearEmptyState() {
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
}

function showEmptyState() {
  if (messagesEl.querySelector(".empty-state")) return;
  if (messagesEl.querySelector(".message")) return;
  const div = document.createElement("div");
  div.className = "empty-state";
  div.textContent = "Start a conversation";
  messagesEl.appendChild(div);
}

function renderLoadedMessages() {
  messagesEl.innerHTML = "";

  if (state.messages.length === 0) {
    showEmptyState();
    return;
  }

  const fragment = document.createDocumentFragment();
  state.messages.forEach((msg, i) => {
    fragment.appendChild(createMessageElement(msg.role, msg.content, i, false));
  });
  messagesEl.appendChild(fragment);

  // Scroll to bottom after load
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    shouldAutoScroll = true;
  });
}

function appendMessage(role, content) {
  clearEmptyState();
  state.messages.push({ role, content });
  const el = createMessageElement(role, content, state.messages.length - 1, true);
  messagesEl.appendChild(el);
  scrollToBottom(true);
}

function removeMessagesFrom(index) {
  state.messages = state.messages.slice(0, index);
  const allMsgs = messagesEl.querySelectorAll(".message");
  for (let i = allMsgs.length - 1; i >= index; i--) {
    allMsgs[i].remove();
  }
  if (state.messages.length === 0) {
    showEmptyState();
  }
}

// ── Message Actions ──

messagesEl.addEventListener("click", async (e) => {
  if (state.isStreaming) return;

  const messageEl = e.target.closest(".message");
  if (!messageEl) return;

  if (e.target.closest("textarea")) return;

  const btn = e.target.closest(".action-btn");
  if (!btn) {
    messageEl.focus();
    return;
  }

  const index = parseInt(messageEl.dataset.index, 10);
  const isAssistant = messageEl.classList.contains("assistant");

  if (btn.classList.contains("delete-btn")) {
    removeMessagesFrom(index);
    triggerAutoSave();
  } else if (btn.classList.contains("edit-btn")) {
    startEdit(messageEl, index, isAssistant);
  } else if (btn.classList.contains("retry-btn")) {
    removeMessagesFrom(index);
    await streamResponse();
  }
});

function startEdit(messageEl, index, isAssistant = false) {
  const contentDiv = messageEl.querySelector(".message-content");
  const actionsDiv = messageEl.querySelector(".message-actions");
  const originalContent = state.messages[index].content;

  // Hide actions with opacity (no layout shift)
  actionsDiv.style.opacity = "0";
  actionsDiv.style.pointerEvents = "none";

  // Create textarea
  const textarea = document.createElement("textarea");
  textarea.className = "edit-textarea";
  textarea.value = originalContent;
  contentDiv.replaceWith(textarea);

  // Size and focus in next frame to avoid layout thrash
  requestAnimationFrame(() => {
    textarea.style.height = textarea.scrollHeight + "px";
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });

  let finished = false;
  const finishEdit = async (save) => {
    if (finished) return;
    finished = true;

    let shouldRegenerate = false;

    if (save) {
      const newContent = textarea.value.trim();
      if (newContent && newContent !== originalContent) {
        state.messages[index].content = newContent;
        if (!isAssistant) {
          removeMessagesFrom(index + 1);
          shouldRegenerate = true;
        }
      }
    }

    // Restore message in-place
    const role = isAssistant ? "assistant" : "user";
    const replacement = createMessageElement(
      role,
      state.messages[index].content,
      index,
      false
    );
    messageEl.replaceWith(replacement);

    triggerAutoSave();

    if (shouldRegenerate) {
      await streamResponse();
    }
  };

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finishEdit(true);
    } else if (e.key === "Escape") {
      finishEdit(false);
    }
  });

  textarea.addEventListener("blur", () => finishEdit(true));
}

function setSendButtonMode(mode) {
  const stopping = mode === "stop";
  sendBtn.classList.toggle("streaming", stopping);
  sendBtn.disabled = false;
  sendBtn.title = stopping ? "Stop generating" : "Send";
  sendBtn.setAttribute("aria-label", stopping ? "Stop generating" : "Send");
  sendBtn.innerHTML = stopping ? STOP_ICON : SEND_ICON;
}

function cancelCurrentStream() {
  if (!state.isStreaming || !state.abortController) return;
  state.abortController.abort();
}

// ── Streaming (rAF-batched) ──

async function streamResponse() {
  state.isStreaming = true;
  state.abortController = new AbortController();
  setSendButtonMode("stop");

  // Remember scroll position intent
  shouldAutoScroll = true;

  clearEmptyState();

  // Create assistant message element
  const index = state.messages.length;
  const assistantEl = document.createElement("div");
  assistantEl.className = "message assistant entering";
  assistantEl.dataset.index = index;
  assistantEl.tabIndex = 0;

  // Thinking section
  let thinkingSection = null;
  let thinkingContentDiv = null;
  if (state.thinkingEnabled) {
    thinkingSection = document.createElement("details");
    thinkingSection.className = "thinking-section";
    thinkingSection.open = true;
    thinkingSection.innerHTML = `
      <summary>Thinking<span class="thinking-indicator"></span></summary>
      <div class="thinking-content"></div>
    `;
    thinkingContentDiv = thinkingSection.querySelector(".thinking-content");
    assistantEl.appendChild(thinkingSection);
  }

  // Content container
  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";
  assistantEl.appendChild(contentDiv);

  // Loading indicator
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "loading-indicator";
  loadingDiv.innerHTML = "<span></span><span></span><span></span>";
  contentDiv.appendChild(loadingDiv);

  // Actions (will be usable after streaming)
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "message-actions";
  actionsDiv.innerHTML = `
    <button class="action-btn edit-btn" title="Edit">&#9998;</button>
    <button class="action-btn retry-btn" title="Retry">&#8635;</button>
  `;
  assistantEl.appendChild(actionsDiv);

  messagesEl.appendChild(assistantEl);
  scrollToBottom(true);

  let fullContent = "";
  let fullThinking = "";
  let buffer = "";
  let loadingRemoved = false;
  let streamDone = false;

  // rAF batching — at most one DOM update per frame
  let dirty = false;
  let rafId = null;

  function scheduleRender() {
    dirty = true;
    if (rafId) return;
    rafId = requestAnimationFrame(flushRender);
  }

  function flushRender() {
    rafId = null;
    if (!dirty) return;
    dirty = false;

    const renderedContent = cleanAssistantContent(fullContent);

    if (!loadingRemoved && (renderedContent || streamDone)) {
      loadingDiv.remove();
      loadingRemoved = true;
    }

    contentDiv.innerHTML = formatContent(renderedContent);

    if (thinkingContentDiv && fullThinking) {
      thinkingContentDiv.innerHTML = formatContent(fullThinking);
    }

    if (shouldAutoScroll) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function renderFinalContent() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    const renderedContent = cleanAssistantContent(fullContent).trim();

    if (!loadingRemoved) {
      loadingDiv.remove();
      loadingRemoved = true;
    }

    contentDiv.innerHTML = formatContent(renderedContent);

    if (thinkingContentDiv && fullThinking) {
      thinkingContentDiv.innerHTML = formatContent(fullThinking);
    }

    return renderedContent;
  }

  try {
    const selectedModel = modelSelect.value || modelSearchInput.value.trim();
    if (!selectedModel) {
      throw new Error("Select a model before sending");
    }
    if (!modelSelect.value && selectedModel) {
      ensureModelOption(selectedModel, `Custom: ${selectedModel}`);
      modelSelect.value = selectedModel;
    }
    const supportsThinking = modelSupportsThinking(selectedModel);
    if (state.thinkingEnabled && !supportsThinking && unsupportedThinkingModelWarned !== selectedModel) {
      showToast("Thinking is not supported by this model; sending normally.", "info", 3500);
      unsupportedThinkingModelWarned = selectedModel;
    }

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: state.abortController.signal,
      body: JSON.stringify({
        model: selectedModel,
        system: systemPrompt.value,
        messages: state.messages,
        session_id: state.sessionId,
        thinking: state.thinkingEnabled && supportsThinking
          ? { enabled: true, budget_tokens: 10000 }
          : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }

    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(line.slice(6));

          if (data.type === "thinking_delta") {
            fullThinking += data.thinking;
            scheduleRender();
          } else if (data.type === "delta") {
            fullContent += data.text;
            scheduleRender();
          } else if (data.type === "done") {
            streamDone = true;
            scheduleRender();

            if (thinkingSection) {
              const indicator =
                thinkingSection.querySelector(".thinking-indicator");
              if (indicator) indicator.classList.add("done");
              setTimeout(() => {
                thinkingSection.open = false;
              }, 400);
            }
            if (data.usage?.cache_read_input_tokens) {
              logDebug("Cache hit", {
                tokens: data.usage.cache_read_input_tokens,
              });
            }
          } else if (data.type === "error") {
            throw new Error(data.error);
          }
        } catch (e) {
          if (e instanceof Error && !e.message.includes("JSON")) throw e;
        }
      }
    }

    // Process remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const data = JSON.parse(buffer.slice(6));
        if (data.type === "delta") {
          fullContent += data.text;
        } else if (data.type === "thinking_delta") {
          fullThinking += data.thinking;
        }
      } catch {
        // Ignore
      }
    }

    renderFinalContent();
    state.messages.push({ role: "assistant", content: fullContent });
  } catch (error) {
    const cancelled =
      state.abortController?.signal.aborted ||
      (error instanceof Error && error.name === "AbortError");

    if (cancelled) {
      const renderedContent = renderFinalContent();
      if (renderedContent) {
        state.messages.push({ role: "assistant", content: fullContent });
        assistantEl.classList.add("cancelled");
      } else {
        assistantEl.remove();
        if (state.messages.length === 0) showEmptyState();
      }
      showToast("Response cancelled", "info", 2000);
    } else {
      // Remove dangling assistant element (no backing state entry)
      assistantEl.remove();
      if (state.messages.length === 0) showEmptyState();
      logError("Failed to get response", error);
      showToast(errorMessage(error, "Failed to get response"), "error", 5000);
    }
  } finally {
    if (rafId) {
      cancelAnimationFrame(rafId);
      dirty = false;
    }

    assistantEl.classList.remove("entering");
    state.isStreaming = false;
    state.abortController = null;
    setSendButtonMode("send");
    input.focus();

    triggerAutoSave({ immediate: true });
  }
}

// ── Chat Persistence ──

let saveTimeout = null;
const AUTOSAVE_DELAY = 2000;
const STREAMING_RETRY_DELAY = 500;
let isSaving = false;
let saveQueued = false;

function triggerAutoSave({ immediate = false } = {}) {
  if (state.messages.length === 0) return;

  state.isDirty = true;

  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(
    attemptAutoSave,
    immediate ? 0 : AUTOSAVE_DELAY
  );
}

async function attemptAutoSave() {
  if (state.messages.length === 0) return;
  if (state.isStreaming) {
    saveTimeout = setTimeout(attemptAutoSave, STREAMING_RETRY_DELAY);
    return;
  }
  await saveCurrentChat();
}

async function saveCurrentChat() {
  if (state.messages.length === 0) return;
  if (isSaving) {
    saveQueued = true;
    return;
  }

  const selectedModel = modelSelect.value || modelSearchInput.value.trim() || FALLBACK_MODEL;
  const payload = {
    id: state.currentChatId,
    title: null,
    sessionId: state.sessionId,
    provider: "openrouter",
    model: selectedModel,
    systemPrompt: systemPrompt.value,
    thinkingEnabled: state.thinkingEnabled,
    messages: state.messages,
  };

  isSaving = true;
  try {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      state.currentChatId = data.id;
      state.isDirty = false;

      // Update sidebar incrementally (no full rebuild)
      if (state.sidebarOpen) {
        updateChatInList({
          id: data.id,
          title: data.title,
          updatedAt: data.updatedAt,
          createdAt: data.createdAt,
        });
      }
    }
  } catch (e) {
    logError("Failed to save chat", e);
  } finally {
    isSaving = false;
    if (saveQueued) {
      saveQueued = false;
      triggerAutoSave({ immediate: true });
    }
  }
}

// ── Chat Loading ──

async function loadChat(chatId) {
  if (state.isStreaming) return;
  if (chatId === state.currentChatId) return;

  // Silent auto-save (no confirm dialog)
  if (state.isDirty && state.messages.length > 0) {
    await saveCurrentChat();
  }

  try {
    const res = await fetch(`/api/chats/${chatId}`);
    if (!res.ok) {
      showToast("Failed to load chat", "error");
      return;
    }

    const chat = await res.json();

    // Restore state
    state.currentChatId = chat.id;
    state.sessionId = chat.sessionId;
    state.messages = chat.messages;
    state.thinkingEnabled = chat.thinkingEnabled;
    state.isDirty = false;

    // Restore UI controls
    if (chat.model) {
      const selected = selectModel(chat.model);
      if (!selected) {
        ensureModelOption(chat.model, `Custom: ${chat.model}`);
        modelSelect.value = chat.model;
        modelSearchInput.value = chat.model;
      }
    }
    systemPrompt.value = chat.systemPrompt || "";
    thinkingToggle.checked = chat.thinkingEnabled;

    if (chat.systemPrompt) {
      systemPanel.classList.add("open");
      systemToggle.classList.add("active");
    } else {
      systemPanel.classList.remove("open");
      systemToggle.classList.remove("active");
    }

    // Render messages (batch, no animation)
    renderLoadedMessages();

    // Update active state in sidebar
    updateActiveChatItem();

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
      closeSidebar();
    }
  } catch (e) {
    logError("Failed to load chat", e);
    showToast("Failed to load chat", "error");
  }
}

async function startNewChat() {
  if (state.isStreaming) return;

  // Silent auto-save
  if (state.isDirty && state.messages.length > 0) {
    await saveCurrentChat();
  }

  state.sessionId = generateSessionId();
  state.messages = [];
  state.currentChatId = null;
  state.isDirty = false;

  messagesEl.innerHTML = "";
  showEmptyState();
  updateActiveChatItem();
  input.focus();
}

// ── Chat List ──

async function loadChatList() {
  try {
    const res = await fetch("/api/chats");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.savedChats = data.chats || [];
    renderChatList();
  } catch (e) {
    logError("Failed to load chat list", e);
  }
}

function renderChatList() {
  if (!chatList) return;

  if (state.savedChats.length === 0) {
    chatList.innerHTML = '<div class="empty-state" style="height:auto;padding:24px;font-size:13px">No saved chats</div>';
    return;
  }

  chatList.innerHTML = state.savedChats
    .map(
      (chat) => `
    <div class="chat-item ${chat.id === state.currentChatId ? "active" : ""}"
         data-chat-id="${chat.id}"
         tabindex="0">
      <div class="chat-item-content">
        <span class="chat-title">${escapeHtml(chat.title)}</span>
        <span class="chat-date">${formatDate(chat.updatedAt)}</span>
      </div>
      <div class="chat-item-actions">
        <button class="action-btn duplicate-btn" title="Duplicate">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="3" width="8" height="10" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M3 11V5.5C3 4.7 3.7 4 4.5 4H10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <button class="action-btn rename-btn" title="Rename">&#9998;</button>
        <button class="action-btn delete-btn" title="Delete">&times;</button>
      </div>
    </div>
  `
    )
    .join("");
}

function updateChatInList(chatData) {
  if (!chatList) return;

  const existingItem = chatList.querySelector(
    `[data-chat-id="${chatData.id}"]`
  );

  if (existingItem) {
    // Update existing item
    const titleEl = existingItem.querySelector(".chat-title");
    const dateEl = existingItem.querySelector(".chat-date");
    if (titleEl && chatData.title) titleEl.textContent = chatData.title;
    if (dateEl) dateEl.textContent = formatDate(chatData.updatedAt);

    // Move to top if not already there
    if (existingItem !== chatList.firstElementChild) {
      chatList.prepend(existingItem);
    }
  } else {
    // Create new item and prepend
    const temp = document.createElement("div");
    temp.innerHTML = `
      <div class="chat-item active" data-chat-id="${chatData.id}" tabindex="0">
        <div class="chat-item-content">
          <span class="chat-title">${escapeHtml(chatData.title || "New chat")}</span>
          <span class="chat-date">${formatDate(chatData.updatedAt)}</span>
        </div>
        <div class="chat-item-actions">
          <button class="action-btn duplicate-btn" title="Duplicate">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="3" width="8" height="10" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M3 11V5.5C3 4.7 3.7 4 4.5 4H10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          </button>
          <button class="action-btn rename-btn" title="Rename">&#9998;</button>
          <button class="action-btn delete-btn" title="Delete">&times;</button>
        </div>
      </div>
    `;
    const emptyState = chatList.querySelector(".empty-state");
    if (emptyState) emptyState.remove();
    chatList.prepend(temp.firstElementChild);
  }

  updateActiveChatItem();

  // Update cached state
  const idx = state.savedChats.findIndex((c) => c.id === chatData.id);
  if (idx >= 0) {
    state.savedChats[idx] = { ...state.savedChats[idx], ...chatData };
  } else {
    state.savedChats.unshift(chatData);
  }
}

function updateActiveChatItem() {
  if (!chatList) return;
  chatList.querySelectorAll(".chat-item").forEach((item) => {
    item.classList.toggle(
      "active",
      item.dataset.chatId === state.currentChatId
    );
  });
}

function formatDate(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;

  if (diff < 86400000) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (diff < 604800000) {
    return date.toLocaleDateString([], { weekday: "short" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ── Chat Actions ──

async function renameChat(chatId, newTitle) {
  try {
    const res = await fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    });

    if (res.ok) {
      const chat = state.savedChats.find((c) => c.id === chatId);
      if (chat) chat.title = newTitle;
    }
  } catch (e) {
    logError("Failed to rename chat", e);
    showToast("Failed to rename chat", "error");
  }
}

async function duplicateChat(chatId) {
  if (state.isStreaming) return;

  if (chatId === state.currentChatId && state.isDirty && state.messages.length > 0) {
    await saveCurrentChat();
  }

  try {
    const res = await fetch(`/api/chats/${chatId}/duplicate`, { method: "POST" });
    if (!res.ok) throw new Error(await readResponseError(res));

    const duplicate = await res.json();
    updateChatInList({
      id: duplicate.id,
      title: duplicate.title,
      updatedAt: duplicate.updatedAt,
      createdAt: duplicate.createdAt,
    });
    await loadChat(duplicate.id);
    showToast("Chat duplicated", "success");
  } catch (e) {
    logError("Failed to duplicate chat", e);
    showToast("Failed to duplicate chat", "error");
  }
}

function startRenameInline(chatId, titleEl) {
  const currentTitle = titleEl.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.value = currentTitle;
  input.className = "rename-input";
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;

    const newTitle = input.value.trim();
    if (save && newTitle && newTitle !== currentTitle) {
      await renameChat(chatId, newTitle);
    }

    const newTitleEl = document.createElement("span");
    newTitleEl.className = "chat-title";
    newTitleEl.textContent =
      save && newTitle ? newTitle : currentTitle;
    input.replaceWith(newTitleEl);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });

  input.addEventListener("blur", () => finish(true));
}

async function deleteChat(chatId) {
  const confirmed = await AppDialog.confirm("Delete this chat?", {
    danger: true,
  });
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
    if (res.ok) {
      state.savedChats = state.savedChats.filter((c) => c.id !== chatId);

      // Remove from sidebar with animation
      const item = chatList?.querySelector(`[data-chat-id="${chatId}"]`);
      if (item) {
        item.style.opacity = "0";
        item.style.transform = "translateX(-10px)";
        item.style.transition = `opacity var(--fast), transform var(--fast)`;
        item.addEventListener("transitionend", () => item.remove(), {
          once: true,
        });
      }

      if (chatId === state.currentChatId) {
        state.currentChatId = null;
        state.messages = [];
        state.isDirty = false;
        messagesEl.innerHTML = "";
        showEmptyState();
      }

      showToast("Chat deleted", "success");
    }
  } catch (e) {
    logError("Failed to delete chat", e);
    showToast("Failed to delete chat", "error");
  }
}

// ── Sidebar ──

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  sidebar.classList.toggle("open", state.sidebarOpen);
  overlay.classList.toggle("visible", state.sidebarOpen);
  if (state.sidebarOpen) {
    loadChatList();
  }
}

function closeSidebar() {
  state.sidebarOpen = false;
  sidebar.classList.remove("open");
  overlay.classList.remove("visible");
}

function initSidebar() {
  sidebar = $("#sidebar");
  sidebarToggle = $("#sidebar-toggle");
  newChatBtn = $("#new-chat-btn");
  chatList = $("#chat-list");

  if (!sidebar || !sidebarToggle) return;

  sidebarToggle.addEventListener("click", toggleSidebar);

  newChatBtn.addEventListener("click", () => {
    startNewChat();
    closeSidebar();
  });

  // Chat list event delegation
  chatList.addEventListener("click", async (e) => {
    const item = e.target.closest(".chat-item");
    if (!item) return;

    const chatId = item.dataset.chatId;

    if (e.target.closest(".delete-btn")) {
      e.stopPropagation();
      await deleteChat(chatId);
    } else if (e.target.closest(".duplicate-btn")) {
      e.stopPropagation();
      await duplicateChat(chatId);
    } else if (e.target.closest(".rename-btn")) {
      e.stopPropagation();
      const titleEl = item.querySelector(".chat-title");
      if (titleEl) startRenameInline(chatId, titleEl);
    } else {
      await loadChat(chatId);
    }
  });

  chatList.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest(".action-btn")) return;

    const item = e.target.closest(".chat-item");
    if (!item) return;

    e.preventDefault();
    await loadChat(item.dataset.chatId);
  });

  // Close sidebar on overlay click
  overlay.addEventListener("click", closeSidebar);

  // Escape to close sidebar
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.sidebarOpen) {
      closeSidebar();
    }
  });
}

// ── Event Listeners ──

// System panel toggle
systemToggle.addEventListener("click", () => {
  systemPanel.classList.toggle("open");
  systemToggle.classList.toggle("active");
});

// Thinking mode
thinkingToggle.addEventListener("change", () => {
  state.thinkingEnabled = thinkingToggle.checked;
  triggerAutoSave();
});

// Clear = new chat
clearBtn.addEventListener("click", () => startNewChat());

// Settings changes trigger save
modelSelect.addEventListener("change", () => {
  modelSearchInput.value = modelSelect.value;
  triggerAutoSave();
});
themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value);
});
systemPrompt.addEventListener("input", () => triggerAutoSave());

// Auto-resize input
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});

sendBtn.addEventListener("click", (e) => {
  if (!state.isStreaming) return;
  e.preventDefault();
  cancelCurrentStream();
});

// Form submit
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.isStreaming) return;

  appendMessage("user", text);
  input.value = "";
  input.style.height = "auto";

  await streamResponse();
});

// Enter to send, Shift+Enter for newline
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

// ── Model Loading ──

const FALLBACK_MODEL = "google/gemini-2.0-flash-001";
const LOCAL_THEME_ID = "local";
const THEME_STORAGE_KEY = "local-chat-theme";
const THEME_STYLESHEET_ID = "obsidian-theme-css";

function modelLabel(model) {
  if (!model.name || model.name === model.id) return model.id;
  return `${model.name} (${model.id})`;
}

function ensureModelOption(modelId, label = modelId) {
  let option = Array.from(modelSelect.options).find((o) => o.value === modelId);
  if (!option) {
    option = document.createElement("option");
    option.value = modelId;
    modelSelect.appendChild(option);
  }
  option.textContent = label;
  return option;
}

function modelSupportsThinking(modelId) {
  const model = allModels.find((m) => m.id === modelId);
  const params = model?.supported_parameters;
  if (!Array.isArray(params) || params.length === 0) return true;
  return params.includes("reasoning") || params.includes("include_reasoning");
}

function selectModel(modelId) {
  const id = (modelId || "").trim();
  if (!id) return false;

  const model = allModels.find((m) => m.id === id);
  if (!model) return false;

  ensureModelOption(model.id, modelLabel(model));
  modelSelect.value = model.id;
  modelSearchInput.value = model.id;
  return true;
}

function renderModelOptions(query = "") {
  const q = query.trim().toLowerCase();
  const selected = modelSelect.value;
  const filtered = q
    ? allModels.filter((m) =>
        m.id.toLowerCase().includes(q) ||
        (m.name || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      )
    : allModels;

  const options = filtered.slice(0, 300);
  modelSelect.innerHTML = "";
  for (const model of options) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = modelLabel(model);
    modelSelect.appendChild(option);
  }

  if (selected && options.some((m) => m.id === selected)) {
    modelSelect.value = selected;
    return;
  }
  if (options.length > 0) {
    modelSelect.value = options[0].id;
  }
}

function defaultModelId() {
  return (
    allModels.find((m) => m.id.startsWith("google/gemini"))?.id ||
    allModels[0]?.id ||
    FALLBACK_MODEL
  );
}

async function loadModels() {
  try {
    const res = await fetch("/api/models?limit=500");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allModels = Array.isArray(data.models) ? data.models : [];
    if (allModels.length === 0) {
      throw new Error("No OpenRouter models returned");
    }

    renderModelOptions();
    if (!selectModel(modelSelect.value)) {
      selectModel(defaultModelId());
    }
  } catch (e) {
    logError("Failed to load models", e);
    allModels = [];
    modelSelect.innerHTML = "";
    ensureModelOption(FALLBACK_MODEL);
    modelSelect.value = FALLBACK_MODEL;
    modelSearchInput.value = FALLBACK_MODEL;
  }
}

modelSearchInput.addEventListener("input", () => {
  renderModelOptions(modelSearchInput.value);
});

modelSearchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const query = modelSearchInput.value.trim();
  if (!query) return;

  if (!selectModel(query)) {
    ensureModelOption(query, `Custom: ${query}`);
    modelSelect.value = query;
  }
  triggerAutoSave();
});

modelSearchInput.addEventListener("blur", () => {
  if (!modelSelect.value) {
    selectModel(defaultModelId());
    return;
  }
  modelSearchInput.value = modelSelect.value;
});

// ── Theme Loading ──

function readSavedThemeId() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || LOCAL_THEME_ID;
  } catch {
    return LOCAL_THEME_ID;
  }
}

function saveThemeId(themeId) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    // Ignore storage errors.
  }
}

function getThemeLinkEl() {
  return document.getElementById(THEME_STYLESHEET_ID);
}

function ensureThemeLinkEl() {
  let link = getThemeLinkEl();
  if (link) return link;

  link = document.createElement("link");
  link.id = THEME_STYLESHEET_ID;
  link.rel = "stylesheet";
  document.head.appendChild(link);
  return link;
}

function themeExists(themeId) {
  return allThemes.some((theme) => theme.id === themeId);
}

function applyTheme(themeId, { persist = true } = {}) {
  const requested = (themeId || "").trim();
  const resolved = requested && requested !== LOCAL_THEME_ID && themeExists(requested)
    ? requested
    : LOCAL_THEME_ID;

  if (resolved === LOCAL_THEME_ID) {
    const link = getThemeLinkEl();
    if (link) link.remove();
    document.body.classList.remove("obsidian-theme", "theme-dark", "theme-light");
  } else {
    const link = ensureThemeLinkEl();
    link.href = `/api/themes/${encodeURIComponent(resolved)}.css`;
    document.body.classList.add("obsidian-theme", "theme-dark");
    document.body.classList.remove("theme-light");
  }

  themeSelect.value = resolved;
  if (persist) saveThemeId(resolved);
}

async function loadThemes() {
  themeSelect.innerHTML = "";
  const localOption = document.createElement("option");
  localOption.value = LOCAL_THEME_ID;
  localOption.textContent = "Theme: Local";
  themeSelect.appendChild(localOption);

  try {
    const res = await fetch("/api/themes?limit=100");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allThemes = Array.isArray(data.themes) ? data.themes : [];
    for (const theme of allThemes) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = `Theme: ${theme.name}`;
      themeSelect.appendChild(option);
    }
  } catch (error) {
    allThemes = [];
    logError("Failed to load themes", error);
  }

  applyTheme(readSavedThemeId(), { persist: false });
}

// ── Init ──

function init() {
  initSidebar();
  loadModels();
  loadThemes();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
