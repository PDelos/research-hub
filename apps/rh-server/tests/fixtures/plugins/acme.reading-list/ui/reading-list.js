// A plugin tab as a custom element: the hub hands it `rhClient` (the same SDK client the UI uses) and its CSS
// variables (--ink, --muted, --line, --accent…) reach inside the shadow root, so it follows light and dark mode.
class ReadingList extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host { display: block; color: var(--ink); }
      h2 { margin: 0 0 8px; font-size: 18px; }
      li { padding: 6px 0; border-bottom: 1px solid var(--line); }
      .muted { color: var(--muted); }
      .badge { color: var(--accent); }
    </style>
    <h2>Reading list <span class="badge">plugin</span></h2>
    <p class="muted" id="status">Loading…</p>
    <ul id="items"></ul>`;
    void this.load(root);
  }
  async load(root) {
    try {
      const papers = await this.rhClient.kbPapers();
      root.getElementById("status").textContent = papers.length
        ? `${papers.length} papers in the knowledge base.`
        : "No papers in the knowledge base yet: star a card to add one.";
      root
        .getElementById("items")
        .replaceChildren(...papers.map((p) => Object.assign(document.createElement("li"), { textContent: p.title })));
    } catch (error) {
      root.getElementById("status").textContent = `Could not load: ${error.message}`;
    }
  }
}
customElements.define("acme-reading-list", ReadingList);
