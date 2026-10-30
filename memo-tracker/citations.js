// Citation detection and paragraph lookup, shared by the tracker and the Word add-in.
// Nothing here guesses at what a case says: a paragraph is only ever shown if it
// exists in a decision the user loaded into their own case library.
(function (root) {
  // Neutral citations ("2019 SCC 65", "2021 ONSC 4567") and CanLII citations
  // ("2015 CanLII 12345 (ON SC)"), with an optional pinpoint ("at para 45", "at paras 10-12").
  const CITE_RE = new RegExp(
    '\\b((?:19|20)\\d{2})\\s+' +
      '(CanLII\\s+\\d+(?:\\s*\\([A-Z ]{2,12}\\))?|[A-Z]{2,}[A-Za-z]{0,6}\\s+\\d{1,6})' +
      '(?:\\s*,?\\s*at\\s+(paras?\\.?|¶+)\\s*(\\d+)(?:\\s*(?:-|–|to)\\s*(\\d+))?)?',
    'g'
  );
  // "Ibid at para 12" / "Ibid., para 12" points back at the last full citation.
  const IBID_RE = /\b(Ibid|Id)\.?\s*,?\s*(?:at\s+)?(?:paras?\.?|¶+)\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/gi;

  function normalizeKey(year, rest) {
    return (year + ' ' + rest.replace(/\s*\([^)]*\)/, '')).replace(/\s+/g, ' ').trim().toUpperCase();
  }

  // Returns [{text, index, key, from, to, ibid}] in document order.
  function findCitations(text) {
    const hits = [];
    let m;
    CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(text))) {
      hits.push({
        text: m[0],
        index: m.index,
        key: normalizeKey(m[1], m[2]),
        from: m[4] ? +m[4] : null,
        to: m[5] ? +m[5] : m[4] ? +m[4] : null,
        ibid: false,
      });
    }
    IBID_RE.lastIndex = 0;
    while ((m = IBID_RE.exec(text))) {
      hits.push({ text: m[0], index: m.index, key: null, from: +m[2], to: m[3] ? +m[3] : +m[2], ibid: true });
    }
    hits.sort((a, b) => a.index - b.index);
    let last = null;
    for (const h of hits) {
      if (h.ibid) h.key = last;
      else last = h.key;
    }
    return hits.filter((h) => h.key);
  }

  // Splits a decision's text into numbered paragraphs. Courts number paragraphs as
  // "[45]" (CanLII, most Ontario courts) or "45." at the start of a line; use whichever
  // style yields more paragraphs.
  function splitParagraphs(text) {
    const styles = [/^\s*\[(\d{1,4})\]\s*/gm, /^\s*(\d{1,4})\.\s+(?=\S)/gm];
    let best = {};
    for (const re of styles) {
      const marks = [];
      let m;
      while ((m = re.exec(text))) marks.push({ n: +m[1], start: m.index, body: m.index + m[0].length });
      const paras = {};
      let expected = 1;
      // Keep only marks that run in sequence, so numbered lists inside a paragraph
      // ("1. the applicant...") don't break the numbering.
      const seq = marks.filter((mk) => (mk.n === expected ? (expected++, true) : false));
      seq.forEach((mk, i) => {
        const end = i + 1 < seq.length ? seq[i + 1].start : text.length;
        paras[mk.n] = text.slice(mk.body, end).replace(/\s+/g, ' ').trim();
      });
      if (Object.keys(paras).length > Object.keys(best).length) best = paras;
    }
    return best;
  }

  // First neutral citation in the decision's own text, used to key it in the library.
  function detectOwnCitation(text) {
    const head = text.slice(0, 4000);
    const hit = findCitations(head).find((h) => !h.ibid);
    return hit ? hit.key : '';
  }

  // Checks one citation against the library. status: ok | no-pinpoint | bad-pinpoint | missing
  function check(hit, library) {
    const c = library[hit.key];
    if (!c) return { status: 'missing', case: null, paras: [] };
    if (hit.from == null) return { status: 'no-pinpoint', case: c, paras: [] };
    const paras = [];
    for (let n = hit.from; n <= Math.min(hit.to, hit.from + 9); n++) {
      if (c.paras[n]) paras.push({ n, text: c.paras[n] });
    }
    return { status: paras.length ? 'ok' : 'bad-pinpoint', case: c, paras };
  }

  const STATUS_LABEL = {
    ok: 'Pinpoint found',
    'no-pinpoint': 'No pinpoint given',
    'bad-pinpoint': 'Paragraph not in the decision',
    missing: 'Case not in your library',
  };

  root.Citations = { findCitations, splitParagraphs, detectOwnCitation, check, normalizeKey, STATUS_LABEL };
})(typeof window !== 'undefined' ? window : globalThis);
