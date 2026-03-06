import { render } from "../ui.js";

export function renderSummaryPlaceholder(appEl) {
  render(appEl, `
    <section class="section">
      <h1 class="h1">稼働サマリ</h1>
      <p class="p">次段で実装します。</p>
    </section>
  `);
}
