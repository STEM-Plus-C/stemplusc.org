#!/usr/bin/env node
/**
 * Render the packet email — one message, two outputs.
 *
 * onboard.mjs owns *what the message says*: it builds a list of blocks from
 * the season config, the family, and the packet link. This file owns *how it
 * looks*, and nothing else. Keeping them apart is what stops the two renderings
 * drifting: there is one source, so the HTML a family reads cannot say
 * something different from the text `--email` prints.
 *
 * ## Why the design is what it is
 *
 * This email welcomes a family and hands them a liability release describing
 * power tools, machine-shop equipment and heavy robots. If it reads as a
 * marketing newsletter, parents skim it — and the hazards paragraph is exactly
 * the one that must not be skimmed. So it is set as a shop traveler: the
 * document that follows a part through fabrication, with a header block, an ID
 * field, and squared corners. The participant id is genuinely how the whole
 * pipeline keys records, so setting it in monospace states something true
 * rather than decorating.
 *
 * ## Email is not the web
 *
 * - Every style is inline. Gmail strips <style> blocks; Windows Outlook renders
 *   through Word and ignores most of a stylesheet either way.
 * - Layout is tables. No flex, no grid — Word supports neither.
 * - No web fonts. System stacks only; anything else silently falls back.
 * - No images, not even the logo. Most clients block remote images by default,
 *   so an <img> wordmark is a broken-image box on first open. Text always
 *   renders, and reads better here anyway.
 * - The button is a table cell, not a padded <a>. Word drops padding on inline
 *   elements, which collapses a styled link into bare text.
 */

// ---------------------------------------------------------------- palette

// Matches @theme in src/styles/global.css. Hard-coded because email cannot
// reach a stylesheet, so these are the only place the brand exists here.
const C = {
  navy: '#081f3f',
  electric: '#1daeff',
  purple: '#7030a0',
  steel: '#5f6b76',
  rule: '#e3e8ee',
  paper: '#ffffff',
  page: '#f4f6f8',
  ink: '#1c2b3d',
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

// ----------------------------------------------------------------- utils

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Turn bare URLs in already-escaped text into links.
 *
 * Runs after escaping, so an ampersand in a query string is already &amp; —
 * which is what an href needs anyway. Trailing sentence punctuation is left
 * outside the link; without that, a URL ending a sentence swallows the period
 * and 404s.
 */
const autolink = (escaped) =>
  escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const trailing = url.match(/[.,;:)]+$/)?.[0] ?? '';
    const href = url.slice(0, url.length - trailing.length);
    return `<a href="${href}" style="color:${C.electric};text-decoration:underline;">${href}</a>${trailing}`;
  });

const para = (text, extra = '') =>
  `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.ink};${extra}">` +
  `${autolink(esc(text))}</p>`;

// ------------------------------------------------------------------ text

/**
 * The plain-text rendering — what `--email` prints, and what anyone pasting
 * into another client gets. Deliberately close to what this email looked like
 * before it had a design, so the printed form stays easy to scan in a terminal.
 */
