import { H2, Screen } from './landing-kit';
import { VALUE_FACTS, VALUE_HEADING, VALUE_LEAD } from '../lib/value-copy';

/* The value in one breath (note #1085): its words live in lib/value-copy. */
export default function ValueSection() {
  return (
    <Screen id="value" label="Your agents, your cloud, your data">
      <h2 className={`[text-wrap:balance] ${H2}`}>{VALUE_HEADING}</h2>
      <p className="mt-4 type-base text-hint sm:mt-5 sm:type-md-sm [text-wrap:pretty] sm:w-3/5">{VALUE_LEAD}</p>
      {/* Two facts, a hairline over each: two columns from sm, one on a
          phone. A definition list, not cards (landing-copy-rules: no grid of
          identical cards, no eyebrows, no numbers). */}
      <dl className="mt-8 grid gap-x-10 sm:mt-10 sm:grid-cols-2">
        {VALUE_FACTS.map(({ title, line }) => (
          <div key={title} data-value-fact className="border-t border-hint/16 py-4 sm:py-5">
            <dt className="type-base font-semibold text-white">{title}</dt>
            <dd className="mt-1 type-sm text-hint sm:type-base [text-wrap:pretty]">{line}</dd>
          </div>
        ))}
      </dl>
    </Screen>
  );
}
