import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, relative, extname, basename, dirname } from "node:path";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import type { AgentHandle } from "./agent.js";

const PORT = 8112; // 8000 + ord('p')

let agentRef: AgentHandle | null = null;

export function setBrowserAgent(agent: AgentHandle): void {
  agentRef = agent;
}

export async function startBrowser(rootDir: string, wikiDir: string): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, rootDir, wikiDir);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
    }
  });

  server.listen(PORT, () => {
    console.log(`🌐 Wiki browser: http://localhost:${PORT}`);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
  wikiDir: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const editing = url.searchParams.has("edit");

  // ── POST: save settings (must come before generic file save) ──
  if (req.method === "POST" && path === "/settings") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const settings: Settings = {
      fastProvider: params.get("fastProvider") ?? "",
      fastModel: params.get("fastModel") ?? "",
      smartProvider: params.get("smartProvider") ?? "",
      smartModel: params.get("smartModel") ?? "",
      screenshotIntervalSecs: parseInt(params.get("screenshotIntervalSecs") ?? "5", 10) || 5,
    };
    await saveSettings(rootDir, settings);
    res.writeHead(302, { Location: "/settings" });
    res.end();
    return;
  }

  // ── POST: toggle checkbox ──
  if (req.method === "POST" && url.searchParams.has("toggleLine")) {
    const lineNum = parseInt(url.searchParams.get("toggleLine")!, 10);
    const filePath = resolveFilePath(path, rootDir, wikiDir);
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    if (lineNum >= 0 && lineNum < lines.length) {
      const line = lines[lineNum]!;
      if (line.match(/^(\s*[-*] )\[ \] /)) {
        lines[lineNum] = line.replace("[ ] ", "[x] ");
      } else if (line.match(/^(\s*[-*] )\[x\] /)) {
        lines[lineNum] = line.replace("[x] ", "[ ] ");
      }
      await writeFile(filePath, lines.join("\n"), "utf-8");
    }
    res.writeHead(302, { Location: path });
    res.end();
    return;
  }

  // ── POST: save file ──
  if (req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const content = params.get("content") ?? "";
    const filePath = resolveFilePath(path, rootDir, wikiDir);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");

    // Redirect back to the view
    res.writeHead(302, { Location: path });
    res.end();
    return;
  }

  // ── GET: homepage ──
  if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await renderIndex(rootDir, wikiDir));
    return;
  }

  // ── API: providers and models ──
  if (path === "/api/providers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!agentRef) {
      res.end(JSON.stringify({ providers: [], error: "Agent not connected yet" }));
    } else {
      try {
        const providers = await agentRef.listProviders();
        res.end(JSON.stringify({ providers }));
      } catch (err) {
        res.end(JSON.stringify({ providers: [], error: String(err) }));
      }
    }
    return;
  }

  if (path === "/api/models") {
    const provider = url.searchParams.get("provider") ?? "";
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!agentRef || !provider) {
      res.end(JSON.stringify({ models: [], current: "" }));
    } else {
      try {
        const result = await agentRef.listModels(provider);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.end(JSON.stringify({ models: [], current: "", error: String(err) }));
      }
    }
    return;
  }

  // ── GET: settings ──
  if (path === "/settings") {
    const settings = await loadSettings(rootDir);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSettings(settings));
    return;
  }

  // ── GET: search ──
  if (path === "/search") {
    const query = url.searchParams.get("q") ?? "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await renderSearch(rootDir, wikiDir, query));
    return;
  }

  // ── GET: check if it's a directory first (before .md resolution) ──
  if (path !== "/prompt" && path !== "/lint" && path !== "/settings") {
    const dirPath = join(wikiDir, path.slice(1));
    try {
      const s = await stat(dirPath);
      if (s.isDirectory()) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await renderDirectory(wikiDir, dirPath));
        return;
      }
    } catch {
      // not a directory
    }
  }

  // ── GET: resolve as file ──
  const filePath = resolveFilePath(path, rootDir, wikiDir);

  // Markdown file
  try {
    const content = await readFile(filePath, "utf-8");
    if (filePath.endsWith(".md")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const isConfigFile = path === "/prompt" || path === "/lint";
      if (editing) {
        res.end(renderEditor(path, content, isConfigFile));
      } else {
        const rel = isConfigFile ? basename(filePath) : relative(wikiDir, filePath);
        res.end(renderMarkdownPage(path, rel, content, isConfigFile));
      }
    } else {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(content);
    }
  } catch {
    if (editing) {
      // New file — open editor with empty content
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderEditor(path, "", false));
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(wrap("404", `<h1>Not found</h1><p><code>${path}</code></p><p><a href="/">← Home</a></p>`));
    }
  }
}

