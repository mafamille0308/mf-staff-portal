import { render } from "../ui.js";

export function renderMailIntakePlaceholder(appEl) {
  render(appEl, `
    <section class="section">
      <h1 class="h1">メール→解釈→登録</h1>
      <p class="p">次段で実装します。</p>
    </section>
  `);
}