export function renderText(blocks) {
  const out = [];

  for (const b of blocks) {
    switch (b.type) {
      case 'p':
        out.push(b.text, '');
        break;
      case 'cta':
        out.push(b.href, '');
        break;
      case 'eyebrow':
        out.push(`${b.text}:`, '');
        break;
      case 'bullets':
        for (const item of b.items) out.push(`- ${item}`, '');
        break;
      case 'docs':
        out.push(b.intro, '');
        for (const d of b.items) out.push(`  ${d.name}: ${d.url}`);
        out.push('', b.note, '');
        break;
      case 'signoff': {
        const s = b.signature;
        // Phone is optional — not every coach publishes one to families.
        out.push('---', '', s.name, ...s.titles, s.org, '', s.tagline, '', s.email);
        if (s.phone) out.push(s.phone);
        break;
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// ------------------------------------------------------------------ html

function htmlBlock(b) {
  switch (b.type) {
    case 'p':
      return para(b.text);

    // A table cell, so Word honours the padding. Squared corners throughout:
    // a pill button is the one shape that would make this read as consumer
    // marketing rather than as a document.
    case 'cta':
      return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px;">
        <tr><td bgcolor="${C.electric}" style="background:${C.electric};padding:14px 28px;">
          <a href="${esc(b.href)}" style="font-family:${SANS};font-size:16px;font-weight:700;color:${C.navy};text-decoration:none;display:inline-block;">${esc(b.label)} &nbsp;&rarr;</a>
        </td></tr>
      </table>`;

    case 'eyebrow':
      return `
      <p style="margin:28px 0 4px;font-family:${MONO};font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${C.steel};">${esc(b.text)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">
        <tr><td height="1" bgcolor="${C.rule}" style="height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr>
      </table>`;

    // Hanging bullets built with a table: Word's handling of <ul> margins is
    // inconsistent enough that lists silently lose their indentation.
    case 'bullets':
      return b.items
        .map(
          (item) => `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;">
        <tr>
          <td width="18" valign="top" style="font-family:${SANS};font-size:16px;line-height:1.6;color:${C.electric};">&bull;</td>
          <td valign="top" style="font-family:${SANS};font-size:16px;line-height:1.6;color:${C.ink};">${autolink(esc(item))}</td>
        </tr>
      </table>`
        )
        .join('');

    // The one place any boldness is spent: a purple rule against otherwise
    // navy-and-blue type. This is the block that must not be skimmed.
    case 'docs':
      return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 24px;">
        <tr>
          <td width="3" bgcolor="${C.purple}" style="width:3px;background:${C.purple};">&nbsp;</td>
          <td style="padding:16px 20px;background:#faf7fd;">
            <p style="margin:0 0 12px;font-family:${MONO};font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${C.purple};">${esc(b.label)}</p>
            <p style="margin:0 0 12px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.ink};">${autolink(esc(b.intro))}</p>
            ${b.items
              .map(
                (d) =>
                  `<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:1.5;"><a href="${esc(d.url)}" style="color:${C.navy};font-weight:600;text-decoration:underline;">${esc(d.name)}</a></p>`
              )
              .join('')}
            <p style="margin:12px 0 0;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.ink};">${autolink(esc(b.note))}</p>
          </td>
        </tr>
      </table>`;

    case 'signoff': {
      const s = b.signature;
      return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:32px 0 0;">
        <tr><td height="1" bgcolor="${C.rule}" style="height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:20px 0 0;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.ink};">
        <strong style="color:${C.navy};">${esc(s.name)}</strong><br>
        ${s.titles.map((t) => `<span style="color:${C.steel};">${esc(t)}</span>`).join('<br>')}
      </p>
      <p style="margin:14px 0 0;font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:.08em;color:${C.navy};">${esc(s.org)}</p>
      <p style="margin:2px 0 0;font-family:${SANS};font-size:13px;font-style:italic;color:${C.electric};">${esc(s.tagline)}</p>
      <p style="margin:14px 0 0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.steel};">
        <a href="mailto:${esc(s.email)}" style="color:${C.electric};text-decoration:none;">${esc(s.email)}</a>${
          s.phone ? `<br>${esc(s.phone)}` : ''
        }
      </p>`;
    }
    default:
      return '';
  }
}

/**
 * The HTML rendering.
 *
 * `participantId` sits in the header block as a field, the way a traveler
 * carries the part number it belongs to. It is also the id the family will be
 * asked for if they ever write in about their registration.
 */
export function renderHtml(blocks, { participantId, subject }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject ?? '')}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.page};">
  <tr><td align="center" style="padding:24px 12px;">

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background:${C.paper};">

      <!-- traveler header -->
      <tr><td bgcolor="${C.navy}" style="background:${C.navy};padding:18px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="font-family:${SANS};font-size:17px;font-weight:700;letter-spacing:.08em;color:${C.paper};">STEM+C</td>
            <td align="right" style="font-family:${MONO};font-size:12px;letter-spacing:.08em;color:${C.electric};">${esc(participantId ?? '')}</td>
          </tr>
        </table>
      </td></tr>
      <tr><td height="3" bgcolor="${C.electric}" style="height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>

      <tr><td style="padding:32px 32px 36px;">
${blocks.map(htmlBlock).join('\n')}
      </td></tr>
    </table>

    <p style="margin:16px 0 0;font-family:${SANS};font-size:12px;color:${C.steel};">STEM+C is a 501(c)(3) nonprofit in Gilbert, Arizona.</p>

  </td></tr>
</table>
</body></html>`;
}
