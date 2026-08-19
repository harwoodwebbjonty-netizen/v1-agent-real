// Placeholder section — matches a client's loan against the best-fit lender.
// Not built yet; ships as a "coming soon" stub so the nav entry (and its
// place in the roadmap) exists ahead of the real implementation.

export function initLenderCalculator(): void {
  const container = document.querySelector<HTMLDivElement>("#view-lender-calculator")!;
  container.innerHTML = `
    <main class="container">
      <header class="page-head">
        <div>
          <h1 class="page-title">Lender Calculator</h1>
          <div class="page-meta"><span>Match a client's loan to the best-fit lender.</span></div>
        </div>
      </header>

      <section class="card">
        <p class="empty-state">Coming soon — this section will recommend the best lender for a given client and loan.</p>
      </section>
    </main>
  `;
}
