'use client';

import Link from 'next/link';
import { DIMENSION_CARDS, METHODOLOGY_PRINCIPLES } from '@/lib/dimensionCards';
import { useLocale, useT } from '@/lib/i18n';

/** /methodology —— 方法论页：Manifesto + 4 条地基原则 + 8 张维度卡（锚点 dim-<dimension>）。 */
export default function MethodologyPage() {
  const t = useT();
  const { locale } = useLocale();
  const m = t.methodology;
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-ink">
      <Link href="/" className="text-dim hover:text-ink">{m.backHome}</Link>
      <h1 className="mt-4 text-3xl font-semibold">{m.title}</h1>
      <p className="mt-2 text-xl text-brass">{m.manifesto}</p>
      <p className="mt-2 text-dim">{m.manifestoNote}</p>

      <h2 className="mt-10 text-xl font-semibold">{m.principlesTitle}</h2>
      <ul className="mt-3 space-y-3">
        {METHODOLOGY_PRINCIPLES.map((p) => {
          const c = locale === 'zh' ? p.zh : p.en;
          return (
            <li key={p.id} className="rounded-lg border border-line bg-panel p-4">
              <div className="font-medium text-amber">{c.anchor}</div>
              <div className="mt-1 text-sm text-dim">{c.note}</div>
            </li>
          );
        })}
      </ul>

      <h2 className="mt-10 text-xl font-semibold">{m.dimsTitle}</h2>
      <p className="mt-2 text-xs text-dim">{m.dimsFormula}</p>
      <div className="mt-4 space-y-4">
        {DIMENSION_CARDS.map((card) => {
          const c = locale === 'zh' ? card.zh : card.en;
          return (
            <section key={card.id} id={`dim-${card.id}`} className="rounded-lg border border-line bg-panel p-5">
              <header className="flex items-baseline justify-between">
                <h3 className="text-lg font-semibold">{c.name}</h3>
                <span className="text-xs text-dim">weight {card.weight}</span>
              </header>
              <dl className="mt-3 grid gap-2 text-sm">
                <div><dt className="inline text-dim">{m.cardExamines}：</dt><dd className="inline">{c.examines}</dd></div>
                <div><dt className="inline text-dim">{m.cardSources}：</dt><dd className="inline">{c.sources}</dd></div>
                <div><dt className="inline text-dim">{m.cardScoring}：</dt><dd className="inline">{c.scoring}</dd></div>
                <div><dt className="inline text-dim">{m.cardAntiGame}：</dt><dd className="inline">{c.antiGame}</dd></div>
                <div><dt className="inline text-amber">{m.cardAnchor}：</dt><dd className="inline">{c.anchor}——{c.anchorNote}</dd></div>
              </dl>
            </section>
          );
        })}
      </div>
    </main>
  );
}