/**
 * Map a URL path to a filesystem path. /prompt is special (lives in rootDir).
 */
function resolveFilePath(urlPath: string, rootDir: string, wikiDir: string): string {
  if (urlPath === "/prompt") {
    return join(rootDir, "prompt.md");
  }
  if (urlPath === "/lint") {
    return join(rootDir, "lint.md");
  }
  let filePath = join(wikiDir, urlPath.slice(1));
  if (!extname(filePath)) {
    filePath += ".md";
  }
  return filePath;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Markdown rendering ──────────────────────────────────────────────

function renderMarkdown(md: string): string {
  let html = md;

  // Strip HTML comments (used for prompt annotations)
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // Fenced code blocks (must come before line-level processing)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    return `<pre><code class="lang-${lang}">${esc(code.trimEnd())}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_m, code) => `<code>${esc(code)}</code>`);

  // Headers
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links: [text](url) — external links open in new tab, internal .md links get extension stripped
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return `<a href="${href}" target="_blank" rel="noopener" class="external">${text} ↗</a>`;
    }
    const browserHref = href.replace(/\.md$/, "").replace(/\.md#/, "#");
    return `<a href="${browserHref}">${text}</a>`;
  });

  // Bare URLs (not already inside a link tag)
  html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<)\]]+)/g,
    '<a href="$1" target="_blank" rel="noopener" class="external">$1 ↗</a>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");

  // Task list items (checkboxes) — track source line numbers for toggling
  {
    let lineNum = 0;
    html = html.replace(/^(.*)$/gm, (line) => {
      const n = lineNum++;
      const doneMatch = line.match(/^(\s*)[-*] \[x\] (.+)$/);
      if (doneMatch) return `${doneMatch[1]}<li class="task done"><input type="checkbox" checked data-line="${n}"> ${doneMatch[2]}</li>`;
      const openMatch = line.match(/^(\s*)[-*] \[ \] (.+)$/);
      if (openMatch) return `${openMatch[1]}<li class="task"><input type="checkbox" data-line="${n}"> ${openMatch[2]}</li>`;
      return line;
    });
  }

  // Unordered list items (non-task)
  html = html.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>");
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>\n$1</ul>\n");

  // Paragraphs: wrap remaining non-tag lines
  const lines = html.split("\n");
  const result: string[] = [];
  let inPre = false;
  for (const line of lines) {
    if (line.includes("<pre>")) inPre = true;
    if (line.includes("</pre>")) inPre = false;
    if (
      inPre ||
      !line.trim() ||
      line.startsWith("<h") ||
      line.startsWith("<ul") ||
      line.startsWith("</ul") ||
      line.startsWith("<li") ||
      line.startsWith("<hr") ||
      line.startsWith("<pre") ||
      line.startsWith("</pre")
    ) {
      result.push(line);
    } else {
      result.push(`<p>${line}</p>`);
    }
  }

  return result.join("\n");
}

/**
 * Render markdown with annotations visible (for the prompt page).
 * HTML comments are shown as styled callout blocks.
 */
