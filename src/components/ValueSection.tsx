import { H2, Screen } from './landing-kit';
import { VALUE_FACTS, VALUE_HEADING, VALUE_LEAD } from '../lib/value-copy';
import builtIn640 from '../assets/landing/value/built-in-640.webp';
import builtIn1200 from '../assets/landing/value/built-in-1200.webp';
import switchTools640 from '../assets/landing/value/switch-tools-640.webp';
import switchTools1200 from '../assets/landing/value/switch-tools-1200.webp';

/* One picture over each fact (note #1131, Adam, 10 Nov 2026, 11:26 UTC: the
   pair he picked of three candidates each). Made with fal.ai (Recraft V4.1
   Pro), held to the page's own colours; the prompts are on note #1131. The
   page colour (#fcfcfb) is baked into each file, so no box shows. The words
   under each picture say everything it shows, so the picture is decorative
   (alt=""). 640 px serves a phone at 1x/2x, 1200 px a desk or a 3x phone. */
const ART: Readonly<Record<string, readonly [string, string]>> = {
  'Built in': [builtIn640, builtIn1200],
  'Switch tools, keep the context': [switchTools640, switchTools1200],
};

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
        {VALUE_FACTS.map(({ title, line }) => {
          const [small, large] = ART[title]!;
          return (
            <div key={title} data-value-fact className="border-t border-hint/16 py-4 sm:py-5">
              <img
                data-value-art
                src={large}
                srcSet={`${small} 640w, ${large} 1200w`}
                sizes="(min-width: 640px) 50vw, 100vw"
                alt=""
                width={1200}
                height={825}
                loading="lazy"
                decoding="async"
                className="mb-3 aspect-[16/11] h-auto w-full select-none sm:mb-4"
              />
              <dt className="type-base font-semibold text-white">{title}</dt>
              <dd className="mt-1 type-sm text-hint sm:type-base [text-wrap:pretty]">{line}</dd>
            </div>
          );
        })}
      </dl>
    </Screen>
  );
}
