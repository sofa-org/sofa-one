/**
 * ASCII-readable substitutes for common Unicode punctuation that appears in
 * persisted billing line descriptions (e.g. plan upgrade proration copy).
 *
 * Applied only at PDF render time so Helvetica / 7-bit content streams stay
 * printable without embedding fonts. Unknown non-ASCII still falls through to
 * the writer's generic `?` replacement — this map never invents meaning.
 */

/** Single-code-point Unicode → printable ASCII (order is irrelevant). */
export const BILLING_PDF_UNICODE_TO_ASCII: Readonly<Record<string, string>> = {
  // Dashes used in "Monthly fee — Starter" and "Plan upgrade proration — …"
  '\u2014': '-', // em dash —
  '\u2013': '-', // en dash –
  '\u2212': '-', // minus sign −
  // Arrow used in "Free → Starter" proration descriptions
  '\u2192': '->', // right arrow →
  '\u2190': '<-', // left arrow ←
  '\u2194': '<->', // left-right arrow ↔
};

/**
 * Replaces known billing-description Unicode punctuation with ASCII while
 * leaving every other character untouched (including other non-ASCII).
 */
export function mapBillingDescriptionToAscii(text: string): string {
  let out = '';
  for (const ch of text) {
    out += BILLING_PDF_UNICODE_TO_ASCII[ch] ?? ch;
  }
  return out;
}