function renderMarkdownWithAnnotations(md: string): string {
  // Turn HTML comments into visible annotation blocks before rendering
  const annotated = md.replace(/<!--([\s\S]*?)-->/g, (_m, content) => {
    const text = content.trim().replace(/\n\s*/g, " ");
    return `<div class="annotation">💡 ${esc(text)}</div>`;
  });
  // Now render the rest as normal markdown (no comments left to strip)
  return renderMarkdown(annotated);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Page templates ──────────────────────────────────────────────────

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — perception wiki</title>
<style>
  :root {
    --bg: #1a1b26; --fg: #c0caf5; --dim: #565f89; --accent: #7aa2f7;
    --accent2: #bb9af7; --border: #292e42; --code-bg: #24283b;
    --green: #9ece6a; --orange: #e0af68; --red: #f7768e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg); color: var(--fg);
    max-width: 800px; margin: 0 auto; padding: 2rem;
    line-height: 1.7;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a.external { color: var(--green); }
  h1 { color: var(--accent2); font-size: 1.8rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; }
  h2 { color: var(--accent); font-size: 1.4rem; margin: 1.3rem 0 0.4rem; }
  h3 { color: var(--green); font-size: 1.15rem; margin: 1rem 0 0.3rem; }
  h4 { color: var(--orange); font-size: 1rem; margin: 0.8rem 0 0.2rem; }
  p { margin: 0.5rem 0; }
  ul { margin: 0.5rem 0 0.5rem 1.5rem; }
  li { margin: 0.2rem 0; }
  hr { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
  code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: var(--code-bg); padding: 0.15rem 0.4rem; border-radius: 4px;
    font-size: 0.9em;
  }
  pre {
    background: var(--code-bg); padding: 1rem; border-radius: 8px;
    overflow-x: auto; margin: 1rem 0; border: 1px solid var(--border);
  }
  pre code { background: none; padding: 0; }
  strong { color: var(--fg); }
  em { color: var(--dim); font-style: italic; }
  nav {
    display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
    padding: 0.8rem 0; border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem; font-size: 0.9rem;
  }
  nav a { color: var(--dim); }
  nav a:hover { color: var(--accent); }
  nav .sep { color: var(--border); }
  .file-list { list-style: none; margin: 0; padding: 0; }
  .file-list li { padding: 0.4rem 0; border-bottom: 1px solid var(--border); }
  .file-list li:last-child { border-bottom: none; }
  .file-list .icon { margin-right: 0.5rem; }
  .badge {
    display: inline-block; font-size: 0.75rem; padding: 0.1rem 0.5rem;
    border-radius: 10px; background: var(--code-bg); color: var(--dim);
    margin-left: 0.5rem;
  }
  .updated { color: var(--dim); font-size: 0.8rem; }
  .annotation {
    background: #1e2030; border-left: 3px solid var(--orange);
    padding: 0.5rem 0.8rem; margin: 0.5rem 0; border-radius: 0 4px 4px 0;
    color: var(--orange); font-size: 0.85rem;
  }
  .toolbar {
    display: flex; gap: 0.5rem; margin-bottom: 1rem;
  }
  .btn {
    display: inline-block; padding: 0.3rem 0.8rem; border-radius: 6px;
    font-size: 0.85rem; cursor: pointer; border: 1px solid var(--border);
    background: var(--code-bg); color: var(--fg); text-decoration: none;
  }
  .btn:hover { background: var(--border); text-decoration: none; }
  .btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .btn-primary:hover { opacity: 0.9; }
  .editor {
    width: 100%; min-height: 60vh; padding: 1rem;
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9rem;
    background: var(--code-bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 8px;
    resize: vertical; line-height: 1.6; tab-size: 2;
  }
  .editor:focus { outline: 1px solid var(--accent); }
  .search-form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .search-input {
    flex: 1; padding: 0.4rem 0.8rem; font-size: 0.9rem;
    background: var(--code-bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; font-family: inherit;
  }
  .search-input:focus { outline: 1px solid var(--accent); }
  .nav-search {
    margin-left: auto; display: flex; gap: 0.3rem;
  }
  .nav-search input {
    padding: 0.2rem 0.5rem; font-size: 0.8rem; width: 140px;
    background: var(--code-bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; font-family: inherit;
  }
  .nav-search input:focus { outline: 1px solid var(--accent); width: 200px; }
  li.task { list-style: none; margin-left: -1.2rem; }
  li.task input[type="checkbox"] { margin-right: 0.4rem; accent-color: var(--accent); }
  li.task.done { opacity: 0.6; text-decoration: line-through; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function breadcrumb(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  const crumbs = [`<a href="/">🦆 wiki</a>`];
  let href = "";
  for (let i = 0; i < parts.length; i++) {
    href += "/" + parts[i]!;
    const name = parts[i]!.replace(/\.md$/, "");
    if (i === parts.length - 1) {
      crumbs.push(`<span>${name}</span>`);
    } else {
      crumbs.push(`<a href="${href}">${name}</a>`);
    }
  }
  return `<nav>${crumbs.join('<span class="sep"> / </span>')}<form action="/search" method="GET" class="nav-search"><input type="text" name="q" placeholder="🔍 Search…"></form></nav>`;
}

function renderMarkdownPage(urlPath: string, relPath: string, content: string, showAnnotations: boolean): string {
  const title = basename(relPath, ".md");
  const rendered = showAnnotations ? renderMarkdownWithAnnotations(content) : renderMarkdown(content);
  const body = `
${breadcrumb(relPath)}
<div class="toolbar">
  <a href="${urlPath}?edit" class="btn">✏️ Edit</a>
</div>
${rendered}
<script>
document.querySelectorAll('input[type="checkbox"][data-line]').forEach(cb => {
  cb.style.cursor = 'pointer';
  cb.addEventListener('click', e => {
    e.preventDefault();
    const line = cb.getAttribute('data-line');
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '${urlPath}?toggleLine=' + line;
    document.body.appendChild(form);
    form.submit();
  });
});
</script>
`;
  return wrap(title, body);
}

function renderEditor(urlPath: string, content: string, isConfigFile: boolean): string {
  const title = isConfigFile ? "Edit " + urlPath.slice(1) : "Edit " + urlPath;
  const hint = isConfigFile
    ? `<p style="color: var(--dim); font-size: 0.85rem; margin-bottom: 1rem">
        Use <code>&lt;!-- comments --&gt;</code> to annotate the prompt — they are stripped before sending to the model.
        Use <code>{{WIKI_DIR}}</code> and <code>{{WIKI_SUMMARY}}</code> as placeholders.
       </p>`
    : "";
  const body = `
${breadcrumb(urlPath.slice(1))}
<h1>✏️ ${esc(title)}</h1>
${hint}
<form method="POST" action="${urlPath}">
  <textarea name="content" class="editor">${esc(content)}</textarea>
  <div class="toolbar" style="margin-top: 0.8rem">
    <button type="submit" class="btn btn-primary">💾 Save</button>
    <a href="${urlPath}" class="btn">Cancel</a>
  </div>
</form>
<script>
  // Tab key inserts a tab instead of moving focus
  document.querySelector('.editor').addEventListener('keydown', function(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = this.selectionStart, end = this.selectionEnd;
      this.value = this.value.substring(0, s) + '  ' + this.value.substring(end);
      this.selectionStart = this.selectionEnd = s + 2;
    }
    // Ctrl/Cmd+S saves
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this.form.submit();
    }
  });
</script>
`;
  return wrap(title, body);
}

// ── Index & directory listing ───────────────────────────────────────

async function renderSearch(rootDir: string, wikiDir: string, query: string): Promise<string> {
  const results: Array<{ href: string; name: string; snippet: string }> = [];
  const q = query.toLowerCase();

  if (q) {
    // Search the prompt file
    try {
      const promptContent = await readFile(join(rootDir, "prompt.md"), "utf-8");
      if (promptContent.toLowerCase().includes(q)) {
        const snippet = extractSnippet(promptContent, q);
        results.push({ href: "/prompt", name: "⚙️ prompt", snippet });
      }
    } catch { /* no prompt file */ }

    // Search all wiki markdown files
    await searchDir(wikiDir, wikiDir, q, results);
  }

  const body = `
${breadcrumb("search")}
<h1>🔍 Search</h1>
<form action="/search" method="GET" class="search-form">
  <input type="text" name="q" value="${esc(query)}" placeholder="Search wiki…" class="search-input" autofocus>
  <button type="submit" class="btn btn-primary">Search</button>
</form>
${q ? `<p style="color: var(--dim)">${results.length} result${results.length !== 1 ? "s" : ""} for "${esc(query)}"</p>` : ""}
<ul class="file-list">
${results.map((r) => `<li><span class="icon">📄</span><a href="${r.href}">${r.name}</a><br><span style="color: var(--dim); font-size: 0.85rem">${r.snippet}</span></li>`).join("\n")}
</ul>
`;
  return wrap("Search", body);
}

async function searchDir(
  dir: string,
  wikiDir: string,
  query: string,
  results: Array<{ href: string; name: string; snippet: string }>,
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("tmp_")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await searchDir(fullPath, wikiDir, query, results);
      } else if (entry.name.endsWith(".md")) {
        const content = await readFile(fullPath, "utf-8");
        const nameMatch = entry.name.toLowerCase().includes(query);
        const contentMatch = content.toLowerCase().includes(query);
        if (nameMatch || contentMatch) {
          const rel = relative(wikiDir, fullPath);
          const href = "/" + rel.replace(/\.md$/, "");
          const name = rel.replace(/\.md$/, "");
          const snippet = contentMatch ? extractSnippet(content, query) : "(filename match)";
          results.push({ href, name, snippet });
        }
      }
    }
  } catch { /* dir might not exist */ }
}

function extractSnippet(content: string, query: string): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx === -1) return "";
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + query.length + 60);
  let snippet = (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
  // Strip markdown/html noise
  snippet = snippet.replace(/[#*`\[\]]/g, "").replace(/\n/g, " ");
  return esc(snippet);
}

function renderSettings(settings: Settings): string {
  const body = `
${breadcrumb("settings")}
<h1>⚙️ Settings</h1>
<p style="color: var(--dim)">Changes take effect on next batch. Restart for interval changes.</p>
<form method="POST" action="/settings">
  <fieldset>
    <legend>Fast model (extraction & filing)</legend>
    <p style="color: var(--dim); font-size: 0.85rem">Used for analyzing screenshots and filing observations. Can be a small/local model.</p>
    <div class="field">
      <label>Provider</label>
      <select id="fastProvider" name="fastProvider"><option value="">Loading…</option></select>
    </div>
    <div class="field">
      <label>Model</label>
      <select id="fastModel" name="fastModel"><option value="">Select a provider first</option></select>
    </div>
  </fieldset>
  <fieldset>
    <legend>Smart model (synthesis & linting)</legend>
    <p style="color: var(--dim); font-size: 0.85rem">Used for rewriting wiki pages into proper articles. Should be your best model.</p>
    <div class="field">
      <label>Provider</label>
      <select id="smartProvider" name="smartProvider"><option value="">Loading…</option></select>
    </div>
    <div class="field">
      <label>Model</label>
      <select id="smartModel" name="smartModel"><option value="">Select a provider first</option></select>
    </div>
  </fieldset>
  <fieldset>
    <legend>Capture</legend>
    <div class="field">
      <label for="screenshotIntervalSecs">Screenshot interval (seconds)</label>
      <input type="number" id="screenshotIntervalSecs" name="screenshotIntervalSecs"
        value="${esc(String(settings.screenshotIntervalSecs))}" min="1">
    </div>
  </fieldset>
  <div style="margin-top: 1rem">
    <button type="submit" class="btn save-btn">Save</button>
    <a href="/" class="btn" style="margin-left: 0.5rem">Cancel</a>
  </div>
</form>
<style>
  fieldset { border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
  legend { color: var(--accent); font-weight: bold; padding: 0 0.5rem; }
  .field { margin: 0.75rem 0; }
  .field label { display: block; margin-bottom: 0.25rem; color: var(--fg); font-size: 0.9rem; }
  .field select, .field input {
    width: 100%; max-width: 400px; padding: 0.4rem 0.6rem;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 4px;
    font-family: inherit; font-size: 0.9rem;
  }
  .field select:focus, .field input:focus { outline: none; border-color: var(--accent); }
  .save-btn { background: var(--accent); color: #fff; border: none; padding: 0.5rem 1.5rem; cursor: pointer; border-radius: 4px; }
  .loading { color: var(--dim); font-style: italic; }
</style>
<script>
  const saved = ${JSON.stringify({
    fastProvider: settings.fastProvider,
    fastModel: settings.fastModel,
    smartProvider: settings.smartProvider,
    smartModel: settings.smartModel,
  })};

  async function loadProviders() {
    const res = await fetch('/api/providers');
    const data = await res.json();
    if (data.error) {
      console.warn('Provider fetch error:', data.error);
    }
    return data.providers || [];
  }

  async function loadModels(provider) {
    if (!provider) return { models: [], current: '' };
    const res = await fetch('/api/models?provider=' + encodeURIComponent(provider));
    return await res.json();
  }

  function populateSelect(sel, items, selectedValue) {
    sel.innerHTML = '<option value="">— select —</option>';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label || item.name || item.id;
      if (item.id === selectedValue) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  async function setupPair(providerSelId, modelSelId, savedProvider, savedModel) {
    const providerSel = document.getElementById(providerSelId);
    const modelSel = document.getElementById(modelSelId);

    const providers = await loadProviders();
    populateSelect(providerSel, providers, savedProvider);

    async function onProviderChange() {
      const provider = providerSel.value;
      modelSel.innerHTML = '<option value="">Loading models…</option>';
      if (!provider) {
        modelSel.innerHTML = '<option value="">Select a provider first</option>';
        return;
      }
      const data = await loadModels(provider);
      if (data.error) {
        modelSel.innerHTML = '<option value="" disabled>⚠️ Provider not configured</option>';
        return;
      }
      if (data.models.length === 0) {
        modelSel.innerHTML = '<option value="">No models available</option>';
        return;
      }
      populateSelect(modelSel, data.models.map(m => ({ id: m.id, label: m.name })),
        provider === savedProvider ? savedModel : data.current);
    }

    providerSel.addEventListener('change', onProviderChange);
    if (savedProvider) await onProviderChange();
  }

  setupPair('fastProvider', 'fastModel', saved.fastProvider, saved.fastModel);
  setupPair('smartProvider', 'smartModel', saved.smartProvider, saved.smartModel);
</script>
`;
  return wrap("Settings", body);
}

async function renderIndex(rootDir: string, wikiDir: string): Promise<string> {
  const sections = await buildTree(wikiDir, wikiDir);
  const hasPrompt = await fileExists(join(rootDir, "prompt.md"));
  const hasLint = await fileExists(join(rootDir, "lint.md"));
  const configLinks = [
    hasPrompt ? '<a href="/prompt">System prompt</a>' : null,
    hasLint ? '<a href="/lint">Lint prompt</a>' : null,
    '<a href="/settings">Settings</a>',
  ].filter(Boolean).join(" · ");
  const body = `
${breadcrumb("")}
<h1>🦆 Perception Wiki</h1>
<p style="color: var(--dim)">Your second brain, built from desktop screenshots.</p>
<hr>
${configLinks ? `<p>⚙️ ${configLinks}</p><hr>` : ""}
${sections}
`;
  return wrap("Home", body);
}

async function renderDirectory(wikiDir: string, dirPath: string): Promise<string> {
  const rel = relative(wikiDir, dirPath);
  const sections = await buildTree(dirPath, wikiDir);
  const body = `
${breadcrumb(rel)}
<h1>📁 ${rel}</h1>
${sections}
`;
  return wrap(rel, body);
}

async function buildTree(dir: string, wikiDir: string): Promise<string> {
  let html = '<ul class="file-list">';
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("tmp_")) continue;
      const rel = relative(wikiDir, join(dir, entry.name));
      const href = "/" + rel.replace(/\.md$/, "");

      if (entry.isDirectory()) {
        const count = await countMdFiles(join(dir, entry.name));
        html += `<li><span class="icon">📁</span><a href="${href}">${entry.name}</a><span class="badge">${count} files</span></li>`;
      } else if (entry.name.endsWith(".md")) {
        const s = await stat(join(dir, entry.name));
        const updated = timeSince(s.mtime);
        html += `<li><span class="icon">📄</span><a href="${href}">${entry.name.replace(/\.md$/, "")}</a> <span class="updated">${updated}</span></li>`;
      }
    }
  } catch {
    html += "<li>(empty)</li>";
  }
  html += "</ul>";
  return html;
}

async function countMdFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countMdFiles(join(dir, entry.name));
      } else if (entry.name.endsWith(".md")) {
        count++;
      }
    }
  } catch {
    // directory might not exist
  }
  return count;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
