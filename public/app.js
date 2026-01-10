// State
const state = {
  messages: [],
  isStreaming: false,
};

// DOM
const $ = (sel) => document.querySelector(sel);
const modelSelect = $("#model-select");
const systemToggle = $("#system-toggle");
const systemPanel = $("#system-panel");
const systemPrompt = $("#system-prompt");
const messagesEl = $("#messages");
const chatForm = $("#chat-form");
const input = $("#input");
const sendBtn = $("#send-btn");

// Toggle system panel
systemToggle.addEventListener("click", () => {
  systemPanel.classList.toggle("hidden");
  systemToggle.classList.toggle("active");
});

// Auto-resize input
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});

// Handle form submit
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.isStreaming) return;

  // Add user message
  addMessage("user", text);
  input.value = "";
  input.style.height = "auto";

  // Start streaming
  await streamResponse();
});

// Keyboard shortcut: Enter to send, Shift+Enter for newline
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

function addMessage(role, content) {
  state.messages.push({ role, content });
  renderMessage(role, content);
}

function renderMessage(role, content, isStreaming = false) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  if (isStreaming) div.classList.add("loading");
  div.innerHTML = formatContent(content);
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatContent(text) {
  if (!text) return "";

  // First escape HTML to prevent XSS
  let escaped = escapeHtml(text);

  // Then apply safe markdown transformations
  // Code blocks: ```code``` -> <pre><code>code</code></pre>
  escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${code}</code></pre>`;
  });

  // Inline code: `code` -> <code>code</code>
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs
  escaped = escaped
    .split('\n\n')
    .map(p => p.trim() ? `<p>${p}</p>` : '')
    .join('');

  return escaped;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function streamResponse() {
  state.isStreaming = true;
  sendBtn.disabled = true;

  // Create assistant message element
  const assistantDiv = renderMessage("assistant", "", true);
  let fullContent = "";
  let buffer = ""; // Buffer for incomplete SSE lines

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelSelect.value,
        system: systemPrompt.value,
        messages: state.messages,
      }),
    });

    // Check for error responses
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append to buffer and split on newlines
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Keep the last incomplete line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(line.slice(6));

          if (data.type === "delta") {
            fullContent += data.text;
            assistantDiv.innerHTML = formatContent(fullContent);
            scrollToBottom();
          } else if (data.type === "done") {
            // Cache info in usage
            if (data.usage?.cache_read_input_tokens) {
              console.log("Cache hit:", data.usage.cache_read_input_tokens, "tokens");
            }
          } else if (data.type === "error") {
            throw new Error(data.error);
          }
        } catch (e) {
          // Re-throw if it's our error, skip if JSON parse error
          if (e.message && !e.message.includes("JSON")) throw e;
        }
      }
    }

    // Process any remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const data = JSON.parse(buffer.slice(6));
        if (data.type === "delta") {
          fullContent += data.text;
          assistantDiv.innerHTML = formatContent(fullContent);
        }
      } catch {
        // Ignore incomplete final chunk
      }
    }

    // Save to state
    state.messages.push({ role: "assistant", content: fullContent });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    assistantDiv.innerHTML = formatContent(`Error: ${errorMsg}`);
  } finally {
    assistantDiv.classList.remove("loading");
    state.isStreaming = false;
    sendBtn.disabled = false;
    input.focus();
  }
}
