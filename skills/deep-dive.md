When: the user wants a thorough review of a topic rather than one paper — "deep dive X", "literature review on X", "catch me up on X", "what's the state of X".
---
Produce a structured mini-review of the topic (the argument, or the user message if no argument).

Steps:
1. corpus_search the topic's keywords. Note which days/categories have hits — this is what the user's feed already knows.
2. If the corpus has a strong hit, fetch_paper the single most relevant recent paper. If its PDF was saved and it is central, summarize_pdf it.
3. web_search the topic for anything newer than the corpus coverage (last weeks).
4. Deliver, in this order:
   - 3-5 bullets: the state of the art in plain English
   - Key paper(s): title + DOI/link for each
   - "What changed recently": 1-3 bullets from the web search
   - "Open gaps": 1-2 bullets (what is not yet solved)
Cite sources as [1], [2] matching a link list at the very end. Never invent titles, dates, or links.
