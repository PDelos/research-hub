// Small full-text documents in the formats the hub reads: arXiv LaTeXML HTML, JATS XML, Docling markdown.
export const ARXIV_HTML = `<!DOCTYPE html><html><body><article class="ltx_document">
<h1 class="ltx_title ltx_title_document">Ribosome profiling with protein language models</h1>
<div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6>
<p class="ltx_p">We report an AUROC of 0.87 on held-out genes.</p></div>
<section id="S1" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2>
<div class="ltx_para"><p class="ltx_p">Translation is measured with <math alttext="k=3"><mi>k</mi></math> frames.</p></div></section>
<section id="S2" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">2 </span>Our kernels</h2>
<div class="ltx_para"><p class="ltx_p">We fine-tune on 12,000 transcripts.</p></div></section>
<section id="S3" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">3 </span>Results</h2>
<div class="ltx_para"><p class="ltx_p">The model reaches 0.87 AUROC.</p></div></section>
<section id="bib" class="ltx_bibliography"><h2 class="ltx_title ltx_title_bibliography">References</h2><p>[1] Ingolia.</p></section>
<section id="A1" class="ltx_appendix"><h2 class="ltx_title ltx_title_appendix">Appendix A</h2><div class="ltx_para"><p class="ltx_p">Extra.</p></div></section>
</article></body></html>`;

export const JATS_XML = `<?xml version="1.0"?>
<!DOCTYPE article PUBLIC "-//NLM//DTD JATS//EN" "JATS.dtd">
<article><front><article-meta><abstract><title>Abstract</title><p>Accurate structures from sequence.</p></abstract></article-meta></front>
<body><sec id="s1"><title>Main</title><p>Proteins fold <xref ref-type="bibr">1</xref>.</p><sec id="s1a"><title>Network</title><p>The Evoformer block.</p></sec></sec>
<sec id="s2"><title>Methods</title><p>Trained on PDB chains.</p><table-wrap><p>table text</p></table-wrap></sec>
<sec id="s3"><title>Results</title><p>Median 0.96 Å r.m.s.d.</p></sec></body>
<back><ref-list><title>References</title><ref><p>Ref</p></ref></ref-list></back></article>`;

export const DOCLING_MD = `<!-- image -->
# Ribosome profiling with protein language models

## Abstract

We report an AUROC of 0.87.

## 1 Introduction

Translation is measured.

### 1.1 Scope

Only yeast.

## 2 Methods

We fine-tune a model.

## References

- Ingolia 2009
`;
