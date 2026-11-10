/* The value in one breath (note #1085). Adam, 8 Nov 2026, 19:00 UTC: "Also
   let's make new section about the strong value proposition of our product.
   Customer gets cutting edge agentic workplace running on customer's cloud,
   guarding it's data." He picked option B of three (19:16 UTC): a screen of
   its own right after the film, with screen 3 ("Run it in your own cloud.
   The code is open-source.") left as it is. Then (19:16 and 19:20 UTC): no
   "Kept current for you" fact and no privacy link; "Built in" says the
   fatigue of stitching tools together, with the word fatigue; "Switch tools,
   keep the context" says the customer depends on neither Anthropic nor
   OpenAI, because the context lives in its own walls; and the lead's data
   sentence is short, a pitch that still admits the daily report.
   "Cutting edge" is his intent, never a word on the page: the named agents
   and the facts say it.

   The short data sentence is Adam's call for this one section (8 Nov 2026).
   Everywhere else the long fixed sentence holds ("None of your data comes to
   us: only a daily report of counts and the contact you chose, which your
   admin sees and can turn off."). Never "leaves" (claims-we-never-make: the
   AI provider reads what the agents send it), and never "none of your data
   comes to us" without the report.

   Note #1131 (Adam, 10 Nov 2026, 11:26 UTC): "Move from Claude Code to
   Codex or OpenCode without losing it." came off the second fact because it
   is heavy; the fact ends at "live in your own cloud." The lead still names
   the three agents. */
export const VALUE_HEADING = 'Your agents. Your cloud. Your data.';
export const VALUE_LEAD =
  'Claude Code, Codex and OpenCode on the plans you already pay for, each on a computer of its own in your company’s cloud. None of your data comes to us, only a daily report.';
export const VALUE_FACTS: readonly { title: string; line: string }[] = [
  {
    title: 'Built in',
    line: 'Skip the fatigue of stitching tools together. Git hosting and CI, sites, email, notes and Drive are built into one workplace.',
  },
  {
    title: 'Switch tools, keep the context',
    line: 'Your context belongs to your workplace, not to Anthropic or OpenAI: notes, knowledge, code and history live in your own cloud.',
  },
];
