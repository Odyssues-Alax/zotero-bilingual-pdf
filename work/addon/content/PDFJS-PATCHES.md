# PDF.js 4.10.38 local extraction patch

Upstream: https://github.com/mozilla/pdf.js/tree/v4.10.38 (Apache-2.0).
The bundled license is unchanged. This patch does not modify rendering.

`getTextContent` recursively reads Form XObjects but upstream only tests the
page viewBox. Forms can contain old text wholly outside their BBox. Carry each
transformed Form BBox into the recursive extraction and intersect conservative
glyph quadrilaterals with every enclosing clip. Preserve partial/edge glyphs,
font decoding, positions, advances and word spacing. Flush at an invisible gap.
Do not cache a clipped-empty Form by resource ID: its next placement can differ.
The public text-content collector aggregates checked/clipped glyph counts.

Helpers: pdf-visibility.mjs. Regression: test-text-visibility.mjs generates PDFs
in memory (nested Forms, transform/rotation, repeated invocation, partial clips).
No page numbers, article titles, font-name whitelists or source PDF rewrites.

Scope: Form BBox clips. Arbitrary clipping paths, soft masks and later painted
occlusion are not newly interpreted here; this is not a claim of full pixel
visibility/OCR. Reapply and run the tests when updating the vendored PDF.js.

- Zotero Bilingual PDF 1.2.9: serialize the PDF indirect reference of structure elements as zbpStructRef. A paragraph can contain marked content on several pages, so the reference provides stable document-local identity. Text extraction and rendering are unchanged.
