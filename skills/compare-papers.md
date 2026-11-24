When: the user wants two or more papers compared — "compare A and B", "A vs B", "which is better for my case".
---
1. fetch_paper each paper named, one at a time (titles, arXiv links, or DOIs from the user message or thread context).
2. summarize_pdf each one that saved a PDF.
3. Deliver a comparison with one row per aspect: task/problem, data, method, key results, limitations. A markdown table works well.
4. Close with 2-3 sentences: which paper fits which use case, and which one to read first.
If a paper is paywalled, mark it and compare from its abstract only — say so explicitly. Never fabricate details to fill a gap.
