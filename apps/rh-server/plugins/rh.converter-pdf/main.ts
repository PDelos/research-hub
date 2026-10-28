// Built-in plugin rh.converter-pdf (spec full-text: Converter slot; design v1-6 D3): the core image's PDF converter,
// pdf.js text per page turned into sections. No Python, no models.
import { extractText, getDocumentProxy } from "unpdf";
import { pdfTextToSections } from "../../src/fulltext/parse.ts";
import type { ConverterExports } from "../rh.fulltext/main.ts";

export function activate(): ConverterExports {
  return {
    available: () => ({ ok: true }),
    async convert(pdf) {
      const doc = await getDocumentProxy(new Uint8Array(pdf));
      const { text } = await extractText(doc, { mergePages: false });
      return pdfTextToSections(text as string[]);
    },
  };
}
