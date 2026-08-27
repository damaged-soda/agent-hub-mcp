(() => {
  "use strict";

  const LONG_TEXT_CHARACTERS = 320;
  const LONG_TEXT_LINES = 6;
  const LONG_TEXT_PREVIEW_CHARACTERS = 160;

  const state = {
    sessions: [],
    selected: null,
    profile: "inspect",
    events: [],
    nextSequence: 0,
    hasMore: false,
    loading: false,
    loadToken: 0,
    expandedDetails: new Set(),
  };

  const listRoot = document.querySelector("#session-list");
  const countRoot = document.querySelector("#session-count");
  const detailRoot = document.querySelector("#detail");
  const providerFilter = document.querySelector("#provider-filter");
  const searchInput = document.querySelector("#session-search");
  const refreshButton = document.querySelector("#refresh-button");
  const apiListUrl = new URL("api/sessions", document.baseURI);
  const apiItemRoot = new URL(`${apiListUrl.href}/`);

  providerFilter.addEventListener("change", renderSessionList);
  searchInput.addEventListener("input", renderSessionList);
  refreshButton.addEventListener("click", refreshSessions);

  refreshSessions();

  async function refreshSessions() {
    refreshButton.disabled = true;
    refreshButton.textContent = "刷新中";
    try {
      const url = new URL(apiListUrl);
      url.searchParams.set("limit", "200");
      const response = await fetch(url, { cache: "no-store" });
      const document = await response.json();
      if (!response.ok || document.kind !== "agent-session-list") {
        throw new Error(document.error?.message || "会话目录不可用");
      }
      state.sessions = Array.isArray(document.data) ? document.data : [];
      renderSessionList();
    } catch (error) {
      listRoot.replaceChildren(errorBox(error.message));
      countRoot.textContent = "加载失败";
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "刷新";
    }
  }

  function renderSessionList() {
    const provider = providerFilter.value;
    const query = searchInput.value.trim().toLowerCase();
    const sessions = state.sessions.filter((session) => {
      if (provider && session.provider !== provider) return false;
      if (!query) return true;
      return [session.title, session.provider, session.native_session_id, session.cwd, session.source_kind]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
    countRoot.textContent = `${sessions.length} / ${state.sessions.length} sessions`;
    listRoot.replaceChildren();
    if (sessions.length === 0) {
      listRoot.append(el("div", "unknown", "没有匹配的会话"));
      return;
    }
    for (const session of sessions) {
      const button = el("button", "session-row");
      button.type = "button";
      button.classList.toggle("is-selected", sameSession(session, state.selected));
      const top = el("span", "session-row-top");
      top.append(
        el("span", "session-provider", session.provider),
        el("span", "session-age", relativeTime(session.updated_at)),
      );
      const title = el("span", "session-title", sessionDisplayTitle(session));
      const cwd = el("span", "session-cwd", session.cwd || "cwd unknown");
      cwd.title = session.cwd || "";
      const id = el("span", "session-id", session.native_session_id);
      id.title = session.native_session_id;
      button.append(top, title, cwd, id);
      button.addEventListener("click", () => selectSession(session));
      listRoot.append(button);
    }
  }

  async function selectSession(session) {
    state.selected = session;
    state.profile = "inspect";
    state.events = [];
    state.nextSequence = 0;
    state.hasMore = false;
    state.expandedDetails.clear();
    renderSessionList();
    renderDetailLoading();
    await loadEvents(false);
  }

  async function loadEvents(append) {
    if (!state.selected) return;
    const loadToken = ++state.loadToken;
    state.loading = true;
    const after = append ? state.nextSequence : 0;
    try {
      const session = state.selected;
      const url = new URL(
        `${encodeURIComponent(session.provider)}/${encodeURIComponent(session.native_session_id)}`,
        apiItemRoot,
      );
      url.searchParams.set("profile", state.profile);
      url.searchParams.set("after", String(after));
      url.searchParams.set("limit", "200");
      const response = await fetch(url, { cache: "no-store" });
      const document = await response.json();
      if (loadToken !== state.loadToken) return;
      if (!response.ok || document.kind !== "agent-session-inspect") {
        throw new Error(document.error?.message || "会话读取失败");
      }
      state.events = append ? state.events.concat(document.data || []) : document.data || [];
      state.nextSequence = document.next_sequence ?? after;
      state.hasMore = document.has_more === true;
      state.selected = document.session || session;
      renderDetail();
      renderSessionList();
    } catch (error) {
      if (loadToken !== state.loadToken) return;
      detailRoot.replaceChildren(errorBox(error.message));
    } finally {
      if (loadToken === state.loadToken) state.loading = false;
    }
  }

  function renderDetailLoading() {
    detailRoot.replaceChildren(el("div", "empty-state", "正在读取会话证据…"));
  }

  function renderDetail() {
    const session = state.selected;
    detailRoot.replaceChildren();

    const header = el("div", "detail-header");
    const heading = el("div", "detail-heading");
    heading.append(
      el("div", "eyebrow", `${session.provider} · ${session.source_kind}`),
      el("h2", "", sessionDisplayTitle(session)),
      el("div", "detail-cwd", session.cwd || "cwd unknown"),
      el("div", "detail-path", session.source_path),
    );
    const actions = el("div", "detail-actions");
    const contentButton = el(
      "button",
      state.profile === "inspect" ? "button-warning" : "button-primary",
      state.profile === "inspect" ? "切换为脱正文" : "显示全部明细",
    );
    contentButton.type = "button";
    contentButton.addEventListener("click", toggleContent);
    const reloadButton = el("button", "", "重读");
    reloadButton.type = "button";
    reloadButton.addEventListener("click", () => loadEvents(false));
    actions.append(contentButton, reloadButton);
    header.append(heading, actions);
    detailRoot.append(header);

    const notice = el("div", "content-notice");
    if (state.profile === "inspect") {
      notice.append(
        el("strong", "", "正文已显示。"),
        document.createTextNode(
          " 当前响应可能包含 system/developer/user prompt、assistant 文本、tool arguments 与结果；服务端禁止缓存，但请勿截图或转发敏感内容。过长字段会有界截断，并在事件明细中标出原始大小和截断位置。",
        ),
      );
    } else {
      notice.append(
        el("strong", "", "默认脱正文。"),
        document.createTextNode(
          " 当前只读取结构、字节数、模型、权限、工具名与 provenance；需要时再显式显示正文。",
        ),
      );
    }
    detailRoot.append(notice);

    const context = latestContext(state.events);
    const usedTools = distinct(
      state.events.filter((event) => event.kind === "tool-call").map((event) => event.data?.tool_name),
    );
    const availableTools = toolNames(context.values.tools);
    const messages = state.events.filter((event) => event.kind === "message");
    const calls = state.events.filter((event) => event.kind === "model-call");
    const resourceAccesses = state.events.flatMap((event) => event.data?.resource_accesses || []);
    const summary = el("div", "summary-grid");
    summary.append(
      summaryCard("events", `${state.events.length}${state.hasMore ? "+" : ""}`),
      summaryCard("messages", String(messages.length)),
      summaryCard("tools used", String(usedTools.length)),
      summaryCard("model calls", String(calls.length)),
      summaryCard("file reads", String(resourceAccesses.filter((item) => item.operation === "read").length)),
      summaryCard("file writes", String(resourceAccesses.filter((item) => item.operation === "write").length)),
    );
    detailRoot.append(summary);

    detailRoot.append(renderEvidence(context));
    detailRoot.append(renderTools(availableTools, usedTools));
    detailRoot.append(renderTimeline());
  }

  function renderEvidence(context) {
    const section = el("section", "section");
    const heading = sectionHeading(
      "上下文证据",
      "requested / launched 将在有编排关联时出现；原生会话至少保留 observed / unknown",
    );
    const table = el("div", "evidence-table");
    const definitions = [
      ["model", "模型"],
      ["effort", "推理强度"],
      ["permission", "权限模式"],
      ["sandbox", "沙箱"],
      ["entrypoint", "入口"],
      ["branch", "分支"],
      ["system_instructions", "system instructions"],
      ["system_instruction_bytes", "system prompt 大小"],
      ["context_summary_bytes", "context summary 大小"],
    ];
    const labels = new Map(definitions);
    const keys = [...definitions.map(([key]) => key),
      ...Object.keys(context.values).filter((key) => !labels.has(key)).sort()];
    for (const key of keys) {
      const label = labels.get(key) || key;
      const evidence = context.evidence.get(key);
      let value = context.values[key];
      if (key.endsWith("_bytes") && Number.isFinite(value)) value = `${formatNumber(value)} bytes`;
      table.append(evidenceRow(key, label, value, evidence));
    }
    section.append(heading, table);
    return section;
  }

  function renderTools(available, used) {
    const section = el("section", "section");
    const panels = el("div", "tool-groups");
    panels.append(toolPanel("观测到的可用工具", available), toolPanel("本段实际调用", used));
    section.append(sectionHeading("工具面", "available 与 used 分开，不用实际调用反推可用清单"), panels);
    return section;
  }

  function renderTimeline() {
    const section = el("section", "section");
    const timeline = el("div", "timeline");
    if (state.events.length === 0) {
      timeline.append(el("div", "unknown", "当前游标范围没有可投影事件"));
    }
    for (const event of state.events) timeline.append(eventCard(event));
    section.append(sectionHeading("会话时间线", `profile=${state.profile}`), timeline);
    if (state.hasMore) {
      const button = el("button", "load-more", "加载更多");
      button.type = "button";
      button.addEventListener("click", () => loadEvents(true));
      section.append(button);
    }
    return section;
  }

  function eventCard(event) {
    const card = el("article", `event-card is-${event.kind}`);
    const head = el("div", "event-head");
    const title = el("div", "event-title");
    title.append(
      el("span", "event-badge", event.kind),
      el("strong", "", eventTitle(event)),
    );
    head.append(title, el("span", "event-sequence", `#${event.sequence}`));
    card.append(head);
    const body = eventBody(event);
    if (body) card.append(textBlock("event-body", body, "展开", `${event.sequence}:body`));
    const resources = Array.isArray(event.data?.resource_accesses) ? event.data.resource_accesses : [];
    if (resources.length > 0) {
      const resourceList = el("div", "event-resources");
      for (const resource of resources) {
        const chip = el(
          "span",
          `resource-chip is-${resource.operation || "unknown"}`,
          `${resource.operation === "write" ? "写" : "读"} ${resource.path || "unknown"}`,
        );
        chip.title = `${resource.evidence || "unknown"} · ${resource.coverage || "unknown"}`;
        resourceList.append(chip);
      }
      card.append(resourceList);
    }
    const json = eventJson(event);
    if (json) {
      const details = el("details", "event-details");
      details.append(
        el(
          "summary",
          "event-details-summary",
          `完整事件明细 · ${formatNumber(textLength(json))} 字符`,
        ),
      );
      details.append(el("pre", "event-json", json));
      rememberExpanded(details, `${event.sequence}:json`);
      card.append(details);
    }
    card.append(
      el(
        "div",
        "event-meta",
        `${event.provenance?.stage || "unknown"} · ${event.provenance?.native_type || "unknown"}${
          event.occurred_at ? ` · ${formatTime(event.occurred_at)}` : ""
        }`,
      ),
    );
    return card;
  }

  function eventTitle(event) {
    if (event.kind === "message") return event.data?.role || "message";
    if (event.kind === "tool-call") return event.data?.tool_name || "tool";
    if (event.kind === "tool-result") return `result · ${event.data?.status || "unknown"}`;
    if (event.kind === "model-call") return event.data?.model || "model call";
    if (event.kind === "context") return "context snapshot";
    return event.data?.status || event.kind;
  }

  function eventBody(event) {
    if (event.kind === "message") {
      return event.data?.content || hiddenText(event.data?.content_bytes, "message body");
    }
    if (event.kind === "tool-call") {
      return event.data?.arguments === undefined
        ? hiddenText(event.data?.argument_bytes, "tool arguments")
        : "";
    }
    if (event.kind === "tool-result") {
      return event.data?.output === undefined
        ? hiddenText(event.data?.output_bytes, "tool output")
        : "";
    }
    if (event.kind === "turn-end") {
      return event.data?.result === undefined
        ? hiddenText(event.data?.result_bytes, "result body")
        : event.data?.result || "";
    }
    return "";
  }

  function eventJson(event) {
    return JSON.stringify({
      data: event.data || {},
      provenance: event.provenance || {},
      occurred_at: event.occurred_at ?? null,
      truncation: event.truncation || null,
    }, null, 2);
  }

  async function toggleContent() {
    state.profile = state.profile === "inspect" ? "metadata" : "inspect";
    state.events = [];
    state.nextSequence = 0;
    state.hasMore = false;
    state.expandedDetails.clear();
    renderDetailLoading();
    await loadEvents(false);
  }

  function latestContext(events) {
    const values = {};
    const evidence = new Map();
    for (const event of events.filter((item) => item.kind === "context")) {
      for (const [key, value] of Object.entries(event.data || {})) {
        values[key] = value;
        evidence.set(key, event);
      }
    }
    return { values, evidence };
  }

  function evidenceRow(key, label, value, event) {
    const row = el("div", "evidence-row");
    const stage = event?.provenance?.stage || "unknown";
    const displayed = value === undefined || value === null || value === "" ? "未知" : displayValue(value);
    row.append(
      el("div", "evidence-key", label),
      textBlock("evidence-value", displayed, "展开", `evidence:${key}`),
      el("div", "evidence-stage", ""),
      el("div", "evidence-source", event?.provenance?.native_type || "no evidence"),
    );
    row.children[2].append(el("span", `stage-badge stage-${stage}`, stage));
    return row;
  }

  function toolPanel(title, tools) {
    const panel = el("article", "tool-panel");
    panel.append(el("h4", "", title));
    const list = el("div", "tool-list");
    if (tools.length === 0) list.append(el("span", "unknown", "未知 / 未观测到"));
    else for (const tool of tools) list.append(el("span", "tool-chip", tool));
    panel.append(list);
    return panel;
  }

  function sectionHeading(title, caption) {
    const heading = el("div", "section-heading");
    heading.append(el("h3", "", title), el("span", "section-caption", caption));
    return heading;
  }

  function summaryCard(label, value) {
    const card = el("article", "summary-card");
    card.append(el("div", "summary-label", label), el("div", "summary-value", value));
    return card;
  }

  function toolNames(value) {
    if (!Array.isArray(value)) return [];
    return distinct(
      value.map((item) => (typeof item === "string" ? item : item?.name)).filter(Boolean),
    );
  }

  function displayValue(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }

  function textBlock(className, value, expandLabel, expansionKey) {
    const text = String(value);
    if (!isLongText(text)) return el("div", className, text);
    const details = el("details", `${className} collapsible-text`);
    details.append(
      collapsibleSummary(text, expandLabel),
      el("div", "collapsible-text-body", text),
    );
    rememberExpanded(details, expansionKey);
    return details;
  }

  function collapsibleSummary(text, expandLabel) {
    const summary = el("summary", "collapsible-text-summary");
    const normalized = text.replace(/\s+/g, " ").trim();
    const characters = Array.from(normalized);
    const preview = characters.slice(0, LONG_TEXT_PREVIEW_CHARACTERS).join("");
    const suffix = characters.length > LONG_TEXT_PREVIEW_CHARACTERS ? "… " : " ";
    summary.append(
      el("span", "collapsible-text-preview", `${preview}${suffix}`),
      el("span", "collapsible-text-action collapsible-text-action-collapsed", expandLabel),
      el(
        "span",
        "collapsible-text-action collapsible-text-action-expanded",
        expandLabel.replace(/^展开/, "收起"),
      ),
    );
    return summary;
  }

  function rememberExpanded(details, key) {
    if (!key) return;
    details.open = state.expandedDetails.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) state.expandedDetails.add(key);
      else state.expandedDetails.delete(key);
    });
  }

  function isLongText(value) {
    return textLength(value) > LONG_TEXT_CHARACTERS || value.split(/\r?\n/).length > LONG_TEXT_LINES;
  }

  function textLength(value) {
    return Array.from(value).length;
  }

  function hiddenText(bytes, label) {
    return Number.isFinite(bytes) ? `${label} hidden · ${formatNumber(bytes)} bytes` : "";
  }

  function sameSession(left, right) {
    return Boolean(
      left &&
        right &&
        left.provider === right.provider &&
        left.native_session_id === right.native_session_id,
    );
  }

  function distinct(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function relativeTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "time unknown";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  }

  function formatTime(value) {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : String(value);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
  }

  function basename(value) {
    const parts = String(value).split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || value;
  }

  function sessionDisplayTitle(session) {
    return session.title || (session.cwd ? basename(session.cwd) : session.native_session_id);
  }

  function errorBox(message) {
    return el("div", "error-box", message);
  }

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }
})();
